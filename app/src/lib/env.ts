import { z } from 'zod';

const envSchema = z.object({
  VITE_SUPABASE_URL: z.url({ message: 'must be a full URL' }),
  VITE_SUPABASE_PUBLISHABLE_KEY: z.string().trim().min(1, { message: 'must not be empty' }),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Validates the Vite env at startup. Only variable names appear in the error,
 * never their values, so a misconfigured key cannot leak into a screenshot or log.
 */
export function parseEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);
  if (parsed.success) return parsed.data;

  const problems = parsed.error.issues.map((issue) => {
    const name = String(issue.path[0] ?? 'env');
    const missing = raw[name] === undefined || raw[name] === '';
    return `${name}: ${missing ? 'is missing' : issue.message}`;
  });
  throw new Error(`Invalid app environment. ${problems.join('; ')}. See app/.env.example.`);
}
