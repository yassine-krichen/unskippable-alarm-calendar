import type { ModeRow, ModeTimeline, ModeWindowSource } from '@alarm-calendar/core';

import { addDays, formatDay, formatTimeInZone, startOfZonedDay, zonedDate } from '@/lib/zoned-time';

/** What is in effect right now, as plain facts; `modeDetailLine` turns them into the line under the chip. */
export interface CurrentMode {
  mode: ModeRow;
  source: ModeWindowSource;
  startedAt: Date;
  /** The last local day the mode covers ('yyyy-MM-dd'), or null when it lasts until switched back. */
  lastDay: string | null;
  /** The exam that caused an automatic window, when there is one. */
  examId: string | null;
}

/** The mode in effect at `now`, or null for Normal. */
export function currentMode(timeline: ModeTimeline, now: Date, tz: string): CurrentMode | null {
  const effective = timeline.at(now);
  if (effective === null) return null;
  const { window } = effective;
  return {
    mode: effective.mode,
    source: effective.source,
    startedAt: new Date(window.startMs),
    // A window ends at an exclusive instant; the last day it covers is the day of the instant just before.
    lastDay: Number.isFinite(window.endMs) ? zonedDate(new Date(window.endMs - 1), tz) : null,
    examId: window.source === 'exam' ? window.id : null,
  };
}

/** A mode that is planned but has not started: a range, or an exam's automatic window. */
export interface UpcomingMode {
  mode: ModeRow;
  source: Exclude<ModeWindowSource, 'manual'>;
  startDay: string;
  lastDay: string;
  examId: string | null;
}

/**
 * The next planned modes after `now`, soonest first. A window already running is not listed (it is the
 * current mode, or hidden under a stronger one), and neither is a manual one (a manual switch starts now).
 */
export function upcomingModes(
  timeline: ModeTimeline,
  modes: readonly ModeRow[],
  now: Date,
  tz: string,
  limit = 2
): UpcomingMode[] {
  const byId = new Map(modes.map((mode) => [mode.id, mode]));
  const list: UpcomingMode[] = [];
  for (const window of timeline.windows) {
    const mode = byId.get(window.modeId);
    if (mode === undefined || window.source === 'manual' || window.startMs <= now.getTime() || !Number.isFinite(window.endMs)) continue;
    list.push({
      mode,
      source: window.source,
      startDay: zonedDate(new Date(window.startMs), tz),
      lastDay: zonedDate(new Date(window.endMs - 1), tz),
      examId: window.source === 'exam' ? window.id : null,
    });
  }
  return list.slice(0, limit);
}

function whenText(instant: Date, now: Date, tz: string): string {
  const day = zonedDate(instant, tz);
  return day === zonedDate(now, tz) ? `today at ${formatTimeInZone(instant, tz)}` : `${formatDay(day)} at ${formatTimeInZone(instant, tz)}`;
}

/** The line that explains why a mode is on and when it stops. */
export function modeDetailLine(current: CurrentMode | null, now: Date, tz: string, examTitle?: string): string {
  if (current === null) return 'Every alarm rings as set.';
  const until = current.lastDay === null ? 'until you switch it off' : `until the end of ${formatDay(current.lastDay)}`;
  switch (current.source) {
    case 'manual':
      return `Switched on ${whenText(current.startedAt, now, tz)}, ${until}.`;
    case 'range':
      return `Planned range, ${until}.`;
    case 'exam':
      return `Started automatically for ${examTitle ?? 'your exam'}, ${until}.`;
  }
}

/** The line for a planned mode: "Exam starts Tue, Oct 13, for Maths". */
export function upcomingLine(upcoming: UpcomingMode, examTitle?: string): string {
  const base = `${upcoming.mode.name} starts ${formatDay(upcoming.startDay)}`;
  return upcoming.source === 'exam' ? `${base}, before ${examTitle ?? 'an exam'}` : `${base}, until the end of ${formatDay(upcoming.lastDay)}`;
}

/**
 * The mode that covers most of each local day from `firstDay` up to, not including, `endDay` (both
 * 'yyyy-MM-dd'), for the calendar's subtle "this day is under a mode" marking. A day with no mode is absent.
 * Ties go to the earlier stretch.
 */
export function modesByDay(timeline: ModeTimeline, firstDay: string, endDay: string, tz: string): Map<string, ModeRow> {
  const result = new Map<string, ModeRow>();
  if (!timeline.active) return result;
  const startOf = (day: string): number => startOfZonedDay(day, tz).getTime();
  const segments = timeline.segments(startOf(firstDay), startOf(endDay));
  for (let day = firstDay; day < endDay; day = addDays(day, 1)) {
    const dayStart = startOf(day);
    const dayEnd = startOf(addDays(day, 1));
    let best: { mode: ModeRow; overlap: number } | null = null;
    for (const segment of segments) {
      const overlap = Math.min(segment.endMs, dayEnd) - Math.max(segment.startMs, dayStart);
      if (overlap > 0 && (best === null || overlap > best.overlap)) best = { mode: segment.mode, overlap };
    }
    if (best !== null) result.set(day, best.mode);
  }
  return result;
}

/**
 * The planned mode (a range, else an exam's window) that is in effect at `now` underneath any manual one: what
 * the person goes back to when they switch back to Normal. Null when nothing planned covers now.
 */
export function plannedModeAt(timeline: ModeTimeline, modes: readonly ModeRow[], now: Date): { mode: ModeRow; source: 'range' | 'exam' } | null {
  const byId = new Map(modes.map((mode) => [mode.id, mode]));
  const nowMs = now.getTime();
  let best: { mode: ModeRow; source: 'range' | 'exam'; startMs: number } | null = null;
  for (const window of timeline.windows) {
    if (window.source === 'manual' || window.startMs > nowMs || nowMs >= window.endMs) continue;
    const mode = byId.get(window.modeId);
    if (mode === undefined) continue;
    const stronger = best === null || (window.source === 'range' && best.source === 'exam') || (window.source === best.source && window.startMs >= best.startMs);
    if (stronger) best = { mode, source: window.source, startMs: window.startMs };
  }
  return best === null ? null : { mode: best.mode, source: best.source };
}
