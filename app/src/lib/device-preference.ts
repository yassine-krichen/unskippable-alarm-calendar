/** Reads a per-device preference. Storage can be blocked (private windows), so failure means "unset". */
export function readDevicePreference(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Returns false when the browser refused to store the value. */
export function writeDevicePreference(key: string, value: string): boolean {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
