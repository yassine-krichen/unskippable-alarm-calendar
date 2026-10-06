import type { HabitTier } from '@alarm-calendar/core';
import { AwardIcon, CircleDashedIcon, GemIcon, MedalIcon, ShieldIcon, TrophyIcon } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface TierMeta {
  label: string;
  /** Each tier has its own icon, so the rank never depends on colour alone. */
  icon: LucideIcon;
  /** Colour of the icon only; the label stays in the normal text colour for contrast. */
  iconClass: string;
  /** The score range, for the legend. */
  range: string;
}

export const TIER_META: Record<HabitTier, TierMeta> = {
  unranked: { label: 'Unranked', icon: CircleDashedIcon, iconClass: 'text-muted-foreground', range: 'Fewer than 5 scored alarms' },
  bronze: { label: 'Bronze', icon: MedalIcon, iconClass: 'text-amber-700 dark:text-amber-500', range: 'Below 40' },
  silver: { label: 'Silver', icon: ShieldIcon, iconClass: 'text-slate-500 dark:text-slate-300', range: '40 to 59' },
  gold: { label: 'Gold', icon: AwardIcon, iconClass: 'text-yellow-600 dark:text-yellow-400', range: '60 to 74' },
  platinum: { label: 'Platinum', icon: TrophyIcon, iconClass: 'text-cyan-700 dark:text-cyan-300', range: '75 to 89' },
  diamond: { label: 'Diamond', icon: GemIcon, iconClass: 'text-indigo-600 dark:text-indigo-300', range: '90 and up' },
};

/** Best first, for the legend. */
export const RANKED_TIERS_DESCENDING: readonly HabitTier[] = ['diamond', 'platinum', 'gold', 'silver', 'bronze'];
