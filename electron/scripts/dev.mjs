// Starts everything for desktop dev: the Vite dev server of the React app (unless
// one already answers on the port) and Electron, which loads it. Electron is
// built first. Only processes this script started are stopped on exit.
//
// Env flags:
//   ALARM_APP_URL          dev server to load (default http://localhost:3021, see root PORTS.md)
//   ALARM_DEV_SEED=1       seed two test alarms (~1 and 1.5 min after launch) into an empty cache
//   ALARM_DEV_SEED_RESET=1 wipe the cache and seed again
//                          (both seed flags use %APPDATA%\alarm-calendar-dev-seed, never the
//                          daily %APPDATA%\alarm-calendar-dev)
//   ALARM_USER_DATA_DIR    explicit data folder for scratch runs (unpackaged only)
//   ALARM_DEV_CHEAT_DAY=1  with the seed, make today a cheat day
//   ALARM_AUTOSTART=1|0    touch the OS login items in dev (off by default)
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import electronPath from 'electron';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const appDir = join(root, '..', 'app');
const appUrl = process.env.ALARM_APP_URL ?? 'http://localhost:3021';
const port = new URL(appUrl).port || '80';

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

async function isUp() {
  try {
    const response = await fetch(appUrl, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

function killTree(child) {
  if (child.exitCode !== null) return;
  // Windows has no process groups; /T takes the whole tree down.
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
}

const env = { ...process.env, ALARM_APP_URL: appUrl };
// Set by some tools that run Electron as plain Node; it would break the app.
delete env.ELECTRON_RUN_AS_NODE;

let vite = null;
if (await isUp()) {
  console.log(`[dev] using the app already running at ${appUrl}`);
} else {
  const viteBin = join(appDir, 'node_modules', 'vite', 'bin', 'vite.js');
  console.log(`[dev] starting Vite on port ${port}`);
  vite = spawn(process.execPath, [viteBin, '--port', port, '--strictPort'], {
    cwd: appDir,
    stdio: 'inherit',
  });
  vite.on('error', (error) => console.error('[dev] Vite failed to start', error));
  const deadline = Date.now() + 60_000;
  while (!(await isUp())) {
    if (vite.exitCode !== null || Date.now() > deadline) {
      console.error('[dev] Vite did not come up');
      if (vite.exitCode === null) killTree(vite);
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

const stopVite = () => {
  if (vite !== null) killTree(vite);
};
process.on('SIGINT', () => {
  stopVite();
  process.exit(130);
});
process.on('exit', stopVite);

const buildCode = await run(process.execPath, [join(root, 'build.mjs')], { cwd: root, env });
if (buildCode !== 0) {
  stopVite();
  process.exit(buildCode);
}

// Extra arguments go to Electron (for example --remote-debugging-port=9333).
const code = await run(electronPath, ['.', ...process.argv.slice(2)], { cwd: root, env });
stopVite();
process.exit(code);
