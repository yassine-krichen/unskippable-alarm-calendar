import { MinusIcon, PlusIcon } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface NumberStepperProps {
  id: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  /** How much the plus and minus buttons change the value; 1 unless given. */
  step?: number;
  /** Shown after the input, e.g. 'min'. */
  unit?: string;
  label: string;
  invalid?: boolean;
  describedBy?: string;
}

// shadcn has no number stepper, so this composes Button + Input with the same tokens.
export function NumberStepper({
  id,
  value,
  onChange,
  min,
  max,
  step: stepSize = 1,
  unit,
  label,
  invalid,
  describedBy,
}: NumberStepperProps) {
  const [text, setText] = useState(String(value));

  // Follow outside changes (form reset, switching which event is edited).
  useEffect(() => {
    setText(String(value));
  }, [value]);

  function commitText(raw: string): void {
    setText(raw);
    const parsed = Number(raw);
    if (raw.trim() !== '' && Number.isInteger(parsed)) onChange(parsed);
  }

  function step(delta: number): void {
    const next = Math.min(max, Math.max(min, (Number.isFinite(value) ? value : min) + delta));
    setText(String(next));
    onChange(next);
  }

  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="icon"
        aria-label={`Decrease ${label}`}
        disabled={value <= min}
        onClick={() => step(-stepSize)}
      >
        <MinusIcon />
      </Button>
      <Input
        id={id}
        value={text}
        inputMode="numeric"
        autoComplete="off"
        aria-invalid={invalid}
        aria-describedby={describedBy}
        className="w-16 text-center tabular-nums"
        onChange={(event) => commitText(event.target.value)}
        onBlur={() => setText(String(value))}
      />
      <Button
        type="button"
        variant="outline"
        size="icon"
        aria-label={`Increase ${label}`}
        disabled={value >= max}
        onClick={() => step(stepSize)}
      >
        <PlusIcon />
      </Button>
      {unit ? <span className="text-sm text-muted-foreground">{unit}</span> : null}
    </div>
  );
}
