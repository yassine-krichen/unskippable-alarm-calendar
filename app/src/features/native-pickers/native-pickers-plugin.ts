import { registerPlugin } from '@capacitor/core';

/** The answer of both dialogs: the picked value, or `cancelled` when it was dismissed. */
export interface NativePickerAnswer {
  value?: string;
  cancelled?: boolean;
}

/** The JSON contract of the local Kotlin plugin (android/.../pickers/NativePickersPlugin.kt). */
export interface NativePickersPlugin {
  /** 'HH:mm' in, 'HH:mm' out. `dark` is the app's own theme, which is separate from the phone's. */
  pickTime(options: { value: string; dark: boolean }): Promise<NativePickerAnswer>;
  /** 'yyyy-MM-dd' in and out; `min` and `max` are inclusive and optional. */
  pickDate(options: { value: string; min?: string; max?: string; dark: boolean }): Promise<NativePickerAnswer>;
}

/** Only call it inside the Android app (see use-native-pickers.ts): there is no web implementation. */
export const NativePickers = registerPlugin<NativePickersPlugin>('NativePickers');
