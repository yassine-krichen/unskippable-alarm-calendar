import { CalendarIcon, XIcon } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useNativePickers } from '@/features/native-pickers/use-native-pickers';
import { useSettingsStore } from '@/features/settings/settings-store';
import { dateFromString, formatDay, stringFromDate, zonedDate } from '@/lib/zoned-time';

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

/** Today in the settings zone (the zone every date in the app is read in); the device's own day until settings load. */
function todayIn(timezone: string | undefined): string {
  return timezone === undefined ? stringFromDate(new Date()) : zonedDate(new Date(), timezone);
}

const FIELD_CLASS = 'min-w-0 flex-1 justify-start font-normal data-[empty=true]:text-muted-foreground';

/**
 * The shadcn date-picker pattern: Popover + Calendar, never a native HTML date input. In the Android app the field is
 * a button that opens the phone's own date dialog instead (NativePickers plugin).
 */
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
  const pickers = useNativePickers();
  const timezone = useSettingsStore((state) => state.settings?.timezone);
  const selected = value === '' ? undefined : dateFromString(value);
  const label = (
    <>
      <CalendarIcon data-icon="inline-start" />
      <span className="truncate">{value === '' ? placeholder : formatDay(value, { year: true })}</span>
    </>
  );

  return (
    <div className="flex items-center gap-1">
      {pickers.available ? (
        <Button
          id={id}
          type="button"
          variant="outline"
          aria-invalid={invalid}
          aria-describedby={describedBy}
          className={FIELD_CLASS}
          data-empty={value === ''}
          onClick={() => {
            void pickers.pickDate({ value, today: todayIn(timezone) }).then((picked) => {
              if (picked !== null) onChange(picked);
            });
          }}
        >
          {label}
        </Button>
      ) : (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            render={
              <Button
                id={id}
                type="button"
                variant="outline"
                aria-invalid={invalid}
                aria-describedby={describedBy}
                className={FIELD_CLASS}
                data-empty={value === ''}
              />
            }
          >
            {label}
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
      )}
      {clearable && value !== '' ? (
        <Button type="button" variant="ghost" size="icon" aria-label="Clear date" onClick={() => onChange('')}>
          <XIcon />
        </Button>
      ) : null}
    </div>
  );
}
