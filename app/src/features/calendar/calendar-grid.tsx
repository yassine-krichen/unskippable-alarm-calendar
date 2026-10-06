import FullCalendar, { useCalendarController } from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/react/daygrid';
import interactionPlugin from '@fullcalendar/react/interaction';
import classicTheme from '@fullcalendar/react/themes/classic';
import timeGridPlugin from '@fullcalendar/react/timegrid';
import type { ModeRow } from '@alarm-calendar/core';
import { BellOffIcon, BookOpenIcon, GraduationCapIcon, MoonStarIcon, PauseIcon } from 'lucide-react';
import { useEffect, useMemo } from 'react';

import { Badge } from '@/components/ui/badge';
import { zonedDate } from '@/lib/zoned-time';

import { slotFromClick, type EventSlot } from './new-event-slot';
import type { CalendarEvent } from './calendar-events';

import '@fullcalendar/react/skeleton.css';
import '@fullcalendar/react/themes/classic/theme.css';

interface CalendarGridProps {
  view: 'week' | 'month';
  /** The day the grid should show, 'yyyy-MM-dd'. */
  anchor: string;
  tz: string;
  /** Monday = 0, as in settings. */
  weekStartsOn: number;
  events: CalendarEvent[];
  cheatDays: ReadonlySet<string>;
  /** The mode that covers most of each day, by 'yyyy-MM-dd'; a day with none is absent. */
  modeDays: ReadonlyMap<string, ModeRow>;
  onCreate: (slot: EventSlot) => void;
  onEdit: (eventId: string) => void;
}

const TIME_24H = { hour: '2-digit', minute: '2-digit', hour12: false } as const;

/**
 * FullCalendar is the one place the app does not use shadcn markup (it renders its own).
 * It is themed with the shadcn tokens in index.css, its toolbar is hidden (the page renders
 * shadcn Buttons), and it only displays the plain events we hand it.
 */
export function CalendarGrid({
  view,
  anchor,
  tz,
  weekStartsOn,
  events,
  cheatDays,
  modeDays,
  onCreate,
  onEdit,
}: CalendarGridProps) {
  const controller = useCalendarController();
  // A cheat day is hatched; a day under a mode is tinted. Both can apply to one day.
  const dayClass = (day: string): string =>
    [cheatDays.has(day) ? 'cheat-day' : '', modeDays.has(day) ? 'mode-day' : ''].filter((name) => name !== '').join(' ');
  const plugins = useMemo(
    () => [classicTheme, dayGridPlugin, timeGridPlugin, interactionPlugin],
    []
  );

  // The page owns navigation; keep the grid on the anchor it is told to show.
  useEffect(() => {
    controller.gotoDate(anchor);
  }, [controller, anchor]);

  return (
    <FullCalendar
      controller={controller}
      plugins={plugins}
      initialView={view === 'week' ? 'timeGridWeek' : 'dayGridMonth'}
      initialDate={anchor}
      timeZone={tz}
      // FullCalendar counts Sunday as 0; settings count Monday as 0.
      firstDay={(weekStartsOn + 1) % 7}
      headerToolbar={false}
      tableHeaderSticky
      height="100%"
      allDaySlot={false}
      nowIndicator
      scrollTime="07:00:00"
      slotDuration="00:30:00"
      // A number, not true: "auto" makes FullCalendar render an `inert=""` probe that React 19 warns about.
      dayMaxEvents={3}
      eventTimeFormat={TIME_24H}
      slotHeaderFormat={TIME_24H}
      events={events}
      // info.date is the real instant the day starts at in the calendar's zone.
      dayCellClass={(info) => dayClass(zonedDate(info.date, tz))}
      dayLaneClass={(info) => dayClass(zonedDate(info.date, tz))}
      dayHeaderContent={(info) => {
        const day = zonedDate(info.date, tz);
        return (
          <span className="flex flex-col items-center gap-0.5">
            <span>{info.text}</span>
            {cheatDays.has(day) ? (
              <Badge variant="outline" className="h-4 px-1.5 text-[0.65rem]">
                Cheat day
              </Badge>
            ) : null}
            {modeDays.has(day) ? (
              <Badge variant="secondary" className="h-4 max-w-full px-1.5 text-[0.65rem]">
                <span className="truncate">{modeDays.get(day)?.name}</span>
              </Badge>
            ) : null}
          </span>
        );
      }}
      dayCellTopContent={(info) => {
        const day = zonedDate(info.date, tz);
        return cheatDays.has(day) || modeDays.has(day) ? (
          <span className="flex min-w-0 items-center gap-1.5">
            {cheatDays.has(day) ? (
              <Badge variant="outline" className="h-4 px-1.5 text-[0.65rem]">
                Cheat day
              </Badge>
            ) : null}
            {modeDays.has(day) ? (
              <Badge variant="secondary" className="h-4 min-w-0 px-1.5 text-[0.65rem]">
                <span className="truncate">{modeDays.get(day)?.name}</span>
              </Badge>
            ) : null}
            <span>{info.dayNumberText}</span>
          </span>
        ) : (
          true
        );
      }}
      eventContent={(info) => {
        const silenced = info.event.extendedProps['silenced'] === true;
        const paused = info.event.extendedProps['paused'] === true;
        const modeName: unknown = info.event.extendedProps['modeName'];
        const prayer = info.event.extendedProps['prayer'] === true;
        const examRole: unknown = info.event.extendedProps['examRole'];
        return (
          <>
            {prayer ? <MoonStarIcon aria-label="Prayer" className="mt-0.5 size-3 shrink-0" /> : null}
            {examRole === 'exam' ? <GraduationCapIcon aria-label="Exam" className="mt-0.5 size-3 shrink-0" /> : null}
            {examRole === 'session' ? <BookOpenIcon aria-label="Revision" className="mt-0.5 size-3 shrink-0" /> : null}
            {silenced ? (
              <BellOffIcon aria-label="Silenced by a cheat day" className="mt-0.5 size-3 shrink-0" />
            ) : null}
            {paused ? (
              <PauseIcon
                aria-label={typeof modeName === 'string' ? `Paused by ${modeName}` : 'Paused by a mode'}
                className="mt-0.5 size-3 shrink-0"
              />
            ) : null}
            <span className={info.timeClass}>{info.timeText}</span>
            <span className={paused ? `${info.titleClass} line-through` : info.titleClass}>{info.event.title}</span>
          </>
        );
      }}
      dateClick={(info) => onCreate(slotFromClick({ instant: info.date, allDay: info.allDay }, tz, new Date()))}
      eventClick={(info) => {
        const eventId: unknown = info.event.extendedProps['eventId'];
        if (typeof eventId === 'string') onEdit(eventId);
      }}
    />
  );
}
