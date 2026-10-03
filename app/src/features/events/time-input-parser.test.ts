import { describe, expect, it } from 'vitest';

import { parseTimeInput } from './time-input-parser';

describe('parseTimeInput', () => {
  it.each([
    ['08:30', '08:30'],
    ['8:30', '08:30'],
    ['830', '08:30'],
    ['0830', '08:30'],
    ['8', '08:00'],
    ['20:15', '20:15'],
    ['00:00', '00:00'],
    ['23:59', '23:59'],
    ['8:30 pm', '20:30'],
    ['8PM', '20:00'],
    ['12am', '00:00'],
    ['12:05 pm', '12:05'],
    ['  7:05 a ', '07:05'],
  ])('reads %j as %s', (typed, expected) => {
    expect(parseTimeInput(typed)).toBe(expected);
  });

  it.each(['', 'abc', '24:00', '8:60', '13pm', '0pm', '8:3', '1:2:3'])('rejects %j', (typed) => {
    expect(parseTimeInput(typed)).toBeNull();
  });
});
