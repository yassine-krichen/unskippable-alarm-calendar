import { describe, expect, it } from 'vitest';

import { alarmPanelBounds, type Rect } from './alarm-bounds';

// A second display to the right of the primary one, with a taskbar-sized strip taken off the top.
const WORK_AREA: Rect = { x: 1920, y: 40, width: 1600, height: 900 };

describe('alarmPanelBounds', () => {
  it('centers the 560x440 panel in the work area, offsets of the display included', () => {
    expect(alarmPanelBounds(WORK_AREA, 0)).toEqual({ x: 2440, y: 270, width: 560, height: 440 });
  });

  it('shrinks to 90% of a work area that is smaller than the panel', () => {
    const small: Rect = { x: 0, y: 0, width: 400, height: 300 };
    expect(alarmPanelBounds(small, 0)).toEqual({ x: 20, y: 15, width: 360, height: 270 });
  });

  it('cascades each further simultaneous alarm down and right', () => {
    const first = alarmPanelBounds(WORK_AREA, 0);
    const second = alarmPanelBounds(WORK_AREA, 1);
    const third = alarmPanelBounds(WORK_AREA, 2);

    expect(second).toEqual({ ...first, x: first.x + 36, y: first.y + 36 });
    expect(third).toEqual({ ...first, x: first.x + 72, y: first.y + 72 });
  });

  it('wraps back to the centered slot after five alarms', () => {
    expect(alarmPanelBounds(WORK_AREA, 4).x).toBe(alarmPanelBounds(WORK_AREA, 0).x + 144);
    expect(alarmPanelBounds(WORK_AREA, 5)).toEqual(alarmPanelBounds(WORK_AREA, 0));
    expect(alarmPanelBounds(WORK_AREA, 7)).toEqual(alarmPanelBounds(WORK_AREA, 2));
  });

  it('keeps a cascaded panel inside a small work area', () => {
    const small: Rect = { x: 0, y: 0, width: 400, height: 300 };
    const last = alarmPanelBounds(small, 4);

    expect(last.x + last.width).toBeLessThanOrEqual(small.width);
    expect(last.y + last.height).toBeLessThanOrEqual(small.height);
  });
});
