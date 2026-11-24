// Google Antigravity (agy, Gemini) end to end: Kiln runs agy as its lead, which hands two tasks to the local qwen workers through
// Kiln's MCP bridge (delegate_task). The agy transcript is built from Kiln's own agy fixture format (tests/fixtures/agy.ts), the
// harness.db is a fake with the real schema, Kiln's lead_sessions row naming the folder. The session must show as an Antigravity
// session with a Gemini-coloured main agent, both workers under it in orange, nothing unclaimed, live updates, and the overview.
// Screenshots -> tests/e2e/artifacts/agy-*.png. Windows stay off-screen (vitest.e2e.config.ts). Run `npx electron-vite build` first.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { showFinishedAgents } from '../fixtures/graphPrefs';
import { AGY_DELEGATE, agyArgs, agyResponse, agyResult, agySteps, agyUser, writeAgyTranscript } from '../fixtures/agy';
import { FakeHarness, QWEN, SYSTEM, asst, delegateResult, toolMsg, userMsg } from '../fixtures/harness';

const ROOT = path.resolve(__dirname, '../..');
const ART = path.join(ROOT, 'tests/e2e/artifacts');
const PORT = Number(process.env.E2E_PORT ?? 48480) + 9;
const CONV = '3c1d9e2a-7b4f-4a8e-9d6c-5e4f3a2b1c0d';
const SID = `agy-${CONV}`;
const CWD = '/Users/demo/code/shop';
const MIN = 60_000;
const T1 = 'task_a1a1a1a1a1a1';
const T2 = 'task_b2b2b2b2b2b2';
const TASKS = [
  { id: T1, title: 'Write cart tests', brief: 'Write unit tests for src/checkout/cart.ts. Verify with npm test.' },
  { id: T2, title: 'Document tax.ts', brief: 'Add JSDoc to every export in src/checkout/tax.ts.' },
];

describe('Google Antigravity lead with Kiln workers', () => {
  let home: string;
  let userData: string;
  let agyDir: string;
  let file: string;
  let h: FakeHarness;
  let app: ElectronApplication;
  let page: Page;
  let now: number;
  let step = 0;
  const ms = (minAgo: number) => Math.round(now - minAgo * MIN);
  const card = (agentId: string) => page.locator(`[data-agent="${agentId}"]`).first();
  const fam = async (agentId: string) => /\bfam-(\w+)\b/.exec((await card(agentId).getAttribute('class')) ?? '')?.[1] ?? '';
  const parentOf = async (agentId: string) => {
    await card(agentId).click();
    const p = page.getByTestId('drawer-parent');
    await p.waitFor({ timeout: 5000 });
    const t = (await p.textContent()) ?? '';
    await page.keyboard.press('Escape');
    return t;
  };

  beforeAll(async () => {
    fs.mkdirSync(ART, { recursive: true });
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-agy-home-'));
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-agy-ud-'));
    agyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-agy-data-'));
    fs.mkdirSync(path.join(home, 'projects'), { recursive: true });
    now = Date.now();

    // the lead: a plan, then two delegate_task calls in one response (agy answers them in order), each with its taskId
    const lines = [
      agyUser(step++, ms(12), 'Clean up checkout; hand the routine parts to the local workers.'),
      agyResponse(step++, ms(11), {
        content: 'Splitting the work: tests and docs go to the local workers.',
        calls: [
          [
            'update_steps',
            agySteps([
              ['Delegate the cart tests', 'in_progress'],
              ['Delegate the tax.ts docs', 'pending'],
              ['Review both', 'pending'],
            ]),
          ],
          ...TASKS.map(
            (t) =>
              [AGY_DELEGATE, agyArgs({ title: t.title, brief: t.brief, acceptance: 'npm test passes', tier: 'local' })] as [string, Record<string, unknown>],
          ),
        ],
        in: 9700,
        cacheRead: 0,
        out: 420,
      }),
      agyResult(step++, ms(10.9), 'OK'),
      agyResult(step++, ms(10.8), delegateResult(T1)),
      agyResult(step++, ms(10.7), delegateResult(T2)),
      agyResponse(step++, ms(10.6), {
        calls: [
          [
            'update_steps',
            agySteps([
              ['Delegate the cart tests', 'done'],
              ['Delegate the tax.ts docs', 'done'],
              ['Review both', 'in_progress'],
            ]),
          ],
          [AGY_DELEGATE.replace('delegate_task', 'task_result'), agyArgs({ taskId: T2, wait: true })],
        ],
      }),
      agyResult(step++, ms(10.5), 'OK'),
    ];
    file = writeAgyTranscript(agyDir, CONV, lines);

    h = new FakeHarness(path.join(userData, 'kiln', 'harness.db'));
    h.project('prj_shop', CWD, ms(60));
    h.leadSession({ kind: 'agy', nativeId: CONV, project: 'prj_shop', ts: ms(12.5), transcript: file });
    TASKS.forEach((t, i) => {
      h.task({ id: t.id, project: 'prj_shop', title: t.title, brief: t.brief, state: 'implementing', ts: ms(10.85 - i * 0.1), model: QWEN });
      h.message({ task: t.id }, SYSTEM, ms(10.84 - i * 0.1));
      h.message({ task: t.id }, userMsg(t.brief), ms(10.84 - i * 0.1));
    });
    // T1: done
    h.message({ task: T1 }, asst('Reading cart.ts.', [['c1', 'read_file', { path: 'src/checkout/cart.ts' }]]), ms(10));
    h.usage({ task: T1 }, { in: 9000, out: 150, ts: ms(10) });
    h.message({ task: T1 }, toolMsg('c1', 'read_file', 'export function cartTotal() {}'), ms(9.9));
    h.message({ task: T1 }, asst('', [['c2', 'run_command', { command: 'npm test' }]]), ms(9));
    h.message({ task: T1 }, toolMsg('c2', 'run_command', 'exit 0'), ms(8));
    h.setTask(T1, { state: 'accepted', summary: 'Added tests/cart.test.ts.' }, ms(7.5));
    // T2: working
    h.message({ task: T2 }, asst('Reading tax.ts.', [['c1', 'read_file', { path: 'src/checkout/tax.ts' }]]), ms(9));
    h.usage({ task: T2 }, { in: 8000, out: 120, ts: ms(9) });
    h.message({ task: T2 }, toolMsg('c1', 'read_file', 'export const tax = 0.2'), ms(8.9));
    h.message({ task: T2 }, asst('', [['c2', 'edit_file', { path: 'src/checkout/tax.ts', old_string: 'a', new_string: 'b' }]]), ms(0.3));

    app = await electron.launch({
      args: [ROOT],
      cwd: ROOT,
      env: {
        ...process.env,
        CLAUDE_VIS_HOME: home,
        CLAUDE_VIS_USER_DATA: userData,
        CLAUDE_VIS_PORT: String(PORT),
        CLAUDE_VIS_HARNESS_DB: h.file,
        CLAUDE_VIS_AGY_DIR: agyDir,
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
    for (const d of [home, userData, agyDir]) if (d) fs.rmSync(d, { recursive: true, force: true });
  });

  it('lists the conversation as an Antigravity session in its project, and nothing unclaimed', async () => {
    const row = page.locator(`.session-row[data-session="${SID}"]`).first();
    expect(await row.getByTestId('agy-badge').count()).toBe(1);
    expect(await row.locator('.t').textContent()).toContain('Clean up checkout');
    expect(await row.locator('.proj').textContent()).toContain('shop');
    // the Claude desktop app cannot open it
    expect(await row.locator('.row-claude').count()).toBe(0);
    expect(await page.getByTestId('open-in-claude').count()).toBe(0);
    // the workers it handed off are under it, not rows of their own
    expect(await page.locator('.session-row[data-session^="kh-task_"]').count()).toBe(0);
  });

  it('shows the lead on Gemini, its plan, and both workers under it on the local model family', async () => {
    await expect.poll(() => fam('main'), { timeout: 10_000 }).toBe('gemini');
    expect(await card('main').textContent()).toMatch(/Gemini 4 Neon/);
    expect(await card('main').textContent()).not.toMatch(/Opus|Sonnet|Haiku|Fable/);
    for (const t of TASKS) {
      await card(`kh-${t.id}`).waitFor({ timeout: 10_000 });
      expect(await card(`kh-${t.id}`).textContent()).toContain(t.title);
      expect(await fam(`kh-${t.id}`), t.id).toBe('local');
      expect(await parentOf(`kh-${t.id}`)).toMatch(/main/i);
    }
    await expect.poll(async () => (await card(`kh-${T1}`).getAttribute('class')) ?? '', { timeout: 10_000 }).toMatch(/\bdone\b/);
    // the Gemini colour is its own: not Haiku's blue, not the local orange
    const colours = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      return ['--gemini', '--haiku', '--local', '--fable'].map((k) => cs.getPropertyValue(k).trim());
    });
    expect(colours[0]).toBeTruthy();
    expect(new Set(colours).size).toBe(4);
    // the legend names the family
    expect(await page.locator('.legend').textContent()).toMatch(/Gemini/);
    await page.mouse.move(5, 500);
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(ART, 'agy-session.png') });
  });

  it('updates live as agy writes steps and the workers work', async () => {
    fs.appendFileSync(
      file,
      [
        agyResult(step++, Date.now(), 'Task task_b2b2b2b2b2b2 needs review.'),
        agyResponse(step++, Date.now(), { calls: [['run_command', agyArgs({ CommandLine: 'npm test', toolSummary: 'Run the checks' })]] }),
      ].join('\n') + '\n',
    );
    await expect.poll(async () => (await card('main').textContent()) ?? '', { timeout: 10_000 }).toMatch(/npm test|Run the checks/);
    h.message({ task: T2 }, toolMsg('c2', 'edit_file', 'Edited src/checkout/tax.ts'), Date.now());
    h.setTask(T2, { state: 'accepted', summary: 'Documented 6 exports.' }, Date.now());
    await expect.poll(async () => (await card(`kh-${T2}`).getAttribute('class')) ?? '', { timeout: 10_000 }).toMatch(/\bdone\b/);
    fs.appendFileSync(
      file,
      [
        agyResult(step++, Date.now(), 'Command exited with code 0.\n\nCommand output:\n2 passing'),
        agyResponse(step++, Date.now(), { content: 'Both tasks are in.' }),
      ].join('\n') + '\n',
    );
    await expect.poll(async () => (await card('main').textContent()) ?? '', { timeout: 10_000 }).toMatch(/Both tasks are in|idle/);
  });

  it('shows in the all-sessions overview as Antigravity on Gemini, with no Claude button', async () => {
    await page.getByRole('button', { name: /all sessions/ }).click();
    const panel = page.locator(`section.ov-panel[data-session="${SID}"]`).first();
    await panel.waitFor({ timeout: 10_000 });
    expect(await panel.locator('.ov-sub').first().textContent()).toContain('Antigravity');
    expect(await panel.locator('.ov-stats').textContent()).toMatch(/Gemini 4 Neon/);
    expect(await panel.locator('.ov-claude').count()).toBe(0);
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(ART, 'agy-overview.png') });
    await page.getByRole('button', { name: /one session/ }).click();
  });
});
