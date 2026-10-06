import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowLeftIcon, LogOutIcon, MoonIcon, ShieldAlertIcon, SlidersHorizontalIcon, SunIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';

import { useTheme } from '@/components/theme-provider';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@/components/ui/combobox';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { signOut } from '@/features/auth/auth-api';
import { useAuthStore } from '@/features/auth/auth-store';
import { detectPlatform } from '@/lib/platform';

import { prayerFormToPatch, prayerFormValues } from './prayer-settings';
import { PrayerSettingsSection } from './prayer-settings-section';
import {
  GRACE_OPTIONS,
  REFIRE_OPTIONS,
  SOUND_OPTIONS,
  WEEK_START_OPTIONS,
  listTimeZones,
  minutes,
  seconds,
  settingsFormSchema,
  withCurrentOption,
  type Option,
  type SettingsFormValues,
} from './settings-options';
import { saveSettings, useSettingsStore } from './settings-store';
import { getSoundId, setSoundId as saveSoundId } from './sound-preference';

function labelFor(options: readonly Option[], value: number): string {
  return options.find((option) => option.value === value)?.label ?? String(value);
}

/** Settings: how time, weeks and alarms behave, plus appearance and the account. */
export function SettingsPage() {
  const navigate = useNavigate();
  const settings = useSettingsStore((state) => state.settings);
  const email = useAuthStore((state) => state.session?.user.email ?? null);
  const userId = useAuthStore((state) => state.session?.user.id ?? null);
  const { theme, setTheme } = useTheme();
  const platform = detectPlatform();
  const [signingOut, setSigningOut] = useState(false);
  const [soundId, setSoundId] = useState(getSoundId);
  const desktop = platform === 'electron' ? window.desktopApi : undefined;
  // Null until the desktop app answers; the switch stays disabled meanwhile.
  const [autostart, setAutostart] = useState<boolean | null>(null);

  useEffect(() => {
    if (desktop === undefined) return;
    let cancelled = false;
    desktop
      .getAutostart()
      .then((enabled) => {
        if (!cancelled) setAutostart(enabled);
      })
      .catch(() => {
        if (!cancelled) toast.error("Couldn't read the start-with-computer setting.");
      });
    return () => {
      cancelled = true;
    };
  }, [desktop]);

  const form = useForm<SettingsFormValues>({
    resolver: zodResolver(settingsFormSchema),
    defaultValues: settings
      ? {
          timezone: settings.timezone,
          weekStartsOn: settings.week_starts_on,
          refireSeconds: settings.refire_seconds,
          graceMinutes: settings.grace_minutes,
          ...prayerFormValues(settings),
        }
      : undefined,
    mode: 'onTouched',
  });

  const timeZones = useMemo(() => listTimeZones(settings?.timezone ?? 'UTC'), [settings?.timezone]);
  const refireOptions = useMemo(
    () => withCurrentOption(REFIRE_OPTIONS, settings?.refire_seconds ?? 120, seconds),
    [settings?.refire_seconds]
  );
  const graceOptions = useMemo(
    () => withCurrentOption(GRACE_OPTIONS, settings?.grace_minutes ?? 30, minutes),
    [settings?.grace_minutes]
  );

  if (!settings || userId === null) return null;

  async function onSubmit(values: SettingsFormValues): Promise<void> {
    if (userId === null) return;
    // UPDATE, never upsert: pass_cap and user_id are not client-writable.
    const result = await saveSettings(userId, {
      timezone: values.timezone,
      week_starts_on: values.weekStartsOn,
      refire_seconds: values.refireSeconds,
      grace_minutes: values.graceMinutes,
      ...prayerFormToPatch(values),
    });
    if (result.error !== null) {
      toast.error("Couldn't save your settings. Your changes are still here, try again.");
      return;
    }
    form.reset(values);
    toast.success('Settings saved');
  }

  async function onSignOut(): Promise<void> {
    setSigningOut(true);
    const result = await signOut();
    setSigningOut(false);
    if (result.error !== null) toast.error("Couldn't sign out. Check your connection and try again.");
  }

  function onSoundChange(next: string): void {
    setSoundId(next);
    if (!saveSoundId(next)) {
      toast.error("Couldn't remember the sound on this device. The browser blocked storage.");
    }
  }

  async function onAutostartChange(next: boolean): Promise<void> {
    if (desktop === undefined) return;
    const previous = autostart;
    setAutostart(next);
    try {
      setAutostart(await desktop.setAutostart(next));
    } catch {
      setAutostart(previous);
      toast.error("Couldn't change the start-with-computer setting. Try again.");
    }
  }

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col">
      <header className="flex items-center gap-2 border-b px-4 py-2 pt-[max(0.5rem,env(safe-area-inset-top))] sm:px-6">
        <Button variant="ghost" size="icon" aria-label="Back to calendar" onClick={() => navigate('/')}>
          <ArrowLeftIcon />
        </Button>
        <h1 className="text-lg font-semibold tracking-tight">Settings</h1>
      </header>

      <form
        noValidate
        onSubmit={(event) => void form.handleSubmit(onSubmit)(event)}
        className="flex flex-1 flex-col gap-8 px-4 py-6 pb-28 sm:px-6"
      >
        <FieldSet>
          <FieldLegend>Time and week</FieldLegend>
          <FieldGroup>
            <Controller
              name="timezone"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="settings-timezone">Time zone</FieldLabel>
                  <Combobox
                    items={timeZones}
                    value={field.value}
                    onValueChange={(next) => {
                      if (next !== null) field.onChange(next);
                    }}
                  >
                    <ComboboxInput
                      id="settings-timezone"
                      placeholder="Search time zones"
                      aria-invalid={fieldState.invalid}
                      className="w-full"
                    />
                    <ComboboxContent>
                      <ComboboxEmpty>No time zone matches that.</ComboboxEmpty>
                      <ComboboxList>
                        {(zone: string) => (
                          <ComboboxItem key={zone} value={zone}>
                            {zone}
                          </ComboboxItem>
                        )}
                      </ComboboxList>
                    </ComboboxContent>
                  </Combobox>
                  <FieldDescription>
                    Event times are entered and shown in this zone. Passes follow it too, and a new zone
                    can take up to a week to reach your pass schedule.
                  </FieldDescription>
                  {fieldState.invalid ? <FieldError errors={[fieldState.error]} /> : null}
                </Field>
              )}
            />

            <Controller
              name="weekStartsOn"
              control={form.control}
              render={({ field }) => (
                <Field>
                  <FieldLabel htmlFor="settings-week-start">Week starts on</FieldLabel>
                  <Select
                    value={field.value}
                    items={WEEK_START_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
                    onValueChange={(next) => {
                      if (typeof next === 'number') field.onChange(next);
                    }}
                  >
                    <SelectTrigger id="settings-week-start" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {WEEK_START_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FieldDescription>Sets the calendar's first column and when you get a new pass.</FieldDescription>
                </Field>
              )}
            />
          </FieldGroup>
        </FieldSet>

        <Separator />

        <FieldSet>
          <FieldLegend>Alarms</FieldLegend>
          <FieldGroup>
            <Controller
              name="refireSeconds"
              control={form.control}
              render={({ field }) => (
                <Field>
                  <FieldLabel htmlFor="settings-refire">Ring again after</FieldLabel>
                  <Select
                    value={field.value}
                    items={refireOptions.map((option) => ({ value: option.value, label: option.label }))}
                    onValueChange={(next) => {
                      if (typeof next === 'number') field.onChange(next);
                    }}
                  >
                    <SelectTrigger id="settings-refire" className="w-full">
                      <SelectValue>{(value: number) => labelFor(refireOptions, value)}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {refireOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FieldDescription>
                    If an alarm is closed without Done or Snooze, it comes back after this long.
                  </FieldDescription>
                </Field>
              )}
            />

            <Controller
              name="graceMinutes"
              control={form.control}
              render={({ field }) => (
                <Field>
                  <FieldLabel htmlFor="settings-grace">Late alarm window</FieldLabel>
                  <Select
                    value={field.value}
                    items={graceOptions.map((option) => ({ value: option.value, label: option.label }))}
                    onValueChange={(next) => {
                      if (typeof next === 'number') field.onChange(next);
                    }}
                  >
                    <SelectTrigger id="settings-grace" className="w-full">
                      <SelectValue>{(value: number) => labelFor(graceOptions, value)}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {graceOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FieldDescription>
                    If the device was off or asleep, an alarm missed by less than this still rings when it
                    wakes. Older ones are skipped.
                  </FieldDescription>
                </Field>
              )}
            />

            <Field>
              <FieldLabel htmlFor="settings-sound">Alarm sound</FieldLabel>
              <Select
                value={soundId}
                items={SOUND_OPTIONS.map((option) => ({ value: option.id, label: option.label }))}
                onValueChange={(next) => {
                  if (typeof next === 'string') onSoundChange(next);
                }}
              >
                <SelectTrigger id="settings-sound" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SOUND_OPTIONS.map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>
                Remembered on this device only.
              </FieldDescription>
            </Field>
          </FieldGroup>
        </FieldSet>

        <Separator />

        <PrayerSettingsSection form={form} settings={settings} />

        <Separator />

        <FieldSet>
          <FieldLegend>Modes</FieldLegend>
          <Field orientation="horizontal">
            <div className="flex flex-1 flex-col gap-1">
              <FieldLabel>Exam, Ramadan, Vacation, Sick and your own</FieldLabel>
              <FieldDescription>
                Pause, move or shorten alarms for a while. Switch one on from the calendar header, or plan it ahead.
              </FieldDescription>
            </div>
            <Button type="button" variant="outline" onClick={() => navigate('/modes')}>
              <SlidersHorizontalIcon data-icon="inline-start" />
              Manage modes
            </Button>
          </Field>
        </FieldSet>

        <Separator />

        <FieldSet>
          <FieldLegend>Appearance</FieldLegend>
          <Field>
            <FieldLabel id="settings-theme-label">Theme</FieldLabel>
            <ToggleGroup
              variant="outline"
              aria-labelledby="settings-theme-label"
              value={[theme]}
              onValueChange={(next) => {
                const chosen = next[0];
                if (chosen === 'light' || chosen === 'dark') setTheme(chosen);
              }}
            >
              <ToggleGroupItem value="dark" className="aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-pressed:hover:bg-primary/80">
                <MoonIcon data-icon="inline-start" />
                Dark
              </ToggleGroupItem>
              <ToggleGroupItem value="light" className="aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-pressed:hover:bg-primary/80">
                <SunIcon data-icon="inline-start" />
                Light
              </ToggleGroupItem>
            </ToggleGroup>
          </Field>
        </FieldSet>

        {platform === 'electron' ? (
          <>
            <Separator />
            <FieldSet>
              <FieldLegend>This computer</FieldLegend>
              <Field orientation="horizontal">
                <div className="flex flex-1 flex-col gap-1">
                  <FieldLabel htmlFor="settings-autostart">Start with the computer</FieldLabel>
                  <FieldDescription>Runs in the tray so alarms ring even with the window closed.</FieldDescription>
                </div>
                <Switch
                  id="settings-autostart"
                  checked={autostart ?? false}
                  disabled={autostart === null}
                  onCheckedChange={(next) => void onAutostartChange(next)}
                />
              </Field>
            </FieldSet>
          </>
        ) : null}

        {platform === 'android' ? (
          <>
            <Separator />
            <FieldSet>
              <FieldLegend>Permissions</FieldLegend>
              {/* Placeholder: statuses come from AlarmAdapter.getPermissionStatus in the adapters step. */}
              <Alert>
                <ShieldAlertIcon />
                <AlertTitle>Alarm permissions</AlertTitle>
                <AlertDescription>
                  Exact alarms, full-screen alerts, notifications and battery optimization show here once the
                  Android app is connected.
                </AlertDescription>
              </Alert>
            </FieldSet>
          </>
        ) : null}

        <Separator />

        <FieldSet>
          <FieldLegend>Account</FieldLegend>
          <div className="flex flex-wrap items-center gap-3">
            <p className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
              {email ? `Signed in as ${email}` : 'Signed in'}
            </p>
            <Button type="button" variant="outline" disabled={signingOut} onClick={() => void onSignOut()}>
              <LogOutIcon data-icon="inline-start" />
              Sign out
            </Button>
          </div>
        </FieldSet>

        <div className="fixed inset-x-0 bottom-0 border-t bg-background/95 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur sm:px-6">
          <div className="mx-auto flex w-full max-w-2xl items-center gap-3">
            <p className="flex-1 text-sm text-muted-foreground" aria-live="polite">
              {form.formState.isDirty ? 'You have unsaved changes.' : 'All changes saved.'}
            </p>
            <Button type="submit" disabled={!form.formState.isDirty || form.formState.isSubmitting}>
              Save changes
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
