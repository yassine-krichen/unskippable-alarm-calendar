import { loadRecentCompletions } from '@/features/completions/completions-store';
import { loadEvents } from '@/features/events/events-store';
import { loadExamCompletions, loadExams } from '@/features/exams/exams-store';
import { loadHabitCompletions } from '@/features/habits/habits-store';
import { loadModes } from '@/features/modes/modes-store';
import { fetchWalletAnchored } from '@/features/passes/passes-api';
import { loadCheatDays, syncPassWallet } from '@/features/passes/passes-store';
import { shouldAdoptDeviceTimeZone } from '@/features/settings/device-timezone';
import { createMissingSettings, loadSettings, saveSettings } from '@/features/settings/settings-store';
import { detectDeviceTimeZone } from '@/lib/zoned-time';

/**
 * Sign-in bootstrap, in the order the wallet needs. Returns an error message, or null on success.
 * 1. Read settings. A missing row is created with the device zone (plain INSERT).
 * 2. Read pass_wallet.anchored_at. While the wallet has never been anchored and settings still say
 *    the 'UTC' default, write the device zone with UPDATE (never upsert: it would touch pass_cap).
 * 3. sync_wallet, which anchors the wallet in that zone.
 * 4. Load cheat days and events, plus recent completions (best effort: they only stop an already
 *    done occurrence from ringing again, so a failure must not block the app). The modes load with them,
 *    best effort too: without them every alarm rings, which is the safe direction, and the schedule is pushed
 *    again as soon as they arrive. The habit history
 *    for the Stats screen is not part of this: it loads after the app is ready (see
 *    startHabitHistorySync), so it can never delay startup or the alarm schedule push.
 */
export async function bootstrap(userId: string): Promise<string | null> {
  const deviceTimeZone = detectDeviceTimeZone();

  const settingsResult = await loadSettings();
  if (settingsResult.error !== null) return settingsResult.error;

  if (settingsResult.data === null) {
    const created = await createMissingSettings(userId, deviceTimeZone ?? 'UTC');
    if (created.error !== null) return created.error;
  } else {
    const anchored = await fetchWalletAnchored();
    if (anchored.error !== null) return anchored.error;
    if (shouldAdoptDeviceTimeZone(settingsResult.data.timezone, deviceTimeZone, anchored.data) && deviceTimeZone !== null) {
      const saved = await saveSettings(userId, { timezone: deviceTimeZone });
      if (saved.error !== null) return `Could not save your time zone: ${saved.error}`;
    }
  }

  const wallet = await syncPassWallet();
  if (wallet.error !== null) return wallet.error;

  // The exams come with the modes: Exam mode's automatic window is derived from them, and the first schedule
  // push should already know it.
  const [cheatDays, events, completions, modes, exams] = await Promise.all([
    loadCheatDays(),
    loadEvents(),
    loadRecentCompletions(),
    loadModes(),
    loadExams(),
  ]);
  if (completions.error !== null) console.warn('Could not load recent completions:', completions.error);
  if (modes.error !== null) console.warn('Could not load modes:', modes.error);
  if (exams.error !== null) console.warn('Could not load exams:', exams.error);
  return cheatDays.error ?? events.error;
}

/** The session completions are looked up by event id, so they need the events; skipped when those failed. */
async function loadExamCompletionsAfter(eventsError: string | null): Promise<void> {
  if (eventsError !== null) return;
  const result = await loadExamCompletions();
  if (result.error !== null) console.warn('Could not load exam completions:', result.error);
}

/**
 * Window-focus refresh. The loads are independent, so they run in parallel; the wallet sync
 * is included so a weekly grant that landed while away shows up. Returns the failure messages.
 */
export async function refreshAll(): Promise<string[]> {
  const results = await Promise.all([
    loadSettings(),
    syncPassWallet(),
    loadCheatDays(),
    loadEvents(),
    loadRecentCompletions(),
    loadHabitCompletions(),
    loadExams(),
    loadModes(),
  ]);
  const failures = results.flatMap((result) => (result.error === null ? [] : [result.error]));
  // After the events, which say which alarms belong to an exam.
  await loadExamCompletionsAfter(results[3]?.error ?? null);
  return failures;
}
