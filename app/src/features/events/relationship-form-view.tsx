import { zodResolver } from '@hookform/resolvers/zod';
import type { Settings } from '@alarm-calendar/core';
import { InfoIcon, Trash2Icon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';

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
import { formatDay, formatTimeInZone, zonedDate } from '@/lib/zoned-time';

import { removeEventGroup, saveEventGroup, saveNewEventGroup } from './events-store';
import {
  PREP_LEAD_DAYS,
  RELATIONSHIP_KINDS,
  RELATIONSHIP_KIND_LABELS,
  createRelationshipFormSchema,
  defaultRelationshipFormValues,
  nextRelationshipRings,
  relationshipGroupToFormValues,
  relationshipToWriteInputs,
  type RelationshipFormValues,
  type RelationshipGroup,
  type RelationshipKind,
} from './relationship-template';

const MONTHS = Array.from({ length: 12 }, (_, index) => ({
  value: String(index + 1),
  label: new Date(2000, index, 1).toLocaleDateString(undefined, { month: 'long' }),
}));

// Same pressed look as the weekday chips in the alarm form.
const KIND_PRESSED =
  'min-w-28 aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-pressed:hover:bg-primary/80';

interface RelationshipFormViewProps {
  /** The pair being edited, or null to create. */
  group: RelationshipGroup | null;
  /** Prefilled date for a new template, from the clicked slot. */
  slotDate: string;
  settings: Settings;
  onDone: () => void;
}

/**
 * The "Birthday / anniversary" form: one person, one date, one time. Saving writes two linked yearly
 * alarms, a prep alarm 7 days before and a wish alarm on the day. Editing changes both together.
 */
export function RelationshipFormView({ group, slotDate, settings, onDone }: RelationshipFormViewProps) {
  const tz = settings.timezone;
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const schema = useMemo(() => createRelationshipFormSchema(), []);

  const form = useForm<RelationshipFormValues>({
    resolver: zodResolver(schema),
    defaultValues: group ? relationshipGroupToFormValues(group, tz) : defaultRelationshipFormValues(slotDate),
    mode: 'onSubmit',
    reValidateMode: 'onChange',
  });

  const watched = useWatch({ control: form.control });
  const preview = useMemo(() => {
    const parsed = schema.safeParse(watched);
    if (!parsed.success) return null;
    return nextRelationshipRings(parsed.data, { tz, now: new Date() }, group ?? undefined);
  }, [schema, watched, tz, group]);

  async function onSubmit(submitted: RelationshipFormValues): Promise<void> {
    const context = { tz, now: new Date() };
    if (group) {
      const { prep, wish } = relationshipToWriteInputs(submitted, context, group.wish.group_id ?? '', group);
      const result = await saveEventGroup([
        { id: group.prep.id, input: prep },
        { id: group.wish.id, input: wish },
      ]);
      if (result.error !== null) {
        toast.error("Couldn't save both alarms. Your changes are still here, try again.");
        return;
      }
      toast.success('Both alarms updated');
      onDone();
      return;
    }

    const { prep, wish } = relationshipToWriteInputs(submitted, context, crypto.randomUUID());
    const result = await saveNewEventGroup([prep, wish]);
    if (result.error !== null) {
      toast.error("Couldn't add the alarms. Your changes are still here, try again.");
      return;
    }
    toast.success(`Added 2 alarms for ${submitted.personName.trim()}`);
    onDone();
  }

  async function onConfirmDelete(): Promise<void> {
    if (!group) return;
    setDeleting(true);
    const result = await removeEventGroup([group.prep.id, group.wish.id]);
    setDeleting(false);
    if (result.error !== null) {
      toast.error("Couldn't delete the alarms. Check your connection and try again.");
      return;
    }
    toast.success('Deleted both alarms');
    setConfirmingDelete(false);
    onDone();
  }

  return (
    <>
      <form
        id="relationship-form"
        noValidate
        onSubmit={(event) => void form.handleSubmit(onSubmit)(event)}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
      >
        <FieldGroup>
          {group ? (
            <Alert>
              <InfoIcon />
              <AlertDescription>
                This changes both alarms, the prep alarm and the wish alarm. Alarms you already completed are kept.
              </AlertDescription>
            </Alert>
          ) : null}

          <Controller
            name="kind"
            control={form.control}
            render={({ field }) => (
              <Field>
                <FieldLabel id="relationship-kind-label">What is it?</FieldLabel>
                <ToggleGroup
                  variant="outline"
                  spacing={1}
                  aria-labelledby="relationship-kind-label"
                  value={[field.value]}
                  onValueChange={(next) => {
                    // A single-select group reports [] when the pressed item is pressed again; keep the choice.
                    const chosen = next[0];
                    if (chosen !== undefined) field.onChange(chosen as RelationshipKind);
                  }}
                >
                  {RELATIONSHIP_KINDS.map((option) => (
                    <ToggleGroupItem key={option} value={option} className={KIND_PRESSED}>
                      {RELATIONSHIP_KIND_LABELS[option]}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </Field>
            )}
          />

          <Controller
            name="personName"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="relationship-name">Who is it for?</FieldLabel>
                <Input
                  {...field}
                  id="relationship-name"
                  autoComplete="off"
                  placeholder="Sam"
                  aria-invalid={fieldState.invalid}
                />
                {fieldState.invalid ? <FieldError errors={[fieldState.error]} /> : null}
              </Field>
            )}
          />

          <FieldSet>
            <FieldLegend variant="label">Date</FieldLegend>
            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3">
              <Controller
                name="month"
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="relationship-month">Month</FieldLabel>
                    <Select
                      value={String(field.value)}
                      items={MONTHS}
                      onValueChange={(next) => {
                        if (next === null) return;
                        field.onChange(Number(next));
                        void form.trigger(['day', 'year']);
                      }}
                    >
                      <SelectTrigger id="relationship-month" className="w-full" aria-invalid={fieldState.invalid}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {MONTHS.map((month) => (
                          <SelectItem key={month.value} value={month.value}>
                            {month.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                )}
              />
              <Controller
                name="day"
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="relationship-day">Day</FieldLabel>
                    <NumberStepper
                      id="relationship-day"
                      label="day of the month"
                      value={field.value}
                      onChange={(day) => {
                        field.onChange(day);
                        void form.trigger('year');
                      }}
                      min={1}
                      max={31}
                      invalid={fieldState.invalid}
                    />
                  </Field>
                )}
              />
            </div>
            {form.formState.errors.day ? <FieldError errors={[form.formState.errors.day]} /> : null}
            <Controller
              name="year"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="relationship-year">Year (optional)</FieldLabel>
                  <Input
                    {...field}
                    id="relationship-year"
                    inputMode="numeric"
                    maxLength={4}
                    autoComplete="off"
                    placeholder="1990"
                    aria-invalid={fieldState.invalid}
                    className="w-28"
                  />
                  <FieldDescription>
                    Leave it empty to start at the next one. A 29 February falls on the 28th in years without one.
                  </FieldDescription>
                  {fieldState.invalid ? <FieldError errors={[fieldState.error]} /> : null}
                </Field>
              )}
            />
          </FieldSet>

          <Controller
            name="time"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="relationship-time">Alarm time</FieldLabel>
                <TimeInput
                  id="relationship-time"
                  value={field.value}
                  onChange={(time) => field.onChange(time)}
                  invalid={fieldState.invalid}
                  describedBy={fieldState.invalid ? 'relationship-time-error' : undefined}
                />
                <FieldDescription>Both alarms ring at this time, in {tz}.</FieldDescription>
                {fieldState.invalid ? <FieldError id="relationship-time-error" errors={[fieldState.error]} /> : null}
              </Field>
            )}
          />

          <Controller
            name="giftNotes"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="relationship-gifts">Gift ideas (optional)</FieldLabel>
                <Textarea {...field} id="relationship-gifts" rows={3} aria-invalid={fieldState.invalid} />
                <FieldDescription>Shown on the prep alarm, {PREP_LEAD_DAYS} days before.</FieldDescription>
                {fieldState.invalid ? <FieldError errors={[fieldState.error]} /> : null}
              </Field>
            )}
          />

          <Controller
            name="showInCalendar"
            control={form.control}
            render={({ field }) => (
              <Field orientation="horizontal">
                <div className="flex flex-1 flex-col gap-1">
                  <FieldLabel htmlFor="relationship-show-in-calendar">Show in calendar</FieldLabel>
                  <FieldDescription>
                    Turn off to keep both alarms off the calendar. They still ring.
                  </FieldDescription>
                </div>
                <Switch id="relationship-show-in-calendar" checked={field.value} onCheckedChange={field.onChange} />
              </Field>
            )}
          />

          <Alert>
            <InfoIcon />
            <AlertDescription>
              {preview === null ? (
                'Fill in the name and date to see when the alarms ring.'
              ) : (
                <>
                  <span className="block">
                    Prep alarm: {ringText(preview.prep, tz)}
                  </span>
                  <span className="block">Wish alarm: {ringText(preview.wish, tz)}</span>
                  <span className="block">Both repeat every year and can be skipped by a cheat day.</span>
                </>
              )}
            </AlertDescription>
          </Alert>
        </FieldGroup>
      </form>

      <div className="flex items-center gap-2 border-t px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {group ? (
          <Button type="button" variant="destructive" onClick={() => setConfirmingDelete(true)}>
            <Trash2Icon data-icon="inline-start" />
            Delete
          </Button>
        ) : null}
        <div className="ml-auto flex gap-2">
          <Button type="button" variant="outline" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" form="relationship-form" disabled={form.formState.isSubmitting}>
            {group ? 'Save changes' : 'Add 2 alarms'}
          </Button>
        </div>
      </div>

      <AlertDialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete both alarms?</AlertDialogTitle>
            <AlertDialogDescription>
              "{group?.prep.title}" and "{group?.wish.title}" stop ringing on every device. Alarms you already
              completed are kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep them</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={deleting} onClick={() => void onConfirmDelete()}>
              Delete both
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function ringText(instant: Date | null, tz: string): string {
  if (instant === null) return 'does not ring again.';
  return `${formatDay(zonedDate(instant, tz), { year: true })} at ${formatTimeInZone(instant, tz)}`;
}
