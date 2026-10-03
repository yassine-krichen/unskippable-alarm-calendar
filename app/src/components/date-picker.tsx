import { CalendarIcon, XIcon } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { dateFromString, formatDay, stringFromDate } from '@/lib/zoned-time';

interface DatePickerProps {
  id: string;
  /** 'yyyy-MM-dd', or '' for no date. */
  value: string;
  onChange: (value: string) => void;
  /** Index of the first weekday in the grid, Sunday = 0 (react-day-picker's convention). */
  weekStartsOn?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  placeholder?: string;
  /** Shows a clear button, for optional dates such as "Ends". */
  clearable?: boolean;
  invalid?: boolean;
  describedBy?: string;
}

/** The shadcn date-picker pattern: Popover + Calendar, never a native date input. */
export function DatePicker({
  id,
  value,
  onChange,
  weekStartsOn,
  placeholder = 'Pick a date',
  clearable,
  invalid,
  describedBy,
}: DatePickerProps) {
  const [open, setOpen] = useState(false);
  const selected = value === '' ? undefined : dateFromString(value);

  return (
    <div className="flex items-center gap-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              id={id}
              type="button"
              variant="outline"
              aria-invalid={invalid}
              aria-describedby={describedBy}
              className="min-w-0 flex-1 justify-start font-normal data-[empty=true]:text-muted-foreground"
              data-empty={value === ''}
            />
          }
        >
          <CalendarIcon data-icon="inline-start" />
          <span className="truncate">{value === '' ? placeholder : formatDay(value, { year: true })}</span>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            selected={selected}
            defaultMonth={selected}
            weekStartsOn={weekStartsOn}
            onSelect={(date) => {
              if (!date) return;
              onChange(stringFromDate(date));
              setOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>
      {clearable && value !== '' ? (
        <Button type="button" variant="ghost" size="icon" aria-label="Clear date" onClick={() => onChange('')}>
          <XIcon />
        </Button>
      ) : null}
    </div>
  );
}
