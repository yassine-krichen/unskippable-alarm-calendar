import {
  AlarmClockIcon,
  ChartNoAxesColumnIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  PlusIcon,
  SettingsIcon,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { EventSheet } from '@/features/events/event-sheet';
import type { EventFormTarget } from '@/features/events/event-form-view';
import { loadEvents, useEventsStore } from '@/features/events/events-store';
import { findRelationshipGroup } from '@/features/events/relationship-template';
import { PassChip } from '@/features/passes/pass-chip';
import { PassDialog } from '@/features/passes/pass-dialog';
import { usePassesStore } from '@/features/passes/passes-store';
import { useSettingsStore } from '@/features/settings/settings-store';
import { useIsDesktop } from '@/hooks/use-media-query';
import { zonedDate, zonedParts } from '@/lib/zoned-time';

import { AgendaView } from './agenda-view';
import { expandOccurrences, toCalendarEvent } from './calendar-events';
import { CalendarGrid } from './calendar-grid';
import {
  AGENDA_DAYS,
  parseCalendarView,
  rangeToInstants,
  shiftAnchor,
  viewTitle,
  visibleDayRange,
  type CalendarView,
} from './calendar-range';
import { nextFullHour, type EventSlot } from './new-event-slot';

const VIEW_LABELS: Record<CalendarView, string> = { week: 'Week', month: 'Month', agenda: 'Agenda' };
const PERIOD_NOUN: Record<CalendarView, string> = { week: 'week', month: 'month', agenda: 'two weeks' };

/** The main screen: Week, Month and Agenda over the same occurrences, plus the pass chip. */
export function CalendarPage() {
  const navigate = useNavigate();
  const isDesktop = useIsDesktop();
  const [searchParams, setSearchParams] = useSearchParams();
  const settings = useSettingsStore((state) => state.settings);
  const events = useEventsStore((state) => state.events);
  const eventsStatus = useEventsStore((state) => state.status);
  const cheatDays = usePassesStore((state) => state.cheatDays);

  const [formTarget, setFormTarget] = useState<EventFormTarget | null>(null);
  const [passDialogOpen, setPassDialogOpen] = useState(false);
  const [anchorOverride, setAnchorOverride] = useState<string | null>(null);

  const tz = settings?.timezone ?? 'UTC';
  const weekStartsOn = settings?.week_starts_on ?? 0;
  const todayInZone = zonedDate(new Date(), tz);
  const anchor = anchorOverride ?? todayInZone;

  // Week on desktop, Agenda on phones, unless the URL says otherwise.
  const view = parseCalendarView(searchParams.get('view')) ?? (isDesktop ? 'week' : 'agenda');

  const cheatDaySet = useMemo(() => new Set(cheatDays), [cheatDays]);
  const range = useMemo(() => visibleDayRange(view, anchor, weekStartsOn), [view, anchor, weekStartsOn]);
  const occurrences = useMemo(
    () => expandOccurrences(events, rangeToInstants(range, tz), tz, cheatDays),
    [events, range, tz, cheatDays]
  );
  const calendarEvents = useMemo(() => occurrences.map(toCalendarEvent), [occurrences]);

  if (!settings) return null;

  function changeView(next: CalendarView): void {
    setSearchParams({ view: next }, { replace: true });
  }

  function openCreate(slot?: EventSlot): void {
    const fallback = zonedParts(new Date(), tz);
    setFormTarget({
      event: null,
      slot: slot ?? { date: todayInZone, time: nextFullHour(fallback.time) },
    });
  }

  function openEdit(eventId: string): void {
    const event = events.find((candidate) => candidate.id === eventId);
    if (event && settings) {
      // An alarm made by the birthday / anniversary template edits as that pair.
      const group = findRelationshipGroup(event, events);
      setFormTarget({ event, group, slot: { date: todayInZone, time: '09:00' } });
    }
  }

  const loading = eventsStatus === 'idle' || eventsStatus === 'loading';

  return (
    <Tabs
      value={view}
      onValueChange={(next) => {
        const parsed = parseCalendarView(String(next));
        if (parsed) changeView(parsed);
      }}
      className="h-dvh gap-0"
    >
      <header className="flex shrink-0 items-center gap-2 border-b px-4 py-2 pt-[max(0.5rem,env(safe-area-inset-top))] sm:px-6">
        <AlarmClockIcon className="size-5" aria-hidden="true" />
        <span className="text-sm font-semibold tracking-tight">Alarm Calendar</span>
        <div className="ml-auto flex items-start gap-2">
          <PassChip onOpen={() => setPassDialogOpen(true)} />
          <Button className="hidden sm:inline-flex" onClick={() => openCreate()}>
            <PlusIcon data-icon="inline-start" />
            New alarm
          </Button>
          <Button variant="ghost" size="icon" aria-label="Habits and ranks" onClick={() => navigate('/stats')}>
            <ChartNoAxesColumnIcon />
          </Button>
          <Button variant="ghost" size="icon" aria-label="Settings" onClick={() => navigate('/settings')}>
            <SettingsIcon />
          </Button>
        </div>
      </header>

      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 sm:px-6">
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            aria-label={`Previous ${PERIOD_NOUN[view]}`}
            onClick={() => setAnchorOverride(shiftAnchor(view, anchor, -1))}
          >
            <ChevronLeftIcon />
          </Button>
          <Button variant="outline" onClick={() => setAnchorOverride(null)}>
            Today
          </Button>
          <Button
            variant="outline"
            size="icon"
            aria-label={`Next ${PERIOD_NOUN[view]}`}
            onClick={() => setAnchorOverride(shiftAnchor(view, anchor, 1))}
          >
            <ChevronRightIcon />
          </Button>
        </div>
        <h1 className="min-w-0 flex-1 basis-40 truncate text-lg font-semibold tabular-nums tracking-tight">
          {viewTitle(view, anchor, weekStartsOn)}
        </h1>
        <TabsList className="w-full sm:w-fit">
          {(Object.keys(VIEW_LABELS) as CalendarView[]).map((key) => (
            <TabsTrigger key={key} value={key} className="flex-1 sm:flex-none">
              {VIEW_LABELS[key]}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>

      {eventsStatus === 'error' ? (
        <div className="px-4 sm:px-6">
          <Alert variant="destructive">
            <AlertTitle>Couldn't load your alarms</AlertTitle>
            <AlertDescription className="flex flex-col items-start gap-2">
              Check your connection and try again.
              <Button variant="outline" size="sm" onClick={() => void loadEvents()}>
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        </div>
      ) : loading ? (
        <CalendarSkeleton />
      ) : (
        <>
          <TabsContent value="week" className="min-h-0 flex-1 px-2 pb-2 sm:px-4">
            <CalendarGrid
              view="week"
              anchor={anchor}
              tz={tz}
              weekStartsOn={weekStartsOn}
              events={calendarEvents}
              cheatDays={cheatDaySet}
              onCreate={openCreate}
              onEdit={openEdit}
            />
          </TabsContent>
          <TabsContent value="month" className="min-h-0 flex-1 px-2 pb-2 sm:px-4">
            <CalendarGrid
              view="month"
              anchor={anchor}
              tz={tz}
              weekStartsOn={weekStartsOn}
              events={calendarEvents}
              cheatDays={cheatDaySet}
              onCreate={openCreate}
              onEdit={openEdit}
            />
          </TabsContent>
          <TabsContent value="agenda" className="min-h-0 flex-1 overflow-y-auto">
            <AgendaView
              start={anchor}
              days={AGENDA_DAYS}
              today={todayInZone}
              tz={tz}
              events={events}
              occurrences={occurrences}
              cheatDays={cheatDaySet}
              onEdit={openEdit}
              onCreate={() => openCreate()}
            />
          </TabsContent>
        </>
      )}

      <Button
        size="icon-lg"
        className="fixed right-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-40 rounded-full shadow-lg sm:hidden"
        aria-label="New alarm"
        onClick={() => openCreate()}
      >
        <PlusIcon />
      </Button>

      <EventSheet target={formTarget} settings={settings} onClose={() => setFormTarget(null)} />
      <PassDialog open={passDialogOpen} onOpenChange={setPassDialogOpen} />
    </Tabs>
  );
}

/** Mirrors the week grid so nothing jumps when the real calendar replaces it. */
function CalendarSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 px-4 pb-4 sm:px-6" aria-busy="true" aria-label="Loading alarms">
      <Skeleton className="h-10 w-full" />
      <Skeleton className="min-h-0 w-full flex-1" />
    </div>
  );
}
