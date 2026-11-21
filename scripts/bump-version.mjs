// Sets the one version everywhere: node scripts/bump-version.mjs <patch|minor|major|x.y.z>
// (task version:bump -- <x>). The root package.json is the source; app and electron copy it, and
// Android reads the root file in android/app/build.gradle. Refuses a dirty tree so the bump is its own commit.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { VERSION_FILES, nextVersion, withVersion } from './release-lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function main() {
  const request = process.argv[2];
  if (request === undefined) throw new Error('Usage: bump-version.mjs <patch|minor|major|x.y.z>');
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim();
  if (dirty !== '') throw new Error('The working tree is not clean. Commit or stash first, so the bump is its own change.');

  const current = JSON.parse(readFileSync(join(root, VERSION_FILES[0]), 'utf8')).version;
  const next = nextVersion(current, request);
  for (const file of VERSION_FILES) {
    const path = join(root, file);
    writeFileSync(path, withVersion(readFileSync(path, 'utf8'), next));
  }
  console.info(`Version ${current} -> ${next} in ${VERSION_FILES.join(', ')}.`);
  console.info('Android picks it up from the root package.json (versionName and versionCode) on the next build.');
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
