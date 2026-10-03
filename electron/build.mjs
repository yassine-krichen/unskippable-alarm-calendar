// Bundles the main process, preload and the temporary alarm page into dist/.
// esbuild is what lets @alarm-calendar/core (exported as TS source) run in
// Electron without a separate compile step for the workspace package.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const common = { bundle: true, sourcemap: true, logLevel: 'info' };

await Promise.all([
  build({
    ...common,
    entryPoints: [join(root, 'src/main.ts')],
    outfile: join(dist, 'main.cjs'),
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
  }),
  // The sandboxed preload can only require 'electron', so everything else is bundled in.
  build({
    ...common,
    entryPoints: [join(root, 'src/preload.ts')],
    outfile: join(dist, 'preload.cjs'),
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
  }),
  build({
    ...common,
    entryPoints: [join(root, 'src/renderer/alarm.ts')],
    outfile: join(dist, 'alarm.js'),
    platform: 'browser',
    format: 'iife',
    target: 'chrome130',
  }),
]);

for (const [from, to] of [
  ['src/renderer/alarm.html', 'alarm.html'],
  ['src/renderer/alarm.css', 'alarm.css'],
  ['src/renderer/main-window.html', 'main-window.html'],
  ['assets/alarm.wav', 'alarm.wav'],
  ['assets/tray.png', 'tray.png'],
]) {
  cpSync(join(root, from), join(dist, to));
}
