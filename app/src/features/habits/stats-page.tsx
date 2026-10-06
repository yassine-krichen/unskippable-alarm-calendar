import {
  HABIT_MAX_WINDOW_DAYS,
  HABIT_MIN_SCORED,
  HABIT_WINDOW_DAYS,
  displayScore,
  type HabitEvent,
  type HabitStats,
  type HabitsReport,
} from '@alarm-calendar/core';
import { ArrowLeftIcon, CheckIcon, FlameIcon, PauseIcon, RepeatIcon, TicketIcon, XIcon } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useNavigate } from 'react-router';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { useEventsStore } from '@/features/events/events-store';

import { sortHabits, unrankedProgress, weeksLabel } from './habit-view';
import { loadHabitCompletions, useHabitCompletionsStore } from './habits-store';
import { TierBadge } from './tier-badge';
import { RANKED_TIERS_DESCENDING, TIER_META } from './tier-meta';
import { useHabitsReport } from './use-habits-report';

const MIN_WEEKS = weeksLabel(HABIT_WINDOW_DAYS);
const MAX_WEEKS = weeksLabel(HABIT_MAX_WINDOW_DAYS);
// A thicker track than the shadcn default, so a score reads at a glance.
const BAR = '[&_[data-slot=progress-track]]:h-2';

/** Habits and ranks: how each repeating alarm has gone over the last four weeks. */
export function StatsPage() {
  const navigate = useNavigate();
  const view = useHabitsReport();
  const completionsStatus = useHabitCompletionsStore((state) => state.status);
  const completionsError = useHabitCompletionsStore((state) => state.error);
  const eventsStatus = useEventsStore((state) => state.status);

  const loading =
    view === null || eventsStatus !== 'ready' || completionsStatus === 'idle' || completionsStatus === 'loading';

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col">
      <header className="flex items-center gap-2 border-b px-4 py-2 pt-[max(0.5rem,env(safe-area-inset-top))] sm:px-6">
        <Button variant="ghost" size="icon" aria-label="Back to calendar" onClick={() => navigate('/')}>
          <ArrowLeftIcon />
        </Button>
        <h1 className="text-lg font-semibold tracking-tight">Habits</h1>
      </header>

      <main className="flex flex-1 flex-col gap-6 px-4 py-6 pb-12 sm:px-6">
        {completionsStatus === 'error' ? (
          // Without completions every alarm would look missed, so show no numbers at all.
          <Alert variant="destructive">
            <AlertTitle>Couldn't load your history</AlertTitle>
            <AlertDescription className="flex flex-col items-start gap-2">
              {completionsError ?? 'Check your connection and try again.'}
              <Button variant="outline" size="sm" onClick={() => void loadHabitCompletions()}>
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        ) : loading ? (
          <StatsSkeleton />
        ) : view.report.habits.length + view.pending.length + view.report.failed.length === 0 ? (
          <NoHabits onBack={() => navigate('/')} />
        ) : (
          <>
            {view.report.failed.length > 0 ? (
              <p role="status" className="text-sm text-destructive">
                {view.report.failed.some((habit) => habit.kind === 'prayer')
                  ? "Prayer times couldn't be calculated, so the prayers are left out. Check your location in Settings."
                  : "Some habits couldn't be scored because their settings are not valid."}
              </p>
            ) : null}
            {view.report.habits.length > 0 ? <OverallCard report={view.report} /> : null}
            <HabitList habits={sortHabits(view.report.habits)} pending={view.pending} loading={view.loading} />
            <HowRanksWork />
          </>
        )}
      </main>
    </div>
  );
}

function OverallCard({ report }: { report: HabitsReport }) {
  const ranked = report.habits.filter((habit) => habit.score !== null).length;
  const unranked = report.habits.length - ranked;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Overall</CardTitle>
        <CardDescription>Recent weeks, across all your repeating alarms</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {report.overallScore === null ? (
          <p className="text-sm">
            No score yet. A repeating alarm needs {HABIT_MIN_SCORED} scored alarms in its window to be ranked.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <span className="text-4xl font-semibold tracking-tight tabular-nums">
                {displayScore(report.overallScore)}
              </span>
              <span className="text-sm text-muted-foreground">out of 100</span>
              <TierBadge tier={report.overallTier} className="ml-auto" />
            </div>
            <Progress
              value={report.overallScore}
              aria-label="Overall score"
              className={BAR}
            />
            <p className="text-sm text-muted-foreground">
              Pooled from {ranked} ranked {ranked === 1 ? 'habit' : 'habits'}. Habits with more recent alarms count for
              more.
            </p>
          </>
        )}
        {unranked > 0 ? (
          <p className="text-sm text-muted-foreground">
            {unranked === 1 ? '1 habit is' : `${unranked} habits are`} unranked. A habit needs {HABIT_MIN_SCORED}{' '}
            scored alarms in its window, at least {MIN_WEEKS}.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

interface HabitListProps {
  habits: HabitStats[];
  /** Habits whose history is not loaded yet, listed after the scored ones. */
  pending: HabitEvent[];
  loading: boolean;
}

function HabitList({ habits, pending, loading }: HabitListProps) {
  return (
    <section aria-labelledby="habits-heading" className="flex flex-col gap-3">
      <h2 id="habits-heading" className="text-base font-semibold tracking-tight">
        Your habits
      </h2>
      <Card className="gap-0 py-0">
        <ul>
          {habits.map((habit, index) => (
            <li key={habit.eventId}>
              {index > 0 ? <Separator /> : null}
              <HabitRow habit={habit} />
            </li>
          ))}
          {pending.map((event, index) => (
            <li key={event.id}>
              {habits.length + index > 0 ? <Separator /> : null}
              <PendingHabitRow event={event} loading={loading} />
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}

function HabitRow({ habit }: { habit: HabitStats }) {
  const pooledPrayer = habit.pooled === 'prayer';
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className="size-2.5 shrink-0 rounded-full bg-muted-foreground/40"
          style={habit.color ? { backgroundColor: habit.color } : undefined}
        />
        <h3 className="min-w-0 flex-1 truncate font-medium">{habit.title}</h3>
        <TierBadge tier={habit.tier} />
      </div>
      {pooledPrayer ? (
        <p className="text-sm text-muted-foreground">
          Fajr, Dhuhr, Asr, Maghrib and Isha together. A day counts when you prayed all of them.
        </p>
      ) : null}

      {habit.score !== null ? (
        <div className="flex items-center gap-3">
          <Progress value={habit.score} aria-label={`${habit.title} score`} className={`${BAR} flex-1`} />
          <span className="w-9 text-right text-sm font-medium tabular-nums">{displayScore(habit.score)}</span>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {unrankedProgress(habit)}. Needs {HABIT_MIN_SCORED}
          {pooledPrayer ? ' days' : ''} in the last {weeksLabel(habit.windowDays)} to get a rank.
        </p>
      )}

      <dl className="flex flex-wrap gap-x-5 gap-y-1.5 text-sm">
        <Stat icon={CheckIcon} label="Done" value={habit.done} />
        <Stat icon={XIcon} label="Missed" value={habit.missed} />
        <Stat icon={TicketIcon} label="Excused" value={habit.excused} />
        {habit.paused > 0 ? <Stat icon={PauseIcon} label="Paused" value={habit.paused} /> : null}
        <Stat icon={FlameIcon} label={pooledPrayer ? 'Day streak' : 'Streak'} value={habit.currentStreak} />
        <Stat
          icon={RepeatIcon}
          label={`Best in ${weeksLabel(habit.windowDays)}${pooledPrayer ? ' (days)' : ''}`}
          value={habit.bestStreak}
        />
      </dl>
    </div>
  );
}

/** A habit whose history is not loaded: never shown as misses, only as loading or unavailable. */
function PendingHabitRow({ event, loading }: { event: HabitEvent; loading: boolean }) {
  return (
    <div className="flex flex-col gap-2 p-4">
      <div className="flex items-center gap-2">
        <h3 className="min-w-0 flex-1 truncate font-medium">{event.title}</h3>
        <TierBadge tier="unranked" />
      </div>
      {loading ? (
        <Skeleton className="h-5 w-56" aria-label="Loading history" />
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <p className="text-sm text-muted-foreground">Couldn't load this habit's history, so it isn't scored.</p>
          <Button variant="outline" size="sm" onClick={() => void loadHabitCompletions()}>
            Try again
          </Button>
        </div>
      )}
    </div>
  );
}

interface StatProps {
  icon: LucideIcon;
  label: string;
  value: number;
}

function Stat({ icon: Icon, label, value }: StatProps) {
  return (
    <div className="flex items-center gap-1.5">
      <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
      {/* The term comes first in the markup; CSS order shows the number before it. */}
      <dt className="order-3 text-muted-foreground">{label}</dt>
      <dd className="order-2 font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function HowRanksWork() {
  return (
    <section aria-labelledby="ranks-heading" className="flex flex-col gap-3">
      <h2 id="ranks-heading" className="text-base font-semibold tracking-tight">
        How ranks work
      </h2>
      <p className="max-w-prose text-sm text-muted-foreground">
        Only repeating alarms count; yearly alarms such as birthdays and anniversaries are not ranked. The five daily
        prayers are one habit, Prayer: its score pools all five, and a day is done only when every prayer of that day
        is, so one missed prayer ends the day streak. Each other alarm is scored over the last {MIN_WEEKS}, or over five of its own repeat periods
        if that is longer (up to {MAX_WEEKS}), so a weekly or monthly alarm can be ranked too. A done alarm earns full
        credit, each snooze costs a little, and a miss counts double. Recent alarms weigh more. Cheat days, alarms
        paused by a mode (Sick, Vacation and the like) and alarms still inside their late window are left out. A
        streak is a run of done alarms over the same window; a cheat day or a paused alarm keeps it going without
        adding to it.
      </p>
      <ul className="grid gap-2 sm:grid-cols-2">
        {RANKED_TIERS_DESCENDING.map((tier) => (
          <li key={tier} className="flex items-center gap-3 text-sm">
            <TierBadge tier={tier} className="w-28 justify-start" />
            <span className="text-muted-foreground">{TIER_META[tier].range}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function NoHabits({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-center">
      <RepeatIcon className="size-8 text-muted-foreground" aria-hidden="true" />
      <h2 className="text-lg font-semibold tracking-tight">No repeating alarms yet</h2>
      <p className="max-w-sm text-sm text-muted-foreground">
        A habit is an alarm that repeats. Make one, and after {HABIT_MIN_SCORED} scored alarms it gets a rank.
      </p>
      <Button onClick={onBack}>Back to calendar</Button>
    </div>
  );
}

function StatsSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading habits">
      <Skeleton className="h-36 w-full" />
      <Skeleton className="h-6 w-32" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
