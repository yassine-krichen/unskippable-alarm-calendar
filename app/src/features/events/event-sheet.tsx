import type { Settings } from '@alarm-calendar/core';

import { ResponsiveSheet } from '@/components/responsive-sheet';

import { EventFormView, type EventFormTarget } from './event-form-view';

interface EventSheetProps {
  /** Null keeps the sheet closed. */
  target: EventFormTarget | null;
  settings: Settings;
  onClose: () => void;
}

/** The event form: a side sheet on desktop, a bottom drawer on phones. */
export function EventSheet({ target, settings, onClose }: EventSheetProps) {
  const editing = target?.event ?? null;
  return (
    <ResponsiveSheet
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={editing ? 'Edit alarm' : 'New alarm'}
      description={
        editing
          ? 'Change when and how this alarm rings.'
          : 'It will ring full screen and can only be stopped with Done or Snooze.'
      }
    >
      {target ? (
        // Remount per target so the form never carries values over from another event.
        <EventFormView
          key={editing?.id ?? `new-${target.slot.date}-${target.slot.time}`}
          target={target}
          settings={settings}
          onDone={onClose}
        />
      ) : null}
    </ResponsiveSheet>
  );
}
