import { describe, expect, it } from 'vitest';

import { makeOccurrenceId, parseOccurrenceId } from './alarm-ipc';

const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const INSTANT = '2026-03-02T09:01:00.000Z';

describe('parseOccurrenceId', () => {
  it('round-trips an id built by makeOccurrenceId', () => {
    const id = makeOccurrenceId(EVENT_ID, new Date(INSTANT));
    expect(parseOccurrenceId(id)).toEqual({ eventId: EVENT_ID, occurrenceAt: INSTANT });
  });

  it.each([
    ['a non-string', 42],
    ['null', null],
    ['an object', { eventId: EVENT_ID }],
    ['an empty string', ''],
    ['a missing instant', `${EVENT_ID}@`],
    ['a missing separator', `${EVENT_ID}${INSTANT}`],
    ['a non-uuid event id', `not-a-uuid@${INSTANT}`],
    ['an instant without milliseconds', `${EVENT_ID}@2026-03-02T09:01:00Z`],
    ['an instant with an offset', `${EVENT_ID}@2026-03-02T09:01:00.000+01:00`],
    ['an impossible date', `${EVENT_ID}@2026-02-31T09:01:00.000Z`],
    ['trailing junk', `${EVENT_ID}@${INSTANT}&x=1`],
    ['an oversized string', `${EVENT_ID}@${INSTANT}${'0'.repeat(200)}`],
  ])('rejects %s', (_label, value) => {
    expect(parseOccurrenceId(value)).toBeNull();
  });
});
