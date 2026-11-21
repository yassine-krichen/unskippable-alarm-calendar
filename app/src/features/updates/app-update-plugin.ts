import { registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';

/** The error codes AppUpdatePlugin.kt rejects with. */
export type AppUpdateErrorCode =
  | 'BAD_ARGUMENT'
  | 'URL_REFUSED'
  | 'BUSY'
  | 'TOO_LARGE'
  | 'NETWORK'
  | 'HASH_MISMATCH'
  | 'BAD_PACKAGE'
  | 'ALARM_ACTIVE'
  | 'INSTALL_NOT_ALLOWED'
  | 'NOT_DOWNLOADED'
  | 'INSTALLER';

export interface UpdateProgress {
  received: number;
  /** 0 when the server did not say how large the file is. */
  total: number;
}

/** The JSON contract of the local Kotlin plugin (android/.../update/AppUpdatePlugin.kt). */
export interface AppUpdatePlugin {
  download(options: { url: string; sha256: string; versionName: string }): Promise<{ versionName: string; sizeBytes: number }>;
  /** Whether a verified copy of this update is still cached (hash, package, signer, version all re-checked). */
  downloaded(options: { versionName: string; sha256: string }): Promise<{ downloaded: boolean; sizeBytes: number }>;
  canInstall(): Promise<{ allowed: boolean }>;
  openInstallPermission(): Promise<void>;
  install(options: { versionName: string }): Promise<{ started: boolean }>;
  addListener(eventName: 'updateProgress', listener: (progress: UpdateProgress) => void): Promise<PluginListenerHandle>;
}

/** Only call it inside the Android app: there is no web implementation, so any call rejects elsewhere. */
export const AppUpdate = registerPlugin<AppUpdatePlugin>('AppUpdate');
