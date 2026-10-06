import { instantMs } from './instant';
import { eventKindOf, isEventPassable } from './occurrences';
import { nominalPeriodDays } from './period';
import { fromWallClock, toWallClock } from './time-zone';
import type {
  EventRow,
  ModeActivationSource,
  ModeConfig,
  ModeRow,
  ModeRuleRow,
  ModeSettings,
  Settings,
} from './types';

// Roadmap v2, phase 5. A mode changes how alarms behave while it is in effect: per alarm it keeps,
// skips (pauses), shifts or shortens it. Modes are applied while occurrences are computed (the schedule
// list, the calendar, habit scoring), never to the alarm rows, so the platform engines need no mode logic:
// a skipped occurrence is simply not in their list, and a shifted one is in it at its new time.
// Keep a Kotlin mirror identical if one is ever needed.

/** Days before an exam that Exam mode switches itself on when the settings do not say. */
export const DEFAULT_EXAM_MODE_DAYS_BEFORE = 10;

/** A shift is at most this many minutes either way (12 hours), also enforced by the database. */
export const MAX_SHIFT_MINUTES = 720;
export const MAX_SHIFT_MS = MAX_SHIFT_MINUTES * 60_000;

/** 'exam' is Exam mode's automatic window before an exam: derived from the exams, never stored. */
export type ModeWindowSource = ModeActivationSource | 'exam';

/** When two windows overlap, the higher source wins: manual, then range, then exam. */
const SOURCE_RANK: Record<ModeWindowSource, number> = { manual: 3, range: 2, exam: 1 };

/** The settings the mode rules read: the zone (the exam window ends at local midnight) and the exam lead. */
export type ModeTimelineSettings = Pick<Settings, 'timezone'> & Partial<ModeSettings>;

/** One stretch of time during which a mode is switched on, before precedence is applied. */
export interface ModeWindow {
  /** The activation's id, or the exam's id for an automatic window. */
  id: string;
  modeId: string;
  source: ModeWindowSource;
  startMs: number;
  /** Exclusive; Infinity for an open-ended manual activation. */
  endMs: number;
}

/** The one mode in effect at an instant, and why. */
export interface EffectiveMode {
  mode: ModeRow;
  source: ModeWindowSource;
  window: ModeWindow;
}

/** A stretch of time with one mode in effect (see ModeTimeline.segments). */
export interface ModeSegment {
  startMs: number;
  endMs: number;
  mode: ModeRow;
  source: ModeWindowSource;
}

export interface ModeTimeline {
  /** False when no mode can ever take effect, so every consumer can skip its mode work. */
  readonly active: boolean;
  /** Every usable window, ascending by start. Windows of a mode that is off are left out. */
  readonly windows: readonly ModeWindow[];
  /** The mode in effect at an instant (one at most: manual beats range beats exam), or null for Normal. */
  at(instant: Date | number): EffectiveMode | null;
  /**
   * The stretches inside [from, to) where a mode is in effect, in order, with neighbours of the same
   * mode and source merged. Stretches of Normal are not listed.
   */
  segments(from: Date | number, to: Date | number): ModeSegment[];
  /** The rule of one alarm under one mode, if the person set one. */
  ruleFor(modeId: string, eventId: string): ModeRuleRow | undefined;
  /**
   * The instants a completion of the occurrence at `atMs` may be recorded at: its own, and that moved by
   * each shift any mode has for this alarm, either way. A Done pressed at a shifted time (08:30) still
   * covers the occurrence once the mode that shifted it has ended and it is back at its own time (09:00),
   * and the reverse. A shift as long as the alarm's own repeat period is ignored, because the neighbouring
   * occurrence is then the one it would match. A prayer is not shifted, so it gets only its own instant.
   */
  matchInstants(
    event: Pick<EventRow, 'id' | 'kind' | 'repeat_unit' | 'repeat_interval' | 'repeat_weekdays'>,
    atMs: number
  ): number[];
}

const toMs = (instant: Date | number): number => (typeof instant === 'number' ? instant : instant.getTime());

/**
 * Exam mode's automatic windows: for each active exam, from local midnight `exam_mode_days_before` days
 * before the exam day to the end of the day after it, in the settings zone, for the built-in Exam mode.
 * Empty when that mode is missing or off, or the lead is 0. Derived on every call, never stored, so editing
 * or deleting an exam moves or removes its window by itself.
 */
export function examModeWindows(
  exams: ModeConfig['exams'],
  modes: readonly ModeRow[],
  settings: ModeTimelineSettings
): ModeWindow[] {
  const days = settings.exam_mode_days_before ?? DEFAULT_EXAM_MODE_DAYS_BEFORE;
  if (!(days > 0)) return [];
  const examMode = modes.find((mode) => mode.builtin_key === 'exam' && mode.active);
  if (examMode === undefined) return [];
  const windows: ModeWindow[] = [];
  for (const exam of exams) {
    if (!exam.active) continue;
    const examMs = instantMs(exam.exam_at);
    if (Number.isNaN(examMs)) continue;
    const examDay = toWallClock(new Date(examMs), settings.timezone).dayNumber;
    windows.push({
      id: exam.id,
      modeId: examMode.id,
      source: 'exam',
      startMs: fromWallClock(examDay - days, 0, settings.timezone).getTime(),
      // The day after the exam is included whole, so the window ends when the day after that begins.
      endMs: fromWallClock(examDay + 2, 0, settings.timezone).getTime(),
    });
  }
  return windows;
}

const NO_MODES: ModeTimeline = {
  active: false,
  windows: [],
  at: () => null,
  segments: () => [],
  ruleFor: () => undefined,
  matchInstants: (_event, atMs) => [atMs],
};

/** The distinct shift minutes each alarm has under any mode that is on (a shift of 0 does nothing). */
function shiftOffsetsByEvent(config: ModeConfig): Map<string, number[]> {
  const active = new Set(config.modes.filter((mode) => mode.active).map((mode) => mode.id));
  const byEvent = new Map<string, number[]>();
  for (const rule of config.rules) {
    const minutes = rule.shift_minutes;
    if (rule.behavior !== 'shift' || minutes === null || !Number.isFinite(minutes) || minutes === 0 || !active.has(rule.mode_id)) continue;
    const list = byEvent.get(rule.event_id) ?? [];
    if (!list.includes(minutes)) list.push(minutes);
    byEvent.set(rule.event_id, list);
  }
  return byEvent;
}

/**
 * Resolves the modes once, so asking "which mode is in effect at this instant" is cheap for the
 * thousands of occurrences of a schedule or a scoring window. Precedence when windows overlap: manual,
 * then range, then exam; among windows of the same source the one that started last wins, so a new
 * switch overrides an older one. Normal is the absence of any window. A mode that is off (active = false)
 * contributes nothing, and neither does an activation that is malformed (unreadable or reversed times).
 * Returns an inert timeline for a missing config.
 */
export function buildModeTimeline(
  config: ModeConfig | null | undefined,
  settings: ModeTimelineSettings
): ModeTimeline {
  if (config === null || config === undefined) return NO_MODES;
  const modesById = new Map(config.modes.map((mode) => [mode.id, mode]));
  const usable = (modeId: string): boolean => modesById.get(modeId)?.active === true;

  const windows: ModeWindow[] = [];
  for (const activation of config.activations) {
    const startMs = instantMs(activation.starts_at);
    const endMs = activation.ends_at === null ? Infinity : instantMs(activation.ends_at);
    if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs || !usable(activation.mode_id)) continue;
    windows.push({ id: activation.id, modeId: activation.mode_id, source: activation.source, startMs, endMs });
  }
  windows.push(...examModeWindows(config.exams, config.modes, settings));
  // Shifts matter for completion matching even when no window is open any more.
  const shiftOffsets = shiftOffsetsByEvent(config);
  if (windows.length === 0 && shiftOffsets.size === 0) return NO_MODES;
  windows.sort((a, b) => a.startMs - b.startMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const rules = new Map<string, ModeRuleRow>();
  for (const rule of config.rules) rules.set(`${rule.mode_id}|${rule.event_id}`, rule);

  const at = (instant: Date | number): EffectiveMode | null => {
    const ms = toMs(instant);
    let best: ModeWindow | null = null;
    for (const window of windows) {
      if (window.startMs > ms) break; // sorted by start: nothing later can contain it
      if (ms >= window.endMs) continue;
      if (
        best === null ||
        SOURCE_RANK[window.source] > SOURCE_RANK[best.source] ||
        (window.source === best.source && window.startMs >= best.startMs)
      ) {
        best = window;
      }
    }
    if (best === null) return null;
    const mode = modesById.get(best.modeId);
    return mode === undefined ? null : { mode, source: best.source, window: best };
  };

  const segments = (from: Date | number, to: Date | number): ModeSegment[] => {
    const fromMs = toMs(from);
    const toLimit = toMs(to);
    // The effective mode can only change at a window's start or end, so evaluate once per stretch between them.
    const cuts = new Set<number>([fromMs]);
    for (const window of windows) {
      if (window.startMs > fromMs && window.startMs < toLimit) cuts.add(window.startMs);
      if (window.endMs > fromMs && window.endMs < toLimit) cuts.add(window.endMs);
    }
    const points = [...cuts].sort((a, b) => a - b);
    const result: ModeSegment[] = [];
    points.forEach((startMs, index) => {
      const endMs = points[index + 1] ?? toLimit;
      const effective = at(startMs);
      if (effective === null || endMs <= startMs) return;
      const last = result[result.length - 1];
      if (last !== undefined && last.endMs === startMs && last.mode.id === effective.mode.id && last.source === effective.source) {
        last.endMs = endMs;
      } else {
        result.push({ startMs, endMs, mode: effective.mode, source: effective.source });
      }
    });
    return result;
  };

  const matchInstants: ModeTimeline['matchInstants'] = (event, atMs) => {
    const offsets = shiftOffsets.get(event.id);
    if (offsets === undefined || eventKindOf(event) !== 'normal') return [atMs];
    const periodMs = event.repeat_unit === 'none' ? Infinity : nominalPeriodDays(event) * 86_400_000;
    const instants = new Set<number>([atMs]);
    for (const minutes of offsets) {
      if (Math.abs(minutes) * 60_000 >= periodMs) continue;
      instants.add(atMs + minutes * 60_000);
      instants.add(atMs - minutes * 60_000);
    }
    return [...instants];
  };

  return {
    active: windows.length > 0,
    windows,
    at,
    segments,
    ruleFor: (modeId, eventId) => rules.get(`${modeId}|${eventId}`),
    matchInstants,
  };
}

/** The mode in effect at an instant, or null for Normal. See buildModeTimeline for the precedence. */
export function effectiveModeAt(
  instant: Date,
  config: ModeConfig | null | undefined,
  settings: ModeTimelineSettings
): EffectiveMode | null {
  return buildModeTimeline(config, settings).at(instant);
}

/** The stretches of [from, to) with a mode in effect; the range variant of effectiveModeAt. */
export function effectiveModeSegments(
  from: Date,
  to: Date,
  config: ModeConfig | null | undefined,
  settings: ModeTimelineSettings
): ModeSegment[] {
  return buildModeTimeline(config, settings).segments(from, to);
}

/** What the mode in effect does to one occurrence of one alarm. */
export type ModeEffect =
  | { kind: 'keep' }
  | { kind: 'paused'; mode: ModeRow }
  | { kind: 'shift'; mode: ModeRow; minutes: number }
  | { kind: 'shorten'; mode: ModeRow; durationMin: number };

const KEEP: ModeEffect = { kind: 'keep' };

/**
 * The effect of the mode in effect at `originalMs` (the occurrence's own, unshifted time) on an alarm.
 *  - A prayer or its reminder is never affected: its times come from the prayer settings, not from a rule.
 *  - Skipping applies only to a passable alarm. A non-passable one (medication, the alarm before an exam)
 *    is never paused, whatever the mode's default or a rule says: it is the one thing a mode may not silence.
 *    It may still be shifted or shortened by an explicit rule, which is the person choosing its new time.
 *  - An alarm with no rule follows the mode's default (keep or skip).
 */
export function modeEffectOf(
  event: Pick<EventRow, 'id' | 'kind' | 'passable'>,
  originalMs: number,
  timeline: ModeTimeline
): ModeEffect {
  if (!timeline.active || eventKindOf(event) !== 'normal') return KEEP;
  const effective = timeline.at(originalMs);
  if (effective === null) return KEEP;
  const { mode } = effective;
  const rule = timeline.ruleFor(mode.id, event.id);
  const behavior = rule?.behavior ?? mode.default_behavior;
  switch (behavior) {
    case 'skip':
      return isEventPassable(event) ? { kind: 'paused', mode } : KEEP;
    case 'shift': {
      const minutes = rule?.shift_minutes ?? 0;
      if (!Number.isFinite(minutes) || minutes === 0) return KEEP;
      const clamped = Math.max(-MAX_SHIFT_MINUTES, Math.min(MAX_SHIFT_MINUTES, Math.trunc(minutes)));
      // An alarm is never shifted to before the mode took effect: it would ring (or have rung) at a time the
      // person was not yet under the mode, or be skipped as already past. A manual switch made just before a
      // medication alarm with a -60 shift must still ring it, at its own time.
      if (originalMs + clamped * 60_000 < effective.window.startMs) return KEEP;
      return { kind: 'shift', mode, minutes: clamped };
    }
    case 'shorten': {
      const durationMin = rule?.duration_min ?? 0;
      return durationMin >= 1 ? { kind: 'shorten', mode, durationMin: Math.trunc(durationMin) } : KEEP;
    }
    case 'keep':
      return KEEP;
  }
}

/** One occurrence after the modes were applied. */
export interface ModedInstant {
  /** When the recurrence rule says it falls: what the mode was chosen by, and what a completion may be keyed by. */
  original: Date;
  /** When it rings: `original` moved by a shift. Equal to `original` otherwise. */
  at: Date;
  /** Skipped by the mode: it must not ring and is not scored. */
  paused: boolean;
  /** Calendar block length under a shorten rule; null = the alarm's own. */
  durationMin: number | null;
  /** The mode that paused, shifted or shortened it; null when nothing changed. */
  mode: ModeRow | null;
}

/**
 * Applies the modes to the occurrences a recurrence (or the exam planner) produced for one alarm. Ascending
 * by `at`, one entry per ring instant (a shifted occurrence that lands on another one keeps one of them, and a
 * live one beats a paused one), paused ones included and flagged. Without any mode, or for a prayer, it is
 * the input unchanged. A shift can move an occurrence up to 12 hours, so a caller that wants "what rings in
 * [a, b)" must ask the recurrence for [a - MAX_SHIFT_MS, b + MAX_SHIFT_MS) and filter on `at`.
 */
export function applyModesToInstants(
  event: Pick<EventRow, 'id' | 'kind' | 'passable'>,
  instants: readonly Date[],
  timeline: ModeTimeline
): ModedInstant[] {
  if (!timeline.active || eventKindOf(event) !== 'normal') {
    return instants.map((original) => ({ original, at: original, paused: false, durationMin: null, mode: null }));
  }
  const byAt = new Map<number, ModedInstant>();
  for (const original of instants) {
    const effect = modeEffectOf(event, original.getTime(), timeline);
    const moded: ModedInstant = {
      original,
      at: effect.kind === 'shift' ? new Date(original.getTime() + effect.minutes * 60_000) : original,
      paused: effect.kind === 'paused',
      durationMin: effect.kind === 'shorten' ? effect.durationMin : null,
      mode: effect.kind === 'keep' ? null : effect.mode,
    };
    const key = moded.at.getTime();
    const existing = byAt.get(key);
    if (existing === undefined || (existing.paused && !moded.paused)) byAt.set(key, moded);
  }
  return [...byAt.values()].sort((a, b) => a.at.getTime() - b.at.getTime());
}
