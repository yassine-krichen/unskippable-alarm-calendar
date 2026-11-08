/**
 * Every failure the tool reports is a CliError with a stable code, so an agent can branch on `error.code` and
 * the exit code instead of parsing a message.
 */
export type ErrorCode =
  | 'usage'
  | 'internal'
  | 'not_logged_in'
  | 'config_missing'
  | 'not_found'
  | 'ambiguous'
  | 'invalid_input'
  | 'invalid_plan'
  | 'conflict'
  | 'permission_denied'
  | 'migration_missing'
  | 'network'
  | 'server';

export const EXIT_CODES: Record<ErrorCode, number> = {
  internal: 1,
  usage: 2,
  not_logged_in: 3,
  config_missing: 3,
  not_found: 4,
  ambiguous: 4,
  invalid_input: 5,
  invalid_plan: 5,
  conflict: 6,
  permission_denied: 7,
  migration_missing: 7,
  network: 7,
  server: 7,
};

/** For `help --json`: what each exit code means. */
export const EXIT_CODE_MEANINGS: Record<number, string> = {
  0: 'ok',
  1: 'unexpected internal error',
  2: 'usage error (unknown command or option, missing argument)',
  3: 'not signed in, or the Supabase URL/key is not configured',
  4: 'not found, or a reference matched more than one thing',
  5: 'invalid input or invalid plan (nothing was written)',
  6: 'conflict (for example an agent key already in use)',
  7: 'server, network, permission or missing-migration error',
};

export class CliError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly hint?: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = 'CliError';
  }

  get exitCode(): number {
    return EXIT_CODES[this.code];
  }
}

export interface ErrorJson {
  ok: false;
  error: { code: ErrorCode; message: string; hint?: string; details?: unknown };
}

export function errorToJson(error: CliError): ErrorJson {
  return {
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      ...(error.hint === undefined ? {} : { hint: error.hint }),
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  };
}
