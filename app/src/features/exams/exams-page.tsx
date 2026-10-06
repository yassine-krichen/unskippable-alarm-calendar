import { dayNumberFromDateString, type ExamRow } from '@alarm-calendar/core';
import { ArrowLeftIcon, GraduationCapIcon, PencilIcon, PlusIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EventSheet } from '@/features/events/event-sheet';
import type { EventFormTarget } from '@/features/events/event-form-view';
import { loadExams, useExamsStore } from '@/features/exams/exams-store';
import { useSettingsStore } from '@/features/settings/settings-store';
import { useNow } from '@/hooks/use-now';
import { formatDay, formatTimeInZone, zonedDate } from '@/lib/zoned-time';

import { DIFFICULTY_LABELS } from './exam-plan';
import { ExamProgressSummary } from './exam-progress-summary';

/** How far off an exam is, in calendar days of the settings zone: "Today", "Tomorrow", "In 12 days", "3 days ago". */
function whenLabel(exam: ExamRow, now: Date, tz: string): string {
  const days = dayNumberFromDateString(zonedDate(new Date(exam.exam_at), tz)) - dayNumberFromDateString(zonedDate(now, tz));
  if (days === 0) return Date.parse(exam.exam_at) > now.getTime() ? 'Today' : 'Earlier today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  return days > 0 ? `In ${days} days` : `${-days} days ago`;
}

/** The exams, upcoming first, each with how its revision sessions are going. Adding and editing use the alarm sheet. */
export function ExamsPage() {
  const navigate = useNavigate();
  const settings = useSettingsStore((state) => state.settings);
  const exams = useExamsStore((state) => state.exams);
  const status = useExamsStore((state) => state.status);
  const error = useExamsStore((state) => state.error);
  const now = useNow();
  const [formTarget, setFormTarget] = useState<EventFormTarget | null>(null);

  const tz = settings?.timezone ?? 'UTC';
  const { upcoming, past } = useMemo(() => {
    const byTime = [...exams].sort((a, b) => Date.parse(a.exam_at) - Date.parse(b.exam_at));
    const split = byTime.findIndex((exam) => Date.parse(exam.exam_at) >= now.getTime());
    return split === -1
      ? { upcoming: [], past: byTime.reverse() }
      : { upcoming: byTime.slice(split), past: byTime.slice(0, split).reverse() };
  }, [exams, now]);

  if (!settings) return null;

  const loading = status === 'idle' || status === 'loading';

  function openCreate(): void {
    setFormTarget({ event: null, startOn: 'exam', slot: { date: zonedDate(new Date(), tz), time: '09:00' } });
  }

  function openEdit(exam: ExamRow): void {
    setFormTarget({ event: null, exam, slot: { date: zonedDate(new Date(), tz), time: '09:00' } });
  }

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col">
      <header className="flex items-center gap-2 border-b px-4 py-2 pt-[max(0.5rem,env(safe-area-inset-top))] sm:px-6">
        <Button variant="ghost" size="icon" aria-label="Back to calendar" onClick={() => navigate('/')}>
          <ArrowLeftIcon />
        </Button>
        <h1 className="text-lg font-semibold tracking-tight">Exams</h1>
        <Button className="ml-auto" onClick={openCreate}>
          <PlusIcon data-icon="inline-start" />
          New exam
        </Button>
      </header>

      <main className="flex flex-1 flex-col gap-6 px-4 py-6 pb-12 sm:px-6">
        {status === 'error' ? (
          <Alert variant="destructive">
            <AlertTitle>Couldn't load your exams</AlertTitle>
            <AlertDescription className="flex flex-col items-start gap-2">
              {error ?? 'Check your connection and try again.'}
              <Button variant="outline" size="sm" onClick={() => void loadExams()}>
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        ) : loading ? (
          <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading exams">
            <Skeleton className="h-36 w-full" />
            <Skeleton className="h-36 w-full" />
          </div>
        ) : exams.length === 0 ? (
          <NoExams onCreate={openCreate} />
        ) : (
          <>
            {upcoming.length > 0 ? (
              <ExamSection heading="Upcoming" exams={upcoming} now={now} tz={tz} onEdit={openEdit} />
            ) : null}
            {past.length > 0 ? <ExamSection heading="Past" exams={past} now={now} tz={tz} onEdit={openEdit} /> : null}
          </>
        )}
      </main>

      <EventSheet target={formTarget} settings={settings} onClose={() => setFormTarget(null)} />
    </div>
  );
}

interface ExamSectionProps {
  heading: string;
  exams: ExamRow[];
  now: Date;
  tz: string;
  onEdit: (exam: ExamRow) => void;
}

function ExamSection({ heading, exams, now, tz, onEdit }: ExamSectionProps) {
  const id = `exams-${heading.toLowerCase()}`;
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h2 id={id} className="text-base font-semibold tracking-tight">
        {heading}
      </h2>
      <ul className="flex flex-col gap-3">
        {exams.map((exam) => (
          <li key={exam.id}>
            <ExamCard exam={exam} now={now} tz={tz} onEdit={() => onEdit(exam)} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function ExamCard({ exam, now, tz, onEdit }: { exam: ExamRow; now: Date; tz: string; onEdit: () => void }) {
  const at = new Date(exam.exam_at);
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <CardTitle className="truncate">{exam.title}</CardTitle>
            <CardDescription>
              {whenLabel(exam, now, tz)}, {formatDay(zonedDate(at, tz), { year: true })} at {formatTimeInZone(at, tz)}
            </CardDescription>
          </div>
          <Badge variant="outline" className="shrink-0">
            {DIFFICULTY_LABELS[exam.difficulty]}
          </Badge>
          <Button variant="ghost" size="icon" aria-label={`Edit ${exam.title}`} onClick={onEdit}>
            <PencilIcon />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <ExamProgressSummary exam={exam} />
      </CardContent>
    </Card>
  );
}

function NoExams({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-center">
      <GraduationCapIcon className="size-8 text-muted-foreground" aria-hidden="true" />
      <h2 className="text-lg font-semibold tracking-tight">No exams yet</h2>
      <p className="max-w-sm text-sm text-muted-foreground">
        Add an exam and it plans your revision: an alarm 7, 3 and 1 days before (and 14 for a hard one), plus a
        catch-up if you miss one.
      </p>
      <Button onClick={onCreate}>
        <PlusIcon data-icon="inline-start" />
        Add an exam
      </Button>
    </div>
  );
}
