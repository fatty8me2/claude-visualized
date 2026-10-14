// Pure helpers for OS integration (launch at login, global hotkey), kept free of electron so they can be unit-tested.

export const DEFAULT_MINI_HOTKEY = 'CommandOrControl+Alt+V';

const MODIFIERS = new Set(['command', 'cmd', 'control', 'ctrl', 'commandorcontrol', 'cmdorctrl', 'alt', 'option', 'altgr', 'shift', 'super', 'meta']);
const NAMED_KEYS = new Set([
  'plus',
  'space',
  'tab',
  'capslock',
  'numlock',
  'scrolllock',
  'backspace',
  'delete',
  'insert',
  'return',
  'enter',
  'up',
  'down',
  'left',
  'right',
  'home',
  'end',
  'pageup',
  'pagedown',
  'escape',
  'esc',
  'volumeup',
  'volumedown',
  'volumemute',
  'medianexttrack',
  'mediaprevioustrack',
  'mediastop',
  'mediaplaypause',
  'printscreen',
]);
const isKey = (k: string) =>
  /^[a-z0-9]$/i.test(k) ||
  /^[`\-=[\]\\;',./]$/.test(k) ||
  /^f([1-9]|1\d|2[0-4])$/i.test(k) ||
  /^num([0-9]|dec|add|sub|mult|div)$/i.test(k) ||
  NAMED_KEYS.has(k.toLowerCase());
const isPrimary = (m: string) => ['command', 'cmd', 'control', 'ctrl', 'commandorcontrol', 'cmdorctrl'].includes(m.toLowerCase());

/**
 * Check an Electron accelerator string. Requires at least one modifier and exactly one non-modifier key,
 * and refuses plain Ctrl/Cmd+C/V/X/A/Z/Y, which would break copy/paste everywhere.
 */
export function validateHotkey(input: string): { ok: true; accelerator: string } | { ok: false; error: string } {
  const acc = input.trim();
  if (!acc) return { ok: false, error: 'Enter a shortcut such as CommandOrControl+Alt+V.' };
  const parts = acc.split('+').map((p) => p.trim());
  // "Ctrl++" style: an empty part means the key is "+", which Electron spells "Plus"
  if (parts.some((p) => !p)) return { ok: false, error: 'Use "Plus" for the + key, and separate keys with a single "+".' };
  const mods = parts.filter((p) => MODIFIERS.has(p.toLowerCase()));
  const keys = parts.filter((p) => !MODIFIERS.has(p.toLowerCase()));
  if (keys.length === 0) return { ok: false, error: 'Add a key after the modifiers, e.g. CommandOrControl+Alt+V.' };
  if (keys.length > 1) return { ok: false, error: `Only one non-modifier key is allowed (found ${keys.join(', ')}).` };
  if (!isKey(keys[0])) return { ok: false, error: `"${keys[0]}" is not a recognised key.` };
  if (mods.length === 0) return { ok: false, error: 'Include at least one modifier (Ctrl/Command, Alt or Shift).' };
  const onlyPrimary = mods.length === 1 && isPrimary(mods[0]);
  if (onlyPrimary && /^[cvxazy]$/i.test(keys[0])) return { ok: false, error: `${acc} would clash with copy/paste; add another modifier.` };
  return { ok: true, accelerator: parts.join('+') };
}

/** Should this launch start hidden in the tray? (Needs a tray, otherwise there would be no way back in.) */
export function shouldStartHidden(argv: readonly string[], wasOpenedAtLogin: boolean, hasTray: boolean): boolean {
  return hasTray && (argv.includes('--hidden') || wasOpenedAtLogin);
}

/** A second launch brings the window up unless it was itself a hidden (login) launch. */
export function shouldShowOnSecondInstance(argv: readonly string[]): boolean {
  return !argv.includes('--hidden');
}

export type LoginSupport = 'active' | 'dev' | 'disabled';

/** Where launch-at-login can really be registered: packaged builds only (dev would register electron.exe). */
export function loginSupport(isPackaged: boolean, noSystemIntegration: boolean): LoginSupport {
  if (noSystemIntegration) return 'disabled';
  return isPackaged ? 'active' : 'dev';
}
