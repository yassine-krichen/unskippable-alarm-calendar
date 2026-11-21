// Pure helpers for the version bump and the local release flow (docs/releasing.md).
// No file, git or network access here, so the tests need no fixtures.

const VERSION_PATTERN = /^(\d{1,4})\.(\d{1,2})\.(\d{1,2})$/;

/** The files that carry the one version (root package.json is the source; the others are copies). */
export const VERSION_FILES = ['package.json', 'app/package.json', 'electron/package.json'];

/** The repo releases are published to. A constant on purpose: nothing ever builds it from input. */
export const RELEASE_REPO = 'yassine-krichen/unskippable-alarm-calendar';

/** Parses a strict `major.minor.patch` (minor and patch below 100, so versionCode stays unambiguous). */
export function parseVersion(text) {
  const match = VERSION_PATTERN.exec(String(text).trim());
  if (match === null) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/** Android versionCode: 0.2.0 is 200. Mirrors android/app/build.gradle. */
export function versionCode(version) {
  const parsed = typeof version === 'string' ? parseVersion(version) : version;
  if (parsed === null) throw new Error(`"${String(version)}" is not x.y.z.`);
  return parsed.major * 10000 + parsed.minor * 100 + parsed.patch;
}

/**
 * The version a bump request leads to: `patch`, `minor`, `major` or an explicit `x.y.z`.
 * Throws a readable error for anything else, and for an explicit version that is not newer.
 */
export function nextVersion(current, request) {
  const from = parseVersion(current);
  if (from === null) throw new Error(`The current version "${current}" is not x.y.z.`);
  let to;
  if (request === 'patch') to = { ...from, patch: from.patch + 1 };
  else if (request === 'minor') to = { major: from.major, minor: from.minor + 1, patch: 0 };
  else if (request === 'major') to = { major: from.major + 1, minor: 0, patch: 0 };
  else {
    to = parseVersion(request ?? '');
    if (to === null) throw new Error(`"${request}" is not patch, minor, major or x.y.z.`);
    if (versionCode(to) <= versionCode(from)) {
      throw new Error(`${request} is not newer than ${current}; Android would refuse to update to it.`);
    }
  }
  if (to.minor > 99 || to.patch > 99) throw new Error('minor and patch must stay below 100 (the Android versionCode packs them).');
  return `${to.major}.${to.minor}.${to.patch}`;
}

/** Replaces the top-level "version" of a package.json text, keeping its formatting. Throws when there is none. */
export function withVersion(packageJsonText, version) {
  const pattern = /^(\s{2}"version":\s*)"[^"]*"/m;
  if (!pattern.test(packageJsonText)) throw new Error('package.json has no top-level "version".');
  return packageJsonText.replace(pattern, `$1"${version}"`);
}

/** Null when every file names the same version, else a sentence saying which differ. `versions` maps file to version. */
export function findVersionMismatch(versions) {
  const entries = Object.entries(versions);
  const [firstFile, firstVersion] = entries[0] ?? [];
  const differing = entries.filter(([, version]) => version !== firstVersion);
  if (differing.length === 0) return null;
  const list = entries.map(([file, version]) => `${file}=${version}`).join(', ');
  return `Versions disagree (${list}); ${firstFile} is the source. Run: task version:bump -- <x.y.z>`;
}

/** The asset names a release carries. */
export function releaseAssetNames(version) {
  return {
    apk: `Alarm-Calendar-${version}.apk`,
    installer: `Alarm-Calendar-Setup-${version}.exe`,
    sums: 'SHA256SUMS.txt',
  };
}

/** `sha256sum`-format text: lowercase hex, two spaces, file name, one line each. `entries` is [{ name, sha256 }]. */
export function formatSha256Sums(entries) {
  return entries.map(({ name, sha256 }) => `${sha256.toLowerCase()}  ${name}\n`).join('');
}

/** Whether a Vite env file names `name` with a non-empty value. Only the name is matched; the value is never kept. */
export function envTextSetsVariable(text, name) {
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*\\S`);
  return text.split(/\r?\n/).some((line) => pattern.test(line));
}

/** The files Vite may read env values from (`.env`, `.env.local`, `.env.<mode>`, `.env.<mode>.local`), minus the example. */
export function isViteEnvFileName(fileName) {
  return /^\.env(\..+)?$/.test(fileName) && fileName !== '.env.example';
}

/**
 * What must never be inside built web output: a Supabase secret key (the app only ever uses the publishable key),
 * the service role, or the debug backend's markers. Returns the problems found; empty means clean.
 */
export function findShippingProblems(text) {
  const problems = [];
  if (/sb_secret_[A-Za-z0-9_-]{8,}/.test(text)) problems.push('a Supabase secret key (sb_secret_...)');
  if (/service_role/.test(text)) problems.push('the text "service_role"');
  if (text.includes('__alarmDebug') || text.includes('example.supabase.co')) problems.push('the debug backend (VITE_ALARM_DEBUG)');
  return problems;
}
