import type { UpdateProgress } from './app-update-plugin';

/** "5.2 MB" for a byte count; one decimal, never "0.0 MB" for a small non-empty file. */
export function formatMegabytes(bytes: number): string {
  if (bytes <= 0) return '0 MB';
  const megabytes = bytes / (1024 * 1024);
  return megabytes < 0.1 ? '<0.1 MB' : `${megabytes.toFixed(1)} MB`;
}

/** Whole percent of a download, 0 to 100; 0 while the size is not known yet. */
export function downloadPercent(progress: UpdateProgress | null): number {
  if (progress === null || progress.total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((progress.received / progress.total) * 100)));
}

/** "Last checked 3 hours ago" style text for the About page; `null` means never. */
export function lastCheckedLabel(checkedAt: number | null, now: number): string {
  if (checkedAt === null) return 'Not checked yet';
  const minutes = Math.floor((now - checkedAt) / 60_000);
  if (minutes < 1) return 'Checked just now';
  if (minutes < 60) return `Checked ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Checked ${hours} h ago`;
  return `Checked ${Math.floor(hours / 24)} d ago`;
}
