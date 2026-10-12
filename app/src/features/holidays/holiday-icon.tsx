import type { CalendarHoliday } from '@alarm-calendar/core';
import { FlagIcon, MosqueIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

interface HolidayIconProps {
  holiday: Pick<CalendarHoliday, 'kind' | 'publicHoliday'>;
  className?: string;
}

/**
 * A mosque for an Islamic holiday, a flag for a country's public holiday, and both for an Islamic holiday the country
 * also makes a day off. Shape carries the meaning, so it reads without the colour. The mosque is not the moon of the
 * prayers, which stay with the alarms.
 */
export function HolidayIcon({ holiday, className }: HolidayIconProps) {
  if (holiday.kind === 'public') {
    return <FlagIcon aria-label="Public holiday" className={cn('shrink-0', className)} />;
  }
  return (
    <>
      <MosqueIcon aria-label="Islamic holiday" className={cn('shrink-0', className)} />
      {holiday.publicHoliday ? <FlagIcon aria-label="Public holiday" className={cn('shrink-0', className)} /> : null}
    </>
  );
}
