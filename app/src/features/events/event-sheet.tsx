import type { Settings } from '@alarm-calendar/core';
import { useState } from 'react';

import { ResponsiveSheet } from '@/components/responsive-sheet';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

import { ExamFormView } from '@/features/exams/exam-form-view';

import { EventFormView, type EventFormTarget } from './event-form-view';
import { useGroupIdSupport } from './events-api';
import { PrayerAlarmInfo } from './prayer-alarm-info';
import { RelationshipFormView } from './relationship-form-view';

type NewEventMode = 'alarm' | 'relationship' | 'exam';

interface EventSheetProps {
  /** Null keeps the sheet closed. */
  target: EventFormTarget | null;
  settings: Settings;
  onClose: () => void;
}

function targetKey(target: EventFormTarget): string {
  return (
    target.exam?.id ?? target.group?.wish.id ?? target.event?.id ?? `new-${target.slot.date}-${target.slot.time}`
  );
}

/**
 * The event form: a side sheet on desktop, a bottom drawer on phones. A new alarm can be a plain
 * alarm, a "Birthday / anniversary" template (two linked yearly alarms) or an exam (its alarm plus
 * revision sessions); an alarm that came from a template or an exam opens that form, so the alarms that
 * belong together are edited together.
 */
export function EventSheet({ target, settings, onClose }: EventSheetProps) {
  // The picked mode belongs to one target, so reopening the sheet starts on a plain alarm again.
  const [picked, setPicked] = useState<{ key: string; mode: NewEventMode } | null>(null);

  // Until the group_id column exists, a birthday could not be saved, so the tab is off.
  const groupsUnavailable = useGroupIdSupport((state) => state.missing);

  function close(): void {
    setPicked(null);
    onClose();
  }

  const key = target ? targetKey(target) : null;
  const group = target?.group ?? null;
  const exam = target?.exam ?? null;
  const editing = target?.event ?? null;
  const creating = target !== null && editing === null && exam === null;
  const startMode: NewEventMode = target?.startOn === 'exam' ? 'exam' : 'alarm';
  const pickedMode = picked?.key === key ? picked.mode : startMode;
  const mode: NewEventMode = exam
    ? 'exam'
    : group
      ? 'relationship'
      : pickedMode === 'relationship' && groupsUnavailable
        ? 'alarm'
        : pickedMode;

  // A prayer or its reminder has no time of its own to edit: it opens a short summary instead.
  const prayerEvent = editing !== null && editing.kind !== undefined && editing.kind !== 'normal' ? editing : null;

  let title = 'New alarm';
  let description = 'It will ring on a centered panel and can only be stopped with Done or Snooze.';
  if (prayerEvent) {
    title = prayerEvent.kind === 'prayer' ? `${prayerEvent.title} prayer` : 'Prayer reminder';
    description = 'Prayer alarms follow the prayer times in Settings.';
  } else if (exam) {
    title = 'Edit exam';
    description = 'Change the date or difficulty and the revision sessions still to come follow.';
  } else if (group) {
    title = 'Edit birthday or anniversary';
    description = 'Change the person, date or time of both alarms.';
  } else if (editing) {
    title = 'Edit alarm';
    description = 'Change when and how this alarm rings.';
  } else if (mode === 'relationship') {
    title = 'New birthday or anniversary';
    description = 'Adds a prep alarm 7 days before and a wish alarm on the day.';
  } else if (mode === 'exam') {
    title = 'New exam';
    description = 'Adds an alarm before the exam and revision sessions leading up to it.';
  }

  return (
    <ResponsiveSheet
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={title}
      description={description}
    >
      {target && key && prayerEvent ? (
        <PrayerAlarmInfo key={key} event={prayerEvent} onDone={close} />
      ) : target && key ? (
        <>
          {creating ? (
            <div className="shrink-0 border-b px-4 py-3">
              <Tabs value={mode} onValueChange={(next) => setPicked({ key, mode: next as NewEventMode })}>
                <TabsList className="w-full">
                  <TabsTrigger value="alarm" className="flex-1">
                    Alarm
                  </TabsTrigger>
                  <TabsTrigger value="relationship" className="flex-1" disabled={groupsUnavailable}>
                    Birthday / anniversary
                  </TabsTrigger>
                  <TabsTrigger value="exam" className="flex-1">
                    Exam
                  </TabsTrigger>
                </TabsList>
              </Tabs>
              {groupsUnavailable ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  Birthday alarms need a database update that has not been applied yet.
                </p>
              ) : null}
            </div>
          ) : null}
          {mode === 'exam' ? (
            <ExamFormView key={`exam-${key}`} exam={exam} slotDate={target.slot.date} settings={settings} onDone={close} />
          ) : mode === 'relationship' ? (
            // Remount per target so the form never carries values over from another event.
            <RelationshipFormView
              key={`relationship-${key}`}
              group={group}
              slotDate={target.slot.date}
              settings={settings}
              onDone={close}
            />
          ) : (
            <EventFormView key={key} target={target} settings={settings} onDone={close} />
          )}
        </>
      ) : null}
    </ResponsiveSheet>
  );
}
