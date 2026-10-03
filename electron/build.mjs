// Bundles the main process and the two preload scripts into dist/. The React app
// (including the alarm screen) is built separately by `pnpm --filter app build`
// and loaded by main; see src/app-server.ts.
// esbuild is what lets @alarm-calendar/core (exported as TS source) run in
// Electron without a separate compile step for the workspace package.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');

/**
 * The Supabase origin the app is built for: the only server main will send the
 * session token to and the only one the CSP allows. Taken from VITE_SUPABASE_URL
 * in the environment, else from that single key in app/.env (the URL is public;
 * nothing else in the file is read or printed).
 */
function supabaseOrigin() {
  let url = process.env.VITE_SUPABASE_URL;
  const envFile = join(root, '..', 'app', '.env');
  if (!url && existsSync(envFile)) {
    const match = /^VITE_SUPABASE_URL=(.*)$/m.exec(readFileSync(envFile, 'utf8'));
    url = match?.[1]?.trim().replace(/^["']|["']$/g, '');
  }
  if (!url) {
    throw new Error('VITE_SUPABASE_URL is not set (environment or app/.env); the app could not sign in.');
  }
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('VITE_SUPABASE_URL must be an https URL');
  return parsed.origin;
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const common = {
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
};

await Promise.all([
  build({
    ...common,
    entryPoints: [join(root, 'src/main.ts')],
    outfile: join(dist, 'main.cjs'),
    define: { __SUPABASE_ORIGIN__: JSON.stringify(supabaseOrigin()) },
  }),
  // Sandboxed preloads can only require 'electron', so everything else is bundled in.
  build({
    ...common,
    entryPoints: [join(root, 'src/alarm-preload.ts')],
    outfile: join(dist, 'alarm-preload.cjs'),
  }),
  build({
    ...common,
    entryPoints: [join(root, 'src/main-preload.ts')],
    outfile: join(dist, 'main-preload.cjs'),
  }),
]);

cpSync(join(root, 'assets/tray.png'), join(dist, 'tray.png'));
