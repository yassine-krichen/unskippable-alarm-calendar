import { BrowserWindow } from 'electron';

/**
 * The regular app window. Closing it hides it to the tray; only the tray menu
 * quits (app.quit() fires before-quit, which flips isQuitting).
 */
export class MainWindow {
  private win: BrowserWindow | null = null;

  constructor(
    private readonly options: {
      /** TEMPORARY placeholder page until the React app is wired in (step 5). */
      pagePath: string;
      isQuitting(): boolean;
    }
  ) {}

  open(): void {
    if (this.win === null || this.win.isDestroyed()) {
      this.win = this.create();
    }
    if (this.win.isMinimized()) this.win.restore();
    this.win.show();
    this.win.focus();
  }

  private create(): BrowserWindow {
    const win = new BrowserWindow({
      width: 960,
      height: 640,
      show: false,
      title: 'Alarm Calendar',
      webPreferences: {
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
    void win.loadFile(this.options.pagePath);
    return win;
  }
}
