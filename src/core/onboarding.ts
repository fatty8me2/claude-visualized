// Pure helpers for the first-run welcome screen: when to show it and how setup checks map to the checklist.
import type { HookInstallState } from './hooksConfig';

/** Bump when the welcome / tour changes enough that returning users should see it again. */
export const ONBOARDING_VERSION = 1;

export interface OnboardingConfig {
  onboardingDone?: boolean;
  onboardingVersion?: number;
}

export function shouldShowOnboarding(cfg: OnboardingConfig, current = ONBOARDING_VERSION, skip = false): boolean {
  if (skip) return false;
  return !cfg.onboardingDone || (cfg.onboardingVersion ?? 0) < current;
}

export type CheckStatus = 'ok' | 'warn' | 'todo';

export interface SetupInput {
  claude: { projectsDirExists: boolean; sessionCount: number } | null;
  usageState: 'ok' | 'no-login' | 'expired' | 'error' | undefined;
  hooks: HookInstallState | 'error' | null;
  /** start-at-login and the global mini-view hotkey, when known */
  launchAtLogin?: boolean;
  hotkey?: string | null;
}

export interface CheckItem {
  id: 'claude' | 'usage' | 'hooks' | 'mini';
  status: CheckStatus;
  optional: boolean;
  title: string;
  detail: string;
}

export const LOGIN_COMMAND = 'claude /login';

export function buildChecklist(i: SetupInput): CheckItem[] {
  const items: CheckItem[] = [];

  const c = i.claude;
  if (!c) items.push({ id: 'claude', status: 'todo', optional: false, title: 'Claude Code data', detail: 'Checking…' });
  else if (!c.projectsDirExists)
    items.push({ id: 'claude', status: 'warn', optional: false, title: 'Claude Code data', detail: 'Not found yet. Install Claude Code (the Code tab in the Claude desktop app, or the claude command), then run one session.' });
  else if (c.sessionCount === 0)
    items.push({ id: 'claude', status: 'warn', optional: false, title: 'Claude Code data', detail: 'Found the folder, but no sessions yet. Start a session in Claude Code and it will show up here.' });
  else items.push({ id: 'claude', status: 'ok', optional: false, title: 'Claude Code data', detail: `Found ${c.sessionCount} session${c.sessionCount === 1 ? '' : 's'}.` });

  const u = i.usageState;
  if (u === 'ok') items.push({ id: 'usage', status: 'ok', optional: false, title: 'Usage meters', detail: 'Connected. Your 5-hour and weekly limits show at the top.' });
  else if (u === undefined) items.push({ id: 'usage', status: 'todo', optional: false, title: 'Usage meters', detail: 'Checking…' });
  else
    items.push({
      id: 'usage',
      status: 'warn',
      optional: false,
      title: 'Usage meters',
      detail: u === 'error' ? 'Could not reach the usage service. It will retry; check your internet connection.' : 'Needs a login. Run the command below in a terminal and follow the steps.',
    });

  const h = i.hooks;
  if (h === 'installed') items.push({ id: 'hooks', status: 'ok', optional: true, title: 'Live hooks', detail: 'Installed. Updates arrive instantly.' });
  else items.push({ id: 'hooks', status: 'todo', optional: true, title: 'Live hooks', detail: h === 'error' ? 'Could not read your Claude settings file.' : 'Optional. Without them the app is about a second behind, which is fine for most people.' });

  const key = i.hotkey ? i.hotkey.replace('CommandOrControl', 'Ctrl') : null;
  items.push({
    id: 'mini',
    status: i.launchAtLogin ? 'ok' : 'todo',
    optional: true,
    title: 'Always there',
    detail: i.launchAtLogin
      ? `Starts with your computer and waits in the tray.${key ? ` Press ${key} anywhere for the mini view.` : ''}`
      : `Optional. Turn on "start at login" in settings so it waits in the tray.${key ? ` Press ${key} anywhere for a small always-on-top mini view.` : ''}`,
  });
  return items;
}
