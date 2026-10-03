import { BrowserWindow, shell } from 'electron';

import type { AlarmView } from './alarm-ipc';
import type { Logger } from './logger';

const REFOCUS_DELAY_MS = 250;

export interface AlarmWindowsOptions {
  preloadPath: string;
  /** URL of the React alarm route for one occurrence. */
  pageUrlFor(occurrenceId: string): string;
  /** A window went away for any reason (closed by the user or by us). */
  onClosed(occurrenceId: string): void;
  log: Logger;
}

/** One full-screen, always-on-top window per ringing occurrence. */
export class AlarmWindows {
  private readonly windows = new Map<string, BrowserWindow>();
  private readonly occurrenceByWebContents = new Map<number, string>();
  // Windows on their way out; the hide that comes with closing must not re-show them.
  private readonly closing = new WeakSet<BrowserWindow>();

  constructor(private readonly options: AlarmWindowsOptions) {}

  show(view: AlarmView): void {
    const existing = this.windows.get(view.occurrenceId);
    if (existing !== undefined && !existing.isDestroyed()) {
      this.bringToFront(existing);
      return;
    }

    const win = new BrowserWindow({
      show: false,
      frame: false,
      fullscreen: true,
      alwaysOnTop: true,
      skipTaskbar: false,
      // Win+D / Win+M / Win+Down must not be a way to hide the alarm.
      minimizable: false,
      maximizable: false,
      resizable: false,
      backgroundColor: '#000000',
      title: 'Alarm',
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        // The looping alarm sound starts without any user gesture.
        autoplayPolicy: 'no-user-gesture-required',
      },
    });
    const webContentsId = win.webContents.id;
    this.windows.set(view.occurrenceId, win);
    this.occurrenceByWebContents.set(webContentsId, view.occurrenceId);

    win.once('ready-to-show', () => this.bringToFront(win));
    win.on('close', () => this.closing.add(win));
    // Hiding or defocusing the alarm without Done/Snooze must not work: put it back.
    win.on('minimize', () => this.bringToFront(win));
    win.on('hide', () => this.bringToFront(win));
    win.on('blur', () => this.refocusSoon(win));
    // A dead or hung page would leave a full-screen window with no buttons.
    // destroy() still emits 'closed', which schedules the re-ring.
    win.webContents.on('render-process-gone', (_event, details) => {
      this.options.log('alarm_window.render_process_gone', { reason: details.reason });
      win.destroy();
    });
    win.on('unresponsive', () => {
      this.options.log('alarm_window.unresponsive');
      win.destroy();
    });
    win.on('closed', () => {
      this.windows.delete(view.occurrenceId);
      this.occurrenceByWebContents.delete(webContentsId);
      this.options.onClosed(view.occurrenceId);
    });

    // A page that failed to load has no buttons and no sound, and a full-screen window with
    // nothing on it is worse than none. Beep, then destroy it: 'closed' schedules the re-ring.
    win.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (!isMainFrame) return;
      this.options.log('alarm_window.load_failed', { code, description });
      shell.beep();
      win.destroy();
    });
    void win.loadURL(this.options.pageUrlFor(view.occurrenceId)).catch((error: unknown) => {
      // did-fail-load above already handled the window; this only keeps the rejection handled.
      this.options.log('alarm_window.load_rejected', { error: String(error) });
    });
    this.options.log('alarm_window.opened', { occurrenceId: view.occurrenceId });
  }

  /** Closes the window of an occurrence; its onClosed callback still fires. */
  close(occurrenceId: string): void {
    const win = this.windows.get(occurrenceId);
    if (win !== undefined && !win.isDestroyed()) win.close();
  }

  /** The occurrence a renderer may act on, looked up by its own webContents. */
  occurrenceOwnedBy(webContentsId: number): string | null {
    return this.occurrenceByWebContents.get(webContentsId) ?? null;
  }

  /**
   * Safety net for the 30 s evaluation: restore any alarm window that got
   * hidden, and make sure one of them has focus. Does not fight over focus
   * between several ringing alarms.
   */
  ensureVisible(): void {
    const open = [...this.windows.values()].filter(
      (win) => !win.isDestroyed() && !this.closing.has(win)
    );
    for (const win of open) {
      if (win.isMinimized() || !win.isVisible()) this.bringToFront(win);
    }
    const first = open[0];
    if (first !== undefined && !open.some((win) => win.isFocused())) this.bringToFront(first);
  }

  private refocusSoon(win: BrowserWindow): void {
    // Debounced, and skipped when another alarm window took focus, so two
    // ringing alarms do not steal focus from each other in a loop.
    setTimeout(() => {
      if (win.isDestroyed() || this.closing.has(win) || win.isFocused()) return;
      const otherFocused = [...this.windows.values()].some(
        (other) => other !== win && !other.isDestroyed() && other.isFocused()
      );
      if (!otherFocused) this.bringToFront(win);
    }, REFOCUS_DELAY_MS);
  }

  private bringToFront(win: BrowserWindow): void {
    if (win.isDestroyed() || this.closing.has(win)) return;
    if (win.isMinimized()) win.restore();
    // 'screen-saver' is the highest level Windows offers to a normal window.
    win.setAlwaysOnTop(true, 'screen-saver');
    win.show();
    win.moveTop();
    win.focus();
    // Flash the taskbar button until the window has focus (no-op once it does).
    win.flashFrame(true);
    win.once('focus', () => {
      if (!win.isDestroyed()) win.flashFrame(false);
    });
  }
}
