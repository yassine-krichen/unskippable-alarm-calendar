// Generates the placeholder alarm tone and the tray icon, so no binary has to
// be hand-made. Output is committed; re-run with `pnpm generate-assets`.
// REPLACE app/public/sounds/alarm.wav with a real alarm sound (spec section 9 asks for an
// mp3). The alarm screen plays it from the React app; all three sound options in
// Settings map to this one file until real sounds exist.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

const assetsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');
const soundsDir = join(assetsDir, '..', '..', 'app', 'public', 'sounds');
mkdirSync(assetsDir, { recursive: true });
mkdirSync(soundsDir, { recursive: true });

function buildAlarmWav() {
  const sampleRate = 22050;
  const frequencyHz = 880;
  const beepSeconds = 0.14;
  const gapSeconds = 0.1;
  const beepsPerLoop = 3;
  const tailSeconds = 0.5;
  const amplitude = 0.7;
  const fadeSeconds = 0.01;

  const samples = [];
  const pushSilence = (seconds) => {
    for (let i = 0; i < Math.round(seconds * sampleRate); i++) samples.push(0);
  };
  for (let beep = 0; beep < beepsPerLoop; beep++) {
    const count = Math.round(beepSeconds * sampleRate);
    const fade = Math.round(fadeSeconds * sampleRate);
    for (let i = 0; i < count; i++) {
      // Short fades avoid the click at the start and end of each beep.
      const envelope = Math.min(1, i / fade, (count - 1 - i) / fade);
      const value = Math.sin((2 * Math.PI * frequencyHz * i) / sampleRate);
      samples.push(Math.round(value * envelope * amplitude * 32767));
    }
    pushSilence(gapSeconds);
  }
  pushSilence(tailSeconds);

  const dataBytes = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataBytes, 40);
  samples.forEach((sample, i) => buffer.writeInt16LE(sample, 44 + i * 2));
  return buffer;
}

function pngChunk(type, data) {
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, checksum]);
}

/** A clock face: light disc, dark rim, two hands. Readable on light and dark taskbars. */
function buildTrayPng() {
  const size = 32;
  const center = (size - 1) / 2;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4); // leading 0 = no PNG filter
    for (let x = 0; x < size; x++) {
      const distance = Math.hypot(x - center, y - center);
      const onMinuteHand = Math.abs(x - center) < 1.2 && y <= center && y >= center - 10;
      const onHourHand = Math.abs(y - center) < 1.2 && x >= center && x <= center + 7;
      let rgba = [0, 0, 0, 0];
      if (distance <= 14.5 && distance > 12) rgba = [20, 20, 20, 255];
      else if (distance <= 12) rgba = onMinuteHand || onHourHand ? [20, 20, 20, 255] : [245, 245, 245, 255];
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

writeFileSync(join(soundsDir, 'alarm.wav'), buildAlarmWav());
writeFileSync(join(assetsDir, 'tray.png'), buildTrayPng());
console.log('wrote app/public/sounds/alarm.wav and electron/assets/tray.png');
