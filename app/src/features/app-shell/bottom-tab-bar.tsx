import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';

import { useOpenQadaCount } from '@/features/habits/use-prayer-log';
import { useUpdateStore } from '@/features/updates/update-store';
import { hapticSelection } from '@/lib/haptics';
import { cn } from '@/lib/utils';

import { TAB_ITEMS, tabOfPath, type TabId } from './nav-items';

/** True while an input, textarea or select has focus, which is when the on-screen keyboard is up. */
function useTextFieldFocused(): boolean {
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    const isField = (target: EventTarget | null): boolean =>
      target instanceof HTMLElement && target.matches('input:not([type=checkbox]):not([type=radio]), textarea, [contenteditable=true]');
    const onFocusIn = (event: FocusEvent): void => setFocused(isField(event.target));
    const onFocusOut = (): void => setFocused(false);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
    };
  }, []);
  return focused;
}

/**
 * The phone layout's navigation: Today, Calendar, Habits and More, in thumb reach. A tap replaces the history
 * entry (tabs are siblings, not a stack), so the Android back button from any tab goes to Today, and from Today
 * leaves the app. It steps aside while a text field has focus, so the keyboard never sits on top of it.
 */
export function BottomTabBar({ onHeightChange }: { onHeightChange: (height: number) => void }) {
  const { pathname } = useLocation();
  const nav = useRef<HTMLElement>(null);
  const active = tabOfPath(pathname);
  const openQada = useOpenQadaCount();
  const updateAvailable = useUpdateStore((state) => state.latest !== null);
  const keyboardUp = useTextFieldFocused();

  // The bar grows with the system font size (its labels are text), so the page above it is told its real height.
  useEffect(() => {
    const element = nav.current;
    if (element === null) return;
    const observer = new ResizeObserver(() => onHeightChange(element.getBoundingClientRect().height));
    observer.observe(element);
    return () => observer.disconnect();
  }, [onHeightChange, keyboardUp]);

  if (keyboardUp) return null;

  const badge = (id: TabId): { label: string | null; dot: boolean } => {
    if (id === 'habits' && openQada) return { label: String(openQada), dot: false };
    if (id === 'more' && updateAvailable) return { label: null, dot: true };
    return { label: null, dot: false };
  };

  return (
    <nav
      ref={nav}
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-40 border-t bg-background pb-[env(safe-area-inset-bottom)]"
    >
      <ul className="mx-auto grid min-h-14 max-w-xl grid-cols-4">
        {TAB_ITEMS.map((tab) => {
          const selected = active === tab.id;
          const { label: badgeLabel, dot } = badge(tab.id);
          const extra =
            tab.id === 'habits' && badgeLabel !== null
              ? `, ${badgeLabel} prayers to make up`
              : tab.id === 'more' && dot
                ? ', an update is available'
                : '';
          return (
            <li key={tab.id} className="contents">
              <Link
                to={tab.path}
                replace
                aria-current={selected ? 'page' : undefined}
                aria-label={`${tab.label}${extra}`}
                onClick={() => {
                  if (!selected) hapticSelection();
                }}
                className="group flex flex-col items-center justify-center gap-0.5 text-xs font-medium text-muted-foreground outline-none aria-[current=page]:text-foreground"
              >
                <span
                  className={cn(
                    'relative flex h-8 w-16 items-center justify-center rounded-full transition-colors group-focus-visible:ring-3 group-focus-visible:ring-ring/50 group-aria-[current=page]:bg-secondary'
                  )}
                >
                  <tab.icon className="size-5" aria-hidden="true" />
                  {badgeLabel !== null ? (
                    <span
                      aria-hidden="true"
                      className="absolute top-0 right-2.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] leading-none font-semibold text-primary-foreground"
                    >
                      {badgeLabel}
                    </span>
                  ) : null}
                  {dot ? (
                    <span aria-hidden="true" className="absolute top-0.5 right-4 size-2 rounded-full bg-primary" />
                  ) : null}
                </span>
                <span aria-hidden="true">{tab.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
