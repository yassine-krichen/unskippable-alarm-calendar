// Builds, then launches Electron with the dev seed. The seed (two alarms about
// 1 and 1.5 minutes after launch) is only written into an empty dev cache, so
// relaunching keeps ringing/snoozed state. ALARM_DEV_SEED_RESET=1 wipes the dev
// cache and re-seeds; ALARM_DEV_SEED=0 runs without the seed;
// ALARM_DEV_CHEAT_DAY=1 makes today a cheat day.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import electronPath from 'electron';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', env });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

const env = { ...process.env };
// Set by some tools that run Electron as plain Node; it would break the app.
delete env.ELECTRON_RUN_AS_NODE;
env.ALARM_DEV_SEED ??= '1';

const buildCode = await run(process.execPath, [join(root, 'build.mjs')], env);
if (buildCode !== 0) process.exit(buildCode);

process.exit(await run(electronPath, ['.'], env));
