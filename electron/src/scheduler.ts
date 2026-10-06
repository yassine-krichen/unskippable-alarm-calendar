import {
  applySnooze,
  expandSchedule,
  MAX_LOOKBACK_MINUTES,
  refireAfterDismissal,
  shouldRingMissedOccurrence,
  snoozeUi,
} from '@alarm-calendar/core';
import type {
  CompletionRow,
  ScheduleEventInfo,
  ScheduleOccurrence,
  SchedulePayload,
} from '@alarm-calendar/core';

import { makeOccurrenceId, parseOccurrenceId } from './alarm-ipc';
import type { AlarmView } from './alarm-ipc';
import type { CacheData, OccurrenceState } from './cache';

/**
 * Pure alarm scheduler: no Electron, no timers or clock of its own. The main
 * process injects the real ones, tests inject fakes.
 *
 * It rings what is in the precomputed schedule list (core's expandSchedule) and applies no
 * recurrence or cheat day rules to events itself. The one place it calls core to expand is
 * refillIfStale, which extends the list when the current one is running out.
 */

export const REEVALUATE_INTERVAL_MS = 30_000;

const MS_PER_MINUTE = 60_000;

// Far longer than any grace window, short enough that the cache cannot grow without bound.
export const KNOWN_COMPLETION_RETENTION_MS = 7 * 24 * 60 * MS_PER_MINUTE;

// Main extends the list on its own when less than this much horizon is left...
export const REFILL_WHEN_HORIZON_LEFT_MS = 7 * 24 * 60 * MS_PER_MINUTE;
// ...and at the latest once the list is this old...
export const REFILL_MAX_AGE_MS = 24 * 60 * MS_PER_MINUTE;
// ...but, for the horizon rule, not more often than this, so a horizon that a size cap keeps short
// does not re-expand every 30 seconds.
export const REFILL_MIN_GAP_MS = 60 * MS_PER_MINUTE;

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

function compareOccurrences(a: ScheduleOccurrence, b: ScheduleOccurrence): number {
  const byTime = Date.parse(a.at) - Date.parse(b.at);
  if (byTime !== 0) return byTime;
  return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
}

/** Index of the first occurrence at or after `ms` in a list ascending by time. */
function firstAtOrAfter(list: readonly ScheduleOccurrence[], ms: number): number {
  let low = 0;
  let high = list.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (Date.parse(list[middle]!.at) < ms) low = middle + 1;
    else high = middle;
  }
  return low;
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
   * Replaces the cached schedule (what AlarmAdapter.setSchedule delivers). Completions flagged in
   * the list are merged into the known completions, never replacing them: a completion seen once
   * stays known until it ages out, even if a later push flags fewer.
   */
  setSchedule(payload: SchedulePayload): void {
    const cache = this.deps.cache;
    cache.events = payload.refillSource.events;
    cache.cheatDays = payload.refillSource.cheatDays;
    cache.settings = payload.settings;
    cache.schedule = {
      generatedAt: payload.generatedAt,
      horizonEnd: payload.horizonEnd,
      truncated: payload.truncated,
      // The lookups below need ascending order; for a list core built this is a cheap no-op sort.
      occurrences: [...payload.occurrences].sort(compareOccurrences),
      eventInfo: payload.eventInfo,
    };
    if (payload.truncated) {
      this.deps.log('schedule.truncated', {
        occurrences: payload.occurrences.length,
        horizonEnd: payload.horizonEnd,
      });
    }
    this.mergeKnownCompletions(
      payload.occurrences
        .filter((occurrence) => occurrence.completed)
        .map((occurrence) => occurrence.id)
    );

    const isActive = (eventId: string): boolean => Object.hasOwn(payload.eventInfo, eventId);
    const gone = cache.occurrences.filter((state) => !isActive(state.eventId));
    cache.occurrences = cache.occurrences.filter((state) => isActive(state.eventId));
    for (const state of gone) {
      this.deps.onDismiss(makeOccurrenceId(state.eventId, new Date(state.occurrenceAt)));
    }
    this.refreshStatesFromEventInfo(payload.eventInfo);
    // Forget watermarks of events that left the schedule so the cache cannot grow forever.
    const knownIds = new Set(cache.events.map((event) => event.id));
    for (const eventId of Object.keys(cache.handledThrough)) {
      if (!knownIds.has(eventId)) delete cache.handledThrough[eventId];
    }
    this.deps.persist(cache);
    this.evaluate('set-schedule');
  }

  /** Records a completion the server accepted. Caller persists. */
  markCompleted(completion: CompletionRow): void {
    this.mergeKnownCompletions([
      makeOccurrenceId(completion.event_id, new Date(completion.occurrence_at)),
    ]);
  }

  /** An edit that lands while an alarm is ringing or snoozed (new title, snooze rules) applies to it. */
  private refreshStatesFromEventInfo(eventInfo: Record<string, ScheduleEventInfo>): void {
    for (const state of this.deps.cache.occurrences) {
      const info = eventInfo[state.eventId];
      if (info === undefined) continue;
      state.title = info.title;
      state.notes = info.notes;
      state.maxSnoozes = info.maxSnoozes;
      state.snoozeMinutes = info.snoozeMinutes;
      state.soundId = info.soundId;
    }
  }

  private mergeKnownCompletions(occurrenceIds: readonly string[]): void {
    const cutoffMs = this.deps.now().getTime() - KNOWN_COMPLETION_RETENTION_MS;
    const known = new Set(this.deps.cache.knownCompletions);
    for (const id of occurrenceIds) known.add(id);
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

  /**
   * Extends the list from the cached events when it is running out, so alarms keep a future while
   * the app window stays closed for weeks. Returns true when the list was replaced. Refills when
   * there is no list yet (first start after a version 1 cache), the list is a day old, or less than
   * 7 days of horizon remain (then at most hourly). A list stamped in the future, after the clock
   * moved back, counts as stale.
   */
  private refillIfStale(now: Date): boolean {
    const cache = this.deps.cache;
    const { settings, schedule } = cache;
    if (settings === null) return false;
    if (schedule !== null) {
      const ageMs = now.getTime() - Date.parse(schedule.generatedAt);
      const leftMs = Date.parse(schedule.horizonEnd) - now.getTime();
      const due =
        ageMs < 0 ||
        ageMs >= REFILL_MAX_AGE_MS ||
        leftMs <= 0 ||
        (leftMs < REFILL_WHEN_HORIZON_LEFT_MS && ageMs >= REFILL_MIN_GAP_MS);
      if (!due) return false;
    }

    try {
      const expanded = expandSchedule({
        events: cache.events,
        cheatDays: cache.cheatDays,
        settings,
        completions: cache.knownCompletions.flatMap((id) => {
          const parsed = parseOccurrenceId(id);
          return parsed === null
            ? []
            : [{ event_id: parsed.eventId, occurrence_at: parsed.occurrenceAt }];
        }),
        now,
        onEventFailed: (eventId, error) =>
          this.deps.log('scheduler.event_failed', { eventId, error: String(error) }),
      });
      cache.schedule = {
        generatedAt: now.toISOString(),
        horizonEnd: expanded.horizonEnd,
        truncated: expanded.truncated,
        occurrences: expanded.occurrences,
        eventInfo: expanded.eventInfo,
      };
      this.deps.log('schedule.refilled', {
        occurrences: expanded.occurrences.length,
        horizonEnd: expanded.horizonEnd,
        truncated: expanded.truncated,
      });
      return true;
    } catch (error) {
      // A cached time zone that stopped being valid must not take the evaluation loop down.
      this.deps.log('schedule.refill_failed', { error: String(error) });
      return false;
    }
  }

  /** True while any occurrence is ringing or snoozed, i.e. an alarm is not finished yet. */
  hasActiveOccurrences(): boolean {
    return this.deps.cache.occurrences.length > 0;
  }

  /**
   * Re-checks everything against the clock: refills a running-out schedule, wakes snoozed and
   * re-firing alarms, rings due occurrences, then re-arms the single timeout. Call it on
   * powerMonitor resume and unlock-screen as well as from the timers.
   */
  evaluate(reason: string): void {
    const now = this.deps.now();
    const refilled = this.refillIfStale(now);
    const woke = this.wakeWaitingOccurrences(now);
    const rang = this.ringDueOccurrences(now);
    if (refilled || woke || rang) this.deps.persist(this.deps.cache);
    if (woke || rang) this.deps.log('scheduler.evaluated', { reason });
    this.armTimeout(now);
    this.deps.afterEvaluate?.();
  }

  /** What the alarm screen shows; null unless the occurrence is ringing. */
  getAlarm(occurrenceId: string): AlarmView | null {
    const state = this.findRingingState(occurrenceId);
    return state === null ? null : this.buildView(state);
  }

  /** Records a pending completion and ends the occurrence. False if it was not ringing. */
  done(occurrenceId: string): boolean {
    const state = this.findRingingState(occurrenceId);
    if (state === null) return false;

    const cache = this.deps.cache;
    const completion: CompletionRow = {
      id: this.deps.newId(),
      user_id: state.userId,
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

  /** Snoozes if the occurrence still allows it. False if it was not ringing or no snoozes are left. */
  snooze(occurrenceId: string): boolean {
    const state = this.findRingingState(occurrenceId);
    if (state === null) return false;

    let result;
    try {
      result = applySnooze(snoozeRules(state), state.snoozesUsed, this.deps.now());
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
      state.phase = 'ringing';
      state.wakeAt = null;
      changed = true;
      this.deps.log('alarm.ringing_again', { eventId: state.eventId });
      this.ring(state, now);
    }
    return changed;
  }

  private ringDueOccurrences(now: Date): boolean {
    const { settings, schedule, handledThrough } = this.deps.cache;
    if (settings === null || schedule === null) return false;

    // Only the grace window and the watermark matter: walk the occurrences due now and keep the
    // latest per event. After a long sleep several can be due; only the latest is worth ringing.
    const nowMs = now.getTime();
    const graceStartMs = nowMs - graceMinutesOf(settings) * MS_PER_MINUTE;
    const list = schedule.occurrences;
    const latestByEvent = new Map<string, ScheduleOccurrence>();
    for (let i = firstAtOrAfter(list, graceStartMs); i < list.length; i++) {
      const occurrence = list[i]!;
      const atMs = Date.parse(occurrence.at);
      if (atMs > nowMs) break;
      const watermark = handledThrough[occurrence.eventId];
      if (watermark !== undefined && atMs <= Date.parse(watermark)) continue;
      latestByEvent.set(occurrence.eventId, occurrence);
    }

    let changed = false;
    for (const occurrence of latestByEvent.values()) {
      changed = this.handleLatestDue(occurrence, now) || changed;
    }
    return changed;
  }

  /** Rings, silences or drops the latest due occurrence of one event. Returns true if the cache changed. */
  private handleLatestDue(occurrence: ScheduleOccurrence, now: Date): boolean {
    const cache = this.deps.cache;
    const settings = cache.settings;
    if (settings === null) return false;
    const at = new Date(occurrence.at);

    this.advanceHandledThrough(occurrence.eventId, at);
    // Done on another device (flagged in the list or synced earlier) or here (pending): do not
    // ring it again on resume.
    const alreadyCompleted = occurrence.completed || this.isKnownCompleted(occurrence.eventId, at);
    if (!shouldRingMissedOccurrence(at, now, graceMinutesOf(settings), alreadyCompleted)) {
      if (alreadyCompleted) {
        this.deps.log('alarm.skipped_already_completed', { eventId: occurrence.eventId });
      }
      return true;
    }
    if (occurrence.silenced) {
      this.deps.log('alarm.silenced_by_cheat_day', { eventId: occurrence.eventId });
      return true;
    }
    // Rule 7: a new occurrence of an event that is still ringing is dropped. A
    // snoozed occurrence is part of the same ringing lifecycle, so it counts too.
    const alreadyRinging = cache.occurrences.some((state) => state.eventId === occurrence.eventId);
    if (alreadyRinging) {
      this.deps.log('alarm.dropped_already_ringing', { eventId: occurrence.eventId });
      return true;
    }

    const info = cache.schedule?.eventInfo[occurrence.eventId];
    if (info === undefined) {
      // Cannot happen for a list that passed validation or came from core; never ring blind.
      this.deps.log('scheduler.event_info_missing', { eventId: occurrence.eventId });
      return true;
    }
    const state: OccurrenceState = {
      eventId: occurrence.eventId,
      occurrenceAt: occurrence.at,
      snoozesUsed: 0,
      phase: 'ringing',
      wakeAt: null,
      userId: settings.user_id,
      title: info.title,
      notes: info.notes,
      maxSnoozes: info.maxSnoozes,
      snoozeMinutes: info.snoozeMinutes,
      soundId: info.soundId,
    };
    cache.occurrences.push(state);
    this.deps.log('alarm.ringing', { eventId: state.eventId, occurrenceAt: state.occurrenceAt });
    this.ring(state, now);
    return true;
  }

  /** If the host cannot show the alarm, try again after the refire delay instead of losing it. */
  private ring(state: OccurrenceState, now: Date): void {
    try {
      this.deps.onRing(this.buildView(state));
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

  /** One setTimeout, aimed at the soonest of: next occurrence in the list, any wakeAt. */
  private armTimeout(now: Date): void {
    this.clearTimeoutHandle();
    const { schedule, handledThrough, occurrences } = this.deps.cache;

    let soonestMs = Infinity;
    for (const state of occurrences) {
      if (state.wakeAt !== null) soonestMs = Math.min(soonestMs, Date.parse(state.wakeAt));
    }
    if (this.deps.cache.settings !== null && schedule !== null) {
      // First occurrence strictly after now that its event has not handled yet.
      const list = schedule.occurrences;
      for (let i = firstAtOrAfter(list, now.getTime() + 1); i < list.length; i++) {
        const occurrence = list[i]!;
        const watermark = handledThrough[occurrence.eventId];
        const atMs = Date.parse(occurrence.at);
        if (watermark !== undefined && atMs <= Date.parse(watermark)) continue;
        soonestMs = Math.min(soonestMs, atMs);
        break;
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

  private buildView(state: OccurrenceState): AlarmView {
    const ui = snoozeUi(snoozeRules(state), state.snoozesUsed);
    return {
      occurrenceId: makeOccurrenceId(state.eventId, new Date(state.occurrenceAt)),
      title: state.title,
      notes: state.notes,
      occurrenceAt: state.occurrenceAt,
      snoozeLabel: ui.label,
      snoozeNotice: ui.notice,
      soundId: state.soundId,
    };
  }
}

function snoozeRules(state: OccurrenceState): { max_snoozes: number; snooze_minutes: number } {
  return { max_snoozes: state.maxSnoozes, snooze_minutes: state.snoozeMinutes };
}

/** The grace window the list can serve (core's look-back caps it; an older cache may hold more). */
function graceMinutesOf(settings: { grace_minutes: number }): number {
  return Math.min(settings.grace_minutes, MAX_LOOKBACK_MINUTES);
}
