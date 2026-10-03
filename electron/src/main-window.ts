import { BrowserWindow } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';

import { isAppOrigin } from './app-server';
import type { AppLocation } from './app-server';
import type { Logger } from './logger';
import { nextRecoveryStep } from './main-window-recovery';

/**
 * The regular app window: the React app. Closing it hides it to the tray; only
 * the tray menu quits (app.quit() fires before-quit, which flips isQuitting).
 * It is created at launch (hidden for an autostart) because the React app is
 * what syncs the schedule from Supabase and hands the session to main.
 */
export class MainWindow {
  private win: BrowserWindow | null = null;
  // Consecutive load failures or renderer crashes; any successful load resets it.
  private failures = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly options: {
      location: AppLocation;
      preloadPath: string;
      isQuitting(): boolean;
      log: Logger;
    }
  ) {}

  /** Creates the window without showing it, so the app can sync in the background. */
  warm(): void {
    this.ensureWindow();
  }

  open(): void {
    const win = this.ensureWindow();
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  /** IPC from the app is accepted only from this window's own top frame, on the app origin. */
  isTrustedSender(event: IpcMainInvokeEvent): boolean {
    const win = this.win;
    if (win === null || win.isDestroyed()) return false;
    return (
      event.sender.id === win.webContents.id &&
      event.senderFrame !== null &&
      event.senderFrame === event.sender.mainFrame &&
      isAppOrigin(event.senderFrame.url, this.options.location)
    );
  }

  private ensureWindow(): BrowserWindow {
    if (this.win === null || this.win.isDestroyed()) this.win = this.create();
    return this.win;
  }

  private create(): BrowserWindow {
    const win = new BrowserWindow({
      width: 1100,
      height: 760,
      show: false,
      title: 'Alarm Calendar',
      backgroundColor: '#000000',
      webPreferences: {
        // Hidden most of the time, yet it must keep syncing, flushing and reacting to realtime.
        backgroundThrottling: false,
        preload: this.options.preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    win.removeMenu();
    win.on('close', (event) => {
      if (this.options.isQuitting()) return;
      event.preventDefault();
      win.hide();
    });
    // A dead renderer or an unloadable page would leave the sync silently stopped while the
    // window is hidden: recover with backoff, and rebuild the window if that keeps failing.
    win.webContents.on('render-process-gone', (_event, details) => {
      this.recover(win, 'render_process_gone', { reason: details.reason });
    });
    win.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      // -3 is a navigation that was superseded, not a failure.
      if (isMainFrame && code !== -3) this.recover(win, 'did_fail_load', { code, description });
    });
    win.webContents.on('did-finish-load', () => {
      this.failures = 0;
    });
    win.on('closed', () => {
      // Not a replacement window's timer: a recreated window may already be retrying.
      if (this.win === win) this.cancelRetry();
    });
    void win.loadURL(this.options.location.url).catch(() => undefined); // did-fail-load handles it
    return win;
  }

  private recover(win: BrowserWindow, cause: string, details: Record<string, unknown>): void {
    // Both events can fire for one failure; one retry at a time.
    if (this.win !== win || this.retryTimer !== null) return;
    this.failures++;
    const step = nextRecoveryStep(this.failures);
    this.options.log('main_window.failed', { cause, ...details, failures: this.failures, ...step });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (win.isDestroyed() || this.win !== win) return;
      if (step.action === 'reload') {
        void win.loadURL(this.options.location.url).catch(() => undefined);
        return;
      }
      const wasVisible = win.isVisible();
      win.destroy();
      this.win = null;
      this.failures = 0;
      this.options.log('main_window.recreated');
      this.warm();
      if (wasVisible) this.open();
    }, step.delayMs);
  }

  private cancelRetry(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }
}
