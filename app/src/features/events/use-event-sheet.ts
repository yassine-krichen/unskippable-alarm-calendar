import type { Settings } from '@alarm-calendar/core';
import { useState } from 'react';

import type { Occurrence } from '@/features/calendar/calendar-events';
import { nextFullHour, type EventSlot } from '@/features/calendar/new-event-slot';
import { useExamsStore } from '@/features/exams/exams-store';
import { zonedDate, zonedParts } from '@/lib/zoned-time';

import type { EventFormTarget } from './event-form-view';
import { useEventsStore } from './events-store';
import { findRelationshipGroup } from './relationship-template';

export interface EventSheetController {
  /** What the sheet is open on; null keeps it closed. */
  target: EventFormTarget | null;
  /** Opens the form for a new alarm, on the given slot or on the next full hour today. */
  openCreate: (slot?: EventSlot) => void;
  /** Opens an existing alarm: its details on the phone, its form on the desktop (EventSheet decides). */
  openEdit: (eventId: string, occurrence?: Occurrence | null) => void;
  close: () => void;
}

/**
 * The open / close state of the event sheet and how a tap on an alarm turns into a target, shared by the
 * Calendar and Today screens so both open the same sheet the same way.
 */
export function useEventSheet(settings: Settings): EventSheetController {
  const events = useEventsStore((state) => state.events);
  const exams = useExamsStore((state) => state.exams);
  const [target, setTarget] = useState<EventFormTarget | null>(null);
  const tz = settings.timezone;

  function openCreate(slot?: EventSlot): void {
    const fallback = zonedParts(new Date(), tz);
    setTarget({
      event: null,
      slot: slot ?? { date: zonedDate(new Date(), tz), time: nextFullHour(fallback.time) },
    });
  }

  function openEdit(eventId: string, occurrence: Occurrence | null = null): void {
    const event = events.find((candidate) => candidate.id === eventId);
    if (!event) return;
    const slot = { date: zonedDate(new Date(), tz), time: '09:00' };
    // An alarm of an exam (its own alarm, a session, a catch-up) edits as that exam.
    const exam = event.exam_id ? exams.find((candidate) => candidate.id === event.exam_id) : undefined;
    if (exam) {
      setTarget({ event, exam, slot, occurrence });
      return;
    }
    // An alarm made by the birthday / anniversary template edits as that pair.
    const group = findRelationshipGroup(event, events);
    setTarget({ event, group, slot, occurrence });
  }

  return { target, openCreate, openEdit, close: () => setTarget(null) };
}
