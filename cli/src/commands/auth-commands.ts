import { booleanOption, stringOption } from '../args';
import { assertCode, assertEmail } from '../auth/auth-service';
import { looksLikeSecretKey, readStoredConfig, resolveCredentials, writeStoredConfig } from '../config/credentials';
import { CliError } from '../errors';
import { renderFields } from '../output/render';

import { defineCommand } from './command';

export const login = defineCommand({
  path: ['login'],
  summary: 'Sign in with an emailed one-time code. Two steps for agents: send the code, then verify it.',
  options: [
    { name: 'email', type: 'string', description: 'The account email. Remembered from the last sign-in.' },
    { name: 'code', type: 'string', value: 'digits', description: 'The 6 to 10 digit code from the email. Without it a code is sent.' },
    { name: 'no-prompt', type: 'boolean', description: 'Never ask for the code on the terminal; just send it and exit.' },
  ],
  writes: false,
  needsLogin: false,
  examples: ['alarm-cal login --email me@example.com', 'alarm-cal login --email me@example.com --code 12345678'],
  async run({ rt, args }) {
    const auth = rt.auth();
    const stored = readStoredConfig(rt.paths);
    let email = stringOption(args, 'email') ?? stored.lastEmail;
    let code = stringOption(args, 'code');
    if (email === undefined) {
      if (!rt.interactive) throw new CliError('usage', 'Give the account email with --email.');
      email = await rt.prompt('Email: ');
    }
    assertEmail(email);

    let codeWasSent = false;
    if (code === undefined) {
      await auth.requestCode(email);
      codeWasSent = true;
      if (!rt.interactive || booleanOption(args, 'no-prompt') === true) {
        writeStoredConfig(rt.paths, rt.env, rt.platform, { lastEmail: email });
        return {
          data: { status: 'code_sent', email, next: `alarm-cal login --email ${email} --code <digits>` },
          text: `A sign-in code was sent to ${email}.\nThen run: alarm-cal login --email ${email} --code <digits>`,
        };
      }
      code = await rt.prompt('Code from the email: ');
    }
    assertCode(code);
    const session = await auth.verifyCode(email, code);
    writeStoredConfig(rt.paths, rt.env, rt.platform, { lastEmail: email });
    return {
      data: { status: 'signed_in', email: session.email, user_id: session.userId, code_was_sent: codeWasSent },
      text: `Signed in as ${session.email ?? email}.`,
    };
  },
});

export const logout = defineCommand({
  path: ['logout'],
  summary: 'Sign out and delete the saved session.',
  writes: false,
  needsLogin: false,
  async run({ rt }) {
    const wasSignedIn = await rt.auth().signOut();
    return {
      data: { status: wasSignedIn ? 'signed_out' : 'not_signed_in' },
      text: wasSignedIn ? 'Signed out. The saved session was deleted.' : 'Not signed in.',
    };
  },
});

export const whoami = defineCommand({
  path: ['whoami'],
  summary: 'Show the signed-in account and its timezone. Exits 3 when not signed in.',
  writes: false,
  needsLogin: false,
  async run({ rt }) {
    const auth = rt.auth();
    const info = await auth.sessionInfo();
    if (info === null) {
      throw new CliError('not_logged_in', 'Not signed in.', 'Run `alarm-cal login --email <address>`, then `alarm-cal login --email <address> --code <digits>`.');
    }
    let timezone: string | null = null;
    try {
      timezone = (await (await auth.openStore()).getSettings()).timezone;
    } catch {
      // Offline or settings missing: the account is still known, the timezone is not.
    }
    return {
      data: { email: info.email, user_id: info.userId, session_expires_at: info.expiresAt, timezone },
      text: renderFields([
        ['email', info.email ?? '(none)'],
        ['user id', info.userId],
        ['timezone', timezone ?? '(unknown: could not read settings)'],
        ['session', info.expiresAt === null ? '(unknown expiry)' : `refreshes itself; current token valid until ${info.expiresAt}`],
      ]),
    };
  },
});

export const configShow = defineCommand({
  path: ['config', 'show'],
  summary: 'Show where the Supabase URL and key come from (values are never printed).',
  writes: false,
  needsLogin: false,
  async run({ rt }) {
    let urlSource: string | null = null;
    let keySource: string | null = null;
    let problem: string | null = null;
    try {
      const credentials = resolveCredentials({ env: rt.env, paths: rt.paths, scriptDir: rt.scriptDir });
      urlSource = credentials.urlSource;
      keySource = credentials.keySource;
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error);
    }
    return {
      data: { configured: problem === null, url_source: urlSource, key_source: keySource, config_dir: rt.paths.dir, problem },
      text: renderFields([
        ['url', urlSource === null ? 'missing' : `set (from ${urlSource})`],
        ['publishable key', keySource === null ? 'missing' : `set (from ${keySource})`],
        ['config dir', rt.paths.dir],
        ...(problem === null ? [] : ([['problem', problem]] as Array<[string, string]>)),
      ]),
    };
  },
});

export const configSet = defineCommand({
  path: ['config', 'set'],
  summary: 'Store the Supabase URL or the publishable key in the config file.',
  positionals: [
    { name: 'name', description: '"url" or "key".', required: true },
    { name: 'value', description: 'The value. The key is the publishable (anon) key, never a secret key.', required: true },
  ],
  writes: false,
  needsLogin: false,
  async run({ rt, args }) {
    const [name, value] = args.positionals;
    if ((name !== 'url' && name !== 'key') || value === undefined || value === '') {
      throw new CliError('usage', 'Usage: alarm-cal config set <url|key> <value>.');
    }
    if (name === 'url') {
      try {
        const parsed = new URL(value);
        if (parsed.protocol !== 'https:') throw new Error('not https');
      } catch {
        throw new CliError('invalid_input', 'The URL must be a full https URL, like https://<project>.supabase.co.');
      }
      writeStoredConfig(rt.paths, rt.env, rt.platform, { supabaseUrl: value });
    } else {
      if (looksLikeSecretKey(value)) {
        throw new CliError('invalid_input', 'That looks like a secret or service-role key. This tool only uses the publishable key.');
      }
      writeStoredConfig(rt.paths, rt.env, rt.platform, { supabaseKey: value });
    }
    return { data: { saved: name }, text: `Saved the ${name === 'url' ? 'URL' : 'publishable key'} to ${rt.paths.config}.` };
  },
});

export const configUnset = defineCommand({
  path: ['config', 'unset'],
  summary: 'Remove the stored URL or key from the config file.',
  positionals: [{ name: 'name', description: '"url" or "key".', required: true }],
  writes: false,
  needsLogin: false,
  async run({ rt, args }) {
    const name = args.positionals[0];
    if (name !== 'url' && name !== 'key') throw new CliError('usage', 'Usage: alarm-cal config unset <url|key>.');
    writeStoredConfig(rt.paths, rt.env, rt.platform, name === 'url' ? { supabaseUrl: undefined } : { supabaseKey: undefined });
    return { data: { removed: name }, text: `Removed the stored ${name}.` };
  },
});
