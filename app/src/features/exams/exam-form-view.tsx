import { zodResolver } from '@hookform/resolvers/zod';
import type { ExamDifficulty, ExamRow, Settings } from '@alarm-calendar/core';
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
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useEventsStore } from '@/features/events/events-store';
import { formatDay, formatTimeInZone, zonedDate } from '@/lib/zoned-time';

import { addExam, editExam, removeExam } from './exam-actions';
import {
  MAX_LEAD_MINUTES,
  createExamFormSchema,
  defaultExamFormValues,
  examToFormValues,
} from './exam-form';
import { DIFFICULTY_LABELS, planExam, type ExamFormValues } from './exam-plan';
import { ExamProgressSummary } from './exam-progress-summary';

const DIFFICULTIES: readonly ExamDifficulty[] = [1, 2, 3];
const DIFFICULTY_HINT: Record<ExamDifficulty, string> = {
  1: 'Revision sessions 7, 3 and 1 days before.',
  2: 'Revision sessions 7, 3 and 1 days before.',
  3: 'Revision sessions 14, 7, 3 and 1 days before.',
};

// Same pressed look as the other toggle groups in the sheet.
const CHOICE_PRESSED =
  'min-w-24 aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-pressed:hover:bg-primary/80';

/** Day index 0 = Monday in settings; react-day-picker counts from Sunday = 0. */
function pickerWeekStart(weekStartsOn: number): 0 | 1 | 2 | 3 | 4 | 5 | 6 {
  return ((weekStartsOn + 1) % 7) as 0 | 1 | 2 | 3 | 4 | 5 | 6;
}

interface ExamFormViewProps {
  /** The exam being edited, or null to create. */
  exam: ExamRow | null;
  /** Prefilled exam date for a new exam, from the clicked slot. */
  slotDate: string;
  settings: Settings;
  onDone: () => void;
}

/**
 * The exam form: one exam, one date, how hard it is. Saving writes the exam and its alarms (an alarm before
 * the exam and the revision sessions leading up to it). Editing regenerates the sessions that have not
 * happened yet and keeps the finished ones.
 */
export function ExamFormView({ exam, slotDate, settings, onDone }: ExamFormViewProps) {
  const tz = settings.timezone;
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const schema = useMemo(() => createExamFormSchema({ tz, now: () => new Date(), isNew: exam === null }), [tz, exam]);

  const form = useForm<ExamFormValues>({
    resolver: zodResolver(schema),
    defaultValues: exam
      ? examToFormValues(exam, useEventsStore.getState().events, tz)
      : defaultExamFormValues(slotDate, tz, new Date()),
    mode: 'onSubmit',
    reValidateMode: 'onChange',
  });

  const watched = useWatch({ control: form.control });
  const preview = useMemo(() => {
    const parsed = schema.safeParse(watched);
    return parsed.success ? planExam(parsed.data, tz, new Date()) : null;
  }, [schema, watched, tz]);

  async function onSubmit(submitted: ExamFormValues): Promise<void> {
    const result = exam ? await editExam(exam, submitted, tz) : await addExam(submitted, tz);
    if (result.error !== null) {
      toast.error("Couldn't save the exam. Your changes are still here, try again.");
      return;
    }
    toast.success(exam ? 'Exam updated' : 'Exam added');
    onDone();
  }

  async function onConfirmDelete(): Promise<void> {
    if (!exam) return;
    setDeleting(true);
    const result = await removeExam(exam);
    setDeleting(false);
    if (result.error !== null) {
      toast.error("Couldn't delete the exam. Check your connection and try again.");
      return;
    }
    toast.success(`Deleted "${exam.title}"`);
    setConfirmingDelete(false);
    onDone();
  }

  return (
    <>
      <form
        id="exam-form"
        noValidate
        onSubmit={(event) => void form.handleSubmit(onSubmit)(event)}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
      >
        <FieldGroup>
          {exam ? (
            <>
              <ExamProgressSummary exam={exam} />
              <Alert>
                <InfoIcon />
                <AlertDescription>
                  Saving replaces the revision sessions that have not happened yet. Sessions already done or missed are
                  kept.
                </AlertDescription>
              </Alert>
            </>
          ) : null}

          <Controller
            name="title"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="exam-title">Exam</FieldLabel>
                <Input
                  {...field}
                  id="exam-title"
                  autoComplete="off"
                  placeholder="Linear algebra"
                  aria-invalid={fieldState.invalid}
                />
                {fieldState.invalid ? <FieldError errors={[fieldState.error]} /> : null}
              </Field>
            )}
          />

          <FieldSet>
            <FieldLegend variant="label">When is it?</FieldLegend>
            <div className="grid grid-cols-2 gap-3">
              <Controller
                name="examDate"
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="exam-date">Date</FieldLabel>
                    <DatePicker
                      id="exam-date"
                      value={field.value}
                      onChange={(date) => field.onChange(date)}
                      weekStartsOn={pickerWeekStart(settings.week_starts_on)}
                      invalid={fieldState.invalid}
                    />
                  </Field>
                )}
              />
              <Controller
                name="examTime"
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="exam-time">Starts at</FieldLabel>
                    <TimeInput
                      id="exam-time"
                      value={field.value}
                      onChange={(time) => field.onChange(time)}
                      invalid={fieldState.invalid}
                      describedBy={fieldState.invalid ? 'exam-time-error' : undefined}
                    />
                  </Field>
                )}
              />
            </div>
            {form.formState.errors.examDate ? <FieldError errors={[form.formState.errors.examDate]} /> : null}
            {form.formState.errors.examTime ? (
              <FieldError id="exam-time-error" errors={[form.formState.errors.examTime]} />
            ) : null}
            <FieldDescription>Times are in {tz}. Change the zone in Settings.</FieldDescription>
          </FieldSet>

          <Controller
            name="difficulty"
            control={form.control}
            render={({ field }) => (
              <Field>
                <FieldLabel id="exam-difficulty-label">How hard is it?</FieldLabel>
                <ToggleGroup
                  variant="outline"
                  spacing={1}
                  aria-labelledby="exam-difficulty-label"
                  value={[String(field.value)]}
                  onValueChange={(next) => {
                    // A single-select group reports [] when the pressed item is pressed again; keep the choice.
                    const chosen = next[0];
                    if (chosen !== undefined) field.onChange(Number(chosen) as ExamDifficulty);
                  }}
                >
                  {DIFFICULTIES.map((option) => (
                    <ToggleGroupItem key={option} value={String(option)} className={CHOICE_PRESSED}>
                      {DIFFICULTY_LABELS[option]}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
                <FieldDescription>{DIFFICULTY_HINT[field.value]}</FieldDescription>
              </Field>
            )}
          />

          <FieldSet>
            <FieldLegend variant="label">Revision sessions</FieldLegend>
            <div className="grid grid-cols-2 gap-3">
              <Controller
                name="sessionTime"
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="exam-session-time">Time of day</FieldLabel>
                    <TimeInput
                      id="exam-session-time"
                      value={field.value}
                      onChange={(time) => field.onChange(time)}
                      invalid={fieldState.invalid}
                      describedBy={fieldState.invalid ? 'exam-session-time-error' : undefined}
                    />
                  </Field>
                )}
              />
              <Controller
                name="sessionMinutes"
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="exam-session-length">Length</FieldLabel>
                    <NumberStepper
                      id="exam-session-length"
                      label="session length"
                      value={field.value}
                      onChange={field.onChange}
                      min={5}
                      max={480}
                      unit="min"
                      invalid={fieldState.invalid}
                    />
                  </Field>
                )}
              />
            </div>
            {form.formState.errors.sessionTime ? (
              <FieldError id="exam-session-time-error" errors={[form.formState.errors.sessionTime]} />
            ) : null}
            {form.formState.errors.sessionMinutes ? (
              <FieldError errors={[form.formState.errors.sessionMinutes]} />
            ) : null}
            <FieldDescription>
              Each session is an alarm. Miss one and a catch-up session is added halfway to the exam.
            </FieldDescription>
          </FieldSet>

          <Controller
            name="leadMinutes"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="exam-lead">Exam alarm</FieldLabel>
                <NumberStepper
                  id="exam-lead"
                  label="minutes before the exam"
                  value={field.value}
                  onChange={field.onChange}
                  min={0}
                  max={MAX_LEAD_MINUTES}
                  unit="min before"
                  invalid={fieldState.invalid}
                />
                <FieldDescription>
                  Rings this long before the exam starts. Cheat days never silence it.
                </FieldDescription>
                {fieldState.invalid ? <FieldError errors={[fieldState.error]} /> : null}
              </Field>
            )}
          />

          <Controller
            name="notes"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="exam-notes">Notes (optional)</FieldLabel>
                <Textarea {...field} id="exam-notes" rows={3} aria-invalid={fieldState.invalid} />
                <FieldDescription>Chapters, room, what to bring. Shown on every alarm of this exam.</FieldDescription>
                {fieldState.invalid ? <FieldError errors={[fieldState.error]} /> : null}
              </Field>
            )}
          />

          <PlanPreview plan={preview} tz={tz} editing={exam !== null} />
        </FieldGroup>
      </form>

      <div className="flex items-center gap-2 border-t px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {exam ? (
          <Button type="button" variant="destructive" onClick={() => setConfirmingDelete(true)}>
            <Trash2Icon data-icon="inline-start" />
            Delete
          </Button>
        ) : null}
        <div className="ml-auto flex gap-2">
          <Button type="button" variant="outline" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" form="exam-form" disabled={form.formState.isSubmitting}>
            {exam ? 'Save changes' : 'Add exam'}
          </Button>
        </div>
      </div>

      <AlertDialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this exam?</AlertDialogTitle>
            <AlertDialogDescription>
              "{exam?.title}" and all its alarms, the revision sessions and the exam alarm, stop ringing on every
              device. Sessions you already completed are kept in your history.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={deleting} onClick={() => void onConfirmDelete()}>
              Delete exam
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function PlanPreview({ plan, tz, editing }: { plan: ReturnType<typeof planExam> | null; tz: string; editing: boolean }) {
  if (plan === null) {
    return (
      <Alert>
        <InfoIcon />
        <AlertDescription>Fill in the exam and its date to see when the alarms ring.</AlertDescription>
      </Alert>
    );
  }
  const alarmAt = new Date(plan.examAlarm.start_at);
  const alarmPast = alarmAt.getTime() <= Date.now();
  const when = (instant: Date): string => `${formatDay(zonedDate(instant, tz))} at ${formatTimeInZone(instant, tz)}`;

  return (
    <Alert>
      <InfoIcon />
      <AlertDescription>
        {plan.sessions.length === 0 ? (
          <span className="block">No revision sessions: every one of them would already be in the past.</span>
        ) : (
          <>
            <span className="block font-medium">
              {editing ? 'Sessions still to come' : `${plan.sessions.length} revision ${plan.sessions.length === 1 ? 'session' : 'sessions'}`}
            </span>
            {plan.sessions.map((session) => (
              <span key={session.input.start_at} className="block">
                {when(new Date(session.input.start_at))}
              </span>
            ))}
          </>
        )}
        {plan.skippedSessions > 0 ? (
          <span className="block text-muted-foreground">
            {plan.skippedSessions} earlier {plan.skippedSessions === 1 ? 'session is' : 'sessions are'} already in the
            past and {editing ? 'not planned' : 'skipped'}.
          </span>
        ) : null}
        <span className="mt-1 block">
          {alarmPast && !editing
            ? 'The exam starts too soon for its own alarm, so that one will not ring.'
            : `Exam alarm: ${when(alarmAt)}.`}
        </span>
      </AlertDescription>
    </Alert>
  );
}
