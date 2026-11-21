import type { Settings } from '@alarm-calendar/core';
import { useState } from 'react';
import { Navigate } from 'react-router';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { NewAlarmFab } from '@/features/app-shell/new-alarm-fab';
import { PageHeader } from '@/features/app-shell/page-header';
import { AgendaView } from '@/features/calendar/agenda-view';
import { AGENDA_DAYS } from '@/features/calendar/calendar-range';
import { useCalendarData } from '@/features/calendar/use-calendar-data';
import { EventSheet } from '@/features/events/event-sheet';
import { loadEvents, useEventsStore } from '@/features/events/events-store';
import { useEventSheet } from '@/features/events/use-event-sheet';
import { ModeChip } from '@/features/modes/mode-chip';
import { ModeDialog } from '@/features/modes/mode-dialog';
import { PassChip } from '@/features/passes/pass-chip';
import { PassDialog } from '@/features/passes/pass-dialog';
import { PermissionChip } from '@/features/permissions/permission-chip';
import { useSettingsStore } from '@/features/settings/settings-store';
import { UpdateBanner } from '@/features/updates/update-banner';
import { useIsPhoneLayout } from '@/hooks/use-media-query';
import { useNow } from '@/hooks/use-now';
import { formatDay, formatTimeInZone, zonedDate } from '@/lib/zoned-time';

import { findNextOccurrence, formatCountdown } from './next-alarm';

/**
 * The phone's home: what rings next, the mode and pass chips, any update or permission notice, and the next two
 * weeks as a list. The desktop layout has no Today (its calendar is home), so the address goes there.
 */
export function TodayPage() {
  const phone = useIsPhoneLayout();
  const settings = useSettingsStore((state) => state.settings);
  if (!phone) return <Navigate to="/" replace />;
  if (!settings) return null;
  return <TodayScreen settings={settings} />;
}

function TodayScreen({ settings }: { settings: Settings }) {
  const now = useNow();
  const events = useEventsStore((state) => state.events);
  const eventsStatus = useEventsStore((state) => state.status);
  const [passDialogOpen, setPassDialogOpen] = useState(false);
  const [modeDialogOpen, setModeDialogOpen] = useState(false);
  const sheet = useEventSheet(settings);

  const tz = settings.timezone;
  const today = zonedDate(now, tz);
  const data = useCalendarData('agenda', today, settings);
  const next = findNextOccurrence(data.allOccurrences, now);
  const loading = eventsStatus === 'idle' || eventsStatus === 'loading';

  function openAlarm(eventId: string, key: string): void {
    sheet.openEdit(eventId, data.allOccurrences.find((item) => item.key === key) ?? null);
  }

  return (
    <div className="mx-auto flex min-h-[calc(100dvh-var(--tab-bar-h,0px))] w-full max-w-2xl flex-col">
      <PageHeader title="Today" tabRoot />
      <UpdateBanner />
      <PermissionChip />

      {eventsStatus === 'error' ? (
        <div className="px-4 pt-3">
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
        <div className="flex flex-col gap-3 px-4 pt-3" aria-busy="true" aria-label="Loading alarms">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : (
        <>
          {next !== null ? (
            <div className="px-4 pt-3">
              <button
                type="button"
                onClick={() => openAlarm(next.eventId, next.key)}
                className="flex w-full items-center gap-4 rounded-xl border bg-card px-4 py-3 text-left text-card-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <span className="text-4xl font-semibold tracking-tight tabular-nums">{formatTimeInZone(next.start, tz)}</span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-xs text-muted-foreground">Next alarm</span>
                  <span className="truncate text-base font-medium">{next.title}</span>
                  <span className="text-sm text-muted-foreground tabular-nums">
                    {next.day === today ? 'Today' : formatDay(next.day)}, {formatCountdown(next.start.getTime() - now.getTime())}
                  </span>
                </span>
              </button>
            </div>
          ) : null}

          <div className="flex flex-wrap items-start gap-2 px-4 py-3">
            <ModeChip onOpen={() => setModeDialogOpen(true)} />
            <PassChip onOpen={() => setPassDialogOpen(true)} />
          </div>

          {data.skipped !== null ? (
            <p role="status" className="px-4 pb-2 text-sm text-destructive">
              {data.skipped}
            </p>
          ) : null}

          <div className="min-h-0 flex-1">
            <AgendaView
              start={today}
              days={AGENDA_DAYS}
              today={today}
              tz={tz}
              events={events}
              occurrences={data.occurrences}
              hiddenCount={data.hiddenInRange}
              cheatDays={data.cheatDaySet}
              modeDays={data.modeDays}
              holidayDays={data.holidayDays}
              stretchDays={data.stretchDays}
              onEdit={openAlarm}
              onCreate={() => sheet.openCreate()}
            />
          </div>
        </>
      )}

      <NewAlarmFab onClick={() => sheet.openCreate()} />

      <EventSheet target={sheet.target} settings={settings} onClose={sheet.close} />
      <PassDialog open={passDialogOpen} onOpenChange={setPassDialogOpen} />
      <ModeDialog open={modeDialogOpen} onOpenChange={setModeDialogOpen} />
    </div>
  );
}
