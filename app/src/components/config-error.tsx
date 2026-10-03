import { TriangleAlertIcon } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

/** Shown when the app is built without its Supabase settings. Names variables, never values. */
export function ConfigError({ message }: { message: string }) {
  return (
    <main className="dark mx-auto flex min-h-dvh max-w-md flex-col justify-center bg-background px-6 text-foreground">
      <Alert variant="destructive">
        <TriangleAlertIcon />
        <AlertTitle>The app is not configured</AlertTitle>
        <AlertDescription>
          {message} Copy app/.env.example to app/.env, fill in both values, and restart the dev server.
        </AlertDescription>
      </Alert>
    </main>
  );
}
