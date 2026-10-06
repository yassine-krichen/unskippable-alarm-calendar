import { useEffect, useState } from 'react';

import { Input } from '@/components/ui/input';
import { parseDecimal } from '@/features/settings/prayer-settings';

interface DecimalInputProps {
  id: string;
  /** NaN while the typed text is not a number yet. */
  value: number;
  onChange: (value: number) => void;
  /** Shown as a hint while empty, an example value rather than a label. */
  placeholder?: string;
  invalid?: boolean;
  describedBy?: string;
  className?: string;
}

// shadcn has no number field for decimals (NumberStepper is whole numbers with buttons), so this is
// the shadcn Input with the same tokens. The typed text is kept as typed; the form gets a number, or
// NaN while the text is not one, so the field's own error explains what is wrong instead of the
// input silently snapping back.
export function DecimalInput({ id, value, onChange, placeholder, invalid, describedBy, className }: DecimalInputProps) {
  const [text, setText] = useState(Number.isNaN(value) ? '' : String(value));

  // Follow outside changes (form reset, "Use my location") but never overwrite what is being typed.
  useEffect(() => {
    setText((current) => {
      const typed = parseDecimal(current);
      if (Number.isNaN(value)) return current;
      return typed === value ? current : String(value);
    });
  }, [value]);

  return (
    <Input
      id={id}
      value={text}
      inputMode="decimal"
      autoComplete="off"
      placeholder={placeholder}
      aria-invalid={invalid}
      aria-describedby={describedBy}
      className={className ?? 'tabular-nums'}
      onChange={(event) => {
        const raw = event.target.value;
        setText(raw);
        onChange(parseDecimal(raw) ?? Number.NaN);
      }}
    />
  );
}
