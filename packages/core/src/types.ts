export type RepeatUnit = 'none' | 'hour' | 'day' | 'week' | 'month' | 'year';

export type CompletionStatus = 'done' | 'skipped_cheat';

/**
 * What an events row is. A 'prayer' row is one of the five daily prayers, a 'pre_prayer' row is the
 * reminder before it; both take their times from the prayer settings, not from start_at or the repeat
 * columns (roadmap v2, phase 3b). Everything else is a 'normal' alarm.
 */
export type EventKind = 'normal' | 'prayer' | 'pre_prayer';

export type PrayerName = 'fajr' | 'dhuhr' | 'asr' | 'maghrib' | 'isha';

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
  /**
   * Links the alarms a template created together (a birthday's prep and wish alarms share one id).
   * Null or absent for a plain alarm. Optional so rows from before the column existed, and test
   * fixtures, stay valid.
   */
  group_id?: string | null;
  /** Absent means 'normal' (rows from before the column existed, and test fixtures). */
  kind?: EventKind;
  /** Which prayer a 'prayer' or 'pre_prayer' row is for; null or absent for a normal alarm. */
  prayer?: PrayerName | null;
  /**
   * When the alarm was created, set by the database and never changed. Habit scoring starts no
   * earlier than this. Optional so rows from before the column existed, and test fixtures, stay valid.
   */
  created_at?: string;
  /** The exam this alarm belongs to (its own alarm or a revision session); null or absent for any other alarm. */
  exam_id?: string | null;
  /** What it is for its exam: 'exam' (the alarm before the exam itself) or 'session' (a revision session). */
  exam_role?: ExamRole | null;
  /** For a catch-up session: the id of the missed session it replaces. At most one catch-up per missed session. */
  catch_up_of?: string | null;
  /**
   * Whether the calendar draws this alarm. False hides it from Week, Month and Agenda (a "Show hidden" toggle
   * reveals it); it still rings and still counts in habit scores. Absent means true (rows from before the
   * column existed, and test fixtures). Ignored for the five prayers, which follow
   * `PrayerSettings.show_prayers_in_calendar`.
   */
  show_in_calendar?: boolean;
}

/** The two kinds of alarm an exam owns (roadmap v2, phase 4). Both are one-off 'normal' events. */
export type ExamRole = 'exam' | 'session';

/** 1 easy, 2 normal, 3 hard (hard exams get one more, earlier, revision session). */
export type ExamDifficulty = 1 | 2 | 3;

/** An exam. Its alarms are events rows linked by events.exam_id. */
export interface ExamRow {
  id: string;
  user_id: string;
  title: string;
  /** When the exam starts, ISO 8601. */
  exam_at: string;
  difficulty: ExamDifficulty;
  notes: string | null;
  /** Delete = false, like events. */
  active: boolean;
  created_at: string;
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

/**
 * The prayer-time columns of settings (migration prayer_times). Defaults are Ariana, Tunis with the
 * Tunisian convention; see DEFAULT_PRAYER_SETTINGS in prayer-times.ts.
 */
export interface PrayerSettings {
  prayers_enabled: boolean;
  /** ISO 8601; prayers before it are not scored and not reminded about. Null until first switched on. */
  prayers_enabled_since: string | null;
  /** Degrees north, -65 to 65 (prayer times are not a simple calculation near the poles). */
  latitude: number;
  /** Degrees east, -180 to 180. */
  longitude: number;
  location_label: string;
  /** Sun angle below the horizon at Fajr, degrees. */
  fajr_angle: number;
  /** Sun angle below the horizon at Isha, degrees. */
  isha_angle: number;
  /** Asr shadow factor: 1 (Shafi, Maliki, Hanbali) or 2 (Hanafi). */
  asr_factor: 1 | 2;
  /** Minutes added to each computed time, -60 to 60. */
  fajr_offset_min: number;
  dhuhr_offset_min: number;
  asr_offset_min: number;
  maghrib_offset_min: number;
  isha_offset_min: number;
  /** Minutes before each prayer for its pre-prayer alarm; 0 turns them off. */
  pre_prayer_minutes: number;
  /** Snooze rules of the prayer and pre-prayer alarms; 0 snoozes by default. */
  prayer_max_snoozes: number;
  prayer_snooze_minutes: number;
  /**
   * Whether the five prayers are drawn on the calendar (they ring either way). Default false: the salat
   * alarm is a given and does not need the space. The pre-prayer reminders are never drawn.
   */
  show_prayers_in_calendar: boolean;
}

/** The mode column of settings (migration modes). Absent means DEFAULT_EXAM_MODE_DAYS_BEFORE in modes.ts. */
export interface ModeSettings {
  /** Days before an exam that Exam mode switches itself on (it ends the day after the exam); 0 turns that off. 0 to 60. */
  exam_mode_days_before: number;
}

/**
 * Optional prayer fields: the database always has them, but a cache or a push from before the
 * feature, and most test fixtures, do not. Absent means "prayers off" to the occurrence rules.
 */
export interface Settings extends Partial<PrayerSettings>, Partial<ModeSettings> {
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
  /**
   * Sound of the prayer alarms (a bundled id, or 'custom' for the file the user chose on this
   * device), also per device. Absent means the prayer alarms use `sound`.
   */
  prayerSound?: string;
}

/**
 * One concrete ring, ready for an engine to schedule. Deliberately thin: what is the same for every
 * ring of an alarm (text, snooze rules, sound) lives once per event in `SchedulePayload.eventInfo`,
 * so a 60 day list of a daily alarm repeats nothing. An engine needs no recurrence, cheat day, mode
 * or prayer logic to use it.
 */
export interface ScheduleOccurrence {
  /** `${eventId}@${at}`, the same id the alarm screen and the completion upsert use. */
  id: string;
  eventId: string;
  /** Instant of the ring, ISO 8601 UTC with milliseconds ('...T09:01:00.000Z'). */
  at: string;
  /** A cheat day covers this occurrence (passable events only). A silenced occurrence never rings. */
  silenced: boolean;
  /** A completion is known for it (any device). A completed occurrence never rings. */
  completed: boolean;
  /**
   * Only for an occurrence a mode shifted: when it would have rung without the shift (ISO, at most 12 hours
   * from `at`). A completion recorded at that instant counts for it too.
   */
  originalAt?: string;
  /**
   * Text to show instead of the event's title, for an occurrence whose text depends on state when
   * the list was built (a pre-prayer alarm: "Asr in 15 min", or "You haven't logged Dhuhr ...").
   */
  label?: string;
  /**
   * Text to show instead of `label` if, when this rings, the occurrence `id` is not completed. Present on
   * every pre-prayer alarm whose previous prayer is not known to be completed when the list is built,
   * past or still to come: the engine decides at ring time, so the list needs no rebuild when that
   * prayer passes unlogged or is logged. For a prayer, "completed" matches by event and prayer-day
   * (prayerDayKey), not by exact instant.
   */
  labelIfUnlogged?: { id: string; label: string };
}

/** What an engine needs to show and snooze every occurrence of one event. */
export interface ScheduleEventInfo {
  title: string;
  notes: string | null;
  /** 0 means no snooze button at all. */
  maxSnoozes: number;
  snoozeMinutes: number;
  /** Id of the bundled alarm sound to loop ('custom' for the user's own file), or null for the platform default. */
  soundId: string | null;
  /** Set for a prayer or pre-prayer alarm; absent for a normal one. */
  kind?: EventKind;
  prayer?: PrayerName;
}

/**
 * The precomputed schedule an engine consumes (AlarmAdapter.setSchedule). The list is complete for
 * every active event from `generatedAt` minus the grace window up to `horizonEnd`, inclusive; before
 * `generatedAt` it holds only the latest occurrence per event (the one a missed-while-asleep ring
 * would be about).
 */
export interface SchedulePayload {
  version: 2;
  /** When the list was computed, ISO 8601 UTC. */
  generatedAt: string;
  /**
   * The list is complete up to here. Normally generatedAt plus the horizon (60 days); earlier when
   * the list hit a size cap, so an engine never assumes silence where occurrences were cut. Never
   * earlier than generatedAt.
   */
  horizonEnd: string;
  /** True when a size cap shortened the horizon. */
  truncated: boolean;
  /** Timezone, grace and re-fire rules the engine still needs; the sound rides along as before. */
  settings: AlarmSettings;
  /** Ascending by `at`, then event id, no duplicate ids. */
  occurrences: ScheduleOccurrence[];
  /**
   * Per active event, including ones with no occurrence in the window (so the keys are the active
   * event ids). An engine dismisses a ringing or snoozed alarm only when its event is missing here
   * (deleted or switched off), and reads title, snooze rules and sound from here.
   */
  eventInfo: Record<string, ScheduleEventInfo>;
  /**
   * The inputs the list was computed from. Only the Electron main process reads this, to extend
   * the list on its own while the app window is closed; other engines ignore it.
   */
  refillSource: {
    events: EventRow[];
    cheatDays: string[];
    /**
     * The modes the list was computed with, so main's own refill applies them too. Absent in a push from
     * before modes, and when the person has none.
     */
    modes?: ModeConfig;
  };
}

/** The schedule push before the precomputed list: the engine received the raw events. */
export interface LegacySchedulePayload {
  events: EventRow[];
  cheatDays: string[];
  settings: AlarmSettings;
  completions: CompletionRow[];
}

export interface AlarmAdapter {
  /**
   * Replaces the device's schedule with a precomputed one (see expandSchedule in core). Whatever
   * completions the device knew about are already folded into `completed`, so an occurrence that is
   * done on any device does not ring again when the device wakes inside the grace window.
   */
  setSchedule(payload: SchedulePayload): Promise<void>;
  /** Completions made while the app was closed or offline. */
  drainCompletions(): Promise<CompletionRow[]>;
  /**
   * Occurrence ids (`<event id>@<instant>`) the person marked Done on this device that have not reached
   * the server yet. The app checks it before treating a revision session as missed. Empty where the app
   * itself writes completions straight away (the browser and, for now, Android).
   */
  getPendingDoneOccurrences(): Promise<string[]>;
  getPermissionStatus(): Promise<PermissionStatus>;
  openPermissionSettings(): Promise<void>;
}

/** The four built-in modes; Normal is the absence of a mode, not a row. */
export type BuiltinModeKey = 'exam' | 'ramadan' | 'vacation' | 'sick';

/**
 * What a mode does to one alarm: keep it, skip it (paused: it never rings and is not scored), shift it
 * (rings `shift_minutes` later, negative = earlier) or shorten it (a shorter calendar block; it still rings).
 */
export type ModeBehavior = 'keep' | 'skip' | 'shift' | 'shorten';

/** A mode (roadmap v2, phase 5). The built-ins are found by `builtin_key`, never by name. */
export interface ModeRow {
  id: string;
  user_id: string;
  name: string;
  kind: 'builtin' | 'custom';
  /** Set exactly for the built-ins. */
  builtin_key: BuiltinModeKey | null;
  /** What an alarm with no rule does while the mode is in effect. A non-passable alarm is never skipped. */
  default_behavior: 'keep' | 'skip';
  /** Off = the mode never takes effect. The app's "delete" for a custom mode. */
  active: boolean;
  created_at?: string;
  updated_at?: string;
}

/** One alarm's behavior under one mode; at most one per (mode, alarm). */
export interface ModeRuleRow {
  id: string;
  user_id: string;
  mode_id: string;
  event_id: string;
  behavior: ModeBehavior;
  /** Minutes, -720 to 720; set exactly when `behavior` is 'shift'. */
  shift_minutes: number | null;
  /** Calendar block length in minutes, 1 to 1440; set exactly when `behavior` is 'shorten'. */
  duration_min: number | null;
  updated_at?: string;
}

/** 'manual' is the header switch (open-ended unless given an end), 'range' a planned start and end. */
export type ModeActivationSource = 'manual' | 'range';

/** When a mode is in effect. Exam mode's automatic window before an exam is derived, not stored (see modes.ts). */
export interface ModeActivationRow {
  id: string;
  user_id: string;
  mode_id: string;
  starts_at: string;
  /** Null = open-ended, until switched back; only a manual activation may be. */
  ends_at: string | null;
  source: ModeActivationSource;
  updated_at?: string;
}

/**
 * Everything the mode rules read: the modes, their per-alarm rules, when they were switched on or planned,
 * and the exams that drive Exam mode's automatic window. The exams are only the three fields the window
 * needs. Applied by buildModeTimeline in modes.ts.
 */
export interface ModeConfig {
  modes: readonly ModeRow[];
  rules: readonly ModeRuleRow[];
  activations: readonly ModeActivationRow[];
  exams: ReadonlyArray<Pick<ExamRow, 'id' | 'exam_at' | 'active'>>;
}
