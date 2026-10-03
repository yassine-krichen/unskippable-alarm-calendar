import { localDateString } from '@alarm-calendar/core';
import type { EventRow, Settings } from '@alarm-calendar/core';

/**
 * Hardcoded events for the step 4 checkpoint, built relative to launch time.
 * Only used when ALARM_DEV_SEED=1; never a shipped default.
 */

const DEV_USER_ID = '00000000-0000-4000-8000-000000000001';
export const DEV_EVENT_WITH_SNOOZES_ID = '00000000-0000-4000-8000-0000000000a1';
export const DEV_EVENT_NO_SNOOZE_ID = '00000000-0000-4000-8000-0000000000a2';

export interface DevSeed {
  events: EventRow[];
  cheatDays: string[];
  settings: Settings;
}

function devEvent(
  overrides: Pick<EventRow, 'id' | 'title' | 'start_at' | 'max_snoozes' | 'passable'>,
  now: Date
): EventRow {
  return {
    user_id: DEV_USER_ID,
    notes: 'Dev seed event',
    duration_min: 15,
    repeat_unit: 'none',
    repeat_interval: 1,
    repeat_weekdays: null,
    ends_at: null,
    snooze_minutes: 1,
    color: null,
    active: true,
    updated_at: now.toISOString(),
    ...overrides,
  };
}

export function buildDevSeed(now: Date, timeZone: string, cheatDayToday: boolean): DevSeed {
  const wholeSecondMs = Math.ceil(now.getTime() / 1000) * 1000;
  const startIn = (seconds: number): string =>
    new Date(wholeSecondMs + seconds * 1000).toISOString();
  return {
    events: [
      devEvent(
        {
          id: DEV_EVENT_WITH_SNOOZES_ID,
          title: 'Dev alarm: 2 snoozes of 1 min',
          start_at: startIn(60),
          max_snoozes: 2,
          passable: true,
        },
        now
      ),
      devEvent(
        {
          id: DEV_EVENT_NO_SNOOZE_ID,
          title: 'Dev alarm: no snooze, do it now',
          start_at: startIn(90),
          max_snoozes: 0,
          passable: false,
        },
        now
      ),
    ],
    cheatDays: cheatDayToday ? [localDateString(now, timeZone)] : [],
    settings: {
      user_id: DEV_USER_ID,
      timezone: timeZone,
      week_starts_on: 0,
      refire_seconds: 20,
      pass_cap: 2,
      grace_minutes: 30,
    },
  };
}
