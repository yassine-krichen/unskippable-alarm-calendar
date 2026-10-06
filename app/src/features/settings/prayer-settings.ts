import {
  DEFAULT_PRAYER_SETTINGS,
  PRAYER_LABELS,
  PRAYER_LIMITS,
  PRAYER_NAMES,
  prayerTimesOnDay,
  resolvePrayerConfig,
  toWallClock,
  type PrayerName,
  type Settings,
} from '@alarm-calendar/core';
import { z } from 'zod';

import { formatTimeInZone } from '@/lib/zoned-time';

import type { PrayerSettingsPatch } from './settings-api';

const { latitude: latitudeLimit, angle, offsetMin, prePrayerMinutes, maxSnoozes, snoozeMinutes } = PRAYER_LIMITS;

const offsetField = z
  .number()
  .int('Use whole minutes.')
  .min(offsetMin.min, `At least ${offsetMin.min} minutes.`)
  .max(offsetMin.max, `At most ${offsetMin.max} minutes.`);

const angleField = z
  .number('Enter the angle in degrees.')
  .min(angle.min, `Between ${angle.min} and ${angle.max} degrees.`)
  .max(angle.max, `Between ${angle.min} and ${angle.max} degrees.`);

/** What the Prayer times part of the settings form edits; the bounds are the database's. */
export const prayerFormSchema = z.object({
  latitude: z
    .number('Enter the latitude in degrees.')
    .min(latitudeLimit.min, `Latitude is between ${latitudeLimit.min} and ${latitudeLimit.max}.`)
    .max(latitudeLimit.max, `Latitude is between ${latitudeLimit.min} and ${latitudeLimit.max}.`),
  longitude: z
    .number('Enter the longitude in degrees.')
    .min(-180, 'Longitude is between -180 and 180.')
    .max(180, 'Longitude is between -180 and 180.'),
  locationLabel: z.string().max(100, 'Keep the name under 100 characters.'),
  fajrAngle: angleField,
  ishaAngle: angleField,
  asrFactor: z.union([z.literal(1), z.literal(2)]),
  fajrOffset: offsetField,
  dhuhrOffset: offsetField,
  asrOffset: offsetField,
  maghribOffset: offsetField,
  ishaOffset: offsetField,
  prePrayerMinutes: z.number().int().min(prePrayerMinutes.min).max(prePrayerMinutes.max),
  prayerMaxSnoozes: z.number().int().min(maxSnoozes.min).max(maxSnoozes.max),
  prayerSnoozeMinutes: z.number().int().min(snoozeMinutes.min).max(snoozeMinutes.max),
});

export type PrayerFormValues = z.infer<typeof prayerFormSchema>;

/** The form's starting values: what settings hold, or the Ariana defaults for a row without the columns. */
export function prayerFormValues(settings: Settings): PrayerFormValues {
  const d = DEFAULT_PRAYER_SETTINGS;
  return {
    latitude: settings.latitude ?? d.latitude,
    longitude: settings.longitude ?? d.longitude,
    locationLabel: settings.location_label ?? d.location_label,
    fajrAngle: settings.fajr_angle ?? d.fajr_angle,
    ishaAngle: settings.isha_angle ?? d.isha_angle,
    asrFactor: settings.asr_factor ?? d.asr_factor,
    fajrOffset: settings.fajr_offset_min ?? d.fajr_offset_min,
    dhuhrOffset: settings.dhuhr_offset_min ?? d.dhuhr_offset_min,
    asrOffset: settings.asr_offset_min ?? d.asr_offset_min,
    maghribOffset: settings.maghrib_offset_min ?? d.maghrib_offset_min,
    ishaOffset: settings.isha_offset_min ?? d.isha_offset_min,
    prePrayerMinutes: settings.pre_prayer_minutes ?? d.pre_prayer_minutes,
    prayerMaxSnoozes: settings.prayer_max_snoozes ?? d.prayer_max_snoozes,
    prayerSnoozeMinutes: settings.prayer_snooze_minutes ?? d.prayer_snooze_minutes,
  };
}

/** The settings columns a save writes. prayers_enabled is not among them: switching goes through the RPC. */
export function prayerFormToPatch(values: PrayerFormValues): PrayerSettingsPatch {
  return {
    latitude: values.latitude,
    longitude: values.longitude,
    location_label: values.locationLabel.trim(),
    fajr_angle: values.fajrAngle,
    isha_angle: values.ishaAngle,
    asr_factor: values.asrFactor,
    fajr_offset_min: values.fajrOffset,
    dhuhr_offset_min: values.dhuhrOffset,
    asr_offset_min: values.asrOffset,
    maghrib_offset_min: values.maghribOffset,
    isha_offset_min: values.ishaOffset,
    pre_prayer_minutes: values.prePrayerMinutes,
    prayer_max_snoozes: values.prayerMaxSnoozes,
    prayer_snooze_minutes: values.prayerSnoozeMinutes,
  };
}

export const OFFSET_FIELDS: ReadonlyArray<{ prayer: PrayerName; name: 'fajrOffset' | 'dhuhrOffset' | 'asrOffset' | 'maghribOffset' | 'ishaOffset' }> = [
  { prayer: 'fajr', name: 'fajrOffset' },
  { prayer: 'dhuhr', name: 'dhuhrOffset' },
  { prayer: 'asr', name: 'asrOffset' },
  { prayer: 'maghrib', name: 'maghribOffset' },
  { prayer: 'isha', name: 'ishaOffset' },
];

export interface PrayerPreviewRow {
  prayer: PrayerName;
  label: string;
  /** 'HH:mm' in the settings time zone. */
  time: string;
}

/**
 * Today's five times for what the form currently says, so a wrong location, angle or offset shows up
 * before saving. Null when the values are not valid yet (a field is mid-edit).
 */
export function prayerPreview(values: PrayerFormValues, timezone: string, now: Date = new Date()): PrayerPreviewRow[] | null {
  if (!prayerFormSchema.safeParse(values).success) return null;
  const config = resolvePrayerConfig({
    prayers_enabled: true,
    latitude: values.latitude,
    longitude: values.longitude,
    fajr_angle: values.fajrAngle,
    isha_angle: values.ishaAngle,
    asr_factor: values.asrFactor,
    fajr_offset_min: values.fajrOffset,
    dhuhr_offset_min: values.dhuhrOffset,
    asr_offset_min: values.asrOffset,
    maghrib_offset_min: values.maghribOffset,
    isha_offset_min: values.ishaOffset,
  });
  if (config === null) return null;
  try {
    const times = prayerTimesOnDay(config, toWallClock(now, timezone).dayNumber);
    return PRAYER_NAMES.map((prayer) => ({
      prayer,
      label: PRAYER_LABELS[prayer],
      time: formatTimeInZone(times[prayer], timezone),
    }));
  } catch {
    // No such time at this latitude on this date (polar summer): nothing sensible to preview.
    return null;
  }
}

/** Lead choices for the reminder before each prayer; 0 turns the reminders off. */
export const PRE_PRAYER_OPTIONS = [
  { value: 0, label: 'No reminder' },
  { value: 5, label: '5 minutes before' },
  { value: 10, label: '10 minutes before' },
  { value: 15, label: '15 minutes before' },
  { value: 20, label: '20 minutes before' },
  { value: 30, label: '30 minutes before' },
  { value: 45, label: '45 minutes before' },
  { value: 60, label: '1 hour before' },
] as const;

export function leadLabel(value: number): string {
  return `${value} minutes before`;
}

/** Parses a typed decimal ('36.8625', '36,8625', '-6.2'); null for anything that is not a plain number. */
export function parseDecimal(text: string): number | null {
  const normalized = text.trim().replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) return null;
  return Number(normalized);
}

export interface Coordinates {
  latitude: number;
  longitude: number;
}

/** Coordinates to 4 decimals (about 10 m), plenty for a prayer time and tidy to read. */
export function roundCoordinates(position: Coordinates): Coordinates {
  const round = (value: number): number => Math.round(value * 10_000) / 10_000;
  return { latitude: round(position.latitude), longitude: round(position.longitude) };
}
