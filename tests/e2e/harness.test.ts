// Kiln's agent harness end to end: a lead Claude session hands three tasks to the local qwen workers through
// mcp__harness__delegate_task, and the harness's SQLite database (a fake harness.db with the real schema) holds the workers:
// one finished, one working while the test appends rows, one that ran a sub-agent. Plus a local Agent conversation of the Kiln
// app. Every worker, the sub-agent and the Agent session must show on the local (orange) model family, under the right parent.
// Screenshots -> tests/e2e/artifacts/harness-*.png. Windows stay off-screen (vitest.e2e.config.ts). Run `npx electron-vite build` first.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { showFinishedAgents } from '../fixtures/graphPrefs';
import { FakeHarness, SYSTEM, asst, delegateResult, subTrace, toolMsg, userMsg } from '../fixtures/harness';

const ROOT = path.resolve(__dirname, '../..');
const ART = path.join(ROOT, 'tests/e2e/artifacts');
const PORT = Number(process.env.E2E_PORT ?? 48480) + 8;
const SID = '88888888-8888-4888-8888-888888888888';
const CWD = '/Users/demo/code/shop';
const PROJECT = '-Users-demo-code-shop';
const MIN = 60_000;
const T1 = 'task_a1a1a1a1a1a1';
const T2 = 'task_b2b2b2b2b2b2';
const T3 = 'task_c3c3c3c3c3c3';
const CONV = 'conv_d4d4d4d4d4d4';
const SUB_MSG = 'msg_sub000000001';
const LIVE_SUB_MSG = 'msg_sub000000002';
const TASKS = [
  { id: T1, title: 'Write cart tests', brief: 'Write unit tests for src/checkout/cart.ts. Verify with npm test.' },
  { id: T2, title: 'Document tax.ts', brief: 'Add JSDoc to every export in src/checkout/tax.ts.' },
  { id: T3, title: 'Rename calcTotal', brief: 'Rename calcTotal to computeTotal across src/checkout.' },
];

describe('Kiln agent harness workers', () => {
  let home: string;
  let userData: string;
  let h: FakeHarness;
  let app: ElectronApplication;
  let page: Page;
  let now: number;
  const at = (minAgo: number) => new Date(now - minAgo * MIN).toISOString();
  const ms = (minAgo: number) => Math.round(now - minAgo * MIN);
  let n = 0;
  const line = (minAgo: number, o: object) =>
    JSON.stringify({ sessionId: SID, cwd: CWD, version: '2.1.300', entrypoint: 'cli', gitBranch: 'main', timestamp: at(minAgo), isSidechain: false, ...o });
  const asstLine = (minAgo: number, block: unknown) =>
    line(minAgo, {
      type: 'assistant',
      message: {
        id: `m_${++n}`,
        model: 'claude-opus-5-5',
        role: 'assistant',
        content: [block],
        stop_reason: null,
        usage: { input_tokens: 3000, output_tokens: 90 },
      },
    });
  const result = (minAgo: number, id: string, text: string) =>
    line(minAgo, {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }], is_error: false }] },
    });
  const card = (agentId: string) => page.locator(`[data-agent="${agentId}"]`).first();
  const parentOf = async (agentId: string) => {
    await card(agentId).click();
    const p = page.getByTestId('drawer-parent');
    await p.waitFor({ timeout: 5000 });
    const t = (await p.textContent()) ?? '';
    await page.keyboard.press('Escape');
    return t;
  };
  const isLocal = async (agentId: string) => /\bfam-local\b/.test((await card(agentId).getAttribute('class')) ?? '');

  beforeAll(async () => {
    fs.mkdirSync(ART, { recursive: true });
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-hx-home-'));
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-hx-ud-'));
    now = Date.now();
    const pdir = path.join(home, 'projects', PROJECT);
    fs.mkdirSync(pdir, { recursive: true });

    // the lead: three delegate_task calls (Claude Code runs MCP calls one at a time), each answered with its taskId
    const lines = [line(20, { type: 'user', message: { role: 'user', content: 'Clean up checkout; hand the routine parts to the local workers.' } })];
    TASKS.forEach((t, i) => {
      const id = `toolu_H${i + 1}`;
      lines.push(
        asstLine(15 - i, {
          type: 'tool_use',
          id,
          name: 'mcp__harness__delegate_task',
          input: { title: t.title, brief: t.brief, acceptance: 'npm test passes', tier: 'local' },
        }),
      );
      lines.push(result(14.9 - i, id, delegateResult(t.id)));
    });
    lines.push(asstLine(0.2, { type: 'tool_use', id: 'toolu_W', name: 'mcp__harness__task_result', input: { taskId: T2, wait: true } }));
    fs.writeFileSync(path.join(pdir, `${SID}.jsonl`), lines.join('\n') + '\n');

    h = new FakeHarness(path.join(userData, 'kiln', 'harness.db'));
    h.project('prj_shop', CWD, ms(60));
    const models = [
      { provider: 'openai-compat', model: 'local/qwen3.8-27b-q6' },
      { provider: 'ollama', model: 'qwen3.8:27b' },
      { provider: 'openai-compat', model: 'unsloth/Qwen3.8-27B-GGUF' },
    ];
    TASKS.forEach((t, i) => {
      h.task({ id: t.id, project: 'prj_shop', title: t.title, brief: t.brief, state: 'implementing', ts: ms(14.95 - i), model: models[i] });
      h.message({ task: t.id }, SYSTEM, ms(14.94 - i));
      h.message({ task: t.id }, userMsg(t.brief), ms(14.94 - i));
    });
    // T1: done
    h.message({ task: T1 }, asst('Reading cart.ts.', [['c1', 'read_file', { path: 'src/checkout/cart.ts' }]]), ms(14.5));
    h.usage({ task: T1 }, { in: 9000, out: 150, ts: ms(14.5), model: models[0].model });
    h.message({ task: T1 }, toolMsg('c1', 'read_file', 'export function cartTotal() {}'), ms(14.4));
    h.message({ task: T1 }, asst('', [['c2', 'write_file', { path: 'tests/cart.test.ts', content: 'test()' }]]), ms(14));
    h.message({ task: T1 }, toolMsg('c2', 'write_file', 'Wrote tests/cart.test.ts'), ms(13.9));
    h.message({ task: T1 }, asst('', [['c3', 'run_command', { command: 'npm test' }]]), ms(13.5));
    h.message({ task: T1 }, toolMsg('c3', 'run_command', 'exit 0'), ms(12));
    h.message({ task: T1 }, asst('', [['c4', 'finish', { summary: 'Added tests/cart.test.ts.' }]]), ms(11.9));
    h.message({ task: T1 }, toolMsg('c4', 'finish', 'Recorded.'), ms(11.9));
    h.usage({ task: T1 }, { in: 12_000, out: 400, ts: ms(11.9), model: models[0].model });
    h.setTask(T1, { state: 'accepted', summary: 'Added tests/cart.test.ts.' }, ms(11));
    // T2: working (rows appended below while the app is open)
    h.message({ task: T2 }, asst('Reading tax.ts.', [['c1', 'read_file', { path: 'src/checkout/tax.ts' }]]), ms(10));
    h.usage({ task: T2 }, { in: 8000, out: 120, ts: ms(10), model: models[1].model, provider: 'ollama' });
    h.message({ task: T2 }, toolMsg('c1', 'read_file', 'export const tax = 0.2'), ms(9.9));
    h.message({ task: T2 }, asst('', [['c2', 'edit_file', { path: 'src/checkout/tax.ts', old_string: 'a', new_string: 'b' }]]), ms(0.5));
    // T3: ran an explore sub-agent, then went on
    h.message(
      { task: T3 },
      asst('', [['k1', 'task', { description: 'Find calcTotal callers', prompt: 'List every caller of calcTotal.', subagent_type: 'explore' }]]),
      ms(12),
      SUB_MSG,
    );
    h.message(
      { task: T3 },
      toolMsg('k1', 'task', 'Callers: cart.ts, summary.ts.\n\n[explore sub-agent: 3 model calls, 3 tool calls, 18k tokens in / 900 out, 40 s]', {
        subagent: subTrace(
          [
            ['grep', 'grep "calcTotal"', true],
            ['read_file', 'read_file src/checkout/cart.ts', true],
            ['read_file', 'read_file src/checkout/summary.ts', true],
          ],
          { description: 'Find calcTotal callers', durationMs: 40_000 },
        ),
      }),
      ms(11.3),
    );
    h.message({ task: T3 }, asst('Renaming.', [['c5', 'grep', { pattern: 'calcTotal' }]]), ms(11.2));
    h.usage({ task: T3 }, { in: 10_000, out: 300, ts: ms(11.2), model: models[2].model });
    h.message({ task: T3 }, toolMsg('c5', 'grep', 'src/checkout/cart.ts:3'), ms(11.1));
    h.setTask(T3, { state: 'review', summary: 'Renamed in 2 files.' }, ms(10.5));
    // a local Agent conversation in the Kiln app
    h.conversation({
      id: CONV,
      project: 'prj_shop',
      title: 'Explain the checkout flow',
      ts: ms(5),
      status: 'running',
      model: { provider: 'ollama', model: 'qwen3.8:27b' },
    });
    h.message({ conversation: CONV }, SYSTEM, ms(4.9));
    h.message({ conversation: CONV }, userMsg('Explain the checkout flow.'), ms(4.9));
    h.message({ conversation: CONV }, asst('Looking around.', [['g1', 'glob', { pattern: 'src/checkout/**/*.ts' }]]), ms(4.8));
    h.usage({ conversation: CONV }, { in: 5000, out: 60, ts: ms(4.8), model: 'qwen3.8:27b', provider: 'ollama' });
    h.message({ conversation: CONV }, toolMsg('g1', 'glob', 'src/checkout/cart.ts'), ms(4.7));
    h.todos('conversation', CONV, [{ content: 'Read cart.ts', status: 'in_progress' }], ms(4.6));

    app = await electron.launch({
      args: [ROOT],
      cwd: ROOT,
      env: {
        ...process.env,
        CLAUDE_VIS_HOME: home,
        CLAUDE_VIS_USER_DATA: userData,
        CLAUDE_VIS_PORT: String(PORT),
        CLAUDE_VIS_HARNESS_DB: h.file,
        CLAUDE_VIS_KILN_EVENTS: path.join(userData, 'no-kiln-events.jsonl'),
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
    await card(`kh-${T2}`).waitFor({ timeout: 20_000 });
  });

  afterAll(async () => {
    await app?.close();
    h?.close();
    for (const d of [home, userData]) if (d) fs.rmSync(d, { recursive: true, force: true });
  });

  it('shows every worker under the lead, on the local model family', async () => {
    for (const t of TASKS) {
      await card(`kh-${t.id}`).waitFor({ timeout: 10_000 });
      expect(await card(`kh-${t.id}`).textContent()).toContain(t.title);
      expect(await isLocal(`kh-${t.id}`), t.id).toBe(true);
      expect(await parentOf(`kh-${t.id}`)).toMatch(/main/i);
    }
    // the finished worker says so
    await expect.poll(async () => (await card(`kh-${T1}`).getAttribute('class')) ?? '', { timeout: 10_000 }).toMatch(/\bdone\b/);
    // none of the claimed tasks is listed as a session of its own
    expect(await page.locator('.session-row[data-session^="kh-task_"]').count()).toBe(0);
  });

  it("shows a worker's sub-agent under that worker", async () => {
    const sub = `kh-${T3}-${SUB_MSG}-0`;
    await card(sub).waitFor({ timeout: 10_000 });
    expect(await card(sub).textContent()).toContain('Find calcTotal callers');
    expect(await isLocal(sub)).toBe(true);
    expect(await parentOf(sub)).toContain('Kiln worker');
    await page.mouse.move(5, 500);
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(ART, 'harness-workers.png') });
  });

  it('updates a working worker live, sub-agent included', async () => {
    const sub = `kh-${T2}-${LIVE_SUB_MSG}-0`;
    expect(await card(sub).count()).toBe(0);
    h.message({ task: T2 }, toolMsg('c2', 'edit_file', 'Edited src/checkout/tax.ts'), Date.now());
    h.message(
      { task: T2 },
      asst('', [['k2', 'task', { description: 'Check the docs build', prompt: 'Run the docs build.', subagent_type: 'general' }]]),
      Date.now(),
      LIVE_SUB_MSG,
    );
    await card(sub).waitFor({ timeout: 10_000 });
    expect(await card(sub).textContent()).toContain('Check the docs build');
    expect(await parentOf(sub)).toContain('Kiln worker');
    h.message(
      { task: T2 },
      toolMsg('k2', 'task', 'Docs build passes.', {
        subagent: subTrace([['run_command', 'run_command npm run docs', true]], { type: 'general', description: 'Check the docs build' }),
      }),
      Date.now(),
    );
    h.setTask(T2, { state: 'accepted', summary: 'Documented 6 exports.' }, Date.now());
    await expect.poll(async () => (await card(`kh-${T2}`).getAttribute('class')) ?? '', { timeout: 10_000 }).toMatch(/\bdone\b/);
    await expect.poll(async () => (await card(sub).getAttribute('class')) ?? '', { timeout: 10_000 }).toMatch(/\bdone\b/);
  });

  it('folds finished local workers and their sub-agents away like finished Claude subagents', async () => {
    const liveSub = `kh-${T2}-${LIVE_SUB_MSG}-0`;
    const finished = [`kh-${T1}`, `kh-${T2}`, liveSub];
    for (const id of finished) await expect.poll(async () => (await card(id).getAttribute('class')) ?? '', { timeout: 10_000 }).toMatch(/\bdone\b/);
    // hide finished: every finished local agent goes into its parent's "N finished" chip
    await page.getByRole('button', { name: 'hide finished' }).click();
    for (const id of finished) await expect.poll(() => card(id).count(), { timeout: 5_000 }).toBe(0);
    expect(await page.locator('.node.collapsed').count()).toBeGreaterThan(0);
    // and they stay folded: nothing revives a finished worker
    await page.waitForTimeout(1_500);
    for (const id of finished) expect(await card(id).count(), id).toBe(0);
    await page.getByRole('button', { name: 'show finished' }).click();
    for (const id of finished) await card(id).waitFor({ timeout: 5_000 });
  });

  it('in the all-sessions overview, finished workers fold away shortly after they finish, within one long prompt', async () => {
    await page.getByRole('button', { name: /all sessions/ }).click();
    const inPanel = (id: string) => page.locator(`[data-testid="ov-body"] [data-agent="${id}"]`);
    await page.locator('[data-testid="ov-body"]').first().waitFor({ timeout: 10_000 });
    // T1 and T3 finished minutes ago: already folded into the chip, though the lead's prompt is older still
    await expect.poll(() => inPanel(`kh-${T1}`).count(), { timeout: 15_000 }).toBe(0);
    await expect.poll(() => inPanel(`kh-${T3}`).count(), { timeout: 15_000 }).toBe(0);
    expect(await page.locator('[data-testid="ov-body"] .node.collapsed').count()).toBeGreaterThan(0);
    // T2 finished moments ago: it folds within the linger (30 s, checked on a 10 s step)
    await expect.poll(() => inPanel(`kh-${T2}`).count(), { timeout: 50_000, interval: 1_000 }).toBe(0);
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(ART, 'harness-overview-folded.png') });
    await page.getByRole('button', { name: /one session/ }).click();
  });

  it('lists the local Agent conversation as a Kiln session of its own', async () => {
    const row = page.locator(`.session-row[data-session="kh-${CONV}"]`).first();
    await row.waitFor({ timeout: 10_000 });
    expect(await row.getByTestId('harness-badge').count()).toBe(1);
    await row.click();
    // the selection switches from the lead's view to the conversation's: its main agent runs on qwen
    await expect.poll(() => isLocal('main'), { timeout: 10_000 }).toBe(true);
    expect(await card('main').textContent()).toMatch(/qwen/i);
    await page.mouse.move(5, 500);
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(ART, 'harness-agent-session.png') });
  });
});
