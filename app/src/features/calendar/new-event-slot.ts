import { zonedParts } from '@/lib/zoned-time';

export interface EventSlot {
  /** 'yyyy-MM-dd' in the settings timezone. */
  date: string;
  /** 'HH:mm' */
  time: string;
}

const DEFAULT_ALL_DAY_TIME = '09:00';

/**
 * The date and time to prefill when someone clicks an empty spot. A timed slot keeps its time.
 * A whole-day cell (month view) has no time, so it gets 09:00, or the next full hour when the
 * cell is today, because an alarm set earlier today would never ring.
 */
export function slotFromClick(click: { instant: Date; allDay: boolean }, tz: string, now: Date): EventSlot {
  const clicked = zonedParts(click.instant, tz);
  if (!click.allDay) return { date: clicked.date, time: clicked.time };

  const today = zonedParts(now, tz);
  if (clicked.date !== today.date) return { date: clicked.date, time: DEFAULT_ALL_DAY_TIME };

  return { date: clicked.date, time: nextFullHour(today.time) };
}

/** The next whole hour after an 'HH:mm' time, capped at 23:59 so it stays on the same day. */
export function nextFullHour(time: string): string {
  const hour = Number(time.slice(0, 2)) + 1;
  return hour > 23 ? '23:59' : `${String(hour).padStart(2, '0')}:00`;
}
