// Replaced by esbuild (electron/build.mjs) with the Supabase origin the app was built for;
// undefined when running from source (tests).
declare const __SUPABASE_ORIGIN__: string | undefined;

/**
 * Origin of the Supabase project, e.g. https://<ref>.supabase.co. It comes from the
 * app's own env at build time and is the only server the session token may be sent to
 * and the only one the CSP allows. Null means "not built with one": the app then has no
 * way to sign in, which the build refuses to produce.
 */
export const SUPABASE_ORIGIN: string | null =
  typeof __SUPABASE_ORIGIN__ === 'string' && __SUPABASE_ORIGIN__ !== '' ? __SUPABASE_ORIGIN__ : null;
