import { useEffect, useState } from 'react';

const NOW_TICK_MS = 60_000;

/** The current time, refreshed every minute, so something crossing a deadline (a grace window, an exam) shows up. */
export function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), NOW_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}
