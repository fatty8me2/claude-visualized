import { describe, expect, it } from 'vitest';
import { DEFAULT_MINI_HOTKEY, loginSupport, shouldShowOnSecondInstance, shouldStartHidden, validateHotkey } from '../../src/core/system';

describe('validateHotkey', () => {
  it('accepts the default and common accelerators', () => {
    expect(DEFAULT_MINI_HOTKEY).not.toBe('CommandOrControl+V');
    for (const a of [DEFAULT_MINI_HOTKEY, 'Ctrl+Shift+F12', 'Alt+Space', 'Super+Plus', 'CmdOrCtrl+Shift+C', ' Ctrl+Alt+1 ']) expect(validateHotkey(a).ok, a).toBe(true);
  });
  it('rejects bad input', () => {
    for (const a of ['', '   ', 'V', 'Ctrl', 'Ctrl+', 'Ctrl++', 'Ctrl+A+B', 'Ctrl+Alt+Banana', 'Alt', 'Shift+F25']) expect(validateHotkey(a).ok, a).toBe(false);
  });
  it('refuses clipboard shortcuts but allows them with another modifier', () => {
    for (const a of ['CommandOrControl+V', 'Ctrl+C', 'Cmd+X']) expect(validateHotkey(a).ok, a).toBe(false);
    expect(validateHotkey('CommandOrControl+Alt+V').ok).toBe(true);
  });
  it('trims and returns the accelerator', () => {
    expect(validateHotkey(' Ctrl + Alt + M ')).toEqual({ ok: true, accelerator: 'Ctrl+Alt+M' });
  });
});

describe('launch decisions', () => {
  it('starts hidden for --hidden or login launches, only with a tray', () => {
    expect(shouldStartHidden(['app.exe', '--hidden'], false, true)).toBe(true);
    expect(shouldStartHidden(['app.exe'], true, true)).toBe(true);
    expect(shouldStartHidden(['app.exe'], false, true)).toBe(false);
    expect(shouldStartHidden(['app.exe', '--hidden'], false, false)).toBe(false);
  });
  it('second instance shows the window unless hidden', () => {
    expect(shouldShowOnSecondInstance(['app.exe'])).toBe(true);
    expect(shouldShowOnSecondInstance(['app.exe', '--hidden'])).toBe(false);
  });
  it('login registration only in packaged, non-test runs', () => {
    expect(loginSupport(true, false)).toBe('active');
    expect(loginSupport(false, false)).toBe('dev');
    expect(loginSupport(true, true)).toBe('disabled');
  });
});
