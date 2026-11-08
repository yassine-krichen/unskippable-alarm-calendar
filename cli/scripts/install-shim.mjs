// Puts an `alarm-cal` command on the user's PATH without touching the system PATH: two small launcher files
// in a per-user bin folder (default ~/.local/bin, which is where Claude Code installs its own launcher on
// Windows). `alarm-cal.cmd` serves PowerShell and cmd, the extensionless `alarm-cal` serves Git Bash. If the
// folder is not on PATH yet, the one PowerShell line that adds it to the USER path is printed, not run.
//
//   node cli/scripts/install-shim.mjs [--dir <folder>]
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = join(root, 'dist', 'alarm-cal.cjs');

const dirFlag = process.argv.indexOf('--dir');
const binDir = resolve(dirFlag > 0 && process.argv[dirFlag + 1] ? process.argv[dirFlag + 1] : join(homedir(), '.local', 'bin'));

if (!existsSync(bundle)) {
  console.error(`Not built yet: ${bundle}\nRun \`task alarm-calendar:cli:build\` first.`);
  process.exit(1);
}

mkdirSync(binDir, { recursive: true });
const cmdPath = join(binDir, 'alarm-cal.cmd');
const shPath = join(binDir, 'alarm-cal');
writeFileSync(cmdPath, `@echo off\r\nnode "${bundle}" %*\r\n`);
writeFileSync(shPath, `#!/bin/sh\nexec node "${bundle.replaceAll('\\', '/')}" "$@"\n`);
try {
  chmodSync(shPath, 0o755);
} catch {
  // Windows ignores the mode; Git Bash runs the script anyway.
}

const normalise = (folder) => resolve(folder).replace(/[\\/]+$/, '').toLowerCase();
const onPath = (process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(Boolean).some((entry) => normalise(entry) === normalise(binDir));

console.log(`Installed alarm-cal launchers in ${binDir}:\n  ${cmdPath}\n  ${shPath}`);
if (onPath) {
  console.log('That folder is already on PATH. Open a new terminal if `alarm-cal` is not found yet.');
} else {
  console.log(`\nThat folder is not on PATH. To add it for your user (new terminals only), run in PowerShell:\n`);
  console.log(`  [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ';${binDir}', 'User')`);
}
