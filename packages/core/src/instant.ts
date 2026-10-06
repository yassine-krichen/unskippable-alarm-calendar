/**
 * Epoch milliseconds of a timestamp string, or NaN. Completions come back from Postgres as
 * '+00:00' with optional microseconds, from the desktop flusher as 'Z', and events may differ
 * again, so occurrences are matched by instant, never by string.
 */
export function instantMs(timestamp: string): number {
  // Postgres text output can use a space and a short offset ('+00'); both are valid ISO once fixed.
  const iso = timestamp
    .replace(' ', 'T')
    .replace(/(\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)([+-]\d{2})$/, '$1$2:00');
  return Date.parse(iso);
}
