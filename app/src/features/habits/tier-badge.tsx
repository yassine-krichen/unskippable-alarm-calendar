import type { HabitTier } from '@alarm-calendar/core';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

import { TIER_META } from './tier-meta';

interface TierBadgeProps {
  tier: HabitTier;
  className?: string;
}

/** Icon plus name, so a tier reads without colour. */
export function TierBadge({ tier, className }: TierBadgeProps) {
  const { label, icon: Icon, iconClass } = TIER_META[tier];
  return (
    <Badge variant="outline" className={cn('h-6 gap-1.5 px-2.5 text-sm', className)}>
      <Icon className={cn('size-4!', iconClass)} aria-hidden="true" />
      {label}
    </Badge>
  );
}
