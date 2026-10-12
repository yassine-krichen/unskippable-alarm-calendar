import { normalizeHijriOffset, ramadanOnOrAfter, type ModeBehavior, type ModeRow } from '@alarm-calendar/core';
import { MosqueIcon, Trash2Icon, XIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { DatePicker } from '@/components/date-picker';
import { NumberStepper } from '@/components/number-stepper';
import { ResponsiveSheet } from '@/components/responsive-sheet';
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
import { Badge } from '@/components/ui/badge';
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
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useAuthStore } from '@/features/auth/auth-store';
import { useEventsStore } from '@/features/events/events-store';
import { saveSettings, useSettingsStore } from '@/features/settings/settings-store';
import { addDays, formatDay, pickerWeekStart, zonedDate } from '@/lib/zoned-time';

import { MODE_NAME_MAX, validateModeName } from './mode-name';
import { modePurpose } from './mode-meta';
import { buildRange, modeErrorMessage } from './mode-switch';
import { addRange, patchMode, removeActivation, useModesStore, writeRuleChanges } from './modes-store';
import { BEHAVIOR_LABELS, describeShift, ruleChanges, ruleRowsFor, type RuleRow } from './rules-editor';

const CHOICE_PRESSED = 'aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-pressed:hover:bg-primary/80';
const DEFAULT_EXAM_DAYS = 10;

interface ModeEditorSheetProps {
  /** The mode being edited, or null while the sheet is closed. */
  mode: ModeRow | null;
  onClose: () => void;
}

/** One mode: its name and default, a rule per repeating alarm, and the date ranges it is planned for. */
export function ModeEditorSheet({ mode, onClose }: ModeEditorSheetProps) {
  return (
    <ResponsiveSheet
      open={mode !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={mode?.name ?? 'Mode'}
      description={mode === null ? '' : modePurpose(mode)}
    >
      {mode === null ? null : <ModeEditor key={mode.id} mode={mode} onDone={onClose} />}
    </ResponsiveSheet>
  );
}

function ModeEditor({ mode, onDone }: { mode: ModeRow; onDone: () => void }) {
  const userId = useAuthStore((state) => state.session?.user.id ?? null);
  const settings = useSettingsStore((state) => state.settings);
  const events = useEventsStore((state) => state.events);
  const rules = useModesStore((state) => state.rules);

  const isBuiltin = mode.kind === 'builtin';
  const isExam = mode.builtin_key === 'exam';
  const [name, setName] = useState(mode.name);
  const [defaultBehavior, setDefaultBehavior] = useState(mode.default_behavior);
  const [active, setActive] = useState(mode.active);
  const [examDays, setExamDays] = useState(settings?.exam_mode_days_before ?? DEFAULT_EXAM_DAYS);
  const [edits, setEdits] = useState<Record<string, Partial<RuleRow>>>({});
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [touched, setTouched] = useState(false);

  // Alarms with no rule of their own follow the default being edited, so flipping it moves them in the list.
  const draftMode = useMemo<ModeRow>(() => ({ ...mode, default_behavior: defaultBehavior }), [mode, defaultBehavior]);
  const rows = useMemo(
    () => ruleRowsFor(draftMode, events, rules).map((row) => ({ ...row, ...edits[row.eventId] })),
    [draftMode, events, rules, edits]
  );
  const nameProblem = isBuiltin ? null : validateModeName(name);

  function editRow(eventId: string, patch: Partial<RuleRow>): void {
    setEdits((current) => ({ ...current, [eventId]: { ...current[eventId], ...patch } }));
  }

  async function onSave(): Promise<void> {
    setTouched(true);
    if (nameProblem !== null || userId === null) return;
    const changes = ruleChanges(draftMode, rows, rules);
    if (changes.invalid.length > 0) {
      toast.error('Fix the highlighted alarms first: a shift needs a number of minutes.');
      return;
    }
    setSaving(true);
    const patch = {
      ...(!isBuiltin && name.trim() !== mode.name ? { name: name.trim() } : {}),
      ...(defaultBehavior !== mode.default_behavior ? { default_behavior: defaultBehavior } : {}),
      ...(active !== mode.active ? { active } : {}),
    };
    // One failure stops the rest; saving again repairs it, because each step diffs against what is stored.
    let failure: string | null = null;
    if (Object.keys(patch).length > 0) failure = (await patchMode(mode.id, patch)).error;
    if (failure === null && (changes.upserts.length > 0 || changes.deletes.length > 0)) {
      failure = (await writeRuleChanges(changes.upserts, changes.deletes)).error;
    }
    if (failure === null && isExam && examDays !== (settings?.exam_mode_days_before ?? DEFAULT_EXAM_DAYS)) {
      failure = (await saveSettings(userId, { exam_mode_days_before: examDays })).error;
    }
    setSaving(false);
    if (failure !== null) {
      toast.error(`Couldn't save the mode. ${modeErrorMessage(failure)}`);
      return;
    }
    toast.success('Mode saved');
    onDone();
  }

  async function onConfirmDelete(): Promise<void> {
    setSaving(true);
    const result = await patchMode(mode.id, { active: false });
    setSaving(false);
    if (result.error !== null) {
      toast.error(`Couldn't delete the mode. ${modeErrorMessage(result.error)}`);
      return;
    }
    toast.success(`Deleted "${mode.name}"`);
    setConfirmingDelete(false);
    onDone();
  }

  if (settings === null) return null;

  return (
    <>
      <form
        id="mode-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void onSave();
        }}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
      >
        <FieldGroup>
          {isBuiltin ? null : (
            <Field data-invalid={touched && nameProblem !== null}>
              <FieldLabel htmlFor="mode-name">Name</FieldLabel>
              <Input
                id="mode-name"
                value={name}
                maxLength={MODE_NAME_MAX}
                autoComplete="off"
                aria-invalid={touched && nameProblem !== null}
                onChange={(event) => setName(event.target.value)}
              />
              {touched && nameProblem !== null ? <FieldError>{nameProblem}</FieldError> : null}
            </Field>
          )}

          {isBuiltin ? (
            <Field orientation="horizontal">
              <div className="flex-1">
                <FieldLabel htmlFor="mode-active">Mode is on</FieldLabel>
                <FieldDescription>
                  Off, it never takes effect: not from the header, not from its dates{isExam ? ', and not before an exam' : ''}.
                </FieldDescription>
              </div>
              <Switch id="mode-active" checked={active} onCheckedChange={setActive} />
            </Field>
          ) : null}

          <Field>
            <FieldLabel id="mode-default-label">Alarms with no rule</FieldLabel>
            <ToggleGroup
              variant="outline"
              spacing={1}
              aria-labelledby="mode-default-label"
              value={[defaultBehavior]}
              onValueChange={(next) => {
                const picked = next[0];
                if (picked === 'keep' || picked === 'skip') setDefaultBehavior(picked);
              }}
            >
              <ToggleGroupItem value="keep" className={CHOICE_PRESSED}>
                Keep ringing
              </ToggleGroupItem>
              <ToggleGroupItem value="skip" className={CHOICE_PRESSED}>
                Pause
              </ToggleGroupItem>
            </ToggleGroup>
            <FieldDescription>
              Paused alarms do not ring and are left out of your scores. Alarms that always ring, like medication and
              prayers, are never paused.
            </FieldDescription>
          </Field>

          {isExam ? (
            <Field>
              <FieldLabel htmlFor="mode-exam-days">Starts before an exam</FieldLabel>
              <NumberStepper
                id="mode-exam-days"
                label="days before an exam"
                value={examDays}
                onChange={setExamDays}
                min={0}
                max={60}
                unit={examDays === 1 ? 'day before' : 'days before'}
              />
              <FieldDescription>
                {examDays === 0
                  ? 'Off: Exam mode only runs when you switch it on or plan it.'
                  : `Exam mode switches on ${examDays} ${examDays === 1 ? 'day' : 'days'} before each exam and ends after the day following it. Moving an exam moves the dates.`}
              </FieldDescription>
            </Field>
          ) : null}

          <Separator />

          <FieldSet>
            <FieldLegend variant="label">Your repeating alarms</FieldLegend>
            <FieldDescription>
              Set what this mode does to each one. Prayers are never changed by a mode, and one-off alarms follow the
              default above.
            </FieldDescription>
            {rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                You have no repeating alarms yet. When you add one it appears here.
              </p>
            ) : (
              <ul className="flex flex-col gap-3">
                {rows.map((row) => (
                  <li key={row.eventId}>
                    <RuleRowEditor
                      row={row}
                      invalid={touched && ruleChanges(draftMode, [row], rules).invalid.length > 0}
                      onChange={(patch) => editRow(row.eventId, patch)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </FieldSet>

          <Separator />

          <RangesSection mode={mode} />
        </FieldGroup>
      </form>

      <div className="flex items-center gap-2 border-t px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {isBuiltin ? null : (
          <Button type="button" variant="destructive" onClick={() => setConfirmingDelete(true)}>
            <Trash2Icon data-icon="inline-start" />
            Delete
          </Button>
        )}
        <div className="ml-auto flex gap-2">
          <Button type="button" variant="outline" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" form="mode-form" disabled={saving}>
            Save changes
          </Button>
        </div>
      </div>

      <AlertDialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this mode?</AlertDialogTitle>
            <AlertDialogDescription>
              "{mode.name}" stops applying, now and for its past dates. Alarms it paused in the past count in your
              scores again, as missed if you did not do them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={saving} onClick={() => void onConfirmDelete()}>
              Delete mode
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

const BEHAVIORS: readonly ModeBehavior[] = ['keep', 'skip', 'shift', 'shorten'];

function RuleRowEditor({ row, invalid, onChange }: { row: RuleRow; invalid: boolean; onChange: (patch: Partial<RuleRow>) => void }) {
  const items = BEHAVIORS.map((behavior) => ({ value: behavior, label: BEHAVIOR_LABELS[behavior] }));
  const selectId = `rule-${row.eventId}`;
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3" data-invalid={invalid || undefined}>
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className="size-2.5 shrink-0 rounded-full bg-primary"
          style={row.color ? { backgroundColor: row.color } : undefined}
        />
        <Label htmlFor={selectId} className="min-w-0 flex-1 truncate">
          {row.title}
        </Label>
        {row.alwaysRings ? <Badge variant="outline">Always rings</Badge> : null}
      </div>
      <Select
        value={row.behavior}
        items={items}
        onValueChange={(next) => {
          if (next === 'keep' || next === 'skip' || next === 'shift' || next === 'shorten') onChange({ behavior: next });
        }}
      >
        <SelectTrigger id={selectId} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value} disabled={item.value === 'skip' && row.alwaysRings}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {row.behavior === 'shift' ? (
        <div className="flex flex-col gap-1">
          <NumberStepper
            id={`${selectId}-shift`}
            label={`shift of ${row.title}`}
            value={row.shiftMinutes}
            onChange={(shiftMinutes) => onChange({ shiftMinutes })}
            min={-720}
            max={720}
            step={15}
            unit="min"
            invalid={invalid}
          />
          <p className="text-xs text-muted-foreground">
            {row.shiftMinutes === 0 ? 'Pick a number of minutes, up to 12 hours.' : `Rings ${describeShift(row.shiftMinutes)} from its usual time. Negative is earlier.`}
          </p>
        </div>
      ) : null}
      {row.behavior === 'shorten' ? (
        <div className="flex flex-col gap-1">
          <NumberStepper
            id={`${selectId}-shorten`}
            label={`length of ${row.title}`}
            value={row.durationMin}
            onChange={(durationMin) => onChange({ durationMin })}
            min={1}
            max={1440}
            step={5}
            unit="min"
          />
          <p className="text-xs text-muted-foreground">Only the calendar block gets shorter. The alarm still rings.</p>
        </div>
      ) : null}
    </div>
  );
}

/** The date ranges this mode is planned for, and a form to add one. The first and last day are both included. */
function RangesSection({ mode }: { mode: ModeRow }) {
  const settings = useSettingsStore((state) => state.settings);
  const activations = useModesStore((state) => state.activations);
  const tz = settings?.timezone ?? 'UTC';
  const today = zonedDate(new Date(), tz);
  const [firstDay, setFirstDay] = useState(today);
  const [lastDay, setLastDay] = useState(addDays(today, 6));
  const [saving, setSaving] = useState(false);

  const ranges = useMemo(
    () =>
      activations
        .filter((activation) => activation.mode_id === mode.id && activation.source === 'range' && activation.ends_at !== null)
        .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at)),
    [activations, mode.id]
  );
  if (settings === null) return null;
  const weekStart = pickerWeekStart(settings.week_starts_on);
  // The Ramadan mode can fill the dates in from the Hijri calendar (with the Settings adjustment). It only fills the
  // two pickers: the person still reviews them and adds, because the sighted start can differ by a day.
  const ramadan =
    mode.builtin_key === 'ramadan' ? ramadanOnOrAfter(today, normalizeHijriOffset(settings.hijri_offset_days)) : null;

  async function onAdd(): Promise<void> {
    const range = buildRange({ modeId: mode.id, firstDay, lastDay }, tz);
    if (range.error !== null) {
      toast.error(range.error);
      return;
    }
    setSaving(true);
    const result = await addRange(range.data.modeId, range.data.startsAt, range.data.endsAt);
    setSaving(false);
    if (result.error !== null) {
      toast.error(`Couldn't add the dates. ${modeErrorMessage(result.error)}`);
      return;
    }
    toast.success('Dates added');
  }

  async function onRemove(id: string): Promise<void> {
    const result = await removeActivation(id);
    if (result.error !== null) toast.error(`Couldn't remove the dates. ${modeErrorMessage(result.error)}`);
  }

  return (
    <FieldSet>
      <FieldLegend variant="label">Planned dates</FieldLegend>
      <FieldDescription>
        {mode.builtin_key === 'exam'
          ? 'Besides the days before each exam, you can plan extra stretches.'
          : 'The mode switches on and off by itself on these days. A manual switch from the header overrides them.'}
      </FieldDescription>
      {ranges.length === 0 ? (
        <p className="text-sm text-muted-foreground">No dates planned.</p>
      ) : (
        <ul className="flex flex-col">
          {ranges.map((range) => {
            const first = zonedDate(new Date(range.starts_at), tz);
            const last = zonedDate(new Date(Date.parse(range.ends_at as string) - 1), tz);
            const past = last < today;
            return (
              <li key={range.id} className="flex items-center gap-2 py-1">
                <span className={`flex-1 text-sm ${past ? 'text-muted-foreground' : ''}`}>
                  {first === last ? formatDay(first, { year: true }) : `${formatDay(first)} to ${formatDay(last, { year: true })}`}
                </span>
                {past ? <Badge variant="outline">Past</Badge> : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${formatDay(first)}`}
                  onClick={() => void onRemove(range.id)}
                >
                  <XIcon />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field>
          <FieldLabel htmlFor="range-first">First day</FieldLabel>
          <DatePicker id="range-first" value={firstDay} onChange={setFirstDay} weekStartsOn={weekStart} />
        </Field>
        <Field>
          <FieldLabel htmlFor="range-last">Last day</FieldLabel>
          <DatePicker id="range-last" value={lastDay} onChange={setLastDay} weekStartsOn={weekStart} />
        </Field>
      </div>
      {ramadan !== null ? (
        <div className="flex flex-col items-start gap-1">
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setFirstDay(ramadan.start);
              setLastDay(ramadan.end);
            }}
          >
            <MosqueIcon data-icon="inline-start" />
            Use Ramadan {ramadan.hijriYear} dates
          </Button>
          <FieldDescription>
            Fills in {formatDay(ramadan.start)} to {formatDay(ramadan.end, { year: true })} from the Hijri calendar.
            Check it against the announced start, and change the adjustment in Settings if it is a day off.
          </FieldDescription>
        </div>
      ) : null}
      <Button type="button" variant="outline" disabled={saving} onClick={() => void onAdd()}>
        Add these dates
      </Button>
    </FieldSet>
  );
}
