import { Capacitor } from '@capacitor/core';
import { useCallback } from 'react';

import { useTheme } from '@/components/theme-provider';
import { detectPlatform, type Platform } from '@/lib/platform';

import { NativePickers, type NativePickersPlugin } from './native-pickers-plugin';
import { dateToPick, isPlainDate, pickedValue, timeToPick } from './picker-values';

export interface PickerEnvironment {
  platform?: Platform;
  /** Whether the app runs inside the Capacitor shell (a browser page with Capacitor loaded is not); injectable for tests. */
  nativePlatform?: boolean;
}

/**
 * Whether the platform time and date dialogs are used: only inside the Android app. The desktop and the web keep
 * the text time field and the Popover calendar. Both conditions are needed, as for the alarm adapter: a page that
 * only looks like Android (no Capacitor shell, so no plugin) must not call into it.
 */
export function canUseNativePickers(environment: PickerEnvironment = {}): boolean {
  const platform = environment.platform ?? detectPlatform();
  return platform === 'android' && (environment.nativePlatform ?? Capacitor.isNativePlatform());
}

export interface DatePickOptions {
  /** The field's 'yyyy-MM-dd' ('' for none). */
  value: string;
  /** What to open on when the field is empty. */
  today: string;
  min?: string;
  max?: string;
}

export interface NativePickerApi {
  available: boolean;
  /** Opens the time dialog on the field's time; resolves the picked 'HH:mm', or null when cancelled or it failed. */
  pickTime: (fieldValue: string) => Promise<string | null>;
  /** Opens the date dialog; resolves the picked 'yyyy-MM-dd', or null when cancelled or it failed. */
  pickDate: (options: DatePickOptions) => Promise<string | null>;
}

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

// One dialog at a time: a second tap (or a second field) while one is open does nothing, so dialogs never stack
// and one pick can never be answered into another field. The Kotlin plugin refuses a second one as well.
let dialogOpen = false;

async function exclusive(open: () => Promise<string | null>): Promise<string | null> {
  if (dialogOpen) return null;
  dialogOpen = true;
  try {
    return await open();
  } finally {
    dialogOpen = false;
  }
}

/** The plugin calls, separated from React so a test can hand in a fake plugin. */
export function createNativePickerApi(plugin: NativePickersPlugin, dark: boolean, available: boolean): NativePickerApi {
  return {
    available,
    pickTime(fieldValue) {
      return exclusive(async () => {
        try {
          const answer = await plugin.pickTime({ value: timeToPick(fieldValue), dark });
          return pickedValue(answer, (value) => TIME_PATTERN.test(value));
        } catch (error: unknown) {
          console.warn('The time dialog failed:', error);
          return null;
        }
      });
    },
    pickDate({ value, today, min, max }) {
      return exclusive(async () => {
        try {
          const answer = await plugin.pickDate({
            value: dateToPick(value, today),
            ...(min !== undefined && isPlainDate(min) ? { min } : {}),
            ...(max !== undefined && isPlainDate(max) ? { max } : {}),
            dark,
          });
          return pickedValue(answer, isPlainDate);
        } catch (error: unknown) {
          console.warn('The date dialog failed:', error);
          return null;
        }
      });
    },
  };
}

/** The time and date dialogs of the phone, or `available: false` everywhere else. */
export function useNativePickers(): NativePickerApi {
  const { theme } = useTheme();
  const available = canUseNativePickers();
  // The same function identity per theme keeps the pickers' effects calm.
  const dark = theme === 'dark';
  const pickTime = useCallback((fieldValue: string) => createNativePickerApi(NativePickers, dark, available).pickTime(fieldValue), [dark, available]);
  const pickDate = useCallback((options: DatePickOptions) => createNativePickerApi(NativePickers, dark, available).pickDate(options), [dark, available]);
  return { available, pickTime, pickDate };
}
