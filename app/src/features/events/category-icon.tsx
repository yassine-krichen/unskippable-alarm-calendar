import { BookOpenIcon, GiftIcon, GraduationCapIcon, RotateCcwIcon, type LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

import { CATEGORY_LABELS, type AlarmCategory } from './category-colors';

const CATEGORY_ICONS: Record<AlarmCategory, LucideIcon> = {
  birthday: GiftIcon,
  exam: GraduationCapIcon,
  revision: BookOpenIcon,
  'catch-up': RotateCcwIcon,
};

// Tinted with the category's own token, so a list row carries the colour the calendar chip does.
const CATEGORY_ICON_COLORS: Record<AlarmCategory, string> = {
  birthday: 'text-(--cat-birthday-accent)',
  exam: 'text-(--cat-exam-solid)',
  revision: 'text-(--cat-revision-accent)',
  'catch-up': 'text-(--cat-revision-accent)',
};

interface CategoryIconProps {
  category: AlarmCategory;
  /** Leave the colour to the surrounding text (inside a calendar chip, which sets its own). */
  inherit?: boolean;
  className?: string;
}

/** The icon of a fixed-colour alarm category: shape plus colour, so it reads without the colour. */
export function CategoryIcon({ category, inherit = false, className }: CategoryIconProps) {
  const Icon = CATEGORY_ICONS[category];
  return (
    <Icon
      aria-label={CATEGORY_LABELS[category]}
      className={cn('shrink-0', inherit ? '' : CATEGORY_ICON_COLORS[category], className)}
    />
  );
}
