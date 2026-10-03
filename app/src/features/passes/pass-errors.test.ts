import { describe, expect, it } from 'vitest';

import { passErrorMessage } from './pass-errors';

describe('passErrorMessage', () => {
  it.each([
    'no_passes_left',
    'day_in_past',
    'already_cheat_day',
    'not_a_cheat_day',
    'day_not_in_future',
    'invalid_day',
    'not_authenticated',
  ])('maps %s to a sentence a person can act on', (code) => {
    const message = passErrorMessage(code);
    expect(message).not.toContain('_');
    expect(message.length).toBeGreaterThan(20);
  });

  it('says what each failure means', () => {
    expect(passErrorMessage('no_passes_left')).toMatch(/no passes left/i);
    expect(passErrorMessage('day_in_past')).toMatch(/already passed/i);
    expect(passErrorMessage('already_cheat_day')).toMatch(/already a cheat day/i);
    expect(passErrorMessage('day_not_in_future')).toMatch(/once the day has begun/i);
    expect(passErrorMessage('not_authenticated')).toMatch(/sign in/i);
  });

  it('gives each code its own message', () => {
    const codes = ['no_passes_left', 'day_in_past', 'already_cheat_day', 'not_a_cheat_day', 'day_not_in_future', 'invalid_day', 'not_authenticated'];
    expect(new Set(codes.map(passErrorMessage)).size).toBe(codes.length);
  });

  it('explains a network failure instead of showing the raw error', () => {
    expect(passErrorMessage('TypeError: Failed to fetch')).toMatch(/reach the server/i);
  });

  it('falls back to a generic message and never leaks an unknown raw error', () => {
    const message = passErrorMessage('duplicate key value violates unique constraint "cheat_days_pkey"');
    expect(message).toMatch(/something went wrong/i);
    expect(message).not.toContain('cheat_days_pkey');
  });
});
