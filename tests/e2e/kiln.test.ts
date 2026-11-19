// Kiln end to end: a Claude session hands two tasks to Kiln's local model (mcp__kiln__delegate_task), and a fake Kiln events
// file narrates both runs (one finished, one still working) plus a run no Claude session claims. Checks the Kiln child agents
// on the graph, the hand-off countdown, a live finish, the drawer's Kiln section, the sidebar row of the unclaimed run and the
// Kiln row on the Local models page. Screenshots -> tests/e2e/artifacts/kiln-*.png.
// Windows stay off-screen (vitest.e2e.config.ts). Run `npx electron-vite build` first.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildCmdPriors } from '@core/cmdEta';
import { showFinishedAgents } from '../fixtures/graphPrefs';
import { KILN_STATUS_LINE, kilnRunLines } from '../fixtures/kiln';

const ROOT = path.resolve(__dirname, '../..');
const ART = path.join(ROOT, 'tests/e2e/artifacts');
const PORT = Number(process.env.E2E_PORT ?? 48480);
const SID = '88888888-8888-4888-8888-888888888888';
const CWD = 'C:\\demo\\kiln';
const MIN = 60_000;
const DONE_BRIEF = 'Write tests for the retry helper in src/retry.ts.\nVerify with npm test -- retry. Done = tests pass.';
const LIVE_BRIEF = 'Rename fetchJson to getJson across src/ and update the callers.\nVerify with npm run typecheck.';

const toolUse = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input });

function writeSession(home: string, now: number) {
  const at = (minAgo: number) => new Date(now - minAgo * MIN).toISOString();
  const base = (minAgo: number) => ({ sessionId: SID, cwd: CWD, version: '2.1.300', entrypoint: 'claude-desktop', gitBranch: 'master', timestamp: at(minAgo) });
  let n = 0;
  const user = (minAgo: number, content: unknown) => ({ type: 'user', isSidechain: false, message: { role: 'user', content }, ...base(minAgo) });
  const asst = (minAgo: number, block: unknown) => ({
    type: 'assistant',
    isSidechain: false,
    message: { id: `m_${++n}`, model: 'claude-opus-5-5', role: 'assistant', content: [block], stop_reason: null, usage: { input_tokens: 3000, output_tokens: 120 } },
    ...base(minAgo),
  });
  const lines = [
    user(12, 'Hand the routine parts to the local model: tests for retry, then the fetchJson rename.'),
    asst(11, toolUse('toolu_K0', 'mcp__kiln__delegate_task', { task: DONE_BRIEF, cwd: CWD, effort: 'medium' })),
    user(8, [{ type: 'tool_result', tool_use_id: 'toolu_K0', content: 'status: OK', is_error: false }]),
    asst(7.5, { type: 'text', text: 'The local model wrote the tests. Reviewing the diff next.' }),
    asst(2, toolUse('toolu_K1', 'mcp__kiln__delegate_task', { task: LIVE_BRIEF, cwd: CWD, effort: 'medium' })),
  ];
  const dir = path.join(home, 'projects', 'C--demo-kiln');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${SID}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

describe('Kiln hand-offs', () => {
  let home: string;
  let userData: string;
  let events: string;
  let app: ElectronApplication;
  let page: Page;
  let liveRest: string[];
  const shot = (name: string, el?: string) =>
    el
      ? page
          .locator(el)
          .first()
          .screenshot({ path: path.join(ART, `kiln-${name}.png`) })
      : page.screenshot({ path: path.join(ART, `kiln-${name}.png`) });

  beforeAll(async () => {
    fs.mkdirSync(ART, { recursive: true });
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-kiln-home-'));
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-kiln-ud-'));
    const now = Date.now();
    writeSession(home, now);
    const sec = (minAgo: number) => (now - minAgo * MIN) / 1000;
    const done = kilnRunLines({
      id: 'done1',
      task: DONE_BRIEF,
      cwd: CWD,
      start: sec(10.9),
      steps: [
        ['read_file', 'src/retry.ts', true],
        ['write_file', 'tests/retry.test.ts', true],
        ['bash', 'npm test -- retry', false],
        ['edit_file', 'tests/retry.test.ts', true],
        ['bash', 'npm test -- retry', true],
      ],
      text: 'Added five tests; all pass.',
      finish: { ok: true, answer: 'Added tests/retry.test.ts with five cases (backoff, max tries, abort). npm test -- retry passes.', files: ['tests/retry.test.ts'], seconds: 150 },
    });
    // the live run's process is this test runner, so it counts as still running
    const live = kilnRunLines({
      id: 'live1',
      task: LIVE_BRIEF,
      cwd: CWD,
      pid: process.pid,
      start: sec(1.9),
      steps: [
        ['grep', 'fetchJson', true],
        ['edit_file', 'src/api.ts', true],
        ['bash', 'npm run typecheck', true],
      ],
      finish: { ok: true, answer: 'Renamed in 4 files; typecheck passes.', files: ['src/api.ts', 'src/client.ts', 'src/a.ts', 'src/b.ts'], seconds: 140 },
    });
    // hold back the last result and the finish: written during the test
    liveRest = live.splice(live.length - 2);
    const orphan = kilnRunLines({
      id: 'orphan1',
      task: 'Summarize what scripts/deploy.sh does.',
      cwd: '/srv/other-project',
      start: sec(30),
      readonly: true,
      steps: [['read_file', 'scripts/deploy.sh', true]],
      finish: { ok: true, answer: 'It builds and rsyncs dist/.', seconds: 25 },
    });
    events = path.join(userData, 'kiln-events.jsonl');
    fs.writeFileSync(events, [KILN_STATUS_LINE(sec(13)), ...orphan, ...done, ...live].join('\n') + '\n');
    // past hand-offs at medium effort in this project: 2-4 minutes
    const cmdPriors = path.join(userData, 'cmd-priors.json');
    const runs = [120, 140, 150, 170, 200, 230, 240].map((s) => ({ key: 'Kiln hand-off (medium)', project: 'kiln', ms: s * 1000 }));
    fs.writeFileSync(cmdPriors, JSON.stringify(buildCmdPriors(runs, now)));
    app = await electron.launch({
      args: [ROOT],
      cwd: ROOT,
      env: {
        ...process.env,
        CLAUDE_VIS_HOME: home,
        CLAUDE_VIS_USER_DATA: userData,
        CLAUDE_VIS_PORT: String(PORT),
        CLAUDE_VIS_KILN_EVENTS: events,
        CLAUDE_VIS_CMD_PRIORS: cmdPriors,
        CLAUDE_VIS_NO_EXTERNAL: '1',
        CLAUDE_VIS_NO_SYSTEM_INTEGRATION: '1',
        CLAUDE_VIS_NO_USAGE_API: '1',
        CLAUDE_VIS_SKIP_ONBOARDING: '1',
        CLAUDE_VIS_NO_UPDATES: '1',
        CLAUDE_VIS_DESKTOP_DIR: path.join(userData, 'no-desktop'),
      } as Record<string, string>,
    });
    page = await app.firstWindow();
    await showFinishedAgents(page);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1600, 1000));
    await page.setViewportSize({ width: 1600, height: 1000 }).catch(() => {});
    await page.locator(`.session-row[data-session="${SID}"]`).first().click({ timeout: 20_000 });
    await page.locator('[data-agent="kiln-live1"]').first().waitFor({ timeout: 20_000 });
  });

  afterAll(async () => {
    await app?.close();
    for (const d of [home, userData]) if (d) fs.rmSync(d, { recursive: true, force: true });
  });

  it('draws each hand-off as a Kiln agent on the local model, under the agent that handed it off', async () => {
    const live = page.locator('[data-agent="kiln-live1"]').first();
    const done = page.locator('[data-agent="kiln-done1"]').first();
    await done.waitFor({ timeout: 10_000 });
    expect(await live.textContent()).toContain('Kiln');
    expect(await live.textContent()).toContain('Rename fetchJson to getJson');
    expect(await live.textContent()).toMatch(/local/i);
    expect(await done.textContent()).toContain('Write tests for the retry helper');
    await page.mouse.move(5, 500);
    await page.waitForTimeout(500);
    await shot('session');
    await shot('card', '[data-agent="kiln-live1"]');
  });

  it('counts down the running hand-off from past runs', async () => {
    const strip = page.locator('[data-agent="main"] [data-testid="cmd-eta"]');
    await strip.waitFor({ timeout: 10_000 });
    expect(await strip.getAttribute('aria-valuetext')).toMatch(/Kiln hand-off \(medium\): (~?\d+ min left|<1 min left)/);
    await shot('countdown', '[data-agent="main"]');
  });

  it('shows the run finishing as Kiln writes it', async () => {
    fs.appendFileSync(events, liveRest.join('\n') + '\n');
    await vi.waitFor(async () => expect(await page.locator('[data-agent="kiln-live1"]').first().getAttribute('class')).toMatch(/\bst-done\b|\bdone\b/), {
      timeout: 8000,
    });
  });

  it('puts the run in the drawer: result, files, local tokens and answer', async () => {
    await page.locator('[data-agent="kiln-done1"]').first().click();
    const panel = page.getByTestId('kiln-panel');
    await panel.waitFor({ timeout: 5000 });
    expect(await page.getByTestId('kiln-state').textContent()).toBe('finished');
    expect(await page.getByTestId('kiln-files').textContent()).toContain('retry.test.ts');
    expect(await page.getByTestId('kiln-saved').textContent()).toMatch(/44\.2k tokens ran on your machine/);
    expect(await panel.textContent()).toContain('five cases');
    expect(await page.getByTestId('sb-agents').count()).toBe(1);
    expect(await page.locator('.local-num').first().textContent()).toMatch(/\d/);
    await shot('drawer', '.drawer');
    await page.keyboard.press('Escape');
  });

  it('lists a run no Claude session claims as a Kiln session', async () => {
    const row = page.locator('.session-row[data-session="kiln-orphan1"]');
    await row.waitFor({ timeout: 10_000 });
    expect(await row.getByTestId('kiln-badge').count()).toBe(1);
    await row.click();
    await page.getByTestId('kiln-panel').count();
    await page.locator('[data-agent="main"]').first().click();
    await page.getByTestId('kiln-panel').waitFor({ timeout: 5000 });
    expect(await page.getByTestId('kiln-panel').textContent()).toContain('read-only');
    await shot('orphan');
    await page.keyboard.press('Escape');
  });

  it("finds the local model's answers in History and opens the session that handed them off", async () => {
    await page.getByTestId('nav-history').click();
    await page.getByTestId('history-search').fill('five cases');
    const hit = page.locator('[data-testid="history-hit"]', { hasText: 'Kiln (local model)' }).first();
    await hit.waitFor({ timeout: 10_000 });
    expect(await hit.getAttribute('data-session')).toBe(SID);
    await hit.click();
    await page.locator('[data-agent="kiln-done1"]').first().waitFor({ timeout: 8000 });
  });

  it('shows Kiln on the Local models page', async () => {
    await page.getByTestId('nav-local').click();
    const row = page.getByTestId('kiln-status');
    await row.waitFor({ timeout: 8000 });
    expect(await row.textContent()).toContain('profile ollama');
    expect(await page.getByTestId('kiln-runs').textContent()).toContain('3 hand-offs');
    await shot('local', '[data-testid="local-page"]');
    await page.getByTestId('kiln-open-last').click();
    await page.locator('[data-agent="kiln-live1"]').first().waitFor({ timeout: 8000 });
  });
});
