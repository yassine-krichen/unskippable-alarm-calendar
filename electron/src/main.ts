import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { app, dialog, ipcMain, Menu, nativeImage, powerMonitor, session, Tray } from 'electron';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { buildSchedulePayload } from '@alarm-calendar/core';
import type { ChooseCustomSoundResult, CustomSoundData, CustomSoundInfo, ScheduleResult } from '@alarm-calendar/core';

import { AlarmWindows } from './alarm-window';
import { ALARM_CHANNELS, DESKTOP_CHANNELS, parseOccurrenceId } from './alarm-ipc';
import type { ActionResult, AlarmView } from './alarm-ipc';
import {
  alarmPageUrl,
  buildCsp,
  defaultDistDir,
  isAppOrigin,
  registerAppScheme,
  resolveAppLocation,
  serveAppFromDisk,
} from './app-server';
import { SUPABASE_ORIGIN } from './build-env';
import { createCachePersister, emptyCache, loadCache, persistWithRetry } from './cache';
import type { CacheData } from './cache';
import { CompletionFlusher } from './completion-flusher';
import { CUSTOM_SOUND_EXTENSIONS, CustomSoundStore } from './custom-sound';
import { resolveConfig, resolveUserDataDir, START_HIDDEN_ARG } from './config';
import { buildDevSeed } from './dev-seed';
import {
  parseBoolean,
  parseNoArguments,
  parseOccurrenceIdList,
  parseSchedulePayload,
  parseSessionPayload,
  upgradeLegacyPayload,
} from './desktop-payloads';
import { createLogger } from './logger';
import { MainWindow } from './main-window';
import { AlarmScheduler, realTimers } from './scheduler';
import { SupabaseCompletionSink } from './supabase-sink';

const config = resolveConfig(process.env, app.isPackaged, process.argv);
const appLocation = resolveAppLocation(config.appUrl);
// Before app ready, as Electron requires for privileged schemes.
registerAppScheme();

// Retry cadence for completions that could not be sent (offline, expired token).
const COMPLETION_FLUSH_INTERVAL_MS = 60_000;

// Explicit userData so the scoped package name never becomes a folder name, and so dev and
// seeded test runs never touch real data. The single-instance lock below is keyed by this
// folder, so a seeded run (own folder, no real alarms) can run beside the daily dev app.
app.setName('Alarm Calendar');
app.setPath('userData', resolveUserDataDir(process.env, app.isPackaged, app.getPath('appData')));

const log = createLogger(join(app.getPath('userData'), 'main.log'));

let isQuitting = false;
// True while any alarm is ringing or snoozed; Quit is refused until they are finished.
let quitBlocked = false;
// Set when Windows is ending the session (shutdown/logoff); never block that.
let sessionEnding = false;
// Module-level so the tray icon is not garbage collected (it would vanish).
let tray: Tray | null = null;

// In dev the OS login items are left alone unless ALARM_AUTOSTART says otherwise;
// the Settings toggle then only flips an in-memory flag.
const canPersistAutostart = app.isPackaged || config.autostartForced;
let devAutostart = false;

function readAutostart(): boolean {
  if (!canPersistAutostart) return devAutostart;
  return app.getLoginItemSettings({ args: [START_HIDDEN_ARG] }).openAtLogin;
}

function writeAutostart(enabled: boolean): void {
  if (!canPersistAutostart) {
    devAutostart = enabled;
    log('autostart.dev_flag_only', { openAtLogin: enabled });
    return;
  }
  // --hidden: an autostarted app sits in the tray, it does not open a window at login.
  app.setLoginItemSettings({ openAtLogin: enabled, args: [START_HIDDEN_ARG] });
  log('autostart.applied', { openAtLogin: enabled });
}

/**
 * Install-time default (on when packaged). Applied once, after that the OS
 * entry belongs to the user (the Settings toggle); an explicit ALARM_AUTOSTART
 * always wins.
 */
function applyAutostartDefault(cache: CacheData, persist: () => void): void {
  if (!canPersistAutostart) return;
  if (!config.autostartForced && cache.autostartInitialized) return;
  writeAutostart(config.autostart);
  cache.autostartInitialized = true;
  persist();
}

function safeOrigin(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return 'invalid';
  }
}

function hardenWebContents(): void {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);
  app.on('web-contents-created', (_event, contents) => {
    // The only navigation allowed is within the app's own origin (hash routing does not
    // navigate at all); extra windows and webviews are never created.
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const guard = (event: { preventDefault(): void }, url: string): void => {
      if (isAppOrigin(url, appLocation)) return;
      event.preventDefault();
      log('navigation.blocked', { origin: safeOrigin(url) });
    };
    contents.on('will-navigate', (event, url) => guard(event, url));
    contents.on('will-redirect', (event, url) => guard(event, url));
    contents.on('will-attach-webview', (event) => event.preventDefault());
    if (appLocation.dev) {
      // Dev only: surface renderer warnings and errors in main.log, where the alarm
      // window (full screen, no devtools) is otherwise opaque.
      contents.on('console-message', (event) => {
        if (event.level === 'warning' || event.level === 'error') {
          log('renderer.console', { level: event.level, message: event.message.slice(0, 300) });
        }
      });
    }
  });
}

/** Serves the built app, or in dev attaches the CSP to the Vite server's responses. */
function serveApp(): void {
  const csp = buildCsp(SUPABASE_ORIGIN, appLocation);
  if (appLocation.dev) {
    session.defaultSession.webRequest.onHeadersReceived(
      { urls: [`${appLocation.origin}/*`] },
      (details, callback) => {
        callback({
          responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] },
        });
      }
    );
    log('app.dev_server', { origin: appLocation.origin });
    return;
  }
  const distDir = config.appDist ?? defaultDistDir(__dirname, app.isPackaged);
  if (!existsSync(join(distDir, 'index.html'))) {
    log('app.dist_missing', { distDir });
  }
  serveAppFromDisk(distDir, csp);
  log('app.serving_dist', { distDir });
}

function startAlarmEngine(): void {
  log('app.user_data', { dir: app.getPath('userData') });
  const cachePath = join(app.getPath('userData'), 'cache.json');
  const cache = loadCache(cachePath, log);
  // The persister rewrites the big schedule file only after a push or a refill; every ring, snooze
  // and Done writes just the small state file.
  const savePersisted = createCachePersister(cachePath);
  const persist = (data: CacheData): void => {
    persistWithRetry(() => savePersisted(data), log);
  };

  const distDir = __dirname;

  const mainWindow = new MainWindow({
    location: appLocation,
    preloadPath: join(distDir, 'main-preload.cjs'),
    isQuitting: () => isQuitting,
    log,
  });

  // The scheduler and the windows reference each other; neither is called
  // before both exist.
  let scheduler: AlarmScheduler;
  const alarmWindows = new AlarmWindows({
    preloadPath: join(distDir, 'alarm-preload.cjs'),
    pageUrlFor: (occurrenceId) => alarmPageUrl(appLocation, occurrenceId),
    onClosed: (occurrenceId) => scheduler.windowClosed(occurrenceId),
    log,
  });
  scheduler = new AlarmScheduler({
    cache,
    persist,
    now: () => new Date(),
    timers: realTimers,
    newId: randomUUID,
    onRing: (view: AlarmView) => alarmWindows.show(view),
    onDismiss: (occurrenceId) => alarmWindows.close(occurrenceId),
    afterEvaluate: () => {
      alarmWindows.ensureVisible();
      refreshTrayMenu(scheduler.hasActiveOccurrences());
    },
    log,
  });
  const flusher = new CompletionFlusher({
    cache,
    persist,
    sink: new SupabaseCompletionSink(),
    now: () => new Date(),
    onFlushed: (row) => scheduler.markCompleted(row),
    log,
  });

  // The user's own prayer sound lives in main's data folder; renderers only ever ask main for its bytes.
  const customSound = new CustomSoundStore(join(app.getPath('userData'), 'custom-sound'));

  registerAlarmIpc(scheduler, alarmWindows, flusher, customSound);
  registerDesktopIpc(scheduler, flusher, mainWindow, customSound);
  app.on('second-instance', () => mainWindow.open());
  setInterval(() => {
    if (flusher.hasPending()) void flusher.flush();
  }, COMPLETION_FLUSH_INTERVAL_MS);
  createTray(mainWindow);
  watchPowerEvents(scheduler);

  if (config.devSeed && config.devSeedReset) {
    // Full reset, in place because the scheduler holds this object.
    Object.assign(cache, emptyCache());
    log('dev_seed.reset');
  }
  // Start first so a ringing state recovered after a crash is picked up before
  // any schedule change touches it.
  scheduler.start();
  if (config.devSeed && cache.events.length === 0) {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const seed = buildDevSeed(new Date(), timeZone, config.devCheatDay);
    scheduler.setSchedule(
      buildSchedulePayload({
        events: seed.events,
        cheatDays: seed.cheatDays,
        settings: seed.settings,
        completions: [],
        now: new Date(),
      })
    );
    log('dev_seed.applied', {
      events: seed.events.map((event) => ({ title: event.title, startAt: event.start_at })),
      cheatDays: seed.cheatDays,
    });
  }
  log('scheduler.started', { events: cache.events.length });

  applyAutostartDefault(cache, () => persist(cache));
  // The window exists from launch so the app can sync from Supabase in the background;
  // an autostarted launch stays in the tray.
  mainWindow.warm();
  if (!config.startHidden) mainWindow.open();
}

function registerAlarmIpc(
  scheduler: AlarmScheduler,
  alarmWindows: AlarmWindows,
  flusher: CompletionFlusher,
  customSound: CustomSoundStore
): void {
  /**
   * A renderer may only act on the occurrence its own window was opened for,
   * from its top frame on the app origin. Anything else (bad shape, other
   * window) is refused.
   */
  const authorize = (event: IpcMainInvokeEvent, payload: unknown): string | null => {
    if (parseOccurrenceId(payload) === null) return null;
    if (event.senderFrame === null || event.senderFrame !== event.sender.mainFrame) return null;
    if (!isAppOrigin(event.senderFrame.url, appLocation)) return null;
    return alarmWindows.occurrenceOwnedBy(event.sender.id) === payload ? (payload as string) : null;
  };

  ipcMain.handle(ALARM_CHANNELS.get, (event, payload: unknown): AlarmView | null => {
    const occurrenceId = authorize(event, payload);
    if (occurrenceId === null) return null;
    const view = scheduler.getAlarm(occurrenceId);
    // A window with nothing to show would be stuck full-screen; close it.
    if (view === null) alarmWindows.close(occurrenceId);
    return view;
  });

  ipcMain.handle(ALARM_CHANNELS.done, (event, payload: unknown): ActionResult => {
    const occurrenceId = authorize(event, payload);
    if (occurrenceId === null) return { ok: false };
    const ok = scheduler.done(occurrenceId);
    if (ok) {
      alarmWindows.close(occurrenceId);
      // Send it now when we can; otherwise the periodic flush and the next session push retry.
      void flusher.flush();
    }
    return { ok };
  });

  ipcMain.handle(ALARM_CHANNELS.snooze, (event, payload: unknown): ActionResult => {
    const occurrenceId = authorize(event, payload);
    if (occurrenceId === null) return { ok: false };
    const ok = scheduler.snooze(occurrenceId);
    if (ok) alarmWindows.close(occurrenceId);
    return { ok };
  });

  // Only a window that is ringing an occurrence may ask, and it gets the sound file's bytes, nothing else.
  ipcMain.handle(ALARM_CHANNELS.customSound, (event, payload: unknown): CustomSoundData | null => {
    if (authorize(event, payload) === null) return null;
    const sound = customSound.read();
    log('alarm.custom_sound_requested', { served: sound !== null, bytes: sound?.data.length ?? 0 });
    return sound;
  });
}

/** Handlers for the React app window: schedule, session, autostart. Every payload is validated. */
function registerDesktopIpc(
  scheduler: AlarmScheduler,
  flusher: CompletionFlusher,
  mainWindow: MainWindow,
  customSound: CustomSoundStore
): void {
  const requireTrusted = (event: IpcMainInvokeEvent): void => {
    if (!mainWindow.isTrustedSender(event)) throw new Error('forbidden');
  };

  ipcMain.handle(DESKTOP_CHANNELS.setSchedule, (event, payload: unknown): ScheduleResult => {
    requireTrusted(event);
    const parsed = parseSchedulePayload(payload);
    if (!parsed.ok) {
      log('desktop.schedule_rejected', { reason: parsed.reason });
      throw new Error('invalid schedule payload');
    }
    // A renderer older than the precomputed schedule still sends raw events: expand them here.
    const schedule =
      parsed.version === 2
        ? parsed.value
        : upgradeLegacyPayload(parsed.value, new Date(), (eventId, error) =>
            log('scheduler.event_failed', { eventId, error: String(error) })
          );
    scheduler.setSchedule(schedule);
    log('desktop.schedule_set', {
      payloadVersion: parsed.version,
      occurrences: schedule.occurrences.length,
      events: schedule.refillSource.events.length,
      cheatDays: schedule.refillSource.cheatDays.length,
      horizonEnd: schedule.horizonEnd,
      truncated: schedule.truncated,
    });
    const { dropped } = parsed;
    if (dropped.occurrences + dropped.events + dropped.cheatDays + dropped.completions > 0) {
      log('desktop.schedule_rows_dropped', { ...dropped });
    }
    return { dropped };
  });

  // Main flushes pending completions itself (see completion-flusher.ts), so there is
  // nothing for the app to upsert; handing rows out here as well would write them twice.
  ipcMain.handle(DESKTOP_CHANNELS.drainCompletions, (event): [] => {
    requireTrusted(event);
    return [];
  });

  // Read-only, main window only, no arguments, ids only: which Done presses the server has not got yet.
  ipcMain.handle(DESKTOP_CHANNELS.pendingDoneOccurrences, (event, ...args: unknown[]): string[] => {
    requireTrusted(event);
    if (!parseNoArguments(args).ok) throw new Error('unexpected arguments');
    const ids = parseOccurrenceIdList(flusher.pendingDoneOccurrenceIds());
    if (!ids.ok) throw new Error('invalid pending ids');
    return ids.value;
  });

  ipcMain.handle(DESKTOP_CHANNELS.setSession, (event, payload: unknown): void => {
    requireTrusted(event);
    const parsed = parseSessionPayload(payload, SUPABASE_ORIGIN);
    if (!parsed.ok) {
      log('desktop.session_rejected', { reason: parsed.reason });
      throw new Error('invalid session payload');
    }
    flusher.setSession(parsed.value);
  });

  ipcMain.handle(DESKTOP_CHANNELS.getAutostart, (event): boolean => {
    requireTrusted(event);
    return readAutostart();
  });

  ipcMain.handle(DESKTOP_CHANNELS.setAutostart, (event, payload: unknown): boolean => {
    requireTrusted(event);
    const parsed = parseBoolean(payload);
    if (!parsed.ok) throw new Error('invalid autostart payload');
    writeAutostart(parsed.value);
    return readAutostart();
  });

  ipcMain.handle(DESKTOP_CHANNELS.getCustomSound, (event): CustomSoundInfo | null => {
    requireTrusted(event);
    return customSound.info();
  });

  // The dialog is opened here, in main: the renderer cannot pick a path, only trigger the dialog.
  ipcMain.handle(DESKTOP_CHANNELS.chooseCustomSound, async (event): Promise<ChooseCustomSoundResult> => {
    requireTrusted(event);
    const options = {
      title: 'Choose a sound for the prayer alarms',
      properties: ['openFile' as const],
      filters: [{ name: 'Audio', extensions: [...CUSTOM_SOUND_EXTENSIONS] }],
    };
    const parent = mainWindow.window();
    const picked = parent === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(parent, options);
    const path = picked.filePaths[0];
    if (picked.canceled || path === undefined) return { status: 'cancelled' };
    const result = customSound.save(path);
    log('custom_sound.chosen', { status: result.status });
    return result;
  });

  ipcMain.handle(DESKTOP_CHANNELS.clearCustomSound, (event): void => {
    requireTrusted(event);
    customSound.clear();
    log('custom_sound.cleared');
  });

  ipcMain.handle(DESKTOP_CHANNELS.readCustomSound, (event): CustomSoundData | null => {
    requireTrusted(event);
    return customSound.read();
  });
}

function buildTrayMenu(mainWindow: MainWindow, blocked: boolean): Menu {
  return Menu.buildFromTemplate([
    { label: 'Open Alarm Calendar', click: () => mainWindow.open() },
    { type: 'separator' },
    // Quitting would silence every alarm, so it is only possible once none is
    // ringing or snoozed.
    {
      label: blocked ? 'Quit (finish alarms first)' : 'Quit',
      enabled: !blocked,
      click: () => app.quit(),
    },
  ]);
}

let rebuildTrayMenu: ((blocked: boolean) => void) | null = null;

/** Rebuilds the tray menu only when the Quit state actually changes. */
function refreshTrayMenu(blocked: boolean): void {
  if (blocked === quitBlocked && rebuildTrayMenu !== null) return;
  quitBlocked = blocked;
  rebuildTrayMenu?.(blocked);
}

function createTray(mainWindow: MainWindow): void {
  const icon = nativeImage.createFromPath(join(__dirname, 'tray.png'));
  if (icon.isEmpty()) log('tray.icon_missing');
  tray = new Tray(icon);
  tray.setToolTip('Alarm Calendar');
  rebuildTrayMenu = (blocked) => {
    tray?.setContextMenu(buildTrayMenu(mainWindow, blocked));
    log('tray.menu_built', { quitBlocked: blocked });
  };
  rebuildTrayMenu(quitBlocked);
  tray.on('click', () => mainWindow.open());
  log('tray.created');
}

function watchPowerEvents(scheduler: AlarmScheduler): void {
  // Timers do not run while asleep, so re-check against the clock on wake-up
  // (the grace window decides whether a missed alarm still rings).
  powerMonitor.on('resume', () => {
    log('power.resume');
    scheduler.evaluate('resume');
  });
  // Not emitted on Windows (see session-end on windows) but cheap and correct elsewhere.
  powerMonitor.on('shutdown', () => {
    sessionEnding = true;
  });
  powerMonitor.on('unlock-screen', () => {
    log('power.unlock_screen');
    scheduler.evaluate('unlock-screen');
  });
}

if (!app.requestSingleInstanceLock()) {
  // Another instance already owns the alarms; two would ring twice.
  app.quit();
} else {
  // Tray app: closing every window must not quit. Only the tray menu does.
  app.on('window-all-closed', () => undefined);
  app.on('before-quit', (event) => {
    // The only intended exits are Quit with no active alarm and the OS ending
    // the session. Anything else would silently drop alarms.
    if (quitBlocked && !sessionEnding) {
      event.preventDefault();
      log('quit.refused_alarm_active');
      return;
    }
    isQuitting = true;
  });
  app.on('browser-window-created', (_event, win: BrowserWindow) => {
    // Windows shutdown/logoff: let it through. The cache is already on disk, so
    // alarms resume on next launch.
    win.on('session-end', () => {
      sessionEnding = true;
    });
  });
  process.on('uncaughtException', (error) => {
    log('process.uncaught_exception', { error: error.stack ?? String(error) });
  });

  void app.whenReady().then(() => {
    hardenWebContents();
    serveApp();
    startAlarmEngine();
  });
}
