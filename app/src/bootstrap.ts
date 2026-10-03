import { loadRecentCompletions } from '@/features/completions/completions-store';
import { loadEvents } from '@/features/events/events-store';
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
 *    done occurrence from ringing again, so a failure must not block the app).
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

  const [cheatDays, events, completions] = await Promise.all([loadCheatDays(), loadEvents(), loadRecentCompletions()]);
  if (completions.error !== null) console.warn('Could not load recent completions:', completions.error);
  return cheatDays.error ?? events.error;
}

/**
 * Window-focus refresh. The five loads are independent, so they run in parallel; the wallet sync
 * is included so a weekly grant that landed while away shows up. Returns the failure messages.
 */
export async function refreshAll(): Promise<string[]> {
  const results = await Promise.all([
    loadSettings(),
    syncPassWallet(),
    loadCheatDays(),
    loadEvents(),
    loadRecentCompletions(),
  ]);
  return results.flatMap((result) => (result.error === null ? [] : [result.error]));
}
