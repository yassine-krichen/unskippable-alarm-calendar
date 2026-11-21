import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  envTextSetsVariable,
  findShippingProblems,
  isViteEnvFileName,
  findVersionMismatch,
  formatSha256Sums,
  nextVersion,
  parseVersion,
  releaseAssetNames,
  versionCode,
  withVersion,
} from './release-lib.mjs';

describe('nextVersion', () => {
  it('bumps patch, minor and major, resetting what follows', () => {
    assert.equal(nextVersion('0.2.0', 'patch'), '0.2.1');
    assert.equal(nextVersion('0.2.7', 'minor'), '0.3.0');
    assert.equal(nextVersion('0.2.7', 'major'), '1.0.0');
  });

  it('accepts an explicit newer version', () => {
    assert.equal(nextVersion('0.2.0', '0.4.1'), '0.4.1');
  });

  it('refuses an explicit version that is not newer, because Android would refuse the update', () => {
    assert.throws(() => nextVersion('0.2.0', '0.2.0'), /not newer/);
    assert.throws(() => nextVersion('0.2.0', '0.1.9'), /not newer/);
  });

  it('refuses anything that is not x.y.z', () => {
    assert.throws(() => nextVersion('0.2.0', 'v1.0.0'), /not patch, minor, major or x.y.z/);
    assert.throws(() => nextVersion('0.2.0', '1.0'), /not patch, minor, major or x.y.z/);
    assert.throws(() => nextVersion('0.2.0', '1.0.0-beta'), /not patch, minor, major or x.y.z/);
    assert.throws(() => nextVersion('banana', 'patch'), /not x.y.z/);
  });

  it('refuses a patch bump past 99, which would collide in the versionCode', () => {
    assert.throws(() => nextVersion('0.2.99', 'patch'), /below 100/);
  });
});

describe('versionCode', () => {
  it('packs major, minor and patch so 0.2.0 is 200 and later versions are always larger', () => {
    assert.equal(versionCode('0.2.0'), 200);
    assert.equal(versionCode('1.0.0'), 10000);
    assert.equal(versionCode('0.2.1') > versionCode('0.2.0'), true);
    assert.equal(versionCode('0.10.0') > versionCode('0.9.99'), true);
  });
});

describe('parseVersion', () => {
  it('reads x.y.z only', () => {
    assert.deepEqual(parseVersion('0.2.0'), { major: 0, minor: 2, patch: 0 });
    assert.equal(parseVersion('0.2'), null);
    assert.equal(parseVersion('0.2.0.1'), null);
  });
});

describe('withVersion', () => {
  it('changes only the top-level version and keeps the formatting', () => {
    const text = '{\n  "name": "x",\n  "version": "0.1.0",\n  "dependencies": {\n    "version": "1.0.0"\n  }\n}\n';
    assert.equal(
      withVersion(text, '0.2.0'),
      '{\n  "name": "x",\n  "version": "0.2.0",\n  "dependencies": {\n    "version": "1.0.0"\n  }\n}\n'
    );
  });

  it('throws when there is no version to change', () => {
    assert.throws(() => withVersion('{ "name": "x" }', '0.2.0'), /no top-level "version"/);
  });
});

describe('findVersionMismatch', () => {
  it('is null when every file agrees', () => {
    assert.equal(findVersionMismatch({ 'package.json': '0.2.0', 'app/package.json': '0.2.0' }), null);
  });

  it('names the files when one differs', () => {
    const message = findVersionMismatch({
      'package.json': '0.2.0',
      'app/package.json': '0.2.0',
      'electron/package.json': '0.1.0',
    });
    assert.match(message ?? '', /electron\/package.json=0.1.0/);
  });
});

describe('release files', () => {
  it('names the assets the in-app updater looks for', () => {
    assert.deepEqual(releaseAssetNames('0.2.0'), {
      apk: 'Alarm-Calendar-0.2.0.apk',
      installer: 'Alarm-Calendar-Setup-0.2.0.exe',
      sums: 'SHA256SUMS.txt',
    });
  });

  it('writes SHA256SUMS in sha256sum format with lowercase hex', () => {
    const upper = 'AB'.repeat(32);
    assert.equal(formatSha256Sums([{ name: 'a.apk', sha256: upper }]), `${'ab'.repeat(32)}  a.apk\n`);
  });
});

describe('envTextSetsVariable', () => {
  it('matches the variable name with a value, in any of the usual spellings', () => {
    assert.equal(envTextSetsVariable('A=1\nVITE_ALARM_DEBUG=1\n', 'VITE_ALARM_DEBUG'), true);
    assert.equal(envTextSetsVariable('  VITE_ALARM_DEBUG = true', 'VITE_ALARM_DEBUG'), true);
    assert.equal(envTextSetsVariable('export VITE_ALARM_DEBUG=1\r\n', 'VITE_ALARM_DEBUG'), true);
  });

  it('ignores an empty value, a comment, another variable and a longer name', () => {
    assert.equal(envTextSetsVariable('VITE_ALARM_DEBUG=\n', 'VITE_ALARM_DEBUG'), false);
    assert.equal(envTextSetsVariable('# VITE_ALARM_DEBUG=1\n', 'VITE_ALARM_DEBUG'), false);
    assert.equal(envTextSetsVariable('VITE_ALARM_DEBUG_X=1\n', 'VITE_ALARM_DEBUG'), false);
    assert.equal(envTextSetsVariable('OTHER=VITE_ALARM_DEBUG=1\n', 'VITE_ALARM_DEBUG'), false);
  });
});

describe('isViteEnvFileName', () => {
  it('covers every file Vite reads values from, but not the example', () => {
    for (const name of ['.env', '.env.local', '.env.android', '.env.android.local', '.env.production.local']) {
      assert.equal(isViteEnvFileName(name), true, name);
    }
    for (const name of ['.env.example', 'env.txt', '.envrc-not', 'package.json']) {
      assert.equal(isViteEnvFileName(name), false, name);
    }
  });
});

describe('findShippingProblems', () => {
  it('passes a bundle with only the publishable key', () => {
    assert.deepEqual(findShippingProblems('createClient("https://abc.supabase.co","sb_publishable_abcdef123456")'), []);
  });

  it('flags a secret key, the service role and the debug backend', () => {
    assert.equal(findShippingProblems('k="sb_secret_abcdefgh12345"').length, 1);
    assert.equal(findShippingProblems('role: "service_role"').length, 1);
    assert.equal(findShippingProblems('window.__alarmDebug = {}').length, 1);
    assert.equal(findShippingProblems('https://example.supabase.co').length, 1);
  });
});
