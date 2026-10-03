import { describe, expect, it } from 'vitest';

import { parseEnv } from './env';

const valid = {
  VITE_SUPABASE_URL: 'https://example.supabase.co',
  VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example',
};

describe('parseEnv', () => {
  it('returns the two variables when both are set', () => {
    expect(parseEnv(valid)).toEqual(valid);
  });

  it('fails loudly, naming the missing variable', () => {
    expect(() => parseEnv({ VITE_SUPABASE_URL: valid.VITE_SUPABASE_URL })).toThrow(
      /VITE_SUPABASE_PUBLISHABLE_KEY: is missing/
    );
    expect(() => parseEnv({})).toThrow(/VITE_SUPABASE_URL: is missing.*VITE_SUPABASE_PUBLISHABLE_KEY: is missing/);
  });

  it('treats an empty value like a missing one', () => {
    expect(() => parseEnv({ ...valid, VITE_SUPABASE_PUBLISHABLE_KEY: '' })).toThrow(/is missing/);
  });

  it('rejects a URL that is not a URL, without echoing the value', () => {
    const attempt = () => parseEnv({ ...valid, VITE_SUPABASE_URL: 'not-a-url-secret-ish' });
    expect(attempt).toThrow(/VITE_SUPABASE_URL/);
    expect(attempt).not.toThrow(/secret-ish/);
  });
});
