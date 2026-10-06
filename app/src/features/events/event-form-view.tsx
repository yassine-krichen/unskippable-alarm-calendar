import { zodResolver } from '@hookform/resolvers/zod';
import type { EventRow, Settings } from '@alarm-calendar/core';
import { InfoIcon, Trash2Icon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';

import { DatePicker } from '@/components/date-picker';
import { NumberStepper } from '@/components/number-stepper';
import { TimeInput } from '@/components/time-input';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { EventRank } from '@/features/habits/event-rank';
import { formatDay, weekdayName, weekdayShortName } from '@/lib/zoned-time';

import { EVENT_COLORS } from './event-colors';
import {
  MAX_SNOOZE_LIMIT,
  createEventFormSchema,
  defaultEventFormValues,
  eventFormToWriteInput,
  eventToFormValues,
  firstAlarmDate,
  type EventFormValues,
} from './event-form';
import { removeEvent, saveEvent } from './events-store';
import type { RelationshipGroup } from './relationship-template';
import {
  CUSTOM_REPEAT_UNITS,
  REPEAT_PRESETS,
  REPEAT_PRESET_LABELS,
  isRepeating,
  repeatUnitLabel,
  usesWeekdays,
  type CustomRepeatUnit,
  type RepeatPreset,
} from './repeat-presets';

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;
const NO_COLOR = 'none';
// The default pressed look (a slightly lighter fill) is too faint to read on a swatch.
const COLOR_PRESSED = 'aria-pressed:border-primary aria-pressed:ring-2 aria-pressed:ring-primary/60';

export interface EventFormTarget {
  /** The event being edited, or null to create. */
  event: EventRow | null;
  /** Prefilled date and time for a new event, from the clicked slot. */
  slot: { date: string; time: string };
  /** Set when `event` belongs to a birthday / anniversary template: the edit opens that form instead. */
  group?: RelationshipGroup | null;
}

interface EventFormViewProps {
  target: EventFormTarget;
  settings: Settings;
  onDone: () => void;
}

/** Day index 0 = Monday in settings; react-day-picker counts from Sunday = 0. */
function pickerWeekStart(weekStartsOn: number): 0 | 1 | 2 | 3 | 4 | 5 | 6 {
  return ((weekStartsOn + 1) % 7) as 0 | 1 | 2 | 3 | 4 | 5 | 6;
}

export function EventFormView({ target, settings, onDone }: EventFormViewProps) {
  const tz = settings.timezone;
  const editing = target.event;
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const schema = useMemo(
    () => createEventFormSchema({ tz, now: () => new Date(), isNew: editing === null }),
    [tz, editing]
  );

  const form = useForm<EventFormValues>({
    resolver: zodResolver(schema),
    defaultValues: editing
      ? eventToFormValues(editing, tz)
      : defaultEventFormValues(target.slot.date, target.slot.time),
    // Errors appear on Save, then update as the person fixes them. Validating on blur would flag
    // the autofocused, still-empty title the moment focus moves to another field.
    mode: 'onSubmit',
    reValidateMode: 'onChange',
  });

  const values = useWatch({ control: form.control });
  const repeatState = {
    repeatPreset: values.repeatPreset ?? 'none',
    customInterval: values.customInterval ?? 1,
    customUnit: values.customUnit ?? 'day',
  } as const;
  const repeating = isRepeating(repeatState);
  const weekly = usesWeekdays(repeatState);
  const snoozesAllowed = (values.maxSnoozes ?? 0) > 0;

  const firstDate = firstAlarmDate(form.getValues());
  const startMovedForWeekdays = weekly && firstDate !== form.getValues('startDate');

  async function onSubmit(submitted: EventFormValues): Promise<void> {
    const result = await saveEvent(editing?.id ?? null, eventFormToWriteInput(submitted, tz));
    if (result.error !== null) {
      // The raw database message stays out of the UI; the form keeps every value for a retry.
      toast.error("Couldn't save the alarm. Your changes are still here, try again.");
      return;
    }
    toast.success(editing ? 'Alarm updated' : 'Alarm added');
    onDone();
  }

  async function onConfirmDelete(): Promise<void> {
    if (!editing) return;
    setDeleting(true);
    const result = await removeEvent(editing.id);
    setDeleting(false);
    if (result.error !== null) {
      toast.error("Couldn't delete the alarm. Check your connection and try again.");
      return;
    }
    toast.success(`Deleted "${editing.title}"`);
    setConfirmingDelete(false);
    onDone();
  }

  return (
    <>
      <form
        id="event-form"
        noValidate
        onSubmit={(event) => void form.handleSubmit(onSubmit)(event)}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
      >
        <FieldGroup>
          {editing && editing.repeat_unit !== 'none' ? <EventRank eventId={editing.id} /> : null}
          {editing && editing.repeat_unit !== 'none' ? (
            <Alert>
              <InfoIcon />
              <AlertDescription>
                This edits the whole series from now on. Alarms you already completed are kept.
              </AlertDescription>
            </Alert>
          ) : null}

          <Controller
            name="title"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="event-title">Title</FieldLabel>
                <Input
                  {...field}
                  id="event-title"
                  autoComplete="off"
                  placeholder="Take medication"
                  aria-invalid={fieldState.invalid}
                />
                {fieldState.invalid ? <FieldError errors={[fieldState.error]} /> : null}
              </Field>
            )}
          />

          <FieldSet>
            <FieldLegend variant="label">When</FieldLegend>
            <div className="grid grid-cols-2 gap-3">
              <Controller
                name="startDate"
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="event-start-date">Date</FieldLabel>
                    <DatePicker
                      id="event-start-date"
                      value={field.value}
                      onChange={(date) => field.onChange(date)}
                      weekStartsOn={pickerWeekStart(settings.week_starts_on)}
                      invalid={fieldState.invalid}
                    />
                  </Field>
                )}
              />
              <Controller
                name="startTime"
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="event-start-time">Time</FieldLabel>
                    <TimeInput
                      id="event-start-time"
                      value={field.value}
                      onChange={(time) => field.onChange(time)}
                      invalid={fieldState.invalid}
                      describedBy={fieldState.invalid ? 'event-start-time-error' : undefined}
                    />
                  </Field>
                )}
              />
            </div>
            {form.formState.errors.startDate ? (
              <FieldError errors={[form.formState.errors.startDate]} />
            ) : null}
            {form.formState.errors.startTime ? (
              <FieldError id="event-start-time-error" errors={[form.formState.errors.startTime]} />
            ) : null}
            <FieldDescription>Times are in {tz}. Change the zone in Settings.</FieldDescription>

            <Controller
              name="durationMin"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="event-duration">Duration</FieldLabel>
                  <NumberStepper
                    id="event-duration"
                    label="duration"
                    value={field.value}
                    onChange={field.onChange}
                    min={1}
                    max={1440}
                    unit="min"
                    invalid={fieldState.invalid}
                  />
                  <FieldDescription>Only sets how long the block looks on the calendar.</FieldDescription>
                  {fieldState.invalid ? <FieldError errors={[fieldState.error]} /> : null}
                </Field>
              )}
            />
          </FieldSet>

          <FieldSet>
            <FieldLegend variant="label">Repeat</FieldLegend>
            <Controller
              name="repeatPreset"
              control={form.control}
              render={({ field }) => (
                <Field>
                  <FieldLabel htmlFor="event-repeat" className="sr-only">
                    Repeat
                  </FieldLabel>
                  <Select
                    value={field.value}
                    items={REPEAT_PRESETS.map((preset) => ({
                      value: preset,
                      label: REPEAT_PRESET_LABELS[preset],
                    }))}
                    onValueChange={(next) => {
                      if (next === null) return;
                      field.onChange(next as RepeatPreset);
                      void form.trigger(['weekdays', 'endsDate']);
                    }}
                  >
                    <SelectTrigger id="event-repeat" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {REPEAT_PRESETS.map((preset) => (
                        <SelectItem key={preset} value={preset}>
                          {REPEAT_PRESET_LABELS[preset]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              )}
            />

            {values.repeatPreset === 'custom' ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm">Every</span>
                <Controller
                  name="customInterval"
                  control={form.control}
                  render={({ field, fieldState }) => (
                    <NumberStepper
                      id="event-custom-interval"
                      label="repeat interval"
                      value={field.value}
                      onChange={field.onChange}
                      min={1}
                      max={999}
                      invalid={fieldState.invalid}
                    />
                  )}
                />
                <Controller
                  name="customUnit"
                  control={form.control}
                  render={({ field }) => (
                    <Select
                      value={field.value}
                      items={CUSTOM_REPEAT_UNITS.map((unit) => ({
                        value: unit,
                        label: repeatUnitLabel(unit, repeatState.customInterval),
                      }))}
                      onValueChange={(next) => {
                        if (next === null) return;
                        field.onChange(next as CustomRepeatUnit);
                        void form.trigger(['weekdays', 'endsDate']);
                      }}
                    >
                      <SelectTrigger aria-label="Repeat unit" className="w-28">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {CUSTOM_REPEAT_UNITS.map((unit) => (
                          <SelectItem key={unit} value={unit}>
                            {repeatUnitLabel(unit, repeatState.customInterval)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>
            ) : null}
            {form.formState.errors.customInterval ? (
              <FieldError errors={[form.formState.errors.customInterval]} />
            ) : null}

            {weekly ? (
              <Controller
                name="weekdays"
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel id="event-weekdays-label">On these days</FieldLabel>
                    <ToggleGroup
                      multiple
                      variant="outline"
                      spacing={1}
                      aria-labelledby="event-weekdays-label"
                      className="flex-wrap"
                      value={field.value.map(String)}
                      onValueChange={(next) => field.onChange(next.map(Number).sort((a, b) => a - b))}
                    >
                      {WEEKDAYS.map((weekday) => (
                        <ToggleGroupItem
                          key={weekday}
                          value={String(weekday)}
                          aria-label={weekdayName(weekday)}
                          className="min-w-11 aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-pressed:hover:bg-primary/80"
                        >
                          {weekdayShortName(weekday)}
                        </ToggleGroupItem>
                      ))}
                    </ToggleGroup>
                    {startMovedForWeekdays ? (
                      <FieldDescription>
                        Your start date isn't one of these days, so the first alarm is{' '}
                        <strong className="font-medium text-foreground">{formatDay(firstDate)}</strong>. The
                        date is moved there when you save.
                      </FieldDescription>
                    ) : null}
                    {fieldState.invalid ? <FieldError errors={[fieldState.error]} /> : null}
                  </Field>
                )}
              />
            ) : null}

            {repeating ? (
              <Controller
                name="endsDate"
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="event-ends">Ends (optional)</FieldLabel>
                    <DatePicker
                      id="event-ends"
                      value={field.value}
                      onChange={(date) => field.onChange(date)}
                      weekStartsOn={pickerWeekStart(settings.week_starts_on)}
                      placeholder="Never"
                      clearable
                      invalid={fieldState.invalid}
                    />
                    {fieldState.invalid ? <FieldError errors={[fieldState.error]} /> : null}
                  </Field>
                )}
              />
            ) : null}
          </FieldSet>

          <FieldSet>
            <FieldLegend variant="label">Snooze</FieldLegend>
            <Controller
              name="maxSnoozes"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="event-max-snoozes">Snooze limit</FieldLabel>
                  <NumberStepper
                    id="event-max-snoozes"
                    label="snooze limit"
                    value={field.value}
                    onChange={field.onChange}
                    min={0}
                    max={MAX_SNOOZE_LIMIT}
                    invalid={fieldState.invalid}
                    describedBy="event-max-snoozes-help"
                  />
                  <FieldDescription id="event-max-snoozes-help">
                    0 = no snooze, you have to do it on the spot.
                  </FieldDescription>
                  {fieldState.invalid ? <FieldError errors={[fieldState.error]} /> : null}
                </Field>
              )}
            />
            {snoozesAllowed ? (
              <Controller
                name="snoozeMinutes"
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="event-snooze-minutes">Snooze length</FieldLabel>
                    <NumberStepper
                      id="event-snooze-minutes"
                      label="snooze length"
                      value={field.value}
                      onChange={field.onChange}
                      min={1}
                      max={120}
                      unit="min"
                      invalid={fieldState.invalid}
                    />
                    {fieldState.invalid ? <FieldError errors={[fieldState.error]} /> : null}
                  </Field>
                )}
              />
            ) : null}
          </FieldSet>

          <Controller
            name="passable"
            control={form.control}
            render={({ field }) => (
              <Field orientation="horizontal">
                <div className="flex flex-1 flex-col gap-1">
                  <FieldLabel htmlFor="event-passable">Cheat day can skip this</FieldLabel>
                  <FieldDescription>
                    Turn off for things that must always ring, like medication.
                  </FieldDescription>
                </div>
                <Switch id="event-passable" checked={field.value} onCheckedChange={field.onChange} />
              </Field>
            )}
          />

          <Controller
            name="color"
            control={form.control}
            render={({ field }) => (
              <Field>
                <FieldLabel id="event-color-label">Color</FieldLabel>
                <ToggleGroup
                  variant="outline"
                  spacing={1}
                  aria-labelledby="event-color-label"
                  className="flex-wrap"
                  value={[field.value ?? NO_COLOR]}
                  onValueChange={(next) => {
                    // A single-select group reports [] when the pressed item is pressed again; keep the choice.
                    const chosen = next[0];
                    if (chosen === undefined) return;
                    field.onChange(chosen === NO_COLOR ? null : chosen);
                  }}
                >
                  <ToggleGroupItem value={NO_COLOR} aria-label="No color" className={COLOR_PRESSED}>
                    None
                  </ToggleGroupItem>
                  {EVENT_COLORS.map((color) => (
                    <ToggleGroupItem
                      key={color.value}
                      value={color.value}
                      aria-label={color.label}
                      className={COLOR_PRESSED}
                    >
                      <span
                        aria-hidden="true"
                        className="size-4 rounded-full"
                        style={{ backgroundColor: color.value }}
                      />
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </Field>
            )}
          />

          <Controller
            name="notes"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="event-notes">Notes (optional)</FieldLabel>
                <Textarea {...field} id="event-notes" rows={3} aria-invalid={fieldState.invalid} />
                {fieldState.invalid ? <FieldError errors={[fieldState.error]} /> : null}
              </Field>
            )}
          />
        </FieldGroup>
      </form>

      <div className="flex items-center gap-2 border-t px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {editing ? (
          <Button type="button" variant="destructive" onClick={() => setConfirmingDelete(true)}>
            <Trash2Icon data-icon="inline-start" />
            Delete
          </Button>
        ) : null}
        <div className="ml-auto flex gap-2">
          <Button type="button" variant="outline" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" form="event-form" disabled={form.formState.isSubmitting}>
            {editing ? 'Save changes' : 'Add alarm'}
          </Button>
        </div>
      </div>

      <AlertDialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this alarm?</AlertDialogTitle>
            <AlertDialogDescription>
              "{editing?.title}" stops ringing on every device. Alarms you already completed are kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleting}
              onClick={() => void onConfirmDelete()}
            >
              Delete alarm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
