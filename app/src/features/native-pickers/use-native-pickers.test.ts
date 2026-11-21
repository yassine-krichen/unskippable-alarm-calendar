import { describe, expect, it, vi } from 'vitest';

import type { NativePickersPlugin } from './native-pickers-plugin';
import { canUseNativePickers, createNativePickerApi } from './use-native-pickers';

describe('canUseNativePickers', () => {
  it('is on only in the Android app', () => {
    expect(canUseNativePickers({ platform: 'android', nativePlatform: true })).toBe(true);
  });

  it('stays off for a page that only looks like Android, with no Capacitor shell around it', () => {
    expect(canUseNativePickers({ platform: 'android', nativePlatform: false })).toBe(false);
  });

  it('stays off on the desktop and the web, whatever else is around', () => {
    expect(canUseNativePickers({ platform: 'electron', nativePlatform: true })).toBe(false);
    expect(canUseNativePickers({ platform: 'web', nativePlatform: true })).toBe(false);
    expect(canUseNativePickers({ platform: 'web', nativePlatform: false })).toBe(false);
  });
});

function fakePlugin(answer: { value?: string; cancelled?: boolean } | Error): NativePickersPlugin {
  const respond = () => (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer));
  return { pickTime: vi.fn(respond), pickDate: vi.fn(respond) };
}

describe('createNativePickerApi', () => {
  it('asks the time dialog to open on the field and hands back what was picked', async () => {
    const plugin = fakePlugin({ value: '17:45' });
    const api = createNativePickerApi(plugin, true, true);
    expect(await api.pickTime('8:30 pm')).toBe('17:45');
    expect(plugin.pickTime).toHaveBeenCalledWith({ value: '20:30', dark: true });
  });

  it('opens the date dialog on today for an empty field and passes only valid bounds', async () => {
    const plugin = fakePlugin({ value: '2026-12-24' });
    const api = createNativePickerApi(plugin, false, true);
    const picked = await api.pickDate({ value: '', today: '2026-11-21', min: '2026-11-21', max: 'later' });
    expect(picked).toBe('2026-12-24');
    expect(plugin.pickDate).toHaveBeenCalledWith({ value: '2026-11-21', min: '2026-11-21', dark: false });
  });

  it('answers null when the dialog is cancelled, so the field keeps its value', async () => {
    const api = createNativePickerApi(fakePlugin({ cancelled: true }), false, true);
    expect(await api.pickTime('09:00')).toBeNull();
    expect(await api.pickDate({ value: '2026-11-21', today: '2026-11-21' })).toBeNull();
  });

  it('opens one dialog at a time: a second request while one is open does nothing and reaches no plugin', async () => {
    let finish: (answer: { value: string }) => void = () => undefined;
    const slow = new Promise<{ value: string }>((resolve) => {
      finish = resolve;
    });
    const plugin: NativePickersPlugin = { pickTime: vi.fn(() => slow), pickDate: vi.fn(() => slow) };
    const api = createNativePickerApi(plugin, false, true);

    const first = api.pickTime('09:00');
    expect(await api.pickTime('10:00')).toBeNull();
    expect(await api.pickDate({ value: '2026-11-21', today: '2026-11-21' })).toBeNull();
    expect(plugin.pickTime).toHaveBeenCalledTimes(1);
    expect(plugin.pickDate).not.toHaveBeenCalled();

    finish({ value: '09:30' });
    expect(await first).toBe('09:30');
    // and once it is closed, the next request goes through again
    const next = createNativePickerApi(fakePlugin({ value: '11:00' }), false, true);
    expect(await next.pickTime('09:00')).toBe('11:00');
  });

  it('answers null and logs when the plugin fails, instead of throwing into the form', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const api = createNativePickerApi(fakePlugin(new Error('boom')), false, true);
    expect(await api.pickTime('09:00')).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
