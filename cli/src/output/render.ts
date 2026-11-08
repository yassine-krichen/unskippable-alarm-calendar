/** Plain padded columns; no colours, no box drawing, so it reads the same in a log as in a terminal. */
export function renderTable(headers: readonly string[], rows: ReadonlyArray<readonly string[]>): string {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? '').length))
  );
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join('  ')
      .trimEnd();
  return [line(headers), line(widths.map((width) => '-'.repeat(width))), ...rows.map(line)].join('\n');
}

/** Key: value lines, keys padded to the longest. */
export function renderFields(fields: ReadonlyArray<readonly [string, string]>): string {
  const width = Math.max(0, ...fields.map(([key]) => key.length));
  return fields.map(([key, value]) => `${key.padEnd(width)}  ${value}`).join('\n');
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export function stringify(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
