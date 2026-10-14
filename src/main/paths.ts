import os from 'node:os';
import path from 'node:path';

/** Root of Claude Code's data dir. CLAUDE_VIS_HOME is for tests/fixtures. */
export function claudeHome(): string {
  return process.env.CLAUDE_VIS_HOME || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

export function projectsDir(): string {
  return path.join(claudeHome(), 'projects');
}

export function settingsPath(): string {
  return path.join(claudeHome(), 'settings.json');
}
