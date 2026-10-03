import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { app, ipcMain, Menu, nativeImage, powerMonitor, session, Tray } from 'electron';
import type { BrowserWindow } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';

import { AlarmWindows } from './alarm-window';
import { ALARM_CHANNELS, parseOccurrenceId } from './alarm-ipc';
import type { ActionResult, AlarmView } from './alarm-ipc';
import { emptyCache, loadCache, persistWithRetry, saveCache } from './cache';
import { resolveConfig } from './config';
import { buildDevSeed } from './dev-seed';
import { createLogger } from './logger';
import { MainWindow } from './main-window';
import { AlarmScheduler, realTimers } from './scheduler';

const config = resolveConfig(process.env, app.isPackaged);

// Explicit userData so the scoped package name never becomes a folder name,
// and so dev seed runs never touch real data.
app.setName('Alarm Calendar');
app.setPath(
  'userData',
  join(app.getPath('appData'), config.devSeed ? 'alarm-calendar-dev' : 'alarm-calendar')
);

const log = createLogger(join(app.getPath('userData'), 'main.log'));

let isQuitting = false;
// True while any alarm is ringing or snoozed; Quit is refused until they are finished.
let quitBlocked = false;
// Set when Windows is ending the session (shutdown/logoff); never block that.
let sessionEnding = false;
// Module-level so the tray icon is not garbage collected (it would vanish).
let tray: Tray | null = null;

function applyAutostart(): void {
  // In dev with autostart off, do not touch the login items at all: that would
  // write a registry entry pointing at the dev electron.exe.
  if (!config.autostart && !app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: config.autostart });
  log('autostart.applied', { openAtLogin: config.autostart });
}

function hardenWebContents(): void {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);
  app.on('web-contents-created', (_event, contents) => {
    // Alarm and app pages are local files and never navigate or open windows.
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event) => event.preventDefault());
  });
}

function startAlarmEngine(): void {
  const cachePath = join(app.getPath('userData'), 'cache.json');
  const cache = loadCache(cachePath, log);

  const distDir = __dirname;
  const preloadPath = join(distDir, 'preload.cjs');

  const mainWindow = new MainWindow({
    pagePath: join(distDir, 'main-window.html'),
    isQuitting: () => isQuitting,
  });

  // The scheduler and the windows reference each other; neither is called
  // before both exist.
  let scheduler: AlarmScheduler;
  const alarmWindows = new AlarmWindows({
    preloadPath,
    pagePath: join(distDir, 'alarm.html'),
    onClosed: (occurrenceId) => scheduler.windowClosed(occurrenceId),
    log,
  });
  scheduler = new AlarmScheduler({
    cache,
    persist: (data) => {
      persistWithRetry(() => saveCache(cachePath, data), log);
    },
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

  registerAlarmIpc(scheduler, alarmWindows);
  app.on('second-instance', () => mainWindow.open());
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
    scheduler.setSchedule(seed.events, seed.cheatDays, seed.settings);
    log('dev_seed.applied', {
      events: seed.events.map((event) => ({ title: event.title, startAt: event.start_at })),
      cheatDays: seed.cheatDays,
    });
  }
  log('scheduler.started', { events: cache.events.length });
}

function registerAlarmIpc(scheduler: AlarmScheduler, alarmWindows: AlarmWindows): void {
  /**
   * A renderer may only act on the occurrence its own window was opened for,
   * from its top frame. Anything else (bad shape, other window) is refused.
   */
  const authorize = (event: IpcMainInvokeEvent, payload: unknown): string | null => {
    if (parseOccurrenceId(payload) === null) return null;
    if (event.senderFrame === null || event.senderFrame !== event.sender.mainFrame) return null;
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
    if (ok) alarmWindows.close(occurrenceId);
    return { ok };
  });

  ipcMain.handle(ALARM_CHANNELS.snooze, (event, payload: unknown): ActionResult => {
    const occurrenceId = authorize(event, payload);
    if (occurrenceId === null) return { ok: false };
    const ok = scheduler.snooze(occurrenceId);
    if (ok) alarmWindows.close(occurrenceId);
    return { ok };
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
    applyAutostart();
    startAlarmEngine();
  });
}
