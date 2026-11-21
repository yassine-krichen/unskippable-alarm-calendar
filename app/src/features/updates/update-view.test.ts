import { describe, expect, it } from 'vitest';

import { downloadPercent, formatMegabytes, lastCheckedLabel } from './update-view';

describe('formatMegabytes', () => {
  it('shows one decimal', () => {
    expect(formatMegabytes(5_452_595)).toBe('5.2 MB');
    expect(formatMegabytes(1024 * 1024)).toBe('1.0 MB');
  });

  it('handles empty and tiny sizes', () => {
    expect(formatMegabytes(0)).toBe('0 MB');
    expect(formatMegabytes(1000)).toBe('<0.1 MB');
  });
});

describe('downloadPercent', () => {
  it('is whole percent of what is known', () => {
    expect(downloadPercent({ received: 25, total: 100 })).toBe(25);
    expect(downloadPercent({ received: 1, total: 3 })).toBe(33);
  });

  it('is 0 while the size is unknown or nothing started, and never above 100', () => {
    expect(downloadPercent(null)).toBe(0);
    expect(downloadPercent({ received: 50, total: 0 })).toBe(0);
    expect(downloadPercent({ received: 150, total: 100 })).toBe(100);
  });
});

describe('lastCheckedLabel', () => {
  const now = 1_800_000_000_000;

  it('says never when there was no check', () => {
    expect(lastCheckedLabel(null, now)).toBe('Not checked yet');
  });

  it('reports minutes, hours and days', () => {
    expect(lastCheckedLabel(now - 10_000, now)).toBe('Checked just now');
    expect(lastCheckedLabel(now - 5 * 60_000, now)).toBe('Checked 5 min ago');
    expect(lastCheckedLabel(now - 3 * 3_600_000, now)).toBe('Checked 3 h ago');
    expect(lastCheckedLabel(now - 50 * 3_600_000, now)).toBe('Checked 2 d ago');
  });
});
