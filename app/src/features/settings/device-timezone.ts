import { assertValidTimeZone } from '@alarm-calendar/core';

/**
 * New accounts start on the database default 'UTC'. The device zone is adopted only while the
 * wallet has never been anchored: after the first sync_wallet, a 'UTC' setting is a choice,
 * not a default, and must not be overwritten. Adoption happens before the first sync so the
 * wallet anchors in the zone the person really lives in.
 */
export function shouldAdoptDeviceTimeZone(
  settingsTimeZone: string,
  deviceTimeZone: string | null,
  walletAnchored: boolean
): boolean {
  if (walletAnchored) return false;
  if (settingsTimeZone !== 'UTC') return false;
  if (deviceTimeZone === null || deviceTimeZone === 'UTC') return false;
  try {
    assertValidTimeZone(deviceTimeZone);
    return true;
  } catch {
    return false;
  }
}
