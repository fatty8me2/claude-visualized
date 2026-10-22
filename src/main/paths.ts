import os from 'node:os';
import path from 'node:path';

/** Root of Claude Code's data dir: CLAUDE_VIS_HOME (tests/fixtures), then CLAUDE_CONFIG_DIR (Claude Code's own override), then ~/.claude. Everything reading it goes through here. */
export function claudeHome(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  return env.CLAUDE_VIS_HOME?.trim() || env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, '.claude');
}

export function projectsDir(): string {
  return path.join(claudeHome(), 'projects');
}

export function settingsPath(): string {
  return path.join(claudeHome(), 'settings.json');
}

/** True in an installed build (not `electron .` in dev/tests, not plain Node in unit tests). */
export const isPackagedApp = (): boolean => !!process.versions.electron && !process.defaultApp;

/** A test-only env override: ignored in an installed build, so nothing can redirect the user's login token elsewhere. */
export const testOverride = (name: string): string | undefined => (isPackagedApp() ? undefined : process.env[name] || undefined);
