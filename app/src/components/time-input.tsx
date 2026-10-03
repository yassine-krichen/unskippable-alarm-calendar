import { ClockIcon } from 'lucide-react';
import { useEffect, useState } from 'react';

import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { parseTimeInput } from '@/features/events/time-input-parser';

interface TimeInputProps {
  id: string;
  /** 'HH:mm' 24-hour. */
  value: string;
  onChange: (value: string) => void;
  invalid?: boolean;
  describedBy?: string;
}

// shadcn has no time picker and native time inputs are banned, so this is a text input
// in an input group that understands '8', '830', '8:30 pm' and '20:15' and normalizes to HH:mm.
export function TimeInput({ id, value, onChange, invalid, describedBy }: TimeInputProps) {
  const [text, setText] = useState(value);

  // Follow outside changes (reset, switching events) without overwriting a half-typed value
  // that already parses to the current one.
  useEffect(() => {
    setText((current) => (parseTimeInput(current) === value ? current : value));
  }, [value]);

  function commit(): void {
    const parsed = parseTimeInput(text);
    if (parsed === null) {
      // Leave what was typed visible and let the form's validation message explain it.
      onChange(text);
      return;
    }
    setText(parsed);
    onChange(parsed);
  }

  return (
    <InputGroup>
      <InputGroupAddon>
        <ClockIcon />
      </InputGroupAddon>
      <InputGroupInput
        id={id}
        value={text}
        inputMode="numeric"
        autoComplete="off"
        placeholder="08:30"
        aria-invalid={invalid}
        aria-describedby={describedBy}
        className="tabular-nums"
        onChange={(event) => {
          setText(event.target.value);
          // Report valid times right away so the first-alarm hint stays live while typing.
          const parsed = parseTimeInput(event.target.value);
          if (parsed !== null) onChange(parsed);
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          // Enter submits the form; commit first so the typed time is what gets validated.
          if (event.key === 'Enter') commit();
        }}
      />
    </InputGroup>
  );
}
