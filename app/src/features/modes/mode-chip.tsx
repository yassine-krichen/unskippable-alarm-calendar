import { useMemo } from 'react';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useExamsStore } from '@/features/exams/exams-store';
import { useSettingsStore } from '@/features/settings/settings-store';
import { useNow } from '@/hooks/use-now';
import { formatDay } from '@/lib/zoned-time';

import { ModeIcon } from './mode-icon';
import { NORMAL_LABEL } from './mode-meta';
import { currentMode, upcomingModes } from './mode-status';
import { useModesStore } from './modes-store';
import { useModeTimeline } from './use-modes';

interface ModeChipProps {
  onOpen: () => void;
}

/**
 * Header chip: which mode is in effect, and the switch. Normal is the quiet outline button; a mode that is on
 * fills it, so a day under Sick or Vacation is not something you have to remember. The line under it says
 * when it ends, or what starts next.
 */
export function ModeChip({ onOpen }: ModeChipProps) {
  const settings = useSettingsStore((state) => state.settings);
  const modes = useModesStore((state) => state.modes);
  const status = useModesStore((state) => state.status);
  const exams = useExamsStore((state) => state.exams);
  const timeline = useModeTimeline();
  const now = useNow();
  const tz = settings?.timezone ?? 'UTC';

  const current = useMemo(() => currentMode(timeline, now, tz), [timeline, now, tz]);
  const next = useMemo(() => upcomingModes(timeline, modes, now, tz, 1)[0] ?? null, [timeline, modes, now, tz]);

  if (settings === null || status === 'idle' || (status === 'loading' && modes.length === 0)) {
    return <Skeleton className="h-8 w-24" />;
  }
  // Modes that could not be loaded: the chip stays out of the way (every alarm rings, the safe direction).
  if (status === 'error') return null;

  const name = current === null ? NORMAL_LABEL : current.mode.name;
  const secondary =
    current !== null
      ? current.lastDay === null
        ? 'Until you switch it off'
        : `Until ${formatDay(current.lastDay)}`
      : next !== null
        ? `${next.mode.name} from ${formatDay(next.startDay)}`
        : null;
  const nextExam = next?.examId != null ? exams.find((exam) => exam.id === next.examId) : undefined;

  return (
    <div className="flex flex-col items-end">
      <Button
        variant={current === null ? 'outline' : 'secondary'}
        onClick={onOpen}
        aria-label={`Mode: ${name}${secondary === null ? '' : `. ${secondary}`}. Change mode`}
      >
        <ModeIcon of={current?.mode ?? null} data-icon="inline-start" />
        <span className="max-w-28 truncate">{name}</span>
      </Button>
      {secondary !== null ? (
        <span className="mt-0.5 hidden text-xs text-muted-foreground sm:block" title={nextExam?.title}>
          {secondary}
        </span>
      ) : null}
    </div>
  );
}
