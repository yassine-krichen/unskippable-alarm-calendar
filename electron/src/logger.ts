import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

export type Logger = (event: string, fields?: Record<string, unknown>) => void;

const MAX_LOG_BYTES = 1_000_000;

/**
 * JSON lines to stdout and to a size-capped file in userData. A packaged tray
 * app has no console, so the file is the only way to see what the scheduler did.
 */
export function createLogger(filePath: string): Logger {
  mkdirSync(dirname(filePath), { recursive: true });
  return (event, fields = {}) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), event, ...fields });
    console.info(line);
    try {
      const size = statSync(filePath, { throwIfNoEntry: false })?.size ?? 0;
      if (size > MAX_LOG_BYTES) {
        renameSync(filePath, `${filePath}.old`);
      }
      appendFileSync(filePath, `${line}\n`);
    } catch (error) {
      // Logging must never take the alarm engine down; stdout above still has the line.
      console.error(`log file write failed: ${String(error)}`);
    }
  };
}
