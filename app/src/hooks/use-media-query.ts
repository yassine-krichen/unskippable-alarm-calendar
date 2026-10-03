import { useSyncExternalStore } from 'react';

/** Tracks a CSS media query, e.g. useMediaQuery('(min-width: 768px)'). */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches,
    () => false
  );
}

/** Desktop layout: side sheet and Week as the default calendar view. */
export function useIsDesktop(): boolean {
  return useMediaQuery('(min-width: 768px)');
}
