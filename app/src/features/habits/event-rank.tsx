import { HABIT_MIN_SCORED, displayScore } from '@alarm-calendar/core';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

import { loadHabitCompletions, useHabitCompletionsStore } from './habits-store';
import { TierBadge } from './tier-badge';
import { isRankPending, unrankedProgress, weeksLabel } from './habit-view';
import { useHabitsReport } from './use-habits-report';

/**
 * The rank of one repeating alarm, shown in its edit sheet. Renders nothing when unavailable. For a prayer pass
 * PRAYER_HABIT_ID: the five prayers are one habit, so each shows the combined rank.
 */
export function EventRank({ eventId }: { eventId: string }) {
  const view = useHabitsReport();
  const status = useHabitCompletionsStore((state) => state.status);

  if (status === 'idle' || status === 'loading') return <Skeleton className="h-6 w-48" />;
  // Without the history every alarm would look missed, so show no rank rather than a wrong one.
  if (status === 'error') return null;
  if (view === null) return null;
  if (isRankPending(eventId, view.pending)) {
    // Not scored until its whole window is loaded: a rank from partial history would be wrong.
    if (view.loading) return <Skeleton className="h-6 w-48" />;
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-sm text-muted-foreground">Rank unavailable: history not loaded.</span>
        <Button variant="outline" size="sm" onClick={() => void loadHabitCompletions()}>
          Try again
        </Button>
      </div>
    );
  }
  const habit = view.report.habits.find((candidate) => candidate.eventId === eventId);
  if (habit === undefined) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <TierBadge tier={habit.tier} />
      <span className="text-sm text-muted-foreground">
        {habit.pooled === 'prayer' ? 'All five prayers together. ' : ''}
        {habit.score === null
          ? `${unrankedProgress(habit)}. Needs ${HABIT_MIN_SCORED}${habit.pooled === 'prayer' ? ' days' : ''} in ${weeksLabel(habit.windowDays)}.`
          : `Score ${displayScore(habit.score)} over ${weeksLabel(habit.windowDays)}: ${habit.done} done, ${habit.missed} missed.`}
      </span>
    </div>
  );
}
