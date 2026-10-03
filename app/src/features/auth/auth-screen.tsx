import { zodResolver } from '@hookform/resolvers/zod';
import { AlarmClockIcon, ArrowLeftIcon } from 'lucide-react';
import { REGEXP_ONLY_DIGITS } from 'input-otp';
import { useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
import { Spinner } from '@/components/ui/spinner';

import { authErrorMessage } from './auth-errors';
import { requestSignInCode, verifySignInCode } from './auth-api';

// Must match Authentication > Sign In / Providers > Email > "Email OTP Length" in Supabase (project default is 8).
const CODE_LENGTH = 8;
const RESEND_SECONDS = 30;

const emailSchema = z.object({
  email: z.email('Enter an email address like you@example.com.'),
});

type EmailValues = z.infer<typeof emailSchema>;

/** Sign in with an emailed one-time code: no password, no redirect link. */
export function AuthScreen() {
  const [email, setEmail] = useState<string | null>(null);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-8 px-6 py-12">
      <div className="flex items-center gap-2">
        <AlarmClockIcon className="size-5" aria-hidden="true" />
        <span className="text-sm font-semibold tracking-tight">Alarm Calendar</span>
      </div>
      {email === null ? (
        <EmailStep onSent={setEmail} />
      ) : (
        <CodeStep email={email} onChangeEmail={() => setEmail(null)} />
      )}
    </main>
  );
}

function EmailStep({ onSent }: { onSent: (email: string) => void }) {
  const [serverError, setServerError] = useState<string | null>(null);
  const form = useForm<EmailValues>({
    resolver: zodResolver(emailSchema),
    defaultValues: { email: '' },
    mode: 'onSubmit',
  });

  async function onSubmit(values: EmailValues): Promise<void> {
    setServerError(null);
    const email = values.email.trim();
    const result = await requestSignInCode(email);
    if (result.error !== null) {
      setServerError(authErrorMessage(result.error));
      return;
    }
    onSent(email);
  }

  return (
    <form noValidate onSubmit={(event) => void form.handleSubmit(onSubmit)(event)} className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="text-sm text-muted-foreground">
          We email you a sign-in code. There is no password to remember.
        </p>
      </div>
      <FieldGroup>
        <Controller
          name="email"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="auth-email">Email</FieldLabel>
              <Input
                {...field}
                id="auth-email"
                type="email"
                inputMode="email"
                autoComplete="email"
                autoFocus
                placeholder="you@example.com"
                aria-invalid={fieldState.invalid}
              />
              {fieldState.invalid ? <FieldError errors={[fieldState.error]} /> : null}
            </Field>
          )}
        />
        {serverError ? <FieldError>{serverError}</FieldError> : null}
        <Button type="submit" size="lg" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting ? <Spinner data-icon="inline-start" /> : null}
          Send code
        </Button>
      </FieldGroup>
    </form>
  );
}

export function CodeStep({ email, onChangeEmail }: { email: string; onChangeEmail: () => void }) {
  const [code, setCode] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(RESEND_SECONDS);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (secondsLeft <= 0) return;
    const timer = window.setTimeout(() => setSecondsLeft((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [secondsLeft]);

  async function verify(value: string): Promise<void> {
    if (verifying) return;
    if (value.length !== CODE_LENGTH) {
      setError(`Enter all ${CODE_LENGTH} digits of the code.`);
      return;
    }
    setVerifying(true);
    setError(null);
    const result = await verifySignInCode(email, value);
    setVerifying(false);
    if (result.error !== null) {
      // Clearing the boxes is explained by the message, so the person knows to retype.
      setError(authErrorMessage(result.error));
      setCode('');
    }
    // On success the auth listener swaps this screen out; nothing else to do here.
  }

  async function resend(): Promise<void> {
    setError(null);
    setNotice(null);
    const result = await requestSignInCode(email);
    if (result.error !== null) {
      setError(authErrorMessage(result.error));
      return;
    }
    setNotice('A new code is on its way.');
    setSecondsLeft(RESEND_SECONDS);
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void verify(code);
      }}
      className="flex flex-col gap-6"
    >
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Check your email</h1>
        <p className="text-sm text-muted-foreground">
          Enter the code we sent to <span className="font-medium text-foreground">{email}</span>.
        </p>
      </div>

      <Field data-invalid={error !== null}>
        <FieldLabel htmlFor="auth-code">Code</FieldLabel>
        <InputOTP
          id="auth-code"
          maxLength={CODE_LENGTH}
          containerClassName="w-full"
          pattern={REGEXP_ONLY_DIGITS}
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          value={code}
          disabled={verifying}
          onChange={setCode}
          onComplete={(value) => void verify(value)}
          aria-invalid={error !== null}
        >
          <InputOTPGroup className="w-full">
            {Array.from({ length: CODE_LENGTH }, (_, index) => (
              <InputOTPSlot key={index} index={index} className="h-12 flex-1 text-lg" />
            ))}
          </InputOTPGroup>
        </InputOTP>
        {error ? <FieldError>{error}</FieldError> : null}
        {notice && !error ? <FieldDescription aria-live="polite">{notice}</FieldDescription> : null}
      </Field>

      <div className="flex flex-col gap-3">
        <Button type="submit" size="lg" disabled={verifying}>
          {verifying ? <Spinner data-icon="inline-start" /> : null}
          Sign in
        </Button>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onChangeEmail}>
            <ArrowLeftIcon data-icon="inline-start" />
            Use a different email
          </Button>
          <Button type="button" variant="ghost" size="sm" disabled={secondsLeft > 0} onClick={() => void resend()}>
            {secondsLeft > 0 ? `Resend code in ${secondsLeft}s` : 'Resend code'}
          </Button>
        </div>
      </div>
    </form>
  );
}
