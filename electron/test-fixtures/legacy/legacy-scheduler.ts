// Frozen copy of electron/src/scheduler.ts at commit 3ab5731 (phase 2, the per-event scheduler),
// vendored only so schedule-parity.test.ts can run the old engine beside the list-driven one.
// Not part of the build (outside src/). Delete with the test once phase 3b has shipped.
import {
  applySnooze,
  isSilencedByCheatDay,
  nextOccurrence,
  occurrencesBetween,
  refireAfterDismissal,
  shouldRingMissedOccurrence,
  snoozeUi,
} from '@alarm-calendar/core';
import type { AlarmSettings, CompletionRow, EventRow } from '@alarm-calendar/core';

import { makeOccurrenceId, parseOccurrenceId } from './legacy-alarm-ipc';
import type { AlarmView } from './legacy-alarm-ipc';
import type { CacheData, OccurrenceState } from './legacy-cache';

/**
 * Pure alarm scheduler: no Electron, no timers or clock of its own. The main
 * process injects the real ones, tests inject fakes.
 */

export const REEVALUATE_INTERVAL_MS = 30_000;

const MS_PER_MINUTE = 60_000;

// Far longer than any grace window, short enough that the cache cannot grow without bound.
export const KNOWN_COMPLETION_RETENTION_MS = 7 * 24 * 60 * MS_PER_MINUTE;

// setTimeout stores the delay in a signed 32-bit int and fires at once beyond it.
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

// Only used if an alarm somehow rings before settings were ever cached.
const FALLBACK_REFIRE_SECONDS = 120;

export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const realTimers: Timers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

export type SchedulerLogger = (event: string, fields?: Record<string, unknown>) => void;

export interface SchedulerDeps {
  /** Mutated in place by the scheduler; persist() is called after every change. */
  cache: CacheData;
  persist(cache: CacheData): void;
  now(): Date;
  timers: Timers;
  newId(): string;
  /** Show (or re-show) the alarm UI and start the sound. */
  onRing(view: AlarmView): void;
  /** Close the alarm UI of an occurrence that no longer exists. */
  onDismiss(occurrenceId: string): void;
  /**
   * Called at the end of every evaluation (and so after every state change):
   * the host re-fronts open alarm windows and refreshes the tray menu.
   */
  afterEvaluate?(): void;
  log: SchedulerLogger;
}

export class AlarmScheduler {
  private timeoutHandle: unknown = null;
  private intervalHandle: unknown = null;

  constructor(private readonly deps: SchedulerDeps) {}

  /** Starts the 30 second re-evaluation loop and evaluates immediately. */
  start(): void {
    const now = this.deps.now();
    // An alarm that was on screen when the app died has no window any more.
    // Ring it again at once instead of waiting out a refire delay.
    for (const state of this.deps.cache.occurrences) {
      if (state.phase === 'ringing' && state.wakeAt === null) {
        state.wakeAt = now.toISOString();
      }
    }
    this.intervalHandle = this.deps.timers.setInterval(
      () => this.evaluate('interval'),
      REEVALUATE_INTERVAL_MS
    );
    this.evaluate('start');
  }

  stop(): void {
    this.clearTimeoutHandle();
    if (this.intervalHandle !== null) {
      this.deps.timers.clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /**
   * Replaces the cached schedule (what AlarmAdapter.setSchedule delivers).
   * `completions` are merged into the known completions, never replacing them:
   * a completion seen once stays known until it ages out, even if a later sync
   * has a narrower window.
   */
  setSchedule(
    events: EventRow[],
    cheatDays: string[],
    settings: AlarmSettings,
    completions: readonly CompletionRow[] = []
  ): void {
    const cache = this.deps.cache;
    cache.events = events;
    cache.cheatDays = cheatDays;
    cache.settings = settings;
    this.mergeKnownCompletions(completions);

    const activeIds = new Set(events.filter((event) => event.active).map((event) => event.id));
    const gone = cache.occurrences.filter((state) => !activeIds.has(state.eventId));
    cache.occurrences = cache.occurrences.filter((state) => activeIds.has(state.eventId));
    for (const state of gone) {
      this.deps.onDismiss(makeOccurrenceId(state.eventId, new Date(state.occurrenceAt)));
    }
    // Forget watermarks of events that left the schedule so the cache cannot grow forever.
    const knownIds = new Set(events.map((event) => event.id));
    for (const eventId of Object.keys(cache.handledThrough)) {
      if (!knownIds.has(eventId)) delete cache.handledThrough[eventId];
    }
    this.deps.persist(cache);
    this.evaluate('set-schedule');
  }

  /** Records a completion the server accepted. Caller persists. */
  markCompleted(completion: CompletionRow): void {
    this.mergeKnownCompletions([completion]);
  }

  private mergeKnownCompletions(completions: readonly CompletionRow[]): void {
    const cutoffMs = this.deps.now().getTime() - KNOWN_COMPLETION_RETENTION_MS;
    const known = new Set(this.deps.cache.knownCompletions);
    for (const completion of completions) {
      known.add(makeOccurrenceId(completion.event_id, new Date(completion.occurrence_at)));
    }
    this.deps.cache.knownCompletions = [...known].filter((id) => {
      const parsed = parseOccurrenceId(id);
      return parsed !== null && Date.parse(parsed.occurrenceAt) >= cutoffMs;
    });
  }

  /** Done on this device (not yet flushed) or already synced from any device. */
  private isKnownCompleted(eventId: string, occurrenceAt: Date): boolean {
    const cache = this.deps.cache;
    const iso = occurrenceAt.toISOString();
    return (
      cache.knownCompletions.includes(makeOccurrenceId(eventId, occurrenceAt)) ||
      cache.pendingCompletions.some(
        (pending) =>
          pending.event_id === eventId && new Date(pending.occurrence_at).toISOString() === iso
      )
    );
  }

  /** True while any occurrence is ringing or snoozed, i.e. an alarm is not finished yet. */
  hasActiveOccurrences(): boolean {
    return this.deps.cache.occurrences.length > 0;
  }

  /**
   * Re-checks everything against the clock: wakes snoozed and re-firing
   * alarms, rings due occurrences, then re-arms the single timeout. Call it on
   * powerMonitor resume and unlock-screen as well as from the timers.
   */
  evaluate(reason: string): void {
    const now = this.deps.now();
    const woke = this.wakeWaitingOccurrences(now);
    const rang = this.ringDueOccurrences(now);
    if (woke || rang) {
      this.deps.persist(this.deps.cache);
      this.deps.log('scheduler.evaluated', { reason });
    }
    this.armTimeout(now);
    this.deps.afterEvaluate?.();
  }

  /** What the alarm screen shows; null unless the occurrence is ringing. */
  getAlarm(occurrenceId: string): AlarmView | null {
    const state = this.findRingingState(occurrenceId);
    if (state === null) return null;
    const event = this.findEvent(state.eventId);
    return event === null ? null : this.buildView(event, state);
  }

  /** Records a pending completion and ends the occurrence. False if it was not ringing. */
  done(occurrenceId: string): boolean {
    const state = this.findRingingState(occurrenceId);
    const event = state === null ? null : this.findEvent(state.eventId);
    if (state === null || event === null) return false;

    const cache = this.deps.cache;
    const completion: CompletionRow = {
      id: this.deps.newId(),
      user_id: event.user_id,
      event_id: state.eventId,
      occurrence_at: state.occurrenceAt,
      status: 'done',
      snoozes_used: state.snoozesUsed,
      done_at: this.deps.now().toISOString(),
    };
    // Upserts are keyed by (event_id, occurrence_at), so keep one pending row per key.
    cache.pendingCompletions = cache.pendingCompletions.filter(
      (existing) =>
        existing.event_id !== completion.event_id ||
        existing.occurrence_at !== completion.occurrence_at
    );
    cache.pendingCompletions.push(completion);
    this.removeState(state);
    this.advanceHandledThrough(state.eventId, new Date(state.occurrenceAt));
    this.deps.persist(cache);
    this.deps.log('alarm.done', { occurrenceId, snoozesUsed: state.snoozesUsed });
    this.evaluate('done');
    return true;
  }

  /** Snoozes if the event still allows it. False if it was not ringing or no snoozes are left. */
  snooze(occurrenceId: string): boolean {
    const state = this.findRingingState(occurrenceId);
    const event = state === null ? null : this.findEvent(state.eventId);
    if (state === null || event === null) return false;

    let result;
    try {
      result = applySnooze(event, state.snoozesUsed, this.deps.now());
    } catch (error) {
      if (error instanceof RangeError) return false;
      throw error;
    }
    state.snoozesUsed = result.snoozesUsed;
    state.phase = 'snoozed';
    state.wakeAt = result.refireAt.toISOString();
    this.deps.persist(this.deps.cache);
    this.deps.log('alarm.snoozed', { occurrenceId, snoozesUsed: state.snoozesUsed });
    this.evaluate('snooze');
    return true;
  }

  /** The alarm window went away. If no choice was made, schedule the re-ring. */
  windowClosed(occurrenceId: string): void {
    const state = this.findRingingState(occurrenceId);
    if (state === null || state.wakeAt !== null) return;
    const refireSeconds = this.deps.cache.settings?.refire_seconds ?? FALLBACK_REFIRE_SECONDS;
    const refireAt = refireAfterDismissal({ refire_seconds: refireSeconds }, this.deps.now());
    state.wakeAt = refireAt.toISOString();
    this.deps.persist(this.deps.cache);
    this.deps.log('alarm.closed_without_choice', { occurrenceId, refireAt: state.wakeAt });
    this.evaluate('window-closed');
  }

  private wakeWaitingOccurrences(now: Date): boolean {
    let changed = false;
    for (const state of [...this.deps.cache.occurrences]) {
      if (state.wakeAt === null || Date.parse(state.wakeAt) > now.getTime()) continue;
      const event = this.findEvent(state.eventId);
      if (event === null) {
        this.removeState(state);
        changed = true;
        continue;
      }
      state.phase = 'ringing';
      state.wakeAt = null;
      changed = true;
      this.deps.log('alarm.ringing_again', { eventId: state.eventId });
      this.ring(event, state, now);
    }
    return changed;
  }

  private ringDueOccurrences(now: Date): boolean {
    const { settings, events } = this.deps.cache;
    if (settings === null) return false;

    let changed = false;
    for (const event of events) {
      if (!event.active) continue;
      try {
        changed = this.ringLatestDueOccurrence(event, settings, now) || changed;
      } catch (error) {
        // One malformed event must not stop the others from ringing.
        this.deps.log('scheduler.event_failed', { eventId: event.id, error: String(error) });
      }
    }
    return changed;
  }

  /**
   * Considers the latest occurrence of one event that is due but not yet
   * handled. Returns true if the cache changed.
   */
  private ringLatestDueOccurrence(event: EventRow, settings: AlarmSettings, now: Date): boolean {
    const cache = this.deps.cache;
    const watermark = cache.handledThrough[event.id];
    const graceStartMs = now.getTime() - settings.grace_minutes * MS_PER_MINUTE;
    const fromMs =
      watermark === undefined ? graceStartMs : Math.max(graceStartMs, Date.parse(watermark) + 1);
    const due = occurrencesBetween(
      event,
      new Date(fromMs),
      new Date(now.getTime() + 1),
      settings.timezone
    );
    // After a long sleep several occurrences can be due; only the latest is worth ringing.
    const latest = due.at(-1);
    if (latest === undefined) return false;

    this.advanceHandledThrough(event.id, latest);
    // Done on another device (synced) or here (pending): do not ring it again on resume.
    const alreadyCompleted = this.isKnownCompleted(event.id, latest);
    if (!shouldRingMissedOccurrence(latest, now, settings.grace_minutes, alreadyCompleted)) {
      if (alreadyCompleted) this.deps.log('alarm.skipped_already_completed', { eventId: event.id });
      return true;
    }
    if (isSilencedByCheatDay(event, latest, cache.cheatDays, settings.timezone)) {
      this.deps.log('alarm.silenced_by_cheat_day', { eventId: event.id });
      return true;
    }
    // Rule 7: a new occurrence of an event that is still ringing is dropped. A
    // snoozed occurrence is part of the same ringing lifecycle, so it counts too.
    const alreadyRinging = cache.occurrences.some((state) => state.eventId === event.id);
    if (alreadyRinging) {
      this.deps.log('alarm.dropped_already_ringing', { eventId: event.id });
      return true;
    }

    const state: OccurrenceState = {
      eventId: event.id,
      occurrenceAt: latest.toISOString(),
      snoozesUsed: 0,
      phase: 'ringing',
      wakeAt: null,
    };
    cache.occurrences.push(state);
    this.deps.log('alarm.ringing', { eventId: event.id, occurrenceAt: state.occurrenceAt });
    this.ring(event, state, now);
    return true;
  }

  /** If the host cannot show the alarm, try again after the refire delay instead of losing it. */
  private ring(event: EventRow, state: OccurrenceState, now: Date): void {
    try {
      this.deps.onRing(this.buildView(event, state));
    } catch (error) {
      const refireSeconds = this.deps.cache.settings?.refire_seconds ?? FALLBACK_REFIRE_SECONDS;
      state.wakeAt = refireAfterDismissal({ refire_seconds: refireSeconds }, now).toISOString();
      this.deps.log('alarm.show_failed', {
        eventId: state.eventId,
        error: String(error),
        retryAt: state.wakeAt,
      });
    }
  }

  /** One setTimeout, aimed at the soonest of: next occurrence of any event, any wakeAt. */
  private armTimeout(now: Date): void {
    this.clearTimeoutHandle();
    const { settings, events, handledThrough, occurrences } = this.deps.cache;

    let soonestMs = Infinity;
    for (const state of occurrences) {
      if (state.wakeAt !== null) soonestMs = Math.min(soonestMs, Date.parse(state.wakeAt));
    }
    if (settings !== null) {
      for (const event of events) {
        if (!event.active) continue;
        try {
          const watermark = handledThrough[event.id];
          const afterMs = Math.max(
            now.getTime(),
            watermark === undefined ? 0 : Date.parse(watermark)
          );
          const next = nextOccurrence(event, new Date(afterMs), settings.timezone);
          if (next !== null) soonestMs = Math.min(soonestMs, next.getTime());
        } catch (error) {
          this.deps.log('scheduler.event_failed', { eventId: event.id, error: String(error) });
        }
      }
    }
    if (soonestMs === Infinity) return;

    const delay = Math.min(Math.max(soonestMs - now.getTime(), 1), MAX_TIMEOUT_MS);
    this.timeoutHandle = this.deps.timers.setTimeout(() => this.evaluate('timeout'), delay);
  }

  private clearTimeoutHandle(): void {
    if (this.timeoutHandle !== null) {
      this.deps.timers.clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
  }

  private advanceHandledThrough(eventId: string, occurrenceAt: Date): void {
    const current = this.deps.cache.handledThrough[eventId];
    if (current === undefined || Date.parse(current) < occurrenceAt.getTime()) {
      this.deps.cache.handledThrough[eventId] = occurrenceAt.toISOString();
    }
  }

  private removeState(state: OccurrenceState): void {
    this.deps.cache.occurrences = this.deps.cache.occurrences.filter((s) => s !== state);
  }

  private findEvent(eventId: string): EventRow | null {
    return this.deps.cache.events.find((event) => event.id === eventId) ?? null;
  }

  private findRingingState(occurrenceId: string): OccurrenceState | null {
    const parsed = parseOccurrenceId(occurrenceId);
    if (parsed === null) return null;
    return (
      this.deps.cache.occurrences.find(
        (state) =>
          state.eventId === parsed.eventId &&
          state.occurrenceAt === parsed.occurrenceAt &&
          state.phase === 'ringing'
      ) ?? null
    );
  }

  private buildView(event: EventRow, state: OccurrenceState): AlarmView {
    const ui = snoozeUi(event, state.snoozesUsed);
    return {
      occurrenceId: makeOccurrenceId(state.eventId, new Date(state.occurrenceAt)),
      title: event.title,
      notes: event.notes,
      occurrenceAt: state.occurrenceAt,
      snoozeLabel: ui.label,
      snoozeNotice: ui.notice,
      soundId: this.deps.cache.settings?.sound ?? null,
    };
  }
}
