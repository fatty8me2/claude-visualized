// Agent card motion, end to end on the fixture session: nothing animates on load or on a session switch; a new subagent springs in;
// finishing draws the check; a failure shakes; a permission request makes the main card breathe. Screenshots of each moment go to
// tests/e2e/artifacts/cards-*.png (animations are frozen mid-way for the "mid" shots). Run `npx electron-vite build` first.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, type CDPSession, type ElectronApplication, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOCAL_PROJECT, LOCAL_SID, PROJECT, SID, writeFixture, writeLocalFixture } from '../fixtures/build';

const ROOT = path.resolve(__dirname, '../..');
const ART = path.join(ROOT, 'tests/e2e/artifacts');
const PORT = Number(process.env.E2E_PORT ?? 47899);
const freshLine = (sid: string) => JSON.stringify({ type: 'system', subtype: 'turn_duration', sessionId: sid, timestamp: new Date().toISOString() }) + '\n';
const hook = (body: object) => fetch(`http://127.0.0.1:${PORT}/hook?src=claude-visualized`, { method: 'POST', body: JSON.stringify(body) });

const sideLine = (id: string, model: string, tool: string, input: object) =>
  JSON.stringify({
    type: 'assistant',
    isSidechain: true,
    agentId: id,
    sessionId: SID,
    timestamp: new Date().toISOString(),
    message: {
      id: `m_${id}`,
      model,
      content: [{ type: 'tool_use', id: `toolu_${id}`, name: tool, input }],
      usage: { input_tokens: 400, output_tokens: 12, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  }) + '\n';

describe('agent card motion (fixture data)', () => {
  let home: string;
  let userData: string;
  let sub: string;
  let wf: string;
  let app: ElectronApplication;
  let page: Page;
  let cdp: CDPSession;

  /** a 2x screenshot of an element (CDP clip with scale), so the details are readable */
  const shot = async (name: string, sel = '.graph-wrap') => {
    if (sel !== '.graph-wrap') await page.locator(sel).first().evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center' }));
    const box = (await page.locator(sel).first().boundingBox())!;
    const pad = sel === '.graph-wrap' ? 0 : 14;
    const clip = { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + pad * 2, height: box.height + pad * 2, scale: 2 };
    const r = await cdp.send('Page.captureScreenshot', { format: 'png', clip });
    fs.writeFileSync(path.join(ART, `fx-cards-${name}.png`), Buffer.from(r.data, 'base64'));
  };
  /** every element.animate() call on a card since `mark()`: which card, and which properties */
  const animated = () => page.evaluate(() => (window as unknown as { __anims: string[] }).__anims.slice());
  const mark = () => page.evaluate(() => ((window as unknown as { __anims: string[] }).__anims.length = 0));
  /** freeze animations started from now on at `ms` into the animation; null lets them run and releases the frozen ones */
  const freeze = (ms: number | null) =>
    page.evaluate((t) => {
      const w = window as unknown as { __freeze: number | null };
      w.__freeze = t;
      if (t === null) document.getAnimations().forEach((a) => a.playState === 'paused' && a.play());
    }, ms);
  const spawn = (id: string, desc: string, model: string, tool: string, input: object) => {
    fs.writeFileSync(path.join(sub, `agent-${id}.meta.json`), JSON.stringify({ agentType: 'general-purpose', description: desc, toolUseId: `toolu_n_${id}` }));
    fs.writeFileSync(path.join(sub, `agent-${id}.jsonl`), sideLine(id, model, tool, input));
  };

  beforeAll(async () => {
    fs.mkdirSync(ART, { recursive: true });
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-cards-home-'));
    writeFixture(home);
    fs.appendFileSync(path.join(home, 'projects', PROJECT, `${SID}.jsonl`), freshLine(SID));
    sub = path.join(home, 'projects', PROJECT, SID, 'subagents');
    wf = path.join(sub, 'workflows', 'wf_x');
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-cards-ud-'));
    app = await electron.launch({
      args: [ROOT],
      cwd: ROOT,
      env: {
        ...process.env,
        CLAUDE_VIS_HOME: home,
        CLAUDE_VIS_USER_DATA: userData,
        CLAUDE_VIS_PORT: String(PORT),
        CLAUDE_VIS_NO_EXTERNAL: '1',
        CLAUDE_VIS_NO_SYSTEM_INTEGRATION: '1',
        CLAUDE_VIS_NO_USAGE_API: '1',
        CLAUDE_VIS_SKIP_ONBOARDING: '1',
        CLAUDE_VIS_NO_UPDATES: '1',
        CLAUDE_VIS_DESKTOP_DIR: path.join(userData, 'no-desktop'),
      } as Record<string, string>,
    });
    page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1500, 1000)).catch(() => {});
    await page.setViewportSize({ width: 1440, height: 920 }).catch(() => {});
    // these tests are about the full cards' motion: keep the graph from switching to compact cards in a narrow panel
    await page.evaluate(() => localStorage.setItem('cvis.graph.v1', JSON.stringify({ zoom: 'fit', compact: 'off', hideFinished: false })));
    await page.reload();
    cdp = await page.context().newCDPSession(page);
    // record (and optionally freeze) every Web Animations call made on a card
    await page.evaluate(() => {
      const w = window as unknown as { __anims: string[]; __freeze: number | null };
      w.__anims = [];
      w.__freeze = null;
      const orig = Element.prototype.animate;
      Element.prototype.animate = function (this: Element, kf: Keyframe[] | PropertyIndexedKeyframes | null, opt?: number | KeyframeAnimationOptions) {
        const a = orig.call(this, kf, opt);
        const card = this.closest('[data-agent],[data-chip],[data-fx-for]') as HTMLElement | null;
        if (card) {
          const props = Array.isArray(kf) ? Object.keys(kf[0] ?? {}).filter((k) => k !== 'offset' && k !== 'easing') : Object.keys(kf ?? {});
          w.__anims.push(`${card.dataset.agent ?? card.dataset.chip ?? card.dataset.fxFor}:${props.join('+')}`);
          if (w.__freeze !== null) {
            a.pause();
            a.currentTime = w.__freeze;
          }
        }
        return a;
      };
    });
  });

  afterAll(async () => {
    await app?.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(userData, { recursive: true, force: true });
  });

  it('plays nothing when a session loads', async () => {
    await page.locator('[data-agent="a1"]').waitFor({ timeout: 20_000 });
    await page.waitForTimeout(800);
    expect(await animated()).toEqual([]);
    expect(await page.locator('[data-agent="a2"] .tick').count()).toBe(1);
    await shot('fixture');
  });

  it('lifts a hovered card and outlines the selected one', async () => {
    const a1 = page.locator('[data-agent="a1"]');
    const b = (await a1.boundingBox())!;
    await page.mouse.move(b.x + b.width * 0.5, b.y + b.height * 0.5);
    await page.mouse.move(b.x + b.width * 0.85, b.y + b.height * 0.2, { steps: 6 });
    await page.waitForTimeout(450);
    expect(await a1.evaluate((el) => getComputedStyle(el).translate)).toBe('0px -2px');
    // tilts toward the cursor (a few degrees at most) and the highlight follows it
    const tilt = await a1.evaluate((el) => ({ rx: el.style.getPropertyValue('--rx'), ry: el.style.getPropertyValue('--ry'), mx: el.style.getPropertyValue('--mx') }));
    expect(parseFloat(tilt.ry)).toBeGreaterThan(1);
    expect(Math.abs(parseFloat(tilt.rx))).toBeLessThanOrEqual(4);
    expect(parseFloat(tilt.mx)).toBeGreaterThan(70);
    await shot('hover');
    await shot('hover-card', '[data-agent="a1"]');
    await page.locator('[data-agent="a1"]').click();
    await page.getByTestId('drawer').waitFor();
    await page.waitForTimeout(450);
    expect(await page.locator('[data-agent="a1"] > .brackets').count()).toBe(1);
    await shot('selected');
    await shot('selected-card', '[data-agent="a1"]');
    await page.getByTestId('drawer').getByRole('button', { name: 'close' }).click();
    await page.mouse.move(5, 5);
  });

  it('a new subagent springs in from its parent, glowing in its model colour', async () => {
    await mark();
    await freeze(300);
    spawn('a10', 'review the retry module', 'claude-sonnet-5-5', 'Read', { file_path: 'C:\\demo\\app\\src\\retry.ts' });
    await page.locator('[data-agent="a10"]').waitFor({ timeout: 15_000 });
    await page.waitForTimeout(150);
    expect((await animated()).filter((a) => a.startsWith('a10:'))).toEqual(expect.arrayContaining(['a10:transform', 'a10:opacity']));
    expect(await page.locator('.fx-overlay[data-fx-for="a10"]').count()).toBe(1);
    await shot('spawn-mid');
    await shot('spawn-mid-card', '[data-agent="a10"]');
    await freeze(null);
    await page.waitForTimeout(1500);
    await shot('spawn-settled');
    await shot('running-card', '[data-agent="a10"]');
    expect(await page.locator('[data-agent="a10"]').evaluate((el) => getComputedStyle(el.querySelector('.orbit')!, '::before').animationName)).toBe('orbit-spin');
    await shot('running-main', '[data-agent="main"]');
  });

  it('finishing fills the bar, draws the check, then dims', async () => {
    await mark();
    await freeze(640);
    await hook({ session_id: SID, hook_event_name: 'SubagentStop', agent_id: 'a10' });
    await page.locator('[data-agent="a10"].done').waitFor({ timeout: 15_000 });
    await page.waitForTimeout(150);
    expect((await animated()).filter((a) => a.startsWith('a10:'))).toEqual(
      expect.arrayContaining(['a10:transform+opacity+transformOrigin', 'a10:strokeDasharray+strokeDashoffset']),
    );
    await shot('done-mid');
    await shot('done-mid-card', '[data-agent="a10"]');
    expect(await page.locator('.fx-overlay[data-fx-for="a10"] .fx-spark').count()).toBeGreaterThanOrEqual(8);
    await freeze(null);
    await page.waitForTimeout(2200);
    await shot('done-settled');
    expect(Number(await page.locator('[data-agent="a10"]').evaluate((el) => getComputedStyle(el).opacity))).toBeCloseTo(0.72, 1);
  });

  it('a failure shakes once, then stays red', async () => {
    await mark();
    await freeze(110);
    fs.appendFileSync(path.join(wf, 'journal.jsonl'), '{"type":"result","agentId":"w2","error":true}\n');
    await page.locator('[data-agent="w2"].error').waitFor({ timeout: 15_000 });
    await page.waitForTimeout(150);
    expect((await animated()).filter((a) => a.startsWith('w2:'))).toContain('w2:translate');
    expect(await page.locator('[data-agent="w2"] > .fx-errline').count()).toBe(1);
    await shot('error-mid', '[data-agent="w2"]');
    await freeze(null);
    await page.waitForTimeout(1500);
    await shot('error');
  });

  it('a permission request makes the main card breathe amber', async () => {
    await hook({ session_id: SID, hook_event_name: 'PermissionRequest', tool_name: 'Bash' });
    await page.locator('[data-agent="main"].waiting').waitFor({ timeout: 10_000 });
    expect(await page.locator('[data-agent="main"]').evaluate((el) => getComputedStyle(el.querySelector('.ring')!).animationName)).toBe('breathe');
    expect(await page.locator('[data-agent="main"] > .brackets').count()).toBe(1);
    await page.waitForTimeout(1300);
    await shot('waiting');
    await shot('waiting-main', '[data-agent="main"]');
  });

  it('finished cards fold into the chip and fan back out of it', async () => {
    await mark();
    await page.getByRole('button', { name: 'hide finished' }).click();
    await page.locator('.node.collapsed').first().waitFor();
    await page.waitForTimeout(700);
    expect((await animated()).some((a) => a.startsWith('collapsed:'))).toBe(true);
    await shot('collapsed');
    await mark();
    await freeze(240);
    await page.getByRole('button', { name: 'show finished' }).click();
    await page.locator('[data-agent="a2"]').waitFor();
    await page.waitForTimeout(150);
    expect((await animated()).filter((a) => a.startsWith('a2:'))).toContain('a2:transform');
    await shot('expand-mid');
    await freeze(null);
    await page.waitForTimeout(900);
  });

  it('plays nothing when switching sessions', async () => {
    writeLocalFixture(home);
    fs.appendFileSync(path.join(home, 'projects', LOCAL_PROJECT, `${LOCAL_SID}.jsonl`), freshLine(LOCAL_SID));
    await page.waitForTimeout(1500);
    await mark();
    await page.evaluate((id) => window.api.select(id), LOCAL_SID);
    await page.waitForFunction((id) => window.api.getState().then((s) => s?.id === id), LOCAL_SID, { timeout: 15_000, polling: 250 });
    await page.locator('[data-agent="l1"]').waitFor({ timeout: 15_000 });
    await page.waitForTimeout(600);
    expect(await animated()).toEqual([]);
    await shot('local-session');
    await page.evaluate((id) => window.api.select(id), SID);
    await page.locator('[data-agent="a10"]').waitFor({ timeout: 15_000 });
    await page.waitForTimeout(600);
    expect(await animated()).toEqual([]);
  });

  it('is instant under prefers-reduced-motion', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await mark();
    spawn('a11', 'plan the rollout', 'claude-opus-5-5', 'Glob', { pattern: 'docs/**' });
    await page.locator('[data-agent="a11"]').waitFor({ timeout: 15_000 });
    await hook({ session_id: SID, hook_event_name: 'SubagentStop', agent_id: 'a11' });
    await page.locator('[data-agent="a11"].done').waitFor({ timeout: 15_000 });
    await page.waitForTimeout(500);
    expect(await animated()).toEqual([]);
    expect(await page.locator('[data-agent="a11"]').evaluate((el) => getComputedStyle(el, '::before').animationName)).toBe('none');
    await page.emulateMedia({ reducedMotion: null });
  });
});
