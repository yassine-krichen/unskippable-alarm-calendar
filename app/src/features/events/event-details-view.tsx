import type { EventRow } from '@alarm-calendar/core';
import { BellOffIcon, EyeOffIcon, PauseIcon, PencilIcon, Trash2Icon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';

import { FormFooter, FormFooterActions } from '@/components/form-footer';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { Occurrence } from '@/features/calendar/calendar-events';
import { EventRank } from '@/features/habits/event-rank';
import { hapticWarning } from '@/lib/haptics';

import { describeRepeatRule, describeSnooze } from './event-details';
import { removeEvent } from './events-store';

interface EventDetailsViewProps {
  event: EventRow;
  /** The ring that was tapped, for its state today; null when the alarm was opened without one. */
  occurrence: Occurrence | null;
  /** An alarm that belongs to an exam or a birthday pair is deleted from its own form, with its partners. */
  canDelete: boolean;
  onEdit: () => void;
  onDone: () => void;
}

/**
 * What a tap on an alarm shows on the phone before any form: what it is, when it repeats, how it is doing and
 * whether it will ring today, with Edit one thumb-reach below. Editing swaps this for the form in the same sheet.
 */
export function EventDetailsView({ event, occurrence, canDelete, onEdit, onDone }: EventDetailsViewProps) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const repeating = event.repeat_unit !== 'none';

  async function onConfirmDelete(): Promise<void> {
    setDeleting(true);
    const result = await removeEvent(event.id);
    setDeleting(false);
    if (result.error !== null) {
      toast.error("Couldn't delete the alarm. Check your connection and try again.");
      return;
    }
    hapticWarning();
    toast.success(`Deleted "${event.title}"`);
    setConfirmingDelete(false);
    onDone();
  }

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
        <StateBadges occurrence={occurrence} />
        {repeating ? <EventRank eventId={event.id} /> : null}
        <dl className="flex flex-col gap-3 text-sm">
          <DetailRow label="Repeat">{describeRepeatRule(event)}</DetailRow>
          <DetailRow label="Snooze">{describeSnooze(event.max_snoozes, event.snooze_minutes)}</DetailRow>
          <DetailRow label="Cheat days">
            {event.passable ? 'A cheat day can silence it' : 'Always rings, even on a cheat day'}
          </DetailRow>
          {event.notes ? <DetailRow label="Notes">{event.notes}</DetailRow> : null}
        </dl>
      </div>

      <FormFooter>
        {canDelete ? (
          <Button type="button" variant="destructive" onClick={() => setConfirmingDelete(true)}>
            <Trash2Icon data-icon="inline-start" />
            Delete
          </Button>
        ) : null}
        <FormFooterActions>
          <Button type="button" onClick={onEdit}>
            <PencilIcon data-icon="inline-start" />
            Edit
          </Button>
        </FormFooterActions>
      </FormFooter>

      <AlertDialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this alarm?</AlertDialogTitle>
            <AlertDialogDescription>
              "{event.title}" stops ringing on every device. Alarms you already completed are kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={deleting} onClick={() => void onConfirmDelete()}>
              Delete alarm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="whitespace-pre-wrap">{children}</dd>
    </div>
  );
}

/** Whether this ring will actually sound: paused by a mode, silenced by a cheat day, moved, or hidden. */
function StateBadges({ occurrence }: { occurrence: Occurrence | null }) {
  if (occurrence === null) return null;
  const badges: ReactNode[] = [];
  if (occurrence.paused) {
    badges.push(
      <Badge key="paused" variant="secondary">
        <PauseIcon data-icon="inline-start" />
        Paused{occurrence.modeName ? ` by ${occurrence.modeName}` : ''}
      </Badge>
    );
  } else if (occurrence.silenced) {
    badges.push(
      <Badge key="silenced" variant="secondary">
        <BellOffIcon data-icon="inline-start" />
        Silenced by a cheat day
      </Badge>
    );
  } else if (occurrence.shifted && occurrence.modeName) {
    badges.push(
      <Badge key="shifted" variant="outline">
        Moved by {occurrence.modeName}
      </Badge>
    );
  }
  if (occurrence.hidden) {
    badges.push(
      <Badge key="hidden" variant="outline">
        <EyeOffIcon data-icon="inline-start" />
        Hidden from the calendar
      </Badge>
    );
  }
  if (badges.length === 0) return null;
  return <div className="flex flex-wrap gap-2">{badges}</div>;
}
