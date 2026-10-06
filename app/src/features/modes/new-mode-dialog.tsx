import type { ModeRow } from '@alarm-calendar/core';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

import { MODE_NAME_MAX, validateModeName } from './mode-name';
import { modeErrorMessage } from './mode-switch';
import { addMode } from './modes-store';

const CHOICE_PRESSED = 'aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-pressed:hover:bg-primary/80';

interface NewModeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the new mode so its editor can open straight away. */
  onCreated: (mode: ModeRow) => void;
}

/** A custom mode starts as a name and one choice; its rules and dates are set in the editor that opens next. */
export function NewModeDialog({ open, onOpenChange, onCreated }: NewModeDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New mode</DialogTitle>
          <DialogDescription>
            For anything the built-in modes do not cover, like a hackathon week or a night shift.
          </DialogDescription>
        </DialogHeader>
        <NewModeForm onDone={() => onOpenChange(false)} onCreated={onCreated} />
      </DialogContent>
    </Dialog>
  );
}

function NewModeForm({ onDone, onCreated }: { onDone: () => void; onCreated: (mode: ModeRow) => void }) {
  const [name, setName] = useState('');
  const [defaultBehavior, setDefaultBehavior] = useState<'keep' | 'skip'>('keep');
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const problem = validateModeName(name);

  async function onSubmit(): Promise<void> {
    setTouched(true);
    if (problem !== null) return;
    setSaving(true);
    const result = await addMode(name.trim(), defaultBehavior);
    setSaving(false);
    if (result.error !== null) {
      toast.error(modeErrorMessage(result.error));
      return;
    }
    toast.success(`Created "${result.data.name}"`);
    onDone();
    onCreated(result.data);
  }

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit();
      }}
    >
      <Field data-invalid={touched && problem !== null}>
        <FieldLabel htmlFor="new-mode-name">Name</FieldLabel>
        <Input
          id="new-mode-name"
          value={name}
          maxLength={MODE_NAME_MAX}
          autoComplete="off"
          aria-invalid={touched && problem !== null}
          onChange={(event) => setName(event.target.value)}
        />
        {touched && problem !== null ? <FieldError>{problem}</FieldError> : null}
      </Field>
      <Field>
        <FieldLabel id="new-mode-default-label">Alarms with no rule</FieldLabel>
        <ToggleGroup
          variant="outline"
          spacing={1}
          aria-labelledby="new-mode-default-label"
          value={[defaultBehavior]}
          onValueChange={(next) => {
            const picked = next[0];
            if (picked === 'keep' || picked === 'skip') setDefaultBehavior(picked);
          }}
        >
          <ToggleGroupItem value="keep" className={CHOICE_PRESSED}>
            Keep ringing
          </ToggleGroupItem>
          <ToggleGroupItem value="skip" className={CHOICE_PRESSED}>
            Pause
          </ToggleGroupItem>
        </ToggleGroup>
        <FieldDescription>
          You can set a different behavior for each alarm afterwards. Alarms that always ring are never paused.
        </FieldDescription>
      </Field>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          Create mode
        </Button>
      </DialogFooter>
    </form>
  );
}
