import { HIJRI_OFFSET_LIMITS, hijriCalendarAvailable, ramadanOnOrAfter } from '@alarm-calendar/core';
import { useMemo, useState } from 'react';
import { Controller, useWatch, type UseFormReturn } from 'react-hook-form';

import { NumberStepper } from '@/components/number-stepper';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@/components/ui/combobox';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field';
import { Switch } from '@/components/ui/switch';
import { listHolidayCountries, type HolidayCountry } from '@/features/holidays/country-holidays';
import { formatDay, zonedDate } from '@/lib/zoned-time';

import { regionName } from './holiday-settings';
import type { SettingsFormValues } from './settings-options';

interface CountryItem {
  /** ISO 3166-1 alpha-2, or '' for "None". */
  value: string;
  label: string;
}

const NONE: CountryItem = { value: '', label: 'None' };

interface HolidaySettingsSectionProps {
  form: UseFormReturn<SettingsFormValues>;
  timezone: string;
}

type CountryList =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; countries: HolidayCountry[] };

/**
 * Settings, "Holidays": which country's public holidays and whether the Islamic ones show on the calendar. They are
 * display only and never ring. Everything here is part of the page's form and saves with its button. The country
 * list (the holiday library, large) loads the first time the picker opens.
 */
export function HolidaySettingsSection({ form, timezone }: HolidaySettingsSectionProps) {
  const [list, setList] = useState<CountryList>({ status: 'idle' });
  const values = useWatch({ control: form.control });
  const country = values.holidayCountry ?? '';
  const islamic = values.islamicHolidays === true;
  const offset = values.hijriOffset ?? 0;
  const islamicSupported = hijriCalendarAvailable();

  function loadCountries(): void {
    if (list.status === 'loading' || list.status === 'ready') return;
    setList({ status: 'loading' });
    listHolidayCountries().then(
      (countries) => setList({ status: 'ready', countries }),
      () => setList({ status: 'error' })
    );
  }

  // Until the list has loaded the picker holds None and the chosen country, named without the library.
  const items = useMemo<CountryItem[]>(() => {
    if (list.status === 'ready') {
      return [NONE, ...list.countries.map((entry) => ({ value: entry.code, label: entry.name }))];
    }
    return country === '' ? [NONE] : [NONE, { value: country, label: regionName(country) }];
  }, [list, country]);
  const selected = items.find((item) => item.value === country) ?? NONE;

  // The adjustment only matters when something Hijri-dated shows, and the next Ramadan lets it be checked against the
  // announced date before saving.
  const showsHijriDates = country !== '' || islamic;
  const nextRamadan = useMemo(
    () => (showsHijriDates ? ramadanOnOrAfter(zonedDate(new Date(), timezone), offset) : null),
    [showsHijriDates, timezone, offset]
  );

  return (
    <FieldSet>
      <FieldLegend>Holidays</FieldLegend>
      <FieldDescription>Shown on the calendar only. They never ring and never change an alarm.</FieldDescription>
      <FieldGroup>
        <Controller
          name="holidayCountry"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="settings-holiday-country">Public holidays of</FieldLabel>
              <Combobox
                items={items}
                value={selected}
                isItemEqualToValue={(item: CountryItem, current: CountryItem) => item.value === current.value}
                onValueChange={(next: CountryItem | null) => {
                  if (next !== null) field.onChange(next.value);
                }}
                onOpenChange={(open) => {
                  if (open) loadCountries();
                }}
              >
                <ComboboxInput
                  id="settings-holiday-country"
                  placeholder="Search countries"
                  aria-invalid={fieldState.invalid}
                  className="w-full"
                />
                <ComboboxContent>
                  {list.status === 'loading' ? (
                    <p className="px-2 py-1.5 text-sm text-muted-foreground" role="status">
                      Loading countries...
                    </p>
                  ) : null}
                  {list.status === 'error' ? (
                    <p className="px-2 py-1.5 text-sm text-destructive" role="status">
                      Couldn&apos;t load the country list. Close and reopen this list to try again.
                    </p>
                  ) : null}
                  <ComboboxEmpty>No country matches that.</ComboboxEmpty>
                  <ComboboxList>
                    {(item: CountryItem) => (
                      <ComboboxItem key={item.value === '' ? 'none' : item.value} value={item}>
                        {item.label}
                      </ComboboxItem>
                    )}
                  </ComboboxList>
                </ComboboxContent>
              </Combobox>
              <FieldDescription>
                Nationwide public holidays only, no regional ones. Worked out on this device, no internet needed.
                <br />
                <span className="text-xs">Public holiday data: date-holidays by commenthol, CC BY 3.0, https://github.com/commenthol/date-holidays</span>
              </FieldDescription>
              {fieldState.invalid ? <FieldError errors={[fieldState.error]} /> : null}
            </Field>
          )}
        />

        <Controller
          name="islamicHolidays"
          control={form.control}
          render={({ field }) => (
            <Field orientation="horizontal">
              <div className="flex flex-1 flex-col gap-1">
                <FieldLabel htmlFor="settings-islamic-holidays">Islamic holidays</FieldLabel>
                <FieldDescription>
                  {islamicSupported
                    ? "Islamic New Year, Ashura, Mawlid, Isra and Mi'raj, Ramadan, Laylat al-Qadr, both Eids and the Day of Arafah."
                    : "This device can't work out Hijri dates, so Islamic holidays are not available here."}
                </FieldDescription>
              </div>
              <Switch
                id="settings-islamic-holidays"
                checked={field.value && islamicSupported}
                disabled={!islamicSupported}
                onCheckedChange={(next) => field.onChange(next)}
              />
            </Field>
          )}
        />

        {showsHijriDates ? (
          <Controller
            name="hijriOffset"
            control={form.control}
            render={({ field }) => (
              <Field>
                <FieldLabel htmlFor="settings-hijri-offset">Hijri date adjustment</FieldLabel>
                <NumberStepper
                  id="settings-hijri-offset"
                  label="Hijri date adjustment"
                  value={field.value}
                  min={HIJRI_OFFSET_LIMITS.min}
                  max={HIJRI_OFFSET_LIMITS.max}
                  unit="days"
                  describedBy="settings-hijri-offset-help"
                  onChange={field.onChange}
                />
                <FieldDescription id="settings-hijri-offset-help">
                  Tunisia and many other countries follow local moon sighting, so a holiday can fall a day away from the
                  printed date. Adjust if the calendar is a day off: +1 moves every Hijri date one day later, -1 one day earlier.
                </FieldDescription>
                {nextRamadan !== null ? (
                  <p className="text-sm tabular-nums" aria-live="polite">
                    Next Ramadan starts{' '}
                    <span className="font-medium">{formatDay(nextRamadan.start, { year: true })}</span> (
                    {nextRamadan.hijriYear} AH).
                  </p>
                ) : null}
              </Field>
            )}
          />
        ) : null}
      </FieldGroup>
    </FieldSet>
  );
}
