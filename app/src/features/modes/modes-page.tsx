import type { ModeRow } from '@alarm-calendar/core';
import { ArrowLeftIcon, PencilIcon, PlusIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { useExamsStore } from '@/features/exams/exams-store';
import { useSettingsStore } from '@/features/settings/settings-store';
import { useNow } from '@/hooks/use-now';

import { ModeEditorSheet } from './mode-editor-sheet';
import { ModeIcon } from './mode-icon';
import { defaultBehaviorSummary, listableModes, modePurpose } from './mode-meta';
import { currentMode, modeDetailLine, upcomingLine, upcomingModes } from './mode-status';
import { NewModeDialog } from './new-mode-dialog';
import { loadModes, useModesStore } from './modes-store';
import { useModeTimeline } from './use-modes';

/** Modes: what each one does to your alarms, when they switch on, and the rules per alarm. */
export function ModesPage() {
  const navigate = useNavigate();
  const settings = useSettingsStore((state) => state.settings);
  const modes = useModesStore((state) => state.modes);
  const status = useModesStore((state) => state.status);
  const error = useModesStore((state) => state.error);
  const exams = useExamsStore((state) => state.exams);
  const timeline = useModeTimeline();
  const now = useNow();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const tz = settings?.timezone ?? 'UTC';
  const listed = useMemo(() => listableModes(modes), [modes]);
  const current = useMemo(() => currentMode(timeline, now, tz), [timeline, now, tz]);
  const upcoming = useMemo(() => upcomingModes(timeline, modes, now, tz, 3), [timeline, modes, now, tz]);
  const editing = editingId === null ? null : (modes.find((mode) => mode.id === editingId) ?? null);

  if (!settings) return null;

  const loading = status === 'idle' || (status === 'loading' && modes.length === 0);
  const examTitle = (id: string | null): string | undefined => (id === null ? undefined : exams.find((exam) => exam.id === id)?.title);

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col">
      <header className="flex items-center gap-2 border-b px-4 py-2 pt-[max(0.5rem,env(safe-area-inset-top))] sm:px-6">
        <Button variant="ghost" size="icon" aria-label="Back to calendar" onClick={() => navigate('/')}>
          <ArrowLeftIcon />
        </Button>
        <h1 className="text-lg font-semibold tracking-tight">Modes</h1>
        <Button className="ml-auto" onClick={() => setCreating(true)} disabled={status !== 'ready'}>
          <PlusIcon data-icon="inline-start" />
          New mode
        </Button>
      </header>

      <main className="flex flex-1 flex-col gap-6 px-4 py-6 pb-12 sm:px-6">
        {status === 'error' ? (
          <Alert variant="destructive">
            <AlertTitle>Couldn't load your modes</AlertTitle>
            <AlertDescription className="flex flex-col items-start gap-2">
              {error ?? 'Check your connection and try again.'} Until they load, every alarm rings as set.
              <Button variant="outline" size="sm" onClick={() => void loadModes()}>
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        ) : loading ? (
          <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading modes">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        ) : (
          <>
            <section aria-labelledby="modes-now" className="flex flex-col gap-1">
              <h2 id="modes-now" className="text-base font-semibold tracking-tight">
                {current === null ? 'Normal right now' : `${current.mode.name} is on`}
              </h2>
              <p className="text-sm text-muted-foreground">{modeDetailLine(current, now, tz, examTitle(current?.examId ?? null))}</p>
              {upcoming.map((item) => (
                <p key={`${item.mode.id}-${item.startDay}`} className="text-sm text-muted-foreground">
                  Next: {upcomingLine(item, examTitle(item.examId))}.
                </p>
              ))}
              <p className="mt-1 max-w-prose text-sm text-muted-foreground">
                Switch a mode on from the calendar header, plan it for a range of days below, or let Exam mode start
                by itself before an exam. A manual switch beats a planned range, and a range beats Exam mode.
              </p>
            </section>

            <section aria-labelledby="modes-list" className="flex flex-col gap-3">
              <h2 id="modes-list" className="text-base font-semibold tracking-tight">
                Your modes
              </h2>
              <Card className="gap-0 py-0">
                <ul>
                  {listed.map((mode, index) => (
                    <li key={mode.id}>
                      {index > 0 ? <Separator /> : null}
                      <ModeRowView mode={mode} isCurrent={current?.mode.id === mode.id} onEdit={() => setEditingId(mode.id)} />
                    </li>
                  ))}
                </ul>
              </Card>
            </section>
          </>
        )}
      </main>

      <ModeEditorSheet mode={editing} onClose={() => setEditingId(null)} />
      <NewModeDialog open={creating} onOpenChange={setCreating} onCreated={(mode) => setEditingId(mode.id)} />
    </div>
  );
}

function ModeRowView({ mode, isCurrent, onEdit }: { mode: ModeRow; isCurrent: boolean; onEdit: () => void }) {
  return (
    <div className="flex items-start gap-3 p-4">
      <ModeIcon of={mode} className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-medium">{mode.name}</h3>
          {isCurrent ? <Badge>On now</Badge> : null}
          {!mode.active ? <Badge variant="outline">Off</Badge> : null}
        </div>
        <p className="text-sm text-muted-foreground">{modePurpose(mode)}</p>
        <p className="text-sm text-muted-foreground">{defaultBehaviorSummary(mode)}</p>
      </div>
      <Button variant="ghost" size="icon" aria-label={`Edit ${mode.name}`} onClick={onEdit}>
        <PencilIcon />
      </Button>
    </div>
  );
}
