// End-to-end: launches the built app against a fixture ~/.claude, then drives live updates
// through the transcript files and the hook receiver. Run `npm run build` first.
// SHOT_REAL=1 additionally screenshots the app against the real ~/.claude (read-only).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SID, writeFixture } from '../fixtures/build';

const ROOT = path.resolve(__dirname, '../..');
const ART = path.join(ROOT, 'tests/e2e/artifacts');
const PORT = 47899;

async function launch(env: Record<string, string>) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-ud-'));
  const app = await electron.launch({
    args: [ROOT],
    cwd: ROOT,
    env: { ...process.env, CLAUDE_VIS_USER_DATA: userData, CLAUDE_VIS_PORT: String(PORT), ...env } as Record<string, string>,
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 920 }).catch(() => {});
  return { app, page, userData };
}

describe('app smoke (fixture data)', () => {
  let home: string;
  let app: ElectronApplication;
  let page: Page;
  let userData: string;

  beforeAll(async () => {
    fs.mkdirSync(ART, { recursive: true });
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-home-'));
    writeFixture(home);
    // make the fixture look live
    const now = new Date();
    for (const f of fs.readdirSync(path.join(home, 'projects', 'C--demo-app'))) fs.utimesSync(path.join(home, 'projects', 'C--demo-app', f), now, now);
    ({ app, page, userData } = await launch({ CLAUDE_VIS_HOME: home }));
  });

  afterAll(async () => {
    await app?.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(userData, { recursive: true, force: true });
  });

  it('shows the session, mode and the agent tree', async () => {
    await page.getByText('Retry + docs').first().waitFor({ timeout: 20_000 });
    await page.locator('[data-agent="a1"]').waitFor();
    expect(await page.locator('.modebox .big').innerText()).toBe('PLAN MODE');
    for (const id of ['main', 'a1', 'a2', 'a3', 'wf:wf_x', 'w2']) expect(await page.locator(`[data-agent="${id}"]`).count(), id).toBe(1);
    expect(await page.locator('[data-agent="a2"] .status').innerText()).toContain('done');
    expect(await page.locator('.todo.completed').count()).toBe(1);
    await page.screenshot({ path: path.join(ART, 'fixture.png') });
  });

  it('picks up a new subagent written to disk', async () => {
    const sub = path.join(home, 'projects', 'C--demo-app', SID, 'subagents');
    fs.writeFileSync(path.join(sub, 'agent-a9.meta.json'), JSON.stringify({ agentType: 'Plan', description: 'design the docs update', toolUseId: 'toolu_new' }));
    fs.writeFileSync(
      path.join(sub, 'agent-a9.jsonl'),
      JSON.stringify({ type: 'assistant', isSidechain: true, agentId: 'a9', sessionId: SID, timestamp: new Date().toISOString(), message: { id: 'm9', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'toolu_q', name: 'Glob', input: { pattern: 'docs/**/*.md' } }] } }) + '\n',
    );
    const card = page.locator('[data-agent="a9"]');
    await card.waitFor({ timeout: 10_000 });
    expect(await card.innerText()).toContain('Glob');
    expect(await card.locator('.status').innerText()).toContain('running');
  });

  it('applies hook events instantly', async () => {
    const post = (body: object) => fetch(`http://127.0.0.1:${PORT}/hook?src=claude-visualized`, { method: 'POST', body: JSON.stringify(body) });
    const health = await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.json());
    expect(health.ok).toBe(true);
    const res = await post({ session_id: SID, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_use_id: 'toolu_hook1', tool_input: { file_path: 'C:\\demo\\app\\README.md' }, permission_mode: 'acceptEdits' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
    await page.locator('.modebox .big', { hasText: 'BUILD MODE' }).waitFor({ timeout: 5000 });
    await page.locator('[data-agent="main"]', { hasText: 'README.md' }).waitFor({ timeout: 5000 });
    await post({ session_id: SID, hook_event_name: 'PermissionRequest', tool_name: 'Bash' });
    await page.locator('[data-agent="main"].waiting').waitFor({ timeout: 5000 });
    await page.screenshot({ path: path.join(ART, 'fixture-live.png') });
  });

  it('opens the always-on-top mini view', async () => {
    const [mini] = await Promise.all([app.waitForEvent('window'), page.getByRole('button', { name: /mini/ }).click()]);
    await mini.locator('.mini-main').waitFor({ timeout: 10_000 });
    expect(await mini.locator('.modebadge').innerText()).toBe('BUILD');
    expect(await mini.locator('.mini-chip').count()).toBeGreaterThan(0);
    await mini.screenshot({ path: path.join(ART, 'mini.png') });
    await mini.close();
  });

  it('replays the session', async () => {
    await page.getByRole('button', { name: /replay/ }).click();
    await page.locator('.replaybar').waitFor();
    await page.locator('.replaybar input[type=range]').fill('0');
    await page.waitForTimeout(300);
    expect(await page.locator('[data-agent="a1"]').count()).toBe(0);
    const max = await page.locator('.replaybar input[type=range]').getAttribute('max');
    await page.locator('.replaybar input[type=range]').fill(max!);
    await page.locator('[data-agent="a3"]').waitFor({ timeout: 5000 });
    await page.getByRole('button', { name: /back to live/ }).click();
  });

  it('opens the hooks dialog with a preview that keeps existing hooks', async () => {
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node', args: ['x.mjs'], async: true }] }] } }, null, 2));
    await page.getByRole('button', { name: /hooks/ }).click();
    await page.getByText('not installed').waitFor();
    await page.getByRole('button', { name: /Install hooks/ }).click();
    const after = await page.locator('.diff pre').nth(1).innerText();
    expect(after).toContain('x.mjs');
    expect(after).toContain(`127.0.0.1:${PORT}/hook`);
    await page.getByRole('button', { name: 'Write hooks to settings.json' }).click();
    await page.getByText(/Done\./).waitFor();
    const written = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'));
    expect(written.hooks.Stop).toHaveLength(2);
    expect(written.hooks.Stop[0].hooks[0].args).toEqual(['x.mjs']);
    await page.screenshot({ path: path.join(ART, 'hooks-dialog.png') });
    await page.getByRole('button', { name: /Remove hooks/ }).click();
    await page.getByRole('button', { name: 'Remove hooks from settings.json' }).click();
    await page.getByText(/Done\./).waitFor();
    expect(JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')).hooks.Stop).toHaveLength(1);
  });
});

describe.skipIf(!process.env.SHOT_REAL)('real data screenshot', () => {
  it('renders the real ~/.claude', async () => {
    const { app, page, userData } = await launch({ CLAUDE_VIS_NO_HOOK_SERVER: '1' });
    try {
      await page.locator('.session-row').first().waitFor({ timeout: 20_000 });
      await page.locator('.node').first().waitFor({ timeout: 20_000 });
      await page.waitForTimeout(1500);
      await page.screenshot({ path: path.join(ART, 'real.png') });
      const id = process.env.SHOT_SESSION;
      if (id) {
        const t = Date.now();
        await page.evaluate((sid) => window.api.select(sid), id);
        await page.waitForFunction((sid) => window.api.getState().then((s) => s?.id === sid), id, { timeout: 30_000, polling: 250 });
        await page.locator('.node').first().waitFor({ timeout: 10_000 });
        console.log(`session ${id} ready in ${Date.now() - t}ms`);
        await page.waitForTimeout(800);
        await page.screenshot({ path: path.join(ART, 'real-session.png') });
      }
    } finally {
      await app.close();
      fs.rmSync(userData, { recursive: true, force: true });
    }
  });
});
