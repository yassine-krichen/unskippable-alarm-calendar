import type { ModeRow } from '@alarm-calendar/core';
import { GraduationCapIcon, MoonStarIcon, SunIcon, TagIcon, ThermometerIcon, TreePalmIcon } from 'lucide-react';
import type { ComponentProps } from 'react';

type IconProps = ComponentProps<typeof SunIcon>;

/**
 * The icon of a mode: one per built-in, a tag for a custom one, a sun for Normal (null). The prop is not
 * called `mode` because that is an attribute of SVG elements.
 */
export function ModeIcon({ of, ...props }: { of: Pick<ModeRow, 'builtin_key'> | null } & IconProps) {
  switch (of?.builtin_key) {
    case 'exam':
      return <GraduationCapIcon {...props} />;
    case 'ramadan':
      return <MoonStarIcon {...props} />;
    case 'vacation':
      return <TreePalmIcon {...props} />;
    case 'sick':
      return <ThermometerIcon {...props} />;
    default:
      return of === null ? <SunIcon {...props} /> : <TagIcon {...props} />;
  }
}
