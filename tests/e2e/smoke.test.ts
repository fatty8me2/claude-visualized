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
const PORT = Number(process.env.E2E_PORT ?? 47899);

const freshLine = (sid: string) => JSON.stringify({ type: 'system', subtype: 'turn_duration', sessionId: sid, timestamp: new Date().toISOString() }) + '\n';

async function launch(env: Record<string, string>, existingUserData?: string) {
  const userData = existingUserData ?? fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-ud-'));
  const app = await electron.launch({
    args: [ROOT],
    cwd: ROOT,
    env: { ...process.env, CLAUDE_VIS_USER_DATA: userData, CLAUDE_VIS_PORT: String(PORT), CLAUDE_VIS_NO_EXTERNAL: '1', CLAUDE_VIS_NO_SYSTEM_INTEGRATION: '1', CLAUDE_VIS_NO_USAGE_API: '1', CLAUDE_VIS_SKIP_ONBOARDING: '1', CLAUDE_VIS_DESKTOP_DIR: path.join(userData, 'no-desktop'), ...env } as Record<string, string>,
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
    // liveness comes from transcript timestamps: add a current one
    fs.appendFileSync(path.join(home, 'projects', 'C--demo-app', `${SID}.jsonl`), freshLine(SID));
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

  it('labels each agent with its goal and shows a detail drawer', async () => {
    expect(await page.locator('[data-agent="a2"] [data-goal]').getAttribute('data-goal')).toBe('test');
    expect(await page.locator('[data-agent="a1"] [data-goal]').getAttribute('data-goal')).toBe('search');
    expect(await page.locator('[data-agent="wf:wf_x"] [data-goal]').getAttribute('data-goal')).toBe('workflow');
    expect(await page.locator('[data-agent="a1"] [data-testid="now"]').innerText()).toContain('finished: Found it in src/api.ts');
    await page.screenshot({ path: path.join(ART, 'agent-cards.png') });

    await page.locator('[data-agent="a2"]').click();
    const drawer = page.getByTestId('drawer');
    await drawer.waitFor();
    expect(await drawer.getByTestId('because').innerText()).toContain('test');
    expect(await drawer.getByTestId('drawer-now').innerText()).toContain('finished');
    const timeline = await drawer.getByTestId('timeline').innerText();
    expect(timeline).toContain('Bash');
    expect(timeline).toContain('npm test');
    expect(await drawer.getByTestId('commands').innerText()).toContain('npm test');
    await page.screenshot({ path: path.join(ART, 'agent-drawer.png') });
    await page.locator('[data-agent="a1"]').click();
    expect(await drawer.getByTestId('task').innerText()).toBe('find it');
    expect(await drawer.getByTestId('files').count()).toBe(0);
    await drawer.getByRole('button', { name: '×' }).click();
    await drawer.waitFor({ state: 'detached' });
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
    expect(await card.innerText()).toContain('finding files (docs/**/*.md)');
    expect(await card.locator('[data-goal]').getAttribute('data-goal')).toBe('plan');
    expect(await card.locator('.status').innerText()).toContain('running');
  });

  it('shows the plan beside the graph with evidence-based statuses and hover linking', async () => {
    const rail = page.getByTestId('plan-rail');
    await rail.waitFor({ timeout: 10_000 });
    expect(await page.getByTestId('plan-origin').innerText()).toContain('approved plan');
    const steps = page.locator('[data-testid="plan-step"]');
    expect(await steps.count()).toBe(5);
    const status = async (i: number) => steps.nth(i).getAttribute('data-status');
    // todo 'Map the repo' is completed, agents a1 'search repo' and a2 'run tests' are done, a9 'design the docs update' is running
    expect([await status(0), await status(1), await status(2), await status(3), await status(4)]).toEqual(['done', 'done', 'done', 'pending', 'in_progress']);
    expect((await page.getByTestId('plan-count').innerText()).trim()).toBe('3/5 steps');
    expect(await steps.nth(1).locator('.pr-chip').first().innerText()).toBe('Explore · done');
    expect(await steps.nth(4).locator('.pr-chip').first().innerText()).toContain('running');

    // hovering a step lights up its agent card; hovering a card lights up its step
    await steps.nth(4).hover();
    await page.locator('[data-agent="a9"].hl').waitFor({ timeout: 3000 });
    expect(await page.locator('.node.hl').count()).toBe(1);
    await page.mouse.move(5, 5);
    await page.waitForTimeout(150);
    expect(await page.locator('.node.hl').count()).toBe(0);
    await page.locator('[data-agent="a2"]').hover();
    await steps.nth(2).and(page.locator('.hl')).waitFor({ timeout: 3000 });
    expect(await page.locator('.pr-step.hl').count()).toBe(1);

    // clicking a step selects its agent
    await steps.nth(1).click();
    await page.locator('.drawer').waitFor();
    expect(await page.locator('.drawer .hd b').innerText()).toBe('Explore');
    await page.locator('.drawer .hd button').click();

    await page.mouse.move(5, 5);
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(ART, 'plan-rail.png') });

    // toggle, side and width are remembered
    const w0 = (await rail.boundingBox())!;
    const edge = (await page.getByTestId('plan-resize').boundingBox())!;
    await page.mouse.move(edge.x + edge.width / 2, edge.y + 200);
    await page.mouse.down();
    await page.mouse.move(edge.x + edge.width / 2 + 60, edge.y + 200, { steps: 5 });
    await page.mouse.up();
    expect((await rail.boundingBox())!.width).toBeGreaterThan(w0.width + 40);
    await rail.getByTitle('Move the plan to the other side').click();
    const graph = (await page.locator('.graph-main').boundingBox())!;
    expect((await rail.boundingBox())!.x).toBeGreaterThan(graph.x);
    const saved = JSON.parse(await page.evaluate(() => localStorage.getItem('cvis.plan.v1') ?? 'null'));
    expect(saved).toMatchObject({ open: true, side: 'right' });
    await page.getByTestId('plan-toggle').click();
    expect(await rail.count()).toBe(0);
    await page.getByTestId('plan-toggle').click();
    await rail.waitFor();
    await rail.getByTitle('Move the plan to the other side').click();
    await page.evaluate(() => localStorage.removeItem('cvis.plan.v1'));
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
    // status-line payloads feed the 5-hour / weekly meters
    const resets = Math.floor(Date.now() / 1000) + 2 * 3600;
    await fetch(`http://127.0.0.1:${PORT}/statusline`, { method: 'POST', body: JSON.stringify({ session_id: SID, rate_limits: { five_hour: { used_percentage: 23.5, resets_at: resets }, seven_day: { used_percentage: 87, resets_at: resets + 3 * 86400 } } }) });
    await page.locator('.topbar .meter.ok .m-pct', { hasText: '24%' }).waitFor({ timeout: 5000 });
    expect(await page.locator('.topbar .meter.hot .m-pct').innerText()).toBe('87%');
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

  it('settings dialog offers launch-at-login and the mini hotkey', async () => {
    await page.getByRole('button', { name: /hooks/ }).click();
    const login = page.getByLabel(/Start with Windows|Start at login/);
    await login.waitFor({ timeout: 5000 });
    expect(await login.isChecked()).toBe(false);
    expect(await page.locator('.dialog').innerText()).toContain('disabled in this run');
    const hk = page.getByLabel('Mini view hotkey');
    expect(await hk.inputValue()).toBe('CommandOrControl+Alt+V');
    // invalid shortcuts are rejected without touching the config
    await hk.fill('CommandOrControl+V');
    await page.getByRole('button', { name: 'Apply' }).first().click();
    await page.getByText(/clash with copy\/paste/).waitFor({ timeout: 5000 });
    // a valid one is accepted and stored
    await hk.fill('Ctrl+Alt+M');
    await page.getByRole('button', { name: 'Apply' }).first().click();
    await page.getByText('Registered Ctrl+Alt+M').waitFor({ timeout: 5000 });
    expect(JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8')).miniHotkey).toBe('Ctrl+Alt+M');
    await page.getByRole('button', { name: '×' }).click();
  });

  it('shows every live session side by side on the overview page', async () => {
    // a second live session in another project
    const SID2 = '22222222-2222-4222-8222-222222222222';
    const p2 = path.join(home, 'projects', 'C--other-proj');
    fs.mkdirSync(p2, { recursive: true });
    const lines = fs
      .readFileSync(path.join(home, 'projects', 'C--demo-app', `${SID}.jsonl`), 'utf8')
      .replaceAll(SID, SID2)
      .replaceAll('Retry + docs', 'Second session')
      .replaceAll('C:\\\\demo\\\\app', 'C:\\\\other\\\\proj');
    fs.writeFileSync(path.join(p2, `${SID2}.jsonl`), lines + freshLine(SID2));
    await page.getByRole('button', { name: /all sessions/ }).click();
    await page.locator(`.ov-panel[data-session="${SID2}"]`).waitFor({ timeout: 15_000 });
    expect(await page.locator('.ov-panel').count()).toBe(2);
    // each panel draws its own tree: a3 exists only in the first session's subagent files
    expect(await page.locator(`.ov-panel[data-session="${SID}"] [data-agent="a3"]`).count()).toBe(1);
    expect(await page.locator(`.ov-panel[data-session="${SID2}"] [data-agent="main"]`).count()).toBe(1);
    expect(await page.locator(`.ov-panel[data-session="${SID2}"] [data-agent="a3"]`).count()).toBe(0);
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(ART, 'overview.png') });
    await page.locator(`.ov-panel[data-session="${SID}"] .ov-head`).click();
    await page.locator('.modebox').waitFor();
  });

  it('rearranges, swaps, resizes and resets the panel layout', async () => {
    const box = (sel: string) => page.locator(sel).boundingBox();
    await page.getByTestId('layout-toggle').click();
    await page.getByTestId('layout-bar').waitFor();

    // preset: three columns puts the log to the right of the graph
    await page.getByTestId('preset-columns').click();
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(ART, 'layout-animating.png') });
    await page.waitForTimeout(900);
    const g = (await box('.lp-graph'))!;
    const l = (await box('.lp-log'))!;
    expect(l.x).toBeGreaterThan(g.x + g.width - 2);
    await page.screenshot({ path: path.join(ART, 'layout-edit.png') });

    // drag the mode panel onto the log panel: they swap places
    const modeBefore = (await box('.lp-mode'))!;
    const logBefore = (await box('.lp-log'))!;
    await page.mouse.move(modeBefore.x + modeBefore.width / 2, modeBefore.y + modeBefore.height / 2);
    await page.mouse.down();
    await page.mouse.move(logBefore.x + logBefore.width / 2, logBefore.y + logBefore.height / 2, { steps: 8 });
    await page.locator('.lp-log.drop-target').waitFor();
    await page.mouse.up();
    await page.waitForTimeout(900);
    expect(Math.abs((await box('.lp-mode'))!.x - logBefore.x)).toBeLessThan(4);

    // done editing; resize the side slot by dragging its edge
    await page.getByRole('button', { name: 'done' }).click();
    const handle = page.locator('.lp-log .rz-right');
    const hb = (await handle.boundingBox())!;
    const before = (await box('.lp-log'))!.width;
    await page.mouse.move(hb.x + hb.width / 2, hb.y + 200);
    await page.mouse.down();
    await page.mouse.move(hb.x + hb.width / 2 + 90, hb.y + 200, { steps: 6 });
    await page.mouse.up();
    expect((await box('.lp-log'))!.width).toBeGreaterThan(before + 60);

    // hide the log from edit mode, then reset everything
    await page.getByTestId('layout-toggle').click();
    await page.getByRole('button', { name: '≡ log' }).click();
    await page.waitForTimeout(700);
    expect(await page.locator('.lp-log').count()).toBe(0);
    await page.getByTestId('layout-reset').click();
    await page.waitForTimeout(900);
    const m = (await box('.lp-mode'))!;
    const gr = (await box('.lp-graph'))!;
    const lg = (await box('.lp-log'))!;
    expect(m.x).toBeLessThan(gr.x);
    expect(lg.y).toBeGreaterThan(gr.y + gr.height - 2);
    await page.getByRole('button', { name: 'done' }).click();
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
    await page.getByText('not installed').first().waitFor();
    await page.getByRole('button', { name: /Install hooks/ }).click();
    const after = await page.locator('.diff pre').nth(1).innerText();
    expect(after).toContain('x.mjs');
    expect(after).toContain(`127.0.0.1:${PORT}/hook`);
    await page.getByRole('button', { name: 'Write hooks to settings.json' }).click();
    await page.getByText(/Done\./).waitFor();
    const written = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'));
    expect(written.hooks.Stop).toHaveLength(2);
    expect(written.hooks.Stop[0].hooks[0].args).toEqual(['x.mjs']);
    expect(written.statusLine.command).toContain('claude-visualized-statusline.mjs');
    expect(fs.existsSync(path.join(home, 'claude-visualized-statusline.mjs'))).toBe(true);
    await page.screenshot({ path: path.join(ART, 'hooks-dialog.png') });
    await page.getByRole('button', { name: /Remove hooks/ }).click();
    await page.getByRole('button', { name: 'Remove hooks from settings.json' }).click();
    await page.getByText(/Done\./).waitFor();
    const restored = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'));
    expect(restored.hooks.Stop).toHaveLength(1);
    expect(restored.statusLine).toBeUndefined();
  });
});

describe('first-run welcome and tour', () => {
  let home: string;
  let userData: string;

  beforeAll(() => {
    fs.mkdirSync(ART, { recursive: true });
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-home-'));
    writeFixture(home);
    fs.appendFileSync(path.join(home, 'projects', 'C--demo-app', `${SID}.jsonl`), freshLine(SID));
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-ud-'));
  });

  afterAll(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(userData, { recursive: true, force: true });
  });

  const open = () => launch({ CLAUDE_VIS_HOME: home, CLAUDE_VIS_SKIP_ONBOARDING: '' }, userData);

  it('shows the welcome checklist, walks the tour, and stays away after finishing', async () => {
    const first = await open();
    try {
      const page = first.page;
      await page.getByTestId('welcome').waitFor({ timeout: 20_000 });
      await page.locator('[data-check="claude"].ok').waitFor({ timeout: 10_000 });
      expect(await page.locator('[data-check="claude"]').innerText()).toMatch(/Found \d+ session/);
      for (const id of ['usage', 'hooks', 'mini']) expect(await page.locator(`[data-check="${id}"]`).count(), id).toBe(1);
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(ART, 'welcome.png') });

      await page.getByTestId('take-tour').click();
      await page.getByTestId('tour').waitFor();
      let n = 0;
      for (;;) {
        const label = await page.getByTestId('tour-count').textContent() ?? '';
        n++;
        const total = Number(/of (\d+)/.exec(label)![1]);
        expect(label).toContain(`step ${n} of`);
        if (n === 4) {
          await page.locator('.tour-spot').waitFor();
          await page.waitForTimeout(500);
          await page.screenshot({ path: path.join(ART, 'tour-step.png') });
        }
        if (n === total) break;
        await page.getByTestId('tour-next').click();
      }
      expect(n).toBeGreaterThanOrEqual(6);
      await page.getByTestId('tour-next').click();
      await page.getByTestId('tour').waitFor({ state: 'detached' });
      expect(await page.getByTestId('welcome').count()).toBe(0);
    } finally {
      await first.app.close();
    }

    const second = await open();
    try {
      const page = second.page;
      await page.locator('.session-row').first().waitFor({ timeout: 20_000 });
      await page.waitForTimeout(1500);
      expect(await page.getByTestId('welcome').count()).toBe(0);
      await page.getByRole('button', { name: /help/ }).click();
      await page.getByTestId('welcome').waitFor();
    } finally {
      await second.app.close();
    }
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
