import { describe, expect, it } from 'vitest';

import { buildDevSeed } from './dev-seed';

const NOW = new Date('2026-03-02T09:00:00.250Z');

describe('buildDevSeed', () => {
  it('seeds a 2-snooze event and a no-snooze event shortly after launch', () => {
    const seed = buildDevSeed(NOW, 'UTC', false);
    const [withSnoozes, noSnooze] = seed.events;

    expect(withSnoozes).toMatchObject({
      max_snoozes: 2,
      snooze_minutes: 1,
      start_at: '2026-03-02T09:01:01.000Z',
    });
    expect(noSnooze).toMatchObject({ max_snoozes: 0, start_at: '2026-03-02T09:01:31.000Z' });
    expect(seed.settings.refire_seconds).toBe(20);
    expect(seed.cheatDays).toEqual([]);
  });

  it('makes today a cheat day in the given zone on request', () => {
    // 23:30 UTC on the 2nd is already the 3rd in Tokyo.
    const lateUtc = new Date('2026-03-02T23:30:00.000Z');
    expect(buildDevSeed(lateUtc, 'Asia/Tokyo', true).cheatDays).toEqual(['2026-03-03']);
  });
});
