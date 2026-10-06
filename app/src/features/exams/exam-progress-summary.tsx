import type { ExamProgress, ExamRow } from '@alarm-calendar/core';
import { CheckIcon, ClockIcon, TicketIcon, XIcon } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';

import { loadExamCompletions } from './exams-store';
import { useExamProgress } from './use-exam-progress';

// A thicker track than the shadcn default, like the habit scores.
const BAR = '[&_[data-slot=progress-track]]:h-2';

function Count({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: number }) {
  return (
    <div className="flex items-center gap-1.5">
      <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
      {/* The term comes first in the markup; CSS order shows the number before it. */}
      <dt className="order-3 text-muted-foreground">{label}</dt>
      <dd className="order-2 font-medium tabular-nums">{value}</dd>
    </div>
  );
}

/** Done, missed, skipped and still-to-come revision sessions of one exam, with a bar for the done share. */
export function ExamProgressSummary({ exam }: { exam: Pick<ExamRow, 'id' | 'title' | 'exam_at'> }) {
  const state = useExamProgress(exam);
  if (state.status === 'loading') return <Skeleton className="h-9 w-full" aria-label="Loading progress" />;
  // Too old for its completions to be loaded: say nothing rather than show counts that would be wrong.
  if (state.status === 'archived') return null;
  if (state.status === 'error') {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <p className="text-sm text-muted-foreground">Couldn't load your progress.</p>
        <Button type="button" variant="outline" size="sm" onClick={() => void loadExamCompletions()}>
          Try again
        </Button>
      </div>
    );
  }
  return <ProgressView progress={state.progress} title={exam.title} />;
}

function ProgressView({ progress, title }: { progress: ExamProgress; title: string }) {
  if (progress.total === 0) {
    return <p className="text-sm text-muted-foreground">No revision sessions planned.</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      <Progress value={(progress.done / progress.total) * 100} aria-label={`${title} revision sessions done`} className={BAR} />
      <dl className="flex flex-wrap gap-x-5 gap-y-1.5 text-sm">
        <Count icon={CheckIcon} label="Done" value={progress.done} />
        <Count icon={ClockIcon} label="To go" value={progress.remaining} />
        <Count icon={XIcon} label="Missed" value={progress.missed} />
        {progress.skipped > 0 ? <Count icon={TicketIcon} label="Skipped" value={progress.skipped} /> : null}
      </dl>
    </div>
  );
}
