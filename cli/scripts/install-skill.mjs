// Copies the repository's Claude Code skill (.claude/skills/alarm-calendar) into the user's skills folder
// (%USERPROFILE%\.claude\skills\alarm-calendar) so every Claude Code session can use the calendar.
// The destination folder is replaced, so a file removed from the skill does not linger.
//
//   node cli/scripts/install-skill.mjs [--dest <skills folder>]
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = join(repo, '.claude', 'skills', 'alarm-calendar');

const destFlag = process.argv.indexOf('--dest');
const skillsDir = resolve(destFlag > 0 && process.argv[destFlag + 1] ? process.argv[destFlag + 1] : join(homedir(), '.claude', 'skills'));
const target = join(skillsDir, 'alarm-calendar');

if (!existsSync(join(source, 'SKILL.md'))) {
  console.error(`The skill is missing: ${source}`);
  process.exit(1);
}

mkdirSync(skillsDir, { recursive: true });
rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });
console.log(`Installed the alarm-calendar skill to ${target}`);
