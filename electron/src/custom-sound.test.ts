import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkCustomSound, CUSTOM_SOUND_MAX_BYTES, CustomSoundStore, sniffAudio } from './custom-sound';

/** The first bytes of each supported container, padded so the file is not tiny. */
const MP3_ID3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(200, 1)]);
const MP3_FRAME = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(200, 1)]);
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WAVEfmt '), Buffer.alloc(200, 1)]);
const OGG = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(200, 1)]);
const M4A = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypM4A '), Buffer.alloc(200, 1)]);

describe('sniffAudio', () => {
  it('recognises the four supported containers', () => {
    expect(sniffAudio(MP3_ID3)).toBe('mp3');
    expect(sniffAudio(MP3_FRAME)).toBe('mp3');
    expect(sniffAudio(WAV)).toBe('wav');
    expect(sniffAudio(OGG)).toBe('ogg');
    expect(sniffAudio(M4A)).toBe('m4a');
  });

  it('rejects text, scripts, executables, images and other RIFF files', () => {
    for (const bytes of [
      Buffer.from('<html><script>alert(1)</script></html>'),
      Buffer.from('MZ\x90\x00\x03'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('RIFF....AVI LIST'),
      Buffer.alloc(0),
    ]) {
      expect(sniffAudio(bytes)).toBeNull();
    }
  });
});

describe('checkCustomSound', () => {
  it('accepts a file whose name, size and content agree', () => {
    expect(checkCustomSound('Takbir.MP3', MP3_ID3)).toEqual({ ok: true, extension: 'mp3', mime: 'audio/mpeg' });
    expect(checkCustomSound('a.wav', WAV)).toMatchObject({ ok: true, mime: 'audio/wav' });
    expect(checkCustomSound('a.m4a', M4A)).toMatchObject({ ok: true, mime: 'audio/mp4' });
  });

  it('refuses a name that claims another type than the content', () => {
    expect(checkCustomSound('virus.mp3', WAV).ok).toBe(false);
    expect(checkCustomSound('page.mp3', Buffer.from('<html></html>')).ok).toBe(false);
  });

  it('refuses an unsupported extension, an empty file and one over the limit', () => {
    expect(checkCustomSound('a.exe', MP3_ID3).ok).toBe(false);
    expect(checkCustomSound('a', MP3_ID3).ok).toBe(false);
    expect(checkCustomSound('a.mp3', Buffer.alloc(0)).ok).toBe(false);
    const big = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(CUSTOM_SOUND_MAX_BYTES)]);
    expect(checkCustomSound('a.mp3', big)).toMatchObject({ ok: false, reason: expect.stringContaining('5 MB') });
  });
});

describe('CustomSoundStore', () => {
  let root: string;
  let store: CustomSoundStore;
  const storeDir = (): string => join(root, 'data', 'custom-sound');

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'alarm-custom-sound-'));
    store = new CustomSoundStore(storeDir());
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function source(name: string, bytes: Buffer): string {
    const dir = join(root, 'source');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, bytes);
    return path;
  }

  it('has nothing at first', () => {
    expect(store.info()).toBeNull();
    expect(store.read()).toBeNull();
  });

  it('copies a chosen file into its own folder and serves it back by content', () => {
    const path = source('takbir.mp3', MP3_ID3);
    expect(store.save(path)).toEqual({ status: 'chosen', info: { name: 'takbir.mp3', bytes: MP3_ID3.length } });
    expect(store.info()).toEqual({ name: 'takbir.mp3', bytes: MP3_ID3.length });
    const read = store.read();
    expect(read?.mime).toBe('audio/mpeg');
    expect(Buffer.from(read!.data).equals(MP3_ID3)).toBe(true);
    // The original is untouched and the copy has a fixed name, not the user's.
    expect(readFileSync(path).equals(MP3_ID3)).toBe(true);
    expect(readdirSync(storeDir()).sort()).toEqual(['prayer-sound.json', 'prayer-sound.mp3']);
  });

  it('replaces the previous file, whatever its type', () => {
    store.save(source('a.mp3', MP3_ID3));
    store.save(source('b.ogg', OGG));
    expect(readdirSync(storeDir()).sort()).toEqual(['prayer-sound.json', 'prayer-sound.ogg']);
    expect(store.read()?.mime).toBe('audio/ogg');
  });

  it('rejects a bad file and keeps the one already chosen', () => {
    store.save(source('a.mp3', MP3_ID3));
    expect(store.save(source('notes.mp3', Buffer.from('not audio'))).status).toBe('rejected');
    expect(store.info()?.name).toBe('a.mp3');
    expect(store.save(join(root, 'missing.mp3')).status).toBe('rejected');
    expect(store.save(join(root, 'source')).status).toBe('rejected');
  });

  it('refuses an oversized file before reading it into memory', () => {
    const path = source('huge.mp3', Buffer.concat([Buffer.from('ID3'), Buffer.alloc(CUSTOM_SOUND_MAX_BYTES + 10)]));
    expect(store.save(path)).toMatchObject({ status: 'rejected', reason: expect.stringContaining('5 MB') });
    expect(store.info()).toBeNull();
  });

  it('does not serve a stored file that changed on disk into something else', () => {
    store.save(source('a.mp3', MP3_ID3));
    writeFileSync(join(storeDir(), 'prayer-sound.mp3'), '<html>replaced</html>');
    expect(store.read()).toBeNull();
    expect(store.info()).toBeNull();
  });

  it('refuses a stored file that grew past the limit without reading it', () => {
    store.save(source('a.mp3', MP3_ID3));
    writeFileSync(join(storeDir(), 'prayer-sound.mp3'), Buffer.concat([Buffer.from('ID3'), Buffer.alloc(CUSTOM_SOUND_MAX_BYTES + 10)]));
    expect(store.read()).toBeNull();
  });

  it('never follows a path written into the metadata', () => {
    store.save(source('a.mp3', MP3_ID3));
    const meta = join(storeDir(), 'prayer-sound.json');
    for (const file of ['../../../source/a.mp3', 'C:\\Windows\\win.ini', 'prayer-sound.mp3.exe', 'other.mp3']) {
      writeFileSync(meta, JSON.stringify({ file, name: 'x' }));
      expect(store.read(), file).toBeNull();
    }
    writeFileSync(meta, 'not json');
    expect(store.read()).toBeNull();
  });

  it('keeps a long file name usable: the type is read from the real name, the display name is cut', () => {
    const long = `${'a'.repeat(150)}.mp3`;
    const result = store.save(source(long, MP3_ID3));
    expect(result.status).toBe('chosen');
    expect(store.info()?.name).toHaveLength(100);
  });

  it('clears everything it stored', () => {
    store.save(source('a.mp3', MP3_ID3));
    store.clear();
    expect(store.info()).toBeNull();
    expect(readdirSync(storeDir())).toEqual([]);
    store.clear();
  });
});
