/** API modules return this instead of throwing, so components never catch domain exceptions. */
export type Result<T> = { data: T; error: null } | { data: null; error: string };

export function ok<T>(data: T): Result<T> {
  return { data, error: null };
}

export function fail<T = never>(error: string): Result<T> {
  return { data: null, error };
}
