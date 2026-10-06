import type { EventRow } from '@alarm-calendar/core';
import { BellOffIcon, BookOpenIcon, CalendarPlusIcon, GraduationCapIcon, MoonStarIcon } from 'lucide-react';
import { useMemo } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { describeRepeat } from '@/features/events/repeat-presets';
import { addDays, formatDay, formatTimeInZone } from '@/lib/zoned-time';

import { groupByDay, type Occurrence } from './calendar-events';

interface AgendaViewProps {
  /** First day listed, 'yyyy-MM-dd'. */
  start: string;
  /** Number of days listed. */
  days: number;
  today: string;
  tz: string;
  events: readonly EventRow[];
  occurrences: readonly Occurrence[];
  cheatDays: ReadonlySet<string>;
  onEdit: (eventId: string) => void;
  onCreate: () => void;
}

/** A plain list of what rings next, with today first and cheat days called out. */
export function AgendaView({
  start,
  days,
  today,
  tz,
  events,
  occurrences,
  cheatDays,
  onEdit,
  onCreate,
}: AgendaViewProps) {
  const eventsById = useMemo(() => new Map(events.map((event) => [event.id, event])), [events]);
  const groups = useMemo(() => groupByDay(occurrences), [occurrences]);
  const groupsByDay = useMemo(() => new Map(groups.map((group) => [group.day, group])), [groups]);

  const listedDays: string[] = [];
  for (let offset = 0; offset < days; offset++) {
    const day = addDays(start, offset);
    // Quiet days stay out of the list, except today and cheat days, which carry information.
    if (groupsByDay.has(day) || day === today || cheatDays.has(day)) listedDays.push(day);
  }

  if (occurrences.length === 0 && !listedDays.some((day) => cheatDays.has(day))) {
    return (
      <div className="flex flex-col items-start gap-3 px-4 py-10 sm:px-6">
        <h2 className="text-base font-medium">Nothing rings in this period</h2>
        <p className="max-w-prose text-sm text-muted-foreground">
          Add an alarm and it shows up here, full screen when it fires.
        </p>
        <Button onClick={onCreate}>
          <CalendarPlusIcon data-icon="inline-start" />
          New alarm
        </Button>
      </div>
    );
  }

  return (
    <ol className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-4 pb-24 sm:px-6">
      {listedDays.map((day) => {
        const group = groupsByDay.get(day);
        const cheat = cheatDays.has(day);
        return (
          <li key={day} className="flex flex-col gap-1">
            <div className={`flex items-center gap-2 rounded-md px-2 py-1.5 ${cheat ? 'cheat-day' : ''}`}>
              <h2 className="text-sm font-medium">
                {day === today ? 'Today' : formatDay(day)}
                {day === today ? <span className="font-normal text-muted-foreground">, {formatDay(day)}</span> : null}
              </h2>
              {cheat ? <Badge variant="outline">Cheat day</Badge> : null}
            </div>
            {group ? (
              <ul className="flex flex-col">
                {group.occurrences.map((occurrence) => {
                  const event = eventsById.get(occurrence.eventId);
                  return (
                    <li key={occurrence.key}>
                      <Button
                        variant="ghost"
                        className="h-auto min-h-11 w-full justify-start gap-3 px-2 py-2 text-left font-normal"
                        onClick={() => onEdit(occurrence.eventId)}
                      >
                        <span className="w-12 shrink-0 text-sm tabular-nums">
                          {formatTimeInZone(occurrence.start, tz)}
                        </span>
                        {occurrence.kind === 'prayer' ? (
                          <MoonStarIcon aria-label="Prayer" className="size-3.5 shrink-0" />
                        ) : occurrence.examRole === 'exam' ? (
                          <GraduationCapIcon aria-label="Exam" className="size-3.5 shrink-0" />
                        ) : occurrence.examRole === 'session' ? (
                          <BookOpenIcon aria-label="Revision" className="size-3.5 shrink-0" />
                        ) : (
                          <span
                            aria-hidden="true"
                            className="size-2.5 shrink-0 rounded-full bg-primary"
                            style={occurrence.color ? { backgroundColor: occurrence.color } : undefined}
                          />
                        )}
                        <span className={`min-w-0 flex-1 truncate ${occurrence.silenced ? 'text-muted-foreground' : ''}`}>
                          {occurrence.title}
                        </span>
                        {event && occurrence.kind === 'normal' && event.repeat_unit !== 'none' ? (
                          <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                            {describeRepeat({ unit: event.repeat_unit, interval: event.repeat_interval })}
                          </span>
                        ) : null}
                        {occurrence.silenced ? (
                          <Badge variant="secondary" className="shrink-0">
                            <BellOffIcon data-icon="inline-start" />
                            Silenced
                          </Badge>
                        ) : cheat ? (
                          <Badge variant="outline" className="shrink-0">
                            Rings anyway
                          </Badge>
                        ) : null}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="px-2 py-2 text-sm text-muted-foreground">Nothing scheduled.</p>
            )}
          </li>
        );
      })}
    </ol>
  );
}
