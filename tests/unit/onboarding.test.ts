import { describe, expect, it } from 'vitest';
import { buildChecklist, ONBOARDING_VERSION, shouldShowOnboarding } from '@core/onboarding';

describe('shouldShowOnboarding', () => {
  it('shows on a fresh config', () => expect(shouldShowOnboarding({})).toBe(true));
  it('hides once done at the current version', () => expect(shouldShowOnboarding({ onboardingDone: true, onboardingVersion: ONBOARDING_VERSION })).toBe(false));
  it('shows again for an older version', () => expect(shouldShowOnboarding({ onboardingDone: true, onboardingVersion: 1 }, 2)).toBe(true));
  it('treats a missing version as 0', () => expect(shouldShowOnboarding({ onboardingDone: true }, 1)).toBe(true));
  it('can be skipped (tests)', () => expect(shouldShowOnboarding({}, 1, true)).toBe(false));
});

const base = { claude: { projectsDirExists: true, sessionCount: 3 }, usageState: 'ok' as const, hooks: 'installed' as const };
const by = (items: ReturnType<typeof buildChecklist>, id: string) => items.find((x) => x.id === id)!;

describe('buildChecklist', () => {
  it('all good', () => {
    const l = buildChecklist(base);
    expect(by(l, 'claude').status).toBe('ok');
    expect(by(l, 'claude').detail).toContain('3 sessions');
    expect(by(l, 'usage').status).toBe('ok');
    expect(by(l, 'hooks').status).toBe('ok');
  });
  it('missing projects dir warns and explains', () => {
    const c = by(buildChecklist({ ...base, claude: { projectsDirExists: false, sessionCount: 0 } }), 'claude');
    expect(c.status).toBe('warn');
    expect(c.detail).toMatch(/Install Claude Code/);
  });
  it('empty projects dir warns', () =>
    expect(by(buildChecklist({ ...base, claude: { projectsDirExists: true, sessionCount: 0 } }), 'claude').status).toBe('warn'));
  it('singular session', () =>
    expect(by(buildChecklist({ ...base, claude: { projectsDirExists: true, sessionCount: 1 } }), 'claude').detail).toBe('Found 1 session.'));
  it('usage states', () => {
    expect(by(buildChecklist({ ...base, usageState: 'no-login' }), 'usage').status).toBe('warn');
    expect(by(buildChecklist({ ...base, usageState: 'expired' }), 'usage').detail).toMatch(/login/i);
    expect(by(buildChecklist({ ...base, usageState: undefined }), 'usage').status).toBe('todo');
  });
  it('hooks are optional and never warn', () => {
    for (const h of ['none', 'partial', 'other-port', 'error', null] as const) {
      const x = by(buildChecklist({ ...base, hooks: h }), 'hooks');
      expect(x.optional).toBe(true);
      expect(x.status).toBe('todo');
    }
  });
});
