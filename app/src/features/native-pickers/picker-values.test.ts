import { describe, expect, it } from 'vitest';

import { DEFAULT_PICKER_TIME, dateToPick, isPlainDate, pickedValue, timeToPick } from './picker-values';

describe('timeToPick', () => {
  it('opens on the time the field holds, normalized to HH:mm', () => {
    expect(timeToPick('08:30')).toBe('08:30');
    expect(timeToPick('8')).toBe('08:00');
    expect(timeToPick('830')).toBe('08:30');
    expect(timeToPick('8:30 pm')).toBe('20:30');
  });

  it('falls back to the default when the field holds nothing usable', () => {
    expect(timeToPick('')).toBe(DEFAULT_PICKER_TIME);
    expect(timeToPick('25:99')).toBe(DEFAULT_PICKER_TIME);
    expect(timeToPick('soon')).toBe(DEFAULT_PICKER_TIME);
  });
});

describe('isPlainDate and dateToPick', () => {
  it('accepts real days and rejects the rest, so a value round-trips as written', () => {
    expect(isPlainDate('2026-11-21')).toBe(true);
    expect(isPlainDate('2028-02-29')).toBe(true);
    expect(isPlainDate('2026-02-29')).toBe(false);
    expect(isPlainDate('2026-13-01')).toBe(false);
    expect(isPlainDate('2026-1-1')).toBe(false);
    expect(isPlainDate('')).toBe(false);
  });

  it('opens the date dialog on the field, else on today', () => {
    expect(dateToPick('2026-12-01', '2026-11-21')).toBe('2026-12-01');
    expect(dateToPick('', '2026-11-21')).toBe('2026-11-21');
    expect(dateToPick('nonsense', '2026-11-21')).toBe('2026-11-21');
  });
});

describe('pickedValue', () => {
  const always = () => true;

  it('returns the picked value', () => {
    expect(pickedValue({ value: '09:15' }, always)).toBe('09:15');
  });

  it('returns null for a cancelled dialog, which must change nothing', () => {
    expect(pickedValue({ cancelled: true }, always)).toBeNull();
    expect(pickedValue({ cancelled: true, value: '09:15' }, always)).toBeNull();
  });

  it('returns null for an answer that is not a usable value', () => {
    expect(pickedValue({}, always)).toBeNull();
    expect(pickedValue({ value: 'x' }, () => false)).toBeNull();
  });
});
