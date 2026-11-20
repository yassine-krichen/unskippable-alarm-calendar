import { PRAYER_LATER_MINUTES } from '@alarm-calendar/core';
import type { CantNowChoice } from '@alarm-calendar/core';

import { parseOccurrenceId } from './alarm-ipc';

export interface LaterRequest {
  occurrenceId: string;
  minutes: number;
}

export interface CantNowRequest {
  occurrenceId: string;
  /** The variant of the button the person pressed (what the screen showed). */
  shown: CantNowChoice;
}

/**
 * The payload of the alarm window's Later call: exactly an occurrence id and one of the preset minutes. Kept out
 * of alarm-ipc.ts because that file is bundled into the preload, which must not pull in core's prayer code.
 * Null for anything else (the renderer is not trusted).
 */
export function parseLaterRequest(payload: unknown): LaterRequest | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { occurrenceId, minutes } = payload as Record<string, unknown>;
  if (parseOccurrenceId(occurrenceId) === null) return null;
  if (typeof minutes !== 'number' || !Number.isInteger(minutes) || !PRAYER_LATER_MINUTES.includes(minutes)) return null;
  return { occurrenceId: occurrenceId as string, minutes };
}

/** The payload of the Can't now call: an occurrence id and the variant that was on the button. Null for anything else. */
export function parseCantNowRequest(payload: unknown): CantNowRequest | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { occurrenceId, shown } = payload as Record<string, unknown>;
  if (parseOccurrenceId(occurrenceId) === null) return null;
  if (shown !== 'until_last_call' && shown !== 'give_up') return null;
  return { occurrenceId: occurrenceId as string, shown };
}
