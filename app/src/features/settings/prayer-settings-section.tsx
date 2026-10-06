import type { CustomSoundInfo, Settings } from '@alarm-calendar/core';
import { FileAudioIcon, LocateFixedIcon, PlayIcon, SquareIcon, Trash2Icon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Controller, useWatch, type UseFormReturn } from 'react-hook-form';
import { toast } from 'sonner';

import { DecimalInput } from '@/components/decimal-input';
import { NumberStepper } from '@/components/number-stepper';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { CUSTOM_SOUND_ID, soundUrl } from '@/features/alarm/alarm-sounds';
import { detectPlatform } from '@/lib/platform';

import {
  OFFSET_FIELDS,
  PRE_PRAYER_OPTIONS,
  leadLabel,
  prayerPreview,
  roundCoordinates,
} from './prayer-settings';
import { SOUND_OPTIONS, withCurrentOption, type SettingsFormValues } from './settings-options';
import { switchPrayers } from './settings-store';
import { getPrayerSoundId, setPrayerSoundId } from './sound-preference';

const SAME_AS_ALARM = 'same';
const PREVIEW_MAX_MS = 8_000;

interface PrayerSettingsSectionProps {
  form: UseFormReturn<SettingsFormValues>;
  settings: Settings;
}

/**
 * Settings, "Prayer times": the switch, then (once on) where you are, how the times are worked out,
 * how the alarms behave and what they sound like. The switch acts at once because it creates or
 * hides the 10 prayer alarms; everything else is part of the page's form and saves with it. A live
 * line of today's five times follows the form, so a wrong location or angle is visible before saving.
 */
export function PrayerSettingsSection({ form, settings }: PrayerSettingsSectionProps) {
  const enabled = settings.prayers_enabled === true;
  const [switching, setSwitching] = useState(false);
  const values = useWatch({ control: form.control });
  const desktop = detectPlatform() === 'electron' ? window.desktopApi : undefined;
  // The desktop shell denies every web permission request, so its location button could never work.
  const canLocate = desktop === undefined && typeof navigator !== 'undefined' && 'geolocation' in navigator;

  // Cheap (five astronomical calculations), and `values` re-renders this on every edit.
  const preview = prayerPreview(form.getValues(), settings.timezone);
  const placeName = (values.locationLabel ?? '').trim();
  const leadOptions = useMemo(
    () => withCurrentOption(PRE_PRAYER_OPTIONS, settings.pre_prayer_minutes ?? 15, leadLabel),
    [settings.pre_prayer_minutes]
  );

  async function onSwitch(next: boolean): Promise<void> {
    setSwitching(true);
    const result = await switchPrayers(next);
    setSwitching(false);
    if (result.error !== null) {
      toast.error(next ? "Couldn't switch prayer alarms on. Try again." : "Couldn't switch prayer alarms off. Try again.");
      return;
    }
    toast.success(next ? 'Prayer alarms are on' : 'Prayer alarms are off');
  }

  function locateMe(): void {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude } = roundCoordinates(position.coords);
        const options = { shouldDirty: true, shouldValidate: true };
        form.setValue('latitude', latitude, options);
        form.setValue('longitude', longitude, options);
        if (form.getValues('locationLabel').trim() === '') form.setValue('locationLabel', 'My location', options);
      },
      (error) =>
        toast.error(
          error.code === error.PERMISSION_DENIED
            ? 'Location access is blocked. Enter the coordinates instead.'
            : "Couldn't find your location. Enter the coordinates instead."
        ),
      { timeout: 10_000, maximumAge: 60_000 }
    );
  }

  return (
    <FieldSet>
      <FieldLegend>Prayer times</FieldLegend>
      <Field orientation="horizontal">
        <div className="flex flex-1 flex-col gap-1">
          <FieldLabel htmlFor="settings-prayers">Prayer alarms</FieldLabel>
          <FieldDescription>
            {enabled
              ? 'Five alarms a day with a reminder before each. Cheat days never silence them.'
              : 'Adds Fajr, Dhuhr, Asr, Maghrib and Isha as alarms, with a reminder before each. Worked out on this device, no internet needed.'}
          </FieldDescription>
        </div>
        <Switch
          id="settings-prayers"
          checked={enabled}
          disabled={switching}
          onCheckedChange={(next) => void onSwitch(next)}
        />
      </Field>

      {enabled ? (
        <FieldGroup>
          <Controller
            name="showInCalendar"
            control={form.control}
            render={({ field }) => (
              <Field orientation="horizontal">
                <div className="flex flex-1 flex-col gap-1">
                  <FieldLabel htmlFor="settings-prayers-in-calendar">Show prayers in calendar</FieldLabel>
                  <FieldDescription>
                    Off by default: the prayers ring either way and still count in your ranks. The calendar&apos;s
                    &quot;Show hidden&quot; toggle reveals them.
                  </FieldDescription>
                </div>
                <Switch
                  id="settings-prayers-in-calendar"
                  checked={field.value}
                  onCheckedChange={(next) => field.onChange(next)}
                />
              </Field>
            )}
          />

          <div className="flex flex-col gap-2 rounded-lg border bg-muted/40 p-3" aria-live="polite">
            <p className="text-sm font-medium">
              Today{placeName !== '' ? ` in ${placeName}` : ''}
            </p>
            {preview === null ? (
              <p className="text-sm text-muted-foreground">Fix the highlighted fields to see today&apos;s times.</p>
            ) : (
              <ul className="flex flex-wrap gap-x-5 gap-y-1 text-sm tabular-nums">
                {preview.map((row) => (
                  <li key={row.prayer}>
                    <span className="text-muted-foreground">{row.label}</span> {row.time}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <FieldSet>
            <FieldLegend variant="label">Location</FieldLegend>
            <Controller
              name="locationLabel"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="settings-location-label">Place name</FieldLabel>
                  <Input
                    id="settings-location-label"
                    autoComplete="off"
                    placeholder="Ariana, Tunisia"
                    aria-invalid={fieldState.invalid}
                    value={field.value}
                    onChange={(event) => field.onChange(event.target.value)}
                    onBlur={field.onBlur}
                  />
                  {fieldState.invalid ? <FieldError errors={[fieldState.error]} /> : null}
                </Field>
              )}
            />
            <div className="grid grid-cols-2 gap-3">
              <Controller
                name="latitude"
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="settings-latitude">Latitude</FieldLabel>
                    <DecimalInput
                      id="settings-latitude"
                      value={field.value}
                      onChange={field.onChange}
                      placeholder="36.8625"
                      invalid={fieldState.invalid}
                    />
                    {fieldState.invalid ? <FieldError errors={[fieldState.error]} /> : null}
                  </Field>
                )}
              />
              <Controller
                name="longitude"
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="settings-longitude">Longitude</FieldLabel>
                    <DecimalInput
                      id="settings-longitude"
                      value={field.value}
                      onChange={field.onChange}
                      placeholder="10.1956"
                      invalid={fieldState.invalid}
                    />
                    {fieldState.invalid ? <FieldError errors={[fieldState.error]} /> : null}
                  </Field>
                )}
              />
            </div>
            <FieldDescription>
              Degrees, north and east are positive.{canLocate ? '' : ' Look them up on a map for your place.'} The
              times are shown in your time zone above.
            </FieldDescription>
            {canLocate ? (
              <Button type="button" variant="outline" className="w-fit" onClick={locateMe}>
                <LocateFixedIcon data-icon="inline-start" />
                Use my location
              </Button>
            ) : null}
          </FieldSet>

          <FieldSet>
            <FieldLegend variant="label">How the times are worked out</FieldLegend>
            <div className="grid grid-cols-2 gap-3">
              <Controller
                name="fajrAngle"
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="settings-fajr-angle">Fajr angle</FieldLabel>
                    <DecimalInput id="settings-fajr-angle" value={field.value} onChange={field.onChange} invalid={fieldState.invalid} />
                    {fieldState.invalid ? <FieldError errors={[fieldState.error]} /> : null}
                  </Field>
                )}
              />
              <Controller
                name="ishaAngle"
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="settings-isha-angle">Isha angle</FieldLabel>
                    <DecimalInput id="settings-isha-angle" value={field.value} onChange={field.onChange} invalid={fieldState.invalid} />
                    {fieldState.invalid ? <FieldError errors={[fieldState.error]} /> : null}
                  </Field>
                )}
              />
            </div>
            <FieldDescription>Degrees of the sun below the horizon. 18 is the Tunisian convention.</FieldDescription>
            <Controller
              name="asrFactor"
              control={form.control}
              render={({ field }) => (
                <Field>
                  <FieldLabel htmlFor="settings-asr-factor">Asr</FieldLabel>
                  <Select
                    value={field.value}
                    items={[
                      { value: 1, label: 'Standard (Maliki, Shafi, Hanbali)' },
                      { value: 2, label: 'Hanafi (later)' },
                    ]}
                    onValueChange={(next) => {
                      if (next === 1 || next === 2) field.onChange(next);
                    }}
                  >
                    <SelectTrigger id="settings-asr-factor" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={1}>Standard (Maliki, Shafi, Hanbali)</SelectItem>
                      <SelectItem value={2}>Hanafi (later)</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              )}
            />
          </FieldSet>

          <FieldSet>
            <FieldLegend variant="label">Adjust each time</FieldLegend>
            <FieldDescription>Minutes added to the calculated time, to match your mosque or local timetable. Negative is earlier.</FieldDescription>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {OFFSET_FIELDS.map(({ prayer, name }) => (
                <Controller
                  key={name}
                  name={name}
                  control={form.control}
                  render={({ field, fieldState }) => (
                    <Field data-invalid={fieldState.invalid}>
                      <FieldLabel htmlFor={`settings-offset-${prayer}`} className="capitalize">
                        {prayer}
                      </FieldLabel>
                      <NumberStepper
                        id={`settings-offset-${prayer}`}
                        label={`${prayer} adjustment`}
                        value={field.value}
                        onChange={field.onChange}
                        min={-60}
                        max={60}
                        unit="min"
                        invalid={fieldState.invalid}
                      />
                      {fieldState.invalid ? <FieldError errors={[fieldState.error]} /> : null}
                    </Field>
                  )}
                />
              ))}
            </div>
          </FieldSet>

          <FieldSet>
            <FieldLegend variant="label">Reminders and snooze</FieldLegend>
            <Controller
              name="prePrayerMinutes"
              control={form.control}
              render={({ field }) => (
                <Field>
                  <FieldLabel htmlFor="settings-pre-prayer">Reminder before each prayer</FieldLabel>
                  <Select
                    value={field.value}
                    items={leadOptions.map((option) => ({ value: option.value, label: option.label }))}
                    onValueChange={(next) => {
                      if (typeof next === 'number') field.onChange(next);
                    }}
                  >
                    <SelectTrigger id="settings-pre-prayer" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {leadOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FieldDescription>
                    If the prayer before is not marked prayed, the reminder says so and how long you have.
                  </FieldDescription>
                </Field>
              )}
            />
            <Controller
              name="prayerMaxSnoozes"
              control={form.control}
              render={({ field }) => (
                <Field>
                  <FieldLabel htmlFor="settings-prayer-snoozes">Snoozes allowed</FieldLabel>
                  <NumberStepper
                    id="settings-prayer-snoozes"
                    label="prayer snoozes"
                    value={field.value}
                    onChange={field.onChange}
                    min={0}
                    max={10}
                  />
                  <FieldDescription>0 = no snooze, you answer on the spot.</FieldDescription>
                </Field>
              )}
            />
            {(values.prayerMaxSnoozes ?? 0) > 0 ? (
              <Controller
                name="prayerSnoozeMinutes"
                control={form.control}
                render={({ field }) => (
                  <Field>
                    <FieldLabel htmlFor="settings-prayer-snooze-minutes">Snooze length</FieldLabel>
                    <NumberStepper
                      id="settings-prayer-snooze-minutes"
                      label="prayer snooze length"
                      value={field.value}
                      onChange={field.onChange}
                      min={1}
                      max={120}
                      unit="min"
                    />
                  </Field>
                )}
              />
            ) : null}
          </FieldSet>

          <PrayerSoundField desktop={desktop} />
        </FieldGroup>
      ) : null}
    </FieldSet>
  );
}

/** The prayer alarms' sound: a bundled tone, or on desktop a file of your own (a takbir, for example). */
function PrayerSoundField({ desktop }: { desktop: Window['desktopApi'] }) {
  const [choice, setChoice] = useState<string>(() => getPrayerSoundId() ?? SAME_AS_ALARM);
  // undefined while the desktop app answers.
  const [custom, setCustom] = useState<CustomSoundInfo | null | undefined>(desktop === undefined ? null : undefined);
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const stopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const objectUrl = useRef<string | null>(null);

  useEffect(() => {
    if (desktop === undefined) return;
    let cancelled = false;
    desktop
      .getCustomSound()
      .then((info) => {
        if (!cancelled) setCustom(info);
      })
      .catch(() => {
        if (!cancelled) setCustom(null);
      });
    return () => {
      cancelled = true;
    };
  }, [desktop]);

  useEffect(() => () => stopPreview(), []);

  function stopPreview(): void {
    if (stopTimer.current !== null) clearTimeout(stopTimer.current);
    audioRef.current?.pause();
    audioRef.current = null;
    if (objectUrl.current !== null) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = null;
    setPlaying(false);
  }

  function apply(next: string): void {
    setChoice(next);
    if (!setPrayerSoundId(next === SAME_AS_ALARM ? null : next)) {
      toast.error("Couldn't remember the prayer sound on this device. The browser blocked storage.");
    }
  }

  async function chooseFile(): Promise<void> {
    if (desktop === undefined) return;
    try {
      const result = await desktop.chooseCustomSound();
      if (result.status === 'chosen') {
        setCustom(result.info);
        apply(CUSTOM_SOUND_ID);
        toast.success('Prayer sound set');
      } else if (result.status === 'rejected') {
        toast.error(result.reason);
      }
    } catch {
      toast.error("Couldn't open the file picker. Try again.");
    }
  }

  async function removeFile(): Promise<void> {
    if (desktop === undefined) return;
    try {
      await desktop.clearCustomSound();
      setCustom(null);
      if (choice === CUSTOM_SOUND_ID) apply(SAME_AS_ALARM);
    } catch {
      toast.error("Couldn't remove the file. Try again.");
    }
  }

  async function togglePreview(): Promise<void> {
    if (playing) {
      stopPreview();
      return;
    }
    let source = soundUrl(choice === SAME_AS_ALARM ? null : choice);
    if (choice === CUSTOM_SOUND_ID && desktop !== undefined) {
      const data = await desktop.readCustomSound().catch(() => null);
      if (data === null) {
        toast.error('The chosen file could not be read. Choose it again.');
        return;
      }
      objectUrl.current = URL.createObjectURL(new Blob([data.data as BlobPart], { type: data.mime }));
      source = objectUrl.current;
    }
    const audio = new Audio(source);
    audioRef.current = audio;
    audio.addEventListener('ended', stopPreview, { once: true });
    audio.addEventListener(
      'error',
      () => {
        toast.error("That sound couldn't be played.");
        stopPreview();
      },
      { once: true }
    );
    setPlaying(true);
    stopTimer.current = setTimeout(stopPreview, PREVIEW_MAX_MS);
    audio.play().catch(() => stopPreview());
  }

  const options = [
    { value: SAME_AS_ALARM, label: 'Same as the alarm sound' },
    ...SOUND_OPTIONS.map((option) => ({ value: option.id, label: option.label })),
    ...(desktop !== undefined ? [{ value: CUSTOM_SOUND_ID, label: custom ? `My file: ${custom.name}` : 'My own file' }] : []),
  ];

  return (
    <FieldSet>
      <FieldLegend variant="label">Prayer sound</FieldLegend>
      <Field>
        <FieldLabel htmlFor="settings-prayer-sound">Plays for the prayers</FieldLabel>
        <div className="flex gap-2">
          <Select
            value={choice}
            items={options}
            onValueChange={(next) => {
              if (typeof next !== 'string') return;
              if (next === CUSTOM_SOUND_ID && !custom) void chooseFile();
              else apply(next);
            }}
          >
            <SelectTrigger id="settings-prayer-sound" className="min-w-0 flex-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {options.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="outline"
            aria-label={playing ? 'Stop the preview' : 'Play the prayer sound'}
            onClick={() => void togglePreview()}
          >
            {playing ? <SquareIcon data-icon="inline-start" /> : <PlayIcon data-icon="inline-start" />}
            {playing ? 'Stop' : 'Play'}
          </Button>
        </div>
        <FieldDescription>
          Remembered on this device only. The reminders keep the normal alarm sound.
          {desktop === undefined ? ' Choosing your own file is available in the desktop app.' : ''}
        </FieldDescription>
      </Field>

      {desktop !== undefined ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" onClick={() => void chooseFile()}>
            <FileAudioIcon data-icon="inline-start" />
            Choose file…
          </Button>
          {custom ? (
            <>
              <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{custom.name}</span>
              <Button type="button" variant="ghost" size="sm" onClick={() => void removeFile()}>
                <Trash2Icon data-icon="inline-start" />
                Remove
              </Button>
            </>
          ) : (
            <span className="text-sm text-muted-foreground">mp3, wav, ogg or m4a, up to 5 MB. A takbir recording works well.</span>
          )}
        </div>
      ) : null}
    </FieldSet>
  );
}
