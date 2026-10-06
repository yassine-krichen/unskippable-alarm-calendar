/** The database allows 1 to 60 characters after trimming. */
export const MODE_NAME_MAX = 60;

/** A message for a name the database would refuse, or null when it is fine. */
export function validateModeName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return 'Give the mode a name.';
  if (trimmed.length > MODE_NAME_MAX) return `Keep the name under ${MODE_NAME_MAX} characters.`;
  return null;
}
