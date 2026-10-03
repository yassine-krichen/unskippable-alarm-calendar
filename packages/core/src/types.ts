export type RepeatUnit = 'none' | 'hour' | 'day' | 'week' | 'month';

export type CompletionStatus = 'done' | 'skipped_cheat';

/**
 * Timestamps are ISO 8601 strings (as Supabase returns them and as they cross
 * the Electron IPC / Capacitor bridge). Calendar days are 'yyyy-MM-dd'.
 */
export interface EventRow {
  id: string;
  user_id: string;
  title: string;
  notes: string | null;
  start_at: string;
  duration_min: number;
  repeat_unit: RepeatUnit;
  repeat_interval: number;
  /** 0 to 6, Monday = 0. Only used when repeat_unit is 'week'; null means the weekday of start_at. */
  repeat_weekdays: number[] | null;
  ends_at: string | null;
  /** 0 means no snooze button at all. */
  max_snoozes: number;
  snooze_minutes: number;
  /** Whether a cheat day silences this event. */
  passable: boolean;
  color: string | null;
  active: boolean;
  updated_at: string;
}

export interface CompletionRow {
  id: string;
  user_id: string;
  event_id: string;
  /** Scheduled time of the occurrence; with event_id it identifies the occurrence. */
  occurrence_at: string;
  status: CompletionStatus;
  snoozes_used: number;
  done_at: string;
}

export interface Settings {
  user_id: string;
  /** IANA zone name. */
  timezone: string;
  /** 0 = Monday (default) through 6 = Sunday, the same indexing as repeat_weekdays. */
  week_starts_on: number;
  refire_seconds: number;
  pass_cap: number;
  grace_minutes: number;
}

export interface PassWallet {
  user_id: string;
  balance: number;
  /** Local start-of-week date of the last weekly grant, 'yyyy-MM-dd'. */
  last_granted_week_start: string;
  /**
   * The wallet's own copy of settings.timezone. All wallet math (week start,
   * grants, "today" for passes) uses this, so editing settings cannot move a
   * pass decision. Adopted from settings by syncWallet only.
   */
  timezone: string;
  /** The wallet's own copy of settings.week_starts_on, same rules as timezone. */
  week_starts_on: number;
  /** When the snapshot was first copied from settings; null until the first sync. */
  anchored_at: string | null;
}

export interface CheatDay {
  id: string;
  user_id: string;
  /** Calendar day in the user's timezone, 'yyyy-MM-dd'. */
  day: string;
  created_at: string;
}

export interface PermissionStatus {
  exactAlarm: boolean;
  fullScreenIntent: boolean;
  notifications: boolean;
  batteryOptimizationExempt: boolean;
}

/**
 * What a device needs beyond the synced settings row to alarm correctly. The
 * sound is a per-device preference (spec section 8), so it is not a settings
 * column and rides along on every schedule push instead.
 */
export interface AlarmSettings extends Settings {
  /** Id of the bundled alarm sound; the platform falls back to its default when absent or unknown. */
  sound?: string;
}

export interface AlarmAdapter {
  /**
   * Replaces the device's cached schedule. `completions` are recent completions
   * synced from Supabase (any device); an occurrence that is already done must
   * not ring again when the device wakes inside the grace window. Optional so a
   * caller with nothing synced yet can omit it.
   */
  setSchedule(
    events: EventRow[],
    cheatDays: string[],
    settings: AlarmSettings,
    completions?: CompletionRow[]
  ): Promise<void>;
  /** Completions made while the app was closed or offline. */
  drainCompletions(): Promise<CompletionRow[]>;
  getPermissionStatus(): Promise<PermissionStatus>;
  openPermissionSettings(): Promise<void>;
}
