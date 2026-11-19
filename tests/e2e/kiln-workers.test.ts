// Kiln workers end to end, the way a real fan-out looks on a Mac: Claude hands three tasks to the local model in one turn
// (Claude Code runs the MCP calls one after another, so the second and third runs start minutes after their calls), a
// Claude subagent hands off one of its own, and more runs start while the app is open. Every qwen worker must show up as
// its own Kiln agent under the agent that handed it off. Screenshot -> tests/e2e/artifacts/kiln-workers.png.
// Windows stay off-screen (vitest.e2e.config.ts). Run `npx electron-vite build` first.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { showFinishedAgents } from '../fixtures/graphPrefs';
import { KILN_STATUS_LINE, kilnRunLines } from '../fixtures/kiln';

const ROOT = path.resolve(__dirname, '../..');
const ART = path.join(ROOT, 'tests/e2e/artifacts');
const PORT = Number(process.env.E2E_PORT ?? 48480) + 7;
const SID = '99999999-9999-4999-8999-999999999999';
const CWD = '/Users/dev/code/shop';
const PROJECT = '-Users-dev-code-shop';
const MIN = 60_000;
const SUB = 'a1b2c3d4e5f60718';
const SUB_DESC = 'Audit the checkout module';
// long briefs: the transcript keeps the first 300 characters, Kiln's log up to 4000 (with "…" when it clips)
const brief = (goal: string) =>
  `${goal}\n\nFiles: src/checkout/*.ts. Constraints: keep the public API. ${'Context line. '.repeat(40)}\nVerify with npm test. Done = tests pass.`;
const B1 = brief('Write unit tests for src/checkout/cart.ts.');
const B2 = brief('Add JSDoc to every export in src/checkout/tax.ts.');
const B3 = brief('Rename calcTotal to computeTotal across src/checkout.');
const B4 = brief('Summarize src/checkout/payment.ts for the audit.');
const B5 = brief('Convert src/checkout/legacy.js to TypeScript.');

// Kiln's log clips long fields with "…" (events.py _trunc): the runs' briefs are cut where the transcript's are not
const logged = (b: string) => b.slice(0, 380) + '…';
const toolUse = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input });
const delegate = (id: string, task: string, extra: object = {}) => toolUse(id, 'mcp__kiln__delegate_task', { task, cwd: CWD, effort: 'medium', ...extra });

describe('Kiln workers from a parallel hand-off', () => {
  let home: string;
  let userData: string;
  let events: string;
  let mainFile: string;
  let app: ElectronApplication;
  let page: Page;
  let now: number;
  const at = (minAgo: number) => new Date(now - minAgo * MIN).toISOString();
  const sec = (minAgo: number) => (now - minAgo * MIN) / 1000;
  let n = 0;
  const line = (minAgo: number, o: object, sub = false) =>
    JSON.stringify({
      sessionId: SID,
      cwd: CWD,
      version: '2.1.300',
      entrypoint: 'claude-desktop',
      gitBranch: 'main',
      timestamp: at(minAgo),
      ...(sub ? { isSidechain: true, agentId: SUB } : { isSidechain: false }),
      ...o,
    });
  const asst = (minAgo: number, block: unknown, sub = false, msgId = `m_${++n}`) =>
    line(
      minAgo,
      {
        type: 'assistant',
        message: {
          id: msgId,
          model: 'claude-opus-5-5',
          role: 'assistant',
          content: [block],
          stop_reason: null,
          usage: { input_tokens: 3000, output_tokens: 90 },
        },
      },
      sub,
    );
  const result = (minAgo: number, id: string, text: string, sub = false) =>
    line(minAgo, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: false }] } }, sub);
  const kilnLog = (lines: string[]) => fs.appendFileSync(events, lines.join('\n') + '\n');
  const card = (runId: string) => page.locator(`[data-agent="kiln-${runId}"]`).first();
  const parentOf = async (runId: string) => {
    await card(runId).click();
    const p = page.getByTestId('drawer-parent');
    await p.waitFor({ timeout: 5000 });
    const t = (await p.textContent()) ?? '';
    await page.keyboard.press('Escape');
    return t;
  };

  beforeAll(async () => {
    fs.mkdirSync(ART, { recursive: true });
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-kilnw-home-'));
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-kilnw-ud-'));
    now = Date.now();
    const pdir = path.join(home, 'projects', PROJECT);
    const subDir = path.join(pdir, SID, 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    mainFile = path.join(pdir, `${SID}.jsonl`);

    // main: spawns a subagent, then hands three tasks to Kiln in one assistant message (one line per tool_use, same message id)
    fs.writeFileSync(
      mainFile,
      [
        line(20, { type: 'user', message: { role: 'user', content: 'Audit checkout and farm the routine parts out to the local model.' } }),
        asst(
          19.5,
          toolUse('toolu_AG', 'Agent', {
            description: SUB_DESC,
            subagent_type: 'general-purpose',
            prompt: 'Audit src/checkout and delegate a summary of payment.ts to Kiln.',
          }),
        ),
        asst(15, delegate('toolu_D1', B1), false, 'm_par'),
        asst(15, delegate('toolu_D2', B2), false, 'm_par'),
        asst(15, delegate('toolu_D3', B3), false, 'm_par'),
        // only the first call has returned; the second is running, the third still waits its turn
        result(11, 'toolu_D1', 'status: OK'),
      ].join('\n') + '\n',
    );
    fs.writeFileSync(
      path.join(subDir, `agent-${SUB}.meta.json`),
      JSON.stringify({ agentType: 'general-purpose', description: SUB_DESC, toolUseId: 'toolu_AG' }),
    );
    fs.writeFileSync(
      path.join(subDir, `agent-${SUB}.jsonl`),
      [
        line(19.4, { type: 'user', message: { role: 'user', content: 'Audit src/checkout and delegate a summary of payment.ts to Kiln.' } }, true),
        asst(18, delegate('toolu_S1', B4, { readonly: true }), true),
      ].join('\n') + '\n',
    );

    events = path.join(userData, 'kiln-events.jsonl');
    fs.writeFileSync(events, KILN_STATUS_LINE(sec(21)) + '\n');
    kilnLog(
      kilnRunLines({
        id: 's1',
        task: logged(B4),
        cwd: CWD,
        start: sec(17.9),
        readonly: true,
        steps: [['read_file', 'src/checkout/payment.ts', true]],
        finish: { ok: true, answer: 'payment.ts wraps the Stripe client and retries twice.', seconds: 60 },
      }),
    );
    kilnLog(
      kilnRunLines({
        id: 'd1',
        task: logged(B1),
        cwd: CWD,
        start: sec(14.9),
        steps: [
          ['read_file', 'src/checkout/cart.ts', true],
          ['write_file', 'tests/cart.test.ts', true],
          ['bash', 'npm test', true],
        ],
        finish: { ok: true, answer: 'Added tests/cart.test.ts.', files: ['tests/cart.test.ts'], seconds: 230 },
      }),
    );
    // d2 started only when d1's call returned, four minutes after its own call; still working (this process is its pid)
    kilnLog(kilnRunLines({ id: 'd2', task: logged(B2), cwd: CWD, pid: process.pid, start: sec(10.9), steps: [['read_file', 'src/checkout/tax.ts', true]] }));

    app = await electron.launch({
      args: [ROOT],
      cwd: ROOT,
      env: {
        ...process.env,
        CLAUDE_VIS_HOME: home,
        CLAUDE_VIS_USER_DATA: userData,
        CLAUDE_VIS_PORT: String(PORT),
        CLAUDE_VIS_KILN_EVENTS: events,
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
    await card('d2').waitFor({ timeout: 20_000 });
  });

  afterAll(async () => {
    await app?.close();
    for (const d of [home, userData]) if (d) fs.rmSync(d, { recursive: true, force: true });
  });

  it('shows every run of a parallel hand-off, including one that started minutes after its call', async () => {
    await card('d1').waitFor({ timeout: 10_000 });
    expect(await card('d1').textContent()).toContain('Write unit tests');
    expect(await card('d2').textContent()).toContain('Add JSDoc');
    expect(await parentOf('d1')).toMatch(/main/i);
    expect(await parentOf('d2')).toMatch(/main/i);
  });

  it('shows a run a Claude subagent handed off under that subagent', async () => {
    await card('s1').waitFor({ timeout: 10_000 });
    expect(await card('s1').textContent()).toContain('Summarize');
    // the drawer names a subagent parent by its type
    const parent = await parentOf('s1');
    expect(parent).toContain('general-purpose');
    expect(parent).not.toMatch(/main/i);
  });

  it('adds a queued run when it finally starts, while the app is open', async () => {
    expect(await card('d3').count()).toBe(0);
    // d2 finishes and returns; d3, called 15 minutes ago, starts now
    kilnLog(
      kilnRunLines({
        id: 'd2',
        task: logged(B2),
        cwd: CWD,
        pid: process.pid,
        start: sec(10.9),
        finish: { ok: true, answer: 'Documented 6 exports.', seconds: 600 },
      }).slice(-1),
    );
    fs.appendFileSync(mainFile, result(0.1, 'toolu_D2', 'status: OK') + '\n');
    kilnLog(kilnRunLines({ id: 'd3', task: logged(B3), cwd: CWD, pid: process.pid, start: sec(0), steps: [['grep', 'calcTotal', true]] }));
    await card('d3').waitFor({ timeout: 10_000 });
    expect(await card('d3').textContent()).toContain('Rename calcTotal');
    expect(await parentOf('d3')).toMatch(/main/i);
  });

  it('adds a hand-off made while the app is open', async () => {
    fs.appendFileSync(mainFile, asst(0, delegate('toolu_D4', B5)) + '\n');
    await new Promise((r) => setTimeout(r, 800));
    kilnLog(kilnRunLines({ id: 'd4', task: B5, cwd: CWD, pid: process.pid, start: Date.now() / 1000, steps: [['read_file', 'src/checkout/legacy.js', true]] }));
    await card('d4').waitFor({ timeout: 10_000 });
    expect(await card('d4').textContent()).toContain('Convert src/checkout/legacy.js');
    // every worker is still there, and none of them was listed as a session of its own
    for (const id of ['s1', 'd1', 'd2', 'd3', 'd4']) expect(await card(id).count()).toBe(1);
    expect(await page.locator('.session-row[data-session^="kiln-"]').count()).toBe(0);
    await page.mouse.move(5, 500);
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(ART, 'kiln-workers.png') });
  });
});
