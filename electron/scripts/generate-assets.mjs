// Generates the three alarm sounds, the tray icon and the multi-size Windows
// icon, so no binary has to be hand-made or downloaded. Output is committed;
// re-run with `pnpm --filter @alarm-calendar/electron generate-assets`.
//   app/public/sounds/{bell,chime,pulse}.wav   one loop cycle each, played by the alarm screen
//   electron/assets/tray.png                   32 px tray icon
//   electron/assets/icon.ico                   16..256 px installer / app icon (PNG entries)
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

const assetsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');
const soundsDir = join(assetsDir, '..', '..', 'app', 'public', 'sounds');
mkdirSync(assetsDir, { recursive: true });
mkdirSync(soundsDir, { recursive: true });

// ---------------------------------------------------------------------------
// Sounds. 44.1 kHz mono 16-bit PCM. Each file is one loop cycle that ends in
// silence, so HTMLAudioElement `loop` has no click at the seam. Each sound is
// scaled towards the same RMS (so the three feel equally loud) but never past
// PEAK; the loudness the user hears is then the system volume.
// ---------------------------------------------------------------------------
const SAMPLE_RATE = 44100;
const PEAK = 0.85;
const TARGET_RMS = 0.2;
const TWO_PI = 2 * Math.PI;

/** A mono float buffer with a helper to mix a shaped tone in at a time offset. */
function createTrack(seconds) {
  const samples = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  return {
    samples,
    /** `shape(t)` returns the sample t seconds after `startSeconds`, for `length` seconds. */
    add(startSeconds, length, shape) {
      const first = Math.round(startSeconds * SAMPLE_RATE);
      const count = Math.round(length * SAMPLE_RATE);
      for (let i = 0; i < count && first + i < samples.length; i++) {
        samples[first + i] += shape(i / SAMPLE_RATE);
      }
    },
  };
}

/** Classic bell: a rapid clapper on inharmonic partials, two rings per loop. */
function buildBell() {
  const track = createTrack(2.4);
  // Partial ratios and gains of a struck bell (hum, prime, tierce, quint, nominal, extra).
  const partials = [
    [0.5, 0.35],
    [1.0, 1.0],
    [1.19, 0.5],
    [1.5, 0.35],
    [2.0, 0.55],
    [2.74, 0.3],
  ];
  const fundamental = 1046; // C6: cuts through room noise
  const strikeGap = 0.085;
  for (let ring = 0; ring < 2; ring++) {
    for (let strike = 0; strike < 9; strike++) {
      track.add(ring * 1.2 + strike * strikeGap, 0.32, (t) => {
        const decay = Math.exp(-t * 14);
        const attack = Math.min(1, t / 0.002);
        let value = 0;
        for (const [ratio, gain] of partials) value += gain * Math.sin(TWO_PI * fundamental * ratio * t);
        return value * decay * attack;
      });
    }
  }
  return track.samples;
}

/** Rising chime: a bright four-note arpeggio that climbs and gets louder, then a held top note. */
function buildChime() {
  const track = createTrack(3.2);
  const notes = [659.25, 830.61, 987.77, 1318.51]; // E5 G#5 B5 E6
  const spacing = 0.2;
  for (let round = 0; round < 2; round++) {
    notes.forEach((frequency, index) => {
      const isTop = index === notes.length - 1;
      const gain = 0.6 + index * 0.13;
      track.add(round * 1.5 + index * spacing, isTop ? 0.7 : 0.35, (t) => {
        const decay = Math.exp(-t * (isTop ? 4.5 : 9));
        const attack = Math.min(1, t / 0.004);
        const tone =
          Math.sin(TWO_PI * frequency * t) +
          0.4 * Math.sin(TWO_PI * frequency * 2 * t) +
          0.15 * Math.sin(TWO_PI * frequency * 3 * t);
        return gain * tone * decay * attack;
      });
    });
  }
  return track.samples;
}

/** Digital pulse: a watch-style beep-beep-beep-beeeep in a band-limited square wave. */
function buildPulse() {
  const track = createTrack(2.2);
  const square = (frequency, t) => {
    // Odd harmonics up to the 7th: harsh enough to be an alarm, band-limited so it does not alias.
    let value = 0;
    for (let harmonic = 1; harmonic <= 7; harmonic += 2) value += Math.sin(TWO_PI * frequency * harmonic * t) / harmonic;
    return value;
  };
  const beeps = [
    [0.0, 0.11, 1500],
    [0.2, 0.11, 1500],
    [0.4, 0.11, 1500],
    [0.6, 0.32, 2000],
  ];
  for (let repeat = 0; repeat < 2; repeat++) {
    for (const [start, length, frequency] of beeps) {
      track.add(repeat * 1.1 + start, length, (t) => {
        const fade = 0.004;
        const envelope = Math.min(1, t / fade, (length - t) / fade);
        return square(frequency, t) * Math.max(0, envelope);
      });
    }
  }
  return track.samples;
}

function encodeWav(floatSamples) {
  let peak = 0;
  let sumOfSquares = 0;
  for (const sample of floatSamples) {
    peak = Math.max(peak, Math.abs(sample));
    sumOfSquares += sample * sample;
  }
  const rms = Math.sqrt(sumOfSquares / floatSamples.length);
  const scale = peak === 0 ? 0 : Math.min(TARGET_RMS / rms, PEAK / peak);
  const dataBytes = floatSamples.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataBytes, 40);
  floatSamples.forEach((sample, i) => buffer.writeInt16LE(Math.round(sample * scale * 32767), 44 + i * 2));
  return buffer;
}

// ---------------------------------------------------------------------------
// Icon. One drawing (a clock face: light disc, dark rim, two hands) rendered at
// any size with 4x4 supersampling, used for the tray PNG and every ICO entry.
// ---------------------------------------------------------------------------
function pngChunk(type, data) {
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, checksum]);
}

const DARK = [20, 20, 20];
const LIGHT = [245, 245, 245];

/** Colour of the clock at unit coordinates (u, v) in [-1, 1]; alpha 0 outside the rim. */
function clockPixel(u, v) {
  const distance = Math.hypot(u, v);
  if (distance > 0.906) return [0, 0, 0, 0];
  if (distance > 0.75) return [...DARK, 255];
  const handHalfWidth = 0.075;
  const onMinuteHand = Math.abs(u) < handHalfWidth && v <= 0 && v >= -0.65;
  const onHourHand = Math.abs(v) < handHalfWidth && u >= 0 && u <= 0.45;
  return [...(onMinuteHand || onHourHand ? DARK : LIGHT), 255];
}

function buildClockPng(size) {
  const grid = 4;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4); // leading 0 = no PNG filter
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < grid; sy++) {
        for (let sx = 0; sx < grid; sx++) {
          const u = ((x + (sx + 0.5) / grid) / size) * 2 - 1;
          const v = ((y + (sy + 0.5) / grid) / size) * 2 - 1;
          const [pr, pg, pb, pa] = clockPixel(u, v);
          // Weighted by alpha so the antialiased rim does not pick up a dark fringe.
          r += pr * pa;
          g += pg * pa;
          b += pb * pa;
          a += pa;
        }
      }
      const rgba = a === 0 ? [0, 0, 0, 0] : [r / a, g / a, b / a, a / (grid * grid)].map(Math.round);
      row.set(rgba, 1 + x * 4);
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.concat(rows))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** ICO container with PNG-compressed entries (supported since Windows Vista). */
function buildIco(sizes) {
  const images = sizes.map((size) => ({ size, png: buildClockPng(size) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;
  images.forEach(({ size, png }, index) => {
    const entry = index * 16;
    directory[entry] = size === 256 ? 0 : size; // 0 means 256
    directory[entry + 1] = size === 256 ? 0 : size;
    directory.writeUInt16LE(1, entry + 4); // colour planes
    directory.writeUInt16LE(32, entry + 6); // bits per pixel
    directory.writeUInt32LE(png.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, directory, ...images.map(({ png }) => png)]);
}

// The first placeholder shipped one alarm.wav; the three real sounds replace it.
rmSync(join(soundsDir, 'alarm.wav'), { force: true });
writeFileSync(join(soundsDir, 'bell.wav'), encodeWav(buildBell()));
writeFileSync(join(soundsDir, 'chime.wav'), encodeWav(buildChime()));
writeFileSync(join(soundsDir, 'pulse.wav'), encodeWav(buildPulse()));
writeFileSync(join(assetsDir, 'tray.png'), buildClockPng(32));
writeFileSync(join(assetsDir, 'icon.ico'), buildIco([16, 24, 32, 48, 64, 128, 256]));
console.log('wrote app/public/sounds/{bell,chime,pulse}.wav, electron/assets/tray.png and electron/assets/icon.ico');
