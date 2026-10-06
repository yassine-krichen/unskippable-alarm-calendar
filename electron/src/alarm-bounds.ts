export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const ALARM_PANEL_WIDTH = 560;
export const ALARM_PANEL_HEIGHT = 440;
/** Never more than this share of the work area, so the panel fits small displays. */
const MAX_WORK_AREA_SHARE = 0.9;
/** Each further ringing alarm sits this far down and right of the previous one. */
const CASCADE_STEP = 36;
const CASCADE_SLOTS = 5;

/**
 * Where an alarm panel goes: centered in the work area, with every additional
 * simultaneous alarm cascaded so a stack of panels never hides each other exactly.
 * The cascade wraps after a few slots so it cannot walk off the screen.
 */
export function alarmPanelBounds(workArea: Rect, openAlarms: number): Rect {
  const width = Math.min(ALARM_PANEL_WIDTH, Math.floor(workArea.width * MAX_WORK_AREA_SHARE));
  const height = Math.min(ALARM_PANEL_HEIGHT, Math.floor(workArea.height * MAX_WORK_AREA_SHARE));
  const offset = (openAlarms % CASCADE_SLOTS) * CASCADE_STEP;
  // Centered block of the cascade: slot 0 is the exact center, later slots drift down-right.
  const x = workArea.x + Math.round((workArea.width - width) / 2) + offset;
  const y = workArea.y + Math.round((workArea.height - height) / 2) + offset;
  return {
    x: Math.min(x, workArea.x + workArea.width - width),
    y: Math.min(y, workArea.y + workArea.height - height),
    width,
    height,
  };
}
