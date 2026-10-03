import { describe, expect, it } from 'vitest';

import { authErrorMessage } from './auth-errors';

describe('authErrorMessage', () => {
  it('explains the email rate limit', () => {
    expect(authErrorMessage('email rate limit exceeded')).toMatch(/too many codes/i);
    expect(authErrorMessage('For security purposes, you can only request this after 56 seconds.')).toMatch(
      /too many codes/i
    );
  });

  it('tells the person a wrong or old code needs retyping or resending', () => {
    expect(authErrorMessage('Token has expired or is invalid')).toMatch(/send a new one/i);
  });

  it('flags a bad email address', () => {
    expect(authErrorMessage('Unable to validate email address: invalid format')).toMatch(/email address/i);
  });

  it('explains a network failure', () => {
    expect(authErrorMessage('Failed to fetch')).toMatch(/reach the server/i);
  });

  it('never shows an unknown raw error', () => {
    expect(authErrorMessage('PGRST301 jwt malformed')).toMatch(/something went wrong/i);
  });
});
