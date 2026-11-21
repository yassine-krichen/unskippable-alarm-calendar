// The steps of the local release flow that are not a build (task release, docs/releasing.md):
//   preflight  the tree is clean, the versions agree, the tag is free, no debug build flag, HEAD is pushed
//   verify     built web output holds no secret key and no debug backend
//   assemble   copy the APK and the installer to release/v<version>/ and write SHA256SUMS.txt
//   draft      gh release create v<version> --draft (creates a DRAFT only; publishing stays the owner's step)
// Nothing here pushes, tags or publishes. Nothing prints a secret: only file names, versions and digests.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RELEASE_REPO,
  VERSION_FILES,
  findShippingProblems,
  findVersionMismatch,
  envTextSetsVariable,
  formatSha256Sums,
  isViteEnvFileName,
  releaseAssetNames,
} from './release-lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function readVersions() {
  return Object.fromEntries(VERSION_FILES.map((file) => [file, JSON.parse(readFileSync(join(root, file), 'utf8')).version]));
}

function sha256Of(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * The Vite env files in app/ that set VITE_ALARM_DEBUG (.env, .env.local, .env.android, .env.*.local, ...). Only the
 * variable name is looked for; no value is kept or printed, and neither is any other line.
 */
function envFilesSettingDebug() {
  const dir = join(root, 'app');
  return readdirSync(dir)
    .filter(isViteEnvFileName)
    .filter((fileName) => envTextSetsVariable(readFileSync(join(dir, fileName), 'utf8'), 'VITE_ALARM_DEBUG'));
}

function preflight() {
  const versions = readVersions();
  const mismatch = findVersionMismatch(versions);
  if (mismatch !== null) throw new Error(mismatch);
  const version = versions[VERSION_FILES[0]];

  if (git('status', '--porcelain') !== '') throw new Error('The working tree is not clean. Commit everything first.');
  if (git('tag', '--list', `v${version}`) !== '') {
    throw new Error(`The tag v${version} already exists. Bump the version first: task version:bump -- patch`);
  }
  // A draft release names a commit GitHub must already have.
  if (git('branch', '--remote', '--contains', 'HEAD') === '') {
    throw new Error('HEAD is not on the remote. Push the branch first (the owner approves pushes).');
  }
  const debugFiles = envFilesSettingDebug();
  if (process.env.VITE_ALARM_DEBUG || debugFiles.length > 0) {
    const where = [...(process.env.VITE_ALARM_DEBUG ? ['the environment'] : []), ...debugFiles.map((file) => `app/${file}`)];
    throw new Error(`VITE_ALARM_DEBUG is set (${where.join(', ')}). A release must not carry the debug backend.`);
  }
  console.info(`Preflight ok for v${version} at ${git('rev-parse', '--short', 'HEAD')}.`);
}

function listFiles(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(js|html|css|json)$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

function verify() {
  const dirs = [join(root, 'app', 'dist-android'), join(root, 'app', 'dist')].filter((dir) => existsSync(dir));
  if (dirs.length === 0) throw new Error('No built web output found (app/dist-android, app/dist).');
  for (const dir of dirs) {
    const problems = new Set();
    for (const file of listFiles(dir)) {
      for (const problem of findShippingProblems(readFileSync(file, 'utf8'))) problems.add(problem);
    }
    if (problems.size > 0) throw new Error(`${dir} contains ${[...problems].join(', ')}. Not releasing.`);
  }
  console.info('Web output is clean: no secret key, no debug backend.');
}

function assemble() {
  const version = readVersions()[VERSION_FILES[0]];
  const names = releaseAssetNames(version);
  const sources = [
    { name: names.apk, from: join(root, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk') },
    { name: names.installer, from: join(root, 'electron', 'release', names.installer) },
  ];
  const out = join(root, 'release', `v${version}`);
  mkdirSync(out, { recursive: true });
  const entries = [];
  for (const { name, from } of sources) {
    if (!existsSync(from)) throw new Error(`Missing build output ${from}`);
    copyFileSync(from, join(out, name));
    entries.push({ name, sha256: sha256Of(join(out, name)) });
  }
  writeFileSync(join(out, names.sums), formatSha256Sums(entries));
  for (const { name, sha256 } of entries) {
    console.info(`${name}  ${(statSync(join(out, name)).size / 1048576).toFixed(1)} MB  sha256 ${sha256}`);
  }
  console.info(`Release files in ${out}`);
}

function draft() {
  const version = readVersions()[VERSION_FILES[0]];
  const names = releaseAssetNames(version);
  const dir = join(root, 'release', `v${version}`);
  const files = [names.apk, names.installer, names.sums].map((name) => join(dir, name));
  for (const file of files) if (!existsSync(file)) throw new Error(`Missing ${file}; run the assemble step first.`);
  // --draft: invisible to /releases/latest until the owner publishes it. --target pins the tag to the built commit.
  execFileSync(
    'gh',
    [
      'release', 'create', `v${version}`, '--repo', RELEASE_REPO, '--draft', '--generate-notes',
      '--title', `v${version}`, '--target', git('rev-parse', 'HEAD'), ...files,
    ],
    { cwd: root, stdio: 'inherit' }
  );
  console.info(`Draft release v${version} created. Publish it yourself: gh release edit v${version} --draft=false --repo ${RELEASE_REPO}`);
}

const commands = { preflight, verify, assemble, draft };

try {
  const command = commands[process.argv[2] ?? ''];
  if (command === undefined) throw new Error(`Usage: release.mjs <${Object.keys(commands).join('|')}>`);
  command();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
