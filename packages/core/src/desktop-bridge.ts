import type { CompletionRow, EventKind, SchedulePayload } from './types';

/**
 * Types shared by the Electron main process, its preload scripts and the React
 * app, so the three cannot drift apart. Types only: no runtime code.
 */

/** Everything the alarm screen needs to draw one ringing occurrence. */
export interface AlarmView {
  occurrenceId: string;
  title: string;
  notes: string | null;
  /** ISO 8601 scheduled time of the occurrence. */
  occurrenceAt: string;
  /** Snooze button text, or null when the button must not be shown. */
  snoozeLabel: string | null;
  /** Shown instead of the button when the snooze limit is used up. */
  snoozeNotice: string | null;
  /** Id of the alarm sound to loop (settings payload `sound`), or null for the default. */
  soundId: string | null;
  /** Absent for a normal alarm; the alarm screen says "Prayed" instead of "Done" for a prayer. */
  kind?: EventKind;
}

/** The audio file the user chose for the prayer alarms, as main holds it. */
export interface CustomSoundData {
  /** A media type main checked against the file's bytes: audio/mpeg, audio/wav, audio/ogg or audio/mp4. */
  mime: string;
  data: Uint8Array;
}

/** What the settings screen shows about the chosen file. */
export interface CustomSoundInfo {
  /** The file's original name, for display only. */
  name: string;
  bytes: number;
}

export type ChooseCustomSoundResult =
  | { status: 'chosen'; info: CustomSoundInfo }
  | { status: 'cancelled' }
  /** The file was refused (wrong type, too large, unreadable); `reason` is fit to show the user. */
  | { status: 'rejected'; reason: string };

export interface ActionResult {
  ok: boolean;
}

/** The only surface the preload exposes to the alarm window. */
export interface AlarmApi {
  getAlarm(occurrenceId: string): Promise<AlarmView | null>;
  done(occurrenceId: string): Promise<ActionResult>;
  snooze(occurrenceId: string): Promise<ActionResult>;
  /**
   * The user's own prayer sound, for the window of a ringing occurrence only. The renderer never
   * names a file: main reads the one it copied into its own data folder.
   */
  readCustomSound(occurrenceId: string): Promise<CustomSoundData | null>;
}

/** How many rows main refused from one schedule push; all zero when everything was accepted. */
export interface ScheduleDropped {
  occurrences: number;
  events: number;
  cheatDays: number;
  /** Only a push in the old events-based format carries completions. */
  completions: number;
  /** Mode, rule, activation and exam rows refused from the modes in `refillSource`; absent when none was. */
  modeRows?: number;
}

export interface ScheduleResult {
  dropped: ScheduleDropped;
}

/**
 * What the main process needs to flush pending completions as the signed-in
 * user. The refresh token is deliberately absent: only the renderer refreshes
 * the session, so two clients can never race on a rotating refresh token.
 */
export interface DesktopSession {
  /** Supabase project URL; main refuses any origin other than the one built in. */
  url: string;
  /** Publishable key (designed to ship in clients, RLS enforces access). Never a secret key. */
  publishableKey: string;
  userId: string;
  accessToken: string;
  /** Access token expiry, unix seconds. */
  expiresAt: number;
}

/** The only surface the preload exposes to the main (React app) window. */
export interface DesktopApi {
  /** Rejects when the payload as a whole is unusable; otherwise reports rows it had to drop. */
  setSchedule(payload: SchedulePayload): Promise<ScheduleResult>;
  drainCompletions(): Promise<CompletionRow[]>;
  /** Occurrence ids (`<event id>@<instant>`) marked Done on this device that the server has not accepted yet. */
  getPendingDoneOccurrences(): Promise<string[]>;
  /** Null signs out: main forgets the token and stops flushing. */
  setSession(session: DesktopSession | null): Promise<void>;
  getAutostart(): Promise<boolean>;
  setAutostart(enabled: boolean): Promise<boolean>;
  /** The chosen custom prayer sound, or null when there is none. */
  getCustomSound(): Promise<CustomSoundInfo | null>;
  /** Opens the system file dialog in main; the file is checked and copied into main's data folder. */
  chooseCustomSound(): Promise<ChooseCustomSoundResult>;
  clearCustomSound(): Promise<void>;
  /** The chosen file's bytes, for the preview button in Settings. */
  readCustomSound(): Promise<CustomSoundData | null>;
}
