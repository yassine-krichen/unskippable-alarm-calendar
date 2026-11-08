import { existsSync, readFileSync, rmSync } from 'node:fs';

import type { ConfigPaths } from '../config/paths';
import { ensurePrivateDir, readJsonFile, restrictFile, writeJsonFile } from '../config/private-files';

/**
 * supabase-js storage on a file in the config directory. The file holds the session (access and refresh
 * token) so it is created private and written atomically; nothing here ever prints a value.
 */
export class FileSessionStorage {
  constructor(
    private readonly paths: ConfigPaths,
    private readonly env: Record<string, string | undefined>,
    private readonly platform: NodeJS.Platform
  ) {}

  private read(): Record<string, string> {
    const raw = readJsonFile(this.paths.session);
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return Object.fromEntries(
      Object.entries(raw as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    );
  }

  getItem(key: string): string | null {
    return this.read()[key] ?? null;
  }

  setItem(key: string, value: string): void {
    ensurePrivateDir(this.paths.dir, this.env, this.platform);
    this.write({ ...this.read(), [key]: value });
  }

  private write(content: Record<string, string>): void {
    writeJsonFile(this.paths.session, content);
    restrictFile(this.paths.session, this.env, this.platform);
  }

  removeItem(key: string): void {
    const current = this.read();
    delete current[key];
    if (Object.keys(current).length === 0) {
      if (existsSync(this.paths.session)) rmSync(this.paths.session);
      return;
    }
    this.write(current);
  }

  /** Whether the session file exists (without parsing it). */
  exists(): boolean {
    return existsSync(this.paths.session) && readFileSync(this.paths.session, 'utf8').trim() !== '';
  }
}
