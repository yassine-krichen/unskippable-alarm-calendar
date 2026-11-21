import type { Settings } from '@alarm-calendar/core';
import {
  AlarmClockIcon,
  ChartNoAxesColumnIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  EyeIcon,
  EyeOffIcon,
  GraduationCapIcon,
  PlusIcon,
  SettingsIcon,
} from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Toggle } from '@/components/ui/toggle';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { NewAlarmFab } from '@/features/app-shell/new-alarm-fab';
import { EventSheet } from '@/features/events/event-sheet';
import { loadEvents, useEventsStore } from '@/features/events/events-store';
import { useEventSheet } from '@/features/events/use-event-sheet';
import { useOpenQadaCount } from '@/features/habits/use-prayer-log';
import { ModeChip } from '@/features/modes/mode-chip';
import { ModeDialog } from '@/features/modes/mode-dialog';
import { PassChip } from '@/features/passes/pass-chip';
import { PermissionChip } from '@/features/permissions/permission-chip';
import { PassDialog } from '@/features/passes/pass-dialog';
import { useSettingsStore } from '@/features/settings/settings-store';
import { UpdateBanner } from '@/features/updates/update-banner';
import { useUpdateStore } from '@/features/updates/update-store';
import { ignoreAfterSwipe, useHorizontalSwipe } from '@/hooks/use-horizontal-swipe';
import { useIsPhoneLayout } from '@/hooks/use-media-query';
import { zonedDate } from '@/lib/zoned-time';

import { AgendaView } from './agenda-view';
import { CalendarGrid } from './calendar-grid';
import {
  AGENDA_DAYS,
  DESKTOP_VIEWS,
  PHONE_VIEWS,
  parseCalendarView,
  resolveCalendarView,
  shiftAnchor,
  viewTitle,
  type CalendarView,
} from './calendar-range';
import { useCalendarData } from './use-calendar-data';

const VIEW_LABELS: Record<CalendarView, string> = {
  day: 'Day',
  'three-day': '3 days',
  week: 'Week',
  month: 'Month',
  agenda: 'Agenda',
};
const PERIOD_NOUN: Record<CalendarView, string> = {
  day: 'day',
  'three-day': 'three days',
  week: 'week',
  month: 'month',
  agenda: 'two weeks',
};

/**
 * The calendar. Desktop: Week, Month and Agenda with the header navigation. Phone: Day, 3 days and Month under a
 * compact toolbar; swipe sideways to move, tap a day in Month to open it (Today is the phone's agenda).
 */
export function CalendarPage() {
  const settings = useSettingsStore((state) => state.settings);
  if (!settings) return null;
  return <CalendarScreen settings={settings} />;
}

function CalendarScreen({ settings }: { settings: Settings }) {
  const navigate = useNavigate();
  const phone = useIsPhoneLayout();
  const [searchParams, setSearchParams] = useSearchParams();
  const events = useEventsStore((state) => state.events);
  const eventsStatus = useEventsStore((state) => state.status);
  const openQada = useOpenQadaCount();
  const updateAvailable = useUpdateStore((state) => state.latest !== null);

  const [passDialogOpen, setPassDialogOpen] = useState(false);
  const [modeDialogOpen, setModeDialogOpen] = useState(false);
  const [anchorOverride, setAnchorOverride] = useState<string | null>(null);
  const sheet = useEventSheet(settings);

  const tz = settings.timezone;
  const weekStartsOn = settings.week_starts_on;
  const todayInZone = zonedDate(new Date(), tz);
  const anchor = anchorOverride ?? todayInZone;

  // Week on desktop and Day on the phone, unless the address names a view this layout offers.
  const view = resolveCalendarView(searchParams.get('view'), phone);
  const data = useCalendarData(view, anchor, settings);
  const { allOccurrences, occurrences, skipped, holidays, holidayEvents, modeDays } = data;

  const swipe = useHorizontalSwipe((direction) =>
    setAnchorOverride(shiftAnchor(view, anchor, direction === 'next' ? 1 : -1))
  );

  function changeView(next: CalendarView): void {
    setSearchParams({ view: next }, { replace: true });
  }

  function openAlarm(eventId: string, key?: string): void {
    sheet.openEdit(eventId, key === undefined ? null : (allOccurrences.find((item) => item.key === key) ?? null));
  }

  function openDay(day: string): void {
    setAnchorOverride(day);
    changeView('day');
  }

  const loading = eventsStatus === 'idle' || eventsStatus === 'loading';
  const offeredViews = phone ? PHONE_VIEWS : DESKTOP_VIEWS;
  const phoneGridView = view === 'agenda' || view === 'week' ? 'day' : view;

  const periodButtons = (
    <>
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
    </>
  );

  const showHiddenToggle = data.offerShowHidden ? (
    <Toggle
      variant="outline"
      pressed={data.showHidden}
      onPressedChange={data.setShowHidden}
      aria-label="Show hidden alarms"
    >
      {data.showHidden ? <EyeIcon data-icon="inline-start" /> : <EyeOffIcon data-icon="inline-start" />}
      Show hidden
    </Toggle>
  ) : null;

  const viewTabs = (
    <TabsList className="w-full sm:w-fit">
      {offeredViews.map((key) => (
        <TabsTrigger key={key} value={key} className="flex-1 sm:flex-none">
          {VIEW_LABELS[key]}
        </TabsTrigger>
      ))}
    </TabsList>
  );

  const gridProps = {
    anchor,
    tz,
    weekStartsOn,
    events: data.calendarEvents,
    cheatDays: data.cheatDaySet,
    modeDays,
    holidayEvents,
    stretchDays: holidays.stretches,
    // FullCalendar reports the tap that ends a swipe as a dateClick / eventClick (not a click), so each is guarded.
    onCreate: ignoreAfterSwipe(swipe.tracker, sheet.openCreate),
    onEdit: ignoreAfterSwipe(swipe.tracker, openAlarm),
  } as const;

  return (
    <Tabs
      value={view}
      onValueChange={(next) => {
        const parsed = parseCalendarView(String(next));
        if (parsed) changeView(parsed);
      }}
      className="h-[calc(100dvh-var(--tab-bar-h,0px))] gap-0"
    >
      {phone ? (
        <div className="shrink-0 px-2 pt-[max(0.5rem,env(safe-area-inset-top))] pb-2">
          <div className="flex items-center gap-1.5">
            <h1 className="min-w-0 flex-1 truncate pl-2 text-lg font-semibold tabular-nums tracking-tight">
              {viewTitle(view, anchor, weekStartsOn)}
            </h1>
            {periodButtons}
          </div>
          <div className="mt-2 flex items-center gap-2 px-2">
            <div className="min-w-0 flex-1">{viewTabs}</div>
            {showHiddenToggle}
          </div>
        </div>
      ) : (
        <header className="flex shrink-0 items-center gap-2 border-b px-4 py-2 pt-[max(0.5rem,env(safe-area-inset-top))] sm:px-6">
          <AlarmClockIcon className="size-5" aria-hidden="true" />
          <span className="hidden text-sm font-semibold tracking-tight sm:inline">Alarm Calendar</span>
          <div className="ml-auto flex items-start gap-2">
            <ModeChip onOpen={() => setModeDialogOpen(true)} />
            <PassChip onOpen={() => setPassDialogOpen(true)} />
            <Button className="hidden sm:inline-flex" onClick={() => sheet.openCreate()}>
              <PlusIcon data-icon="inline-start" />
              New alarm
            </Button>
            <Button variant="ghost" size="icon" aria-label="Exams" onClick={() => navigate('/exams')}>
              <GraduationCapIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="relative"
              aria-label={openQada ? `Habits and ranks, ${openQada} prayers to make up` : 'Habits and ranks'}
              onClick={() => navigate('/stats')}
            >
              <ChartNoAxesColumnIcon />
              {openQada ? (
                <Badge variant="secondary" aria-hidden="true" className="absolute -top-1 -right-1 h-4 min-w-4 px-1 text-[10px]">
                  {openQada}
                </Badge>
              ) : null}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="relative"
              aria-label={updateAvailable ? 'Settings, an update is available' : 'Settings'}
              onClick={() => navigate('/settings')}
            >
              <SettingsIcon />
              {updateAvailable ? (
                <span aria-hidden="true" className="absolute top-1 right-1 size-2 rounded-full bg-primary" />
              ) : null}
            </Button>
          </div>
        </header>
      )}

      {phone ? null : (
        <>
          <UpdateBanner />
          <PermissionChip />

          <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 sm:px-6">
            <div className="flex items-center gap-1">{periodButtons}</div>
            <h1 className="min-w-0 flex-1 basis-40 truncate text-lg font-semibold tabular-nums tracking-tight">
              {viewTitle(view, anchor, weekStartsOn)}
            </h1>
            {showHiddenToggle}
            {viewTabs}
          </div>
        </>
      )}

      {skipped !== null ? (
        <p role="status" className="shrink-0 px-4 pb-2 text-sm text-destructive sm:px-6">
          {skipped}
        </p>
      ) : null}

      {holidays.publicFailed ? (
        <p role="status" className="shrink-0 px-4 pb-2 text-sm text-destructive sm:px-6">
          Public holidays couldn't be loaded. Reload the app to try again.
        </p>
      ) : null}

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
      ) : phone ? (
        // One grid for every phone view, remounted per view so FullCalendar starts on the right one. touch-pan-y
        // (and the rule in index.css for its inner scroller) keeps the vertical scroll native and leaves sideways
        // movement to the swipe hook.
        <div className="swipe-x min-h-0 flex-1 touch-pan-y px-1 pb-1" {...swipe.handlers}>
          <CalendarGrid
            key={phoneGridView}
            view={phoneGridView}
            compact
            onPickDay={ignoreAfterSwipe(swipe.tracker, openDay)}
            {...gridProps}
          />
        </div>
      ) : (
        <>
          <TabsContent value="week" className="min-h-0 flex-1 px-2 pb-2 sm:px-4">
            <CalendarGrid view="week" {...gridProps} />
          </TabsContent>
          <TabsContent value="month" className="min-h-0 flex-1 px-2 pb-2 sm:px-4">
            <CalendarGrid view="month" {...gridProps} />
          </TabsContent>
          <TabsContent value="agenda" className="min-h-0 flex-1 overflow-y-auto">
            <AgendaView
              start={anchor}
              days={AGENDA_DAYS}
              today={todayInZone}
              tz={tz}
              events={events}
              occurrences={occurrences}
              hiddenCount={data.hiddenInRange}
              cheatDays={data.cheatDaySet}
              modeDays={modeDays}
              holidayDays={data.holidayDays}
              stretchDays={data.stretchDays}
              onEdit={openAlarm}
              onCreate={() => sheet.openCreate()}
            />
          </TabsContent>
        </>
      )}

      {phone ? <NewAlarmFab onClick={() => sheet.openCreate()} /> : null}

      <EventSheet target={sheet.target} settings={settings} onClose={sheet.close} />
      <PassDialog open={passDialogOpen} onOpenChange={setPassDialogOpen} />
      <ModeDialog open={modeDialogOpen} onOpenChange={setModeDialogOpen} />
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
