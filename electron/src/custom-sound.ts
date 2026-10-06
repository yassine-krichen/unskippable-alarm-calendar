import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, extname, join } from 'node:path';

import type { ChooseCustomSoundResult, CustomSoundData, CustomSoundInfo } from '@alarm-calendar/core';

/**
 * The user's own prayer sound (for example a takbir recording; no recording is bundled). The main
 * process owns the file: it is chosen in a file dialog opened by main, checked, and copied into the
 * app's own data folder under a fixed name. A renderer never names a path and never reads one; it
 * asks main for the bytes of "the custom sound". The check is by content as well as by name, because
 * the file ends up in a media element and a wrong extension is no guarantee of anything.
 */

/** Plenty for a recording of a few minutes; the alarm window reads it again every time it rings. */
export const CUSTOM_SOUND_MAX_BYTES = 5 * 1024 * 1024;

const MIME_BY_EXTENSION = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
} as const;

export type CustomSoundExtension = keyof typeof MIME_BY_EXTENSION;

export const CUSTOM_SOUND_EXTENSIONS = Object.keys(MIME_BY_EXTENSION) as CustomSoundExtension[];

function isExtension(value: string): value is CustomSoundExtension {
  return Object.hasOwn(MIME_BY_EXTENSION, value);
}

function ascii(bytes: Uint8Array, start: number, text: string): boolean {
  if (bytes.length < start + text.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (bytes[start + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

/** The audio container the bytes start as, or null. Only the four types the picker offers. */
export function sniffAudio(bytes: Uint8Array): CustomSoundExtension | null {
  if (ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WAVE')) return 'wav';
  if (ascii(bytes, 0, 'OggS')) return 'ogg';
  if (ascii(bytes, 4, 'ftyp')) return 'm4a';
  if (ascii(bytes, 0, 'ID3')) return 'mp3';
  // An MPEG audio frame header: 11 set sync bits, then a valid version and layer.
  const b0 = bytes[0];
  const b1 = bytes[1];
  if (b0 === 0xff && b1 !== undefined && (b1 & 0xe0) === 0xe0 && (b1 & 0x18) !== 0x08 && (b1 & 0x06) !== 0) {
    return 'mp3';
  }
  return null;
}

export type CustomSoundCheck = { ok: true; extension: CustomSoundExtension; mime: string } | { ok: false; reason: string };

/** Accepts a file by name, size and content: all three must say the same supported type. */
export function checkCustomSound(fileName: string, bytes: Uint8Array): CustomSoundCheck {
  if (bytes.length === 0) return { ok: false, reason: 'That file is empty.' };
  if (bytes.length > CUSTOM_SOUND_MAX_BYTES) {
    return { ok: false, reason: `That file is larger than ${CUSTOM_SOUND_MAX_BYTES / (1024 * 1024)} MB.` };
  }
  const named = extname(fileName).slice(1).toLowerCase();
  if (!isExtension(named)) {
    return { ok: false, reason: `Use a ${CUSTOM_SOUND_EXTENSIONS.join(', ')} file.` };
  }
  const sniffed = sniffAudio(bytes);
  if (sniffed === null || sniffed !== named) {
    return { ok: false, reason: `That file does not look like a real ${named} audio file.` };
  }
  return { ok: true, extension: named, mime: MIME_BY_EXTENSION[named] };
}

const FILE_STEM = 'prayer-sound';
const META_FILE = `${FILE_STEM}.json`;
const MAX_NAME_LENGTH = 100;

interface StoredMeta {
  file: string;
  name: string;
}

/** A display name: the base name with control characters dropped, at most 100 characters. */
function displayName(path: string): string {
  const cleaned = basename(path).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (cleaned === '' ? 'Custom sound' : cleaned).slice(0, MAX_NAME_LENGTH);
}

/** The one custom sound, kept under `dir` as `prayer-sound.<ext>` next to a small metadata file. */
export class CustomSoundStore {
  constructor(private readonly dir: string) {}

  /** Copies a chosen file in, replacing the previous one. The source is only read, never modified. */
  save(sourcePath: string): ChooseCustomSoundResult {
    let bytes: Buffer;
    try {
      const stats = statSync(sourcePath);
      if (!stats.isFile()) return { status: 'rejected', reason: 'That is not a file.' };
      // Refused before reading, so a huge file is never loaded into memory.
      if (stats.size > CUSTOM_SOUND_MAX_BYTES) {
        return { status: 'rejected', reason: `That file is larger than ${CUSTOM_SOUND_MAX_BYTES / (1024 * 1024)} MB.` };
      }
      bytes = readFileSync(sourcePath);
    } catch {
      return { status: 'rejected', reason: "That file couldn't be read." };
    }
    // The check uses the real file name: the display name may be cut short and lose its extension.
    const checked = checkCustomSound(basename(sourcePath), bytes);
    const name = displayName(sourcePath);
    if (!checked.ok) return { status: 'rejected', reason: checked.reason };

    const file = `${FILE_STEM}.${checked.extension}`;
    try {
      mkdirSync(this.dir, { recursive: true });
      // Temp file then rename, so a failed copy never leaves a half-written sound that would play as noise.
      const temp = join(this.dir, `${file}.tmp`);
      writeFileSync(temp, bytes);
      renameSync(temp, join(this.dir, file));
      for (const other of CUSTOM_SOUND_EXTENSIONS) {
        if (other !== checked.extension) rmSync(join(this.dir, `${FILE_STEM}.${other}`), { force: true });
      }
      const meta: StoredMeta = { file, name };
      writeFileSync(join(this.dir, META_FILE), JSON.stringify(meta));
    } catch {
      return { status: 'rejected', reason: "The file couldn't be saved." };
    }
    return { status: 'chosen', info: { name, bytes: bytes.length } };
  }

  /** What was chosen, or null when nothing is stored or the stored file is no longer valid. */
  info(): CustomSoundInfo | null {
    const loaded = this.load();
    return loaded === null ? null : { name: loaded.name, bytes: loaded.data.length };
  }

  /** The sound's bytes with a media type derived from the content, or null. */
  read(): CustomSoundData | null {
    const loaded = this.load();
    return loaded === null ? null : { mime: loaded.mime, data: loaded.data };
  }

  clear(): void {
    if (!existsSync(this.dir)) return;
    for (const entry of readdirSync(this.dir)) {
      if (entry === META_FILE || entry.startsWith(`${FILE_STEM}.`)) rmSync(join(this.dir, entry), { force: true });
    }
  }

  /**
   * Reads the stored file again and checks it again: the folder is writable by the user, so what
   * is on disk now is not necessarily what was saved. The path is built from fixed names only.
   */
  private load(): { name: string; mime: string; data: Uint8Array } | null {
    try {
      const meta = JSON.parse(readFileSync(join(this.dir, META_FILE), 'utf8')) as Partial<StoredMeta>;
      const extension = typeof meta.file === 'string' ? extname(meta.file).slice(1) : '';
      if (meta.file !== `${FILE_STEM}.${extension}` || !isExtension(extension)) return null;
      // The folder is writable by the user: refuse an oversized replacement before reading it into memory.
      if (statSync(join(this.dir, meta.file)).size > CUSTOM_SOUND_MAX_BYTES) return null;
      const data = readFileSync(join(this.dir, meta.file));
      const checked = checkCustomSound(meta.file, data);
      if (!checked.ok) return null;
      const name = typeof meta.name === 'string' ? meta.name.slice(0, MAX_NAME_LENGTH) : 'Custom sound';
      return { name, mime: checked.mime, data: new Uint8Array(data) };
    } catch {
      return null;
    }
  }
}
