import { useEffect } from 'react';

import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';

import { PermissionList } from './permission-list';
import { checkPermissions, usePermissionsStore } from './permissions-store';

/** Settings, Android only: every permission with its state and a button to its system screen. */
export function PermissionsPanel() {
  const summary = usePermissionsStore((state) => state.summary);

  // The app-wide check keeps the store current on resume; this one makes the panel fresh on opening.
  useEffect(() => {
    void checkPermissions('refresh');
  }, []);

  return (
    <Field>
      <FieldLabel>Alarm permissions</FieldLabel>
      <FieldDescription>
        What this phone must allow for alarms to ring on time. &ldquo;Check manually&rdquo; means the phone does not
        tell apps, so look at that screen yourself.
      </FieldDescription>
      {summary === null ? (
        <p className="text-sm text-muted-foreground">Checking…</p>
      ) : (
        <PermissionList rows={summary.rows} buttonOnGranted />
      )}
    </Field>
  );
}
