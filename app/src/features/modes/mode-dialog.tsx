import type { ModeRow, Settings } from '@alarm-calendar/core';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';

import { DatePicker } from '@/components/date-picker';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldContent, FieldDescription, FieldLabel, FieldLegend, FieldSet, FieldTitle } from '@/components/ui/field';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useExamsStore } from '@/features/exams/exams-store';
import { useSettingsStore } from '@/features/settings/settings-store';
import { addDays, formatDay, pickerWeekStart, zonedDate } from '@/lib/zoned-time';

import { ModeIcon } from './mode-icon';
import { NORMAL_LABEL, defaultBehaviorSummary, switchableModes } from './mode-meta';
import { currentMode, modeDetailLine, plannedModeAt, upcomingLine, upcomingModes } from './mode-status';
import { buildSwitchRequest, modeErrorMessage, type EndChoice, type StartChoice } from './mode-switch';
import { switchMode, useModesStore } from './modes-store';
import { useModeTimeline } from './use-modes';

const NORMAL = 'normal';
// Same pressed look as the other toggle groups in the sheets.
const CHOICE_PRESSED = 'aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-pressed:hover:bg-primary/80';

interface ModeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The header switch: pick the mode that is in effect now, when it started (now, or this morning) and when it
 * ends (open-ended, until switched back, or the end of a chosen day). The planned modes (a range, an exam's
 * window) are listed so it is clear what comes next and what a manual switch overrides.
 */
export function ModeDialog({ open, onOpenChange }: ModeDialogProps) {
  const settings = useSettingsStore((state) => state.settings);
  if (settings === null) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Mode</DialogTitle>
          <DialogDescription>
            A mode changes how your alarms behave for a while: pause some, move or shorten others. Alarms that always
            ring, like medication and prayers, are never paused.
          </DialogDescription>
        </DialogHeader>
        <ModeSwitchForm settings={settings} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function ModeSwitchForm({ settings, onDone }: { settings: Settings; onDone: () => void }) {
  const navigate = useNavigate();
  const tz = settings.timezone;
  const modes = useModesStore((state) => state.modes);
  const exams = useExamsStore((state) => state.exams);
  const timeline = useModeTimeline();
  const now = useMemo(() => new Date(), []);

  const current = useMemo(() => currentMode(timeline, now, tz), [timeline, now, tz]);
  const planned = useMemo(() => plannedModeAt(timeline, modes, now), [timeline, modes, now]);
  const upcoming = useMemo(() => upcomingModes(timeline, modes, now, tz, 2), [timeline, modes, now, tz]);
  const choices = useMemo(() => switchableModes(modes), [modes]);
  const hasManual = current?.source === 'manual' || timeline.windows.some((w) => w.source === 'manual' && w.startMs <= now.getTime() && now.getTime() < w.endMs);
  const examTitle = (id: string | null): string | undefined => (id === null ? undefined : exams.find((exam) => exam.id === id)?.title);

  const [choice, setChoice] = useState<string>(current?.mode.id ?? NORMAL);
  const [start, setStart] = useState<StartChoice>('now');
  const [end, setEnd] = useState<EndChoice>('open');
  const [endDate, setEndDate] = useState(() => addDays(zonedDate(now, tz), 1));
  const [saving, setSaving] = useState(false);

  const chosen: ModeRow | null = choice === NORMAL ? null : (choices.find((mode) => mode.id === choice) ?? null);
  // Normal switches a manual mode off; with none on there is nothing to do, and a planned mode cannot be switched off here.
  const nothingToDo = chosen === null && !hasManual;

  async function onApply(): Promise<void> {
    const request = buildSwitchRequest({ modeId: chosen?.id ?? null, start, end, endDate }, new Date(), tz);
    if (request.error !== null) {
      toast.error(request.error);
      return;
    }
    setSaving(true);
    const result = await switchMode(request.data);
    setSaving(false);
    if (result.error !== null) {
      toast.error(modeErrorMessage(result.error));
      return;
    }
    toast.success(chosen === null ? 'Back to normal' : `${chosen.name} is on`);
    onDone();
  }

  return (
    <>
      <section aria-labelledby="mode-now" className="flex items-start gap-3 rounded-lg border bg-muted/40 p-3">
        <ModeIcon of={current?.mode ?? null} className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 id="mode-now" className="text-sm font-medium">
            {current === null ? `${NORMAL_LABEL} right now` : `${current.mode.name} is on`}
          </h3>
          <p className="text-sm text-muted-foreground">{modeDetailLine(current, now, tz, examTitle(current?.examId ?? null))}</p>
          {upcoming.map((item) => (
            <p key={`${item.mode.id}-${item.startDay}`} className="text-sm text-muted-foreground">
              Next: {upcomingLine(item, examTitle(item.examId))}.
            </p>
          ))}
        </div>
      </section>

      <FieldSet>
        <FieldLegend variant="label">Switch to</FieldLegend>
        <RadioGroup value={choice} onValueChange={(next) => setChoice(String(next))} aria-label="Mode">
          <FieldLabel htmlFor="mode-choice-normal">
            <Field orientation="horizontal">
              <FieldContent>
                <FieldTitle>{NORMAL_LABEL}</FieldTitle>
                <FieldDescription>
                  {hasManual
                    ? planned === null
                      ? 'Switches the current mode off. Every alarm rings as set.'
                      : `Switches the manual mode off. ${planned.mode.name} is planned for now, so it applies again.`
                    : planned === null
                      ? 'Every alarm rings as set.'
                      : `${planned.mode.name} is planned for now and ends on its own. Pick a mode here to override it.`}
                </FieldDescription>
              </FieldContent>
              <RadioGroupItem value={NORMAL} id="mode-choice-normal" />
            </Field>
          </FieldLabel>
          {choices.map((mode) => (
            <FieldLabel key={mode.id} htmlFor={`mode-choice-${mode.id}`}>
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldTitle>
                    <ModeIcon of={mode} className="size-4" aria-hidden="true" />
                    {mode.name}
                  </FieldTitle>
                  <FieldDescription>{defaultBehaviorSummary(mode)}</FieldDescription>
                </FieldContent>
                <RadioGroupItem value={mode.id} id={`mode-choice-${mode.id}`} />
              </Field>
            </FieldLabel>
          ))}
        </RadioGroup>
      </FieldSet>

      {chosen !== null ? (
        <div className="flex flex-col gap-4">
          <Field>
            <FieldLabel id="mode-start-label">Starting</FieldLabel>
            <ToggleGroup
              variant="outline"
              spacing={1}
              aria-labelledby="mode-start-label"
              value={[start]}
              onValueChange={(next) => {
                const picked = next[0];
                if (picked === 'now' || picked === 'today') setStart(picked);
              }}
            >
              <ToggleGroupItem value="now" className={CHOICE_PRESSED}>
                Now
              </ToggleGroupItem>
              <ToggleGroupItem value="today" className={CHOICE_PRESSED}>
                Since this morning
              </ToggleGroupItem>
            </ToggleGroup>
            {start === 'today' ? (
              <FieldDescription>
                Alarms that already rang today are no longer counted against you.
              </FieldDescription>
            ) : null}
          </Field>
          <Field>
            <FieldLabel id="mode-end-label">Lasts</FieldLabel>
            <ToggleGroup
              variant="outline"
              spacing={1}
              aria-labelledby="mode-end-label"
              value={[end]}
              onValueChange={(next) => {
                const picked = next[0];
                if (picked === 'open' || picked === 'date') setEnd(picked);
              }}
            >
              <ToggleGroupItem value="open" className={CHOICE_PRESSED}>
                Until I switch it off
              </ToggleGroupItem>
              <ToggleGroupItem value="date" className={CHOICE_PRESSED}>
                Until a day
              </ToggleGroupItem>
            </ToggleGroup>
            {end === 'date' ? (
              <>
                <DatePicker
                  id="mode-end-date"
                  value={endDate}
                  onChange={setEndDate}
                  weekStartsOn={pickerWeekStart(settings.week_starts_on)}
                />
                <FieldDescription>
                  {endDate === '' ? 'Pick the last day.' : `The mode ends when ${formatDay(addDays(endDate, 1))} begins.`}
                </FieldDescription>
              </>
            ) : null}
          </Field>
        </div>
      ) : null}

      <DialogFooter className="items-center sm:justify-between">
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            onDone();
            navigate('/modes');
          }}
        >
          Manage modes
        </Button>
        <Button type="button" disabled={saving || nothingToDo} onClick={() => void onApply()}>
          {chosen === null ? 'Back to normal' : `Switch to ${chosen.name}`}
        </Button>
      </DialogFooter>
    </>
  );
}
