// Bundles the CLI into one file, dist/alarm-cal.cjs, with @alarm-calendar/core, supabase-js and zod inside
// (core is exported as TypeScript source, so esbuild is what lets Node run it). Then writes plan.schema.json
// from the bundle's own plan schema, so the published JSON Schema can never drift from what the tool checks.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
const outfile = join(dist, 'alarm-cal.cjs');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [join(root, 'src/alarm-cal.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: false,
  minify: false,
  logLevel: 'warning',
  banner: { js: '#!/usr/bin/env node' },
  legalComments: 'none',
  // ws is an optional peer of supabase-js's realtime client, which this tool never opens.
  external: ['ws', 'bufferutil', 'utf-8-validate'],
});
chmodSync(outfile, 0o755);

const schemaJson = execFileSync(process.execPath, [outfile, 'schema', 'plan'], { encoding: 'utf8', env: { ...process.env, ALARM_CAL_NO_ACL: '1' } });
const target = join(root, 'plan.schema.json');
const next = `${JSON.stringify(JSON.parse(schemaJson), null, 2)}\n`;
let previous = '';
try {
  previous = readFileSync(target, 'utf8');
} catch {
  // first build
}
if (previous !== next) writeFileSync(target, next);
// Build chatter goes to stderr so `task cli -- ... --json` output stays one clean JSON document.
console.error(`built ${outfile}${previous === next ? '' : ' and updated plan.schema.json'}`);
