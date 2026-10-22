// Connector effects, end to end on the fixture session: nothing plays on load; a new subagent draws an energy arc and bursts at its
// socket; running edges stream comet packets; finishing sends a surge up and a ripple; a failure glitches red; hovering lights the
// ancestry. Screenshots (2x) go to tests/e2e/artifacts/fx-edges-*.png, with animations frozen at chosen moments. Run `npx electron-vite build` first.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, type CDPSession, type ElectronApplication, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECT, SID, writeFixture } from '../fixtures/build';

const ROOT = path.resolve(__dirname, '../..');
const ART = path.join(ROOT, 'tests/e2e/artifacts');
const PORT = Number(process.env.E2E_PORT ?? 47951);
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

describe('connector effects (fixture data)', () => {
  let home: string;
  let userData: string;
  let sub: string;
  let wf: string;
  let app: ElectronApplication;
  let page: Page;
  let cdp: CDPSession;

  const shot = async (name: string) => {
    const box = (await page.locator('.graph-wrap').first().boundingBox())!;
    const clip = { x: box.x, y: box.y, width: box.width, height: box.height, scale: 2 };
    const r = await cdp.send('Page.captureScreenshot', { format: 'png', clip });
    fs.writeFileSync(path.join(ART, `fx-edges-${name}.png`), Buffer.from(r.data, 'base64'));
  };
  /** freeze every CSS animation in the edge layer at `ms` and stop SMIL */
  const freezeAt = (ms: number) =>
    page.evaluate((t) => {
      const svg = document.querySelector('.graph-wrap svg.gf') as SVGSVGElement;
      svg.pauseAnimations();
      for (const a of document.getAnimations()) {
        if ((a.effect as KeyframeEffect | null)?.target && svg.contains((a.effect as KeyframeEffect).target)) {
          a.pause();
          a.currentTime = t;
        }
      }
    }, ms);
  const thaw = () =>
    page.evaluate(() => {
      const svg = document.querySelector('.graph-wrap svg.gf') as SVGSVGElement;
      svg.unpauseAnimations();
      document.getAnimations().forEach((a) => a.playState === 'paused' && a.play());
    });
  const count = (sel: string) => page.locator(`.graph-wrap svg.gf ${sel}`).count();
  const spawn = (id: string, desc: string, model: string, tool: string, input: object) => {
    fs.writeFileSync(path.join(sub, `agent-${id}.meta.json`), JSON.stringify({ agentType: 'general-purpose', description: desc, toolUseId: `toolu_n_${id}` }));
    fs.writeFileSync(path.join(sub, `agent-${id}.jsonl`), sideLine(id, model, tool, input));
  };

  beforeAll(async () => {
    fs.mkdirSync(ART, { recursive: true });
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-edges-home-'));
    writeFixture(home);
    fs.appendFileSync(path.join(home, 'projects', PROJECT, `${SID}.jsonl`), freshLine(SID));
    sub = path.join(home, 'projects', PROJECT, SID, 'subagents');
    wf = path.join(sub, 'workflows', 'wf_x');
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-edges-ud-'));
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
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(2100, 1250));
    await page.evaluate(() => localStorage.setItem('cvis.graph.v1', JSON.stringify({ zoom: 'fit', compact: 'off', hideFinished: false })));
    await page.reload();
    cdp = await page.context().newCDPSession(page);
  });

  afterAll(async () => {
    await app?.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(userData, { recursive: true, force: true });
  });

  it('plays no one-off effect when a session loads, and lines are clearly visible', async () => {
    await page.locator('[data-agent="a1"]').waitFor({ timeout: 20_000 });
    await page.waitForTimeout(800);
    expect(await count('.gf-fxs, .gf-fxr')).toBe(0);
    expect(await count('.gf-base')).toBeGreaterThan(2);
    const w = await page.locator('.graph-wrap svg.gf .gf-base').first().evaluate((el) => getComputedStyle(el).strokeWidth);
    expect(parseFloat(w)).toBeGreaterThanOrEqual(2);
    await shot('1-idle');
  });

  it('a new subagent: energy arc with a spark, then a burst at its socket', async () => {
    spawn('a10', 'review the retry module', 'claude-sonnet-5-5', 'Read', { file_path: 'C:\\demo\\app\\src\\retry.ts' });
    await page.locator('.gf-fxs').first().waitFor({ state: 'attached', timeout: 15_000 });
    await freezeAt(260);
    await shot('2-spawn-mid-arc');
    await freezeAt(700);
    await shot('3-spawn-burst');
    await thaw();
    await page.waitForTimeout(2800);
    expect(await count('.gf-fxs')).toBe(0);
  });

  it('running edges stream packets, brighter during a tool call', async () => {
    expect(await count('.gf-pk')).toBeGreaterThan(0);
    expect(await count('.gf-hub')).toBeGreaterThan(0);
    await shot('4-running-packets');
    // frame times with the full effect stack running
    const frames = await page.evaluate(
      () =>
        new Promise<{ avg: number; p95: number; max: number }>((resolve) => {
          const ts: number[] = [];
          const t0 = performance.now();
          const tick = (t: number) => {
            ts.push(t);
            if (t - t0 < 3000) requestAnimationFrame(tick);
            else {
              const d = ts.slice(1).map((v, i) => v - ts[i]).sort((a, b) => a - b);
              resolve({ avg: d.reduce((s, v) => s + v, 0) / d.length, p95: d[Math.floor(d.length * 0.95)], max: d[d.length - 1] });
            }
          };
          requestAnimationFrame(tick);
        }),
    );
    fs.writeFileSync(path.join(ART, 'fx-edges-frames.json'), JSON.stringify(frames));
    console.log('frame times (ms)', frames);
  });

  it('finishing: a result surge runs up, a ripple opens at the parent, the line cools', async () => {
    await hook({ session_id: SID, hook_event_name: 'SubagentStop', agent_id: 'a10' });
    await page.locator('.gf-fxr').first().waitFor({ state: 'attached', timeout: 15_000 });
    await freezeAt(250);
    await shot('5-return-surge');
    await freezeAt(900);
    await shot('6-return-ripple');
    await thaw();
    await page.waitForTimeout(3000);
    expect(await count('.gf-fxr')).toBe(0);
    await shot('7-settled');
  });

  it('a failure glitches red and stays red-dashed', async () => {
    fs.appendFileSync(path.join(wf, 'journal.jsonl'), '{"type":"result","agentId":"w2","error":true}\n');
    await page.locator('.gf-glitch').first().waitFor({ state: 'attached', timeout: 15_000 });
    await freezeAt(180);
    await shot('8-error-glitch');
    await thaw();
    await page.waitForTimeout(2600);
    await shot('9-error-settled');
  });

  it('waiting for the user: amber beacon', async () => {
    spawn('a12', 'check permissions', 'claude-haiku-5-5', 'Bash', { command: 'ls' });
    await page.locator('[data-agent="a12"]').waitFor({ timeout: 15_000 });
    await page.waitForTimeout(3000);
    await hook({ session_id: SID, hook_event_name: 'PermissionRequest', tool_name: 'Bash', agent_id: 'a12' });
    await page.waitForTimeout(1500);
    await shot('10-waiting');
  });

  it('hovering an agent lights its ancestry and dims the rest', async () => {
    await page.locator('[data-agent="w2"]').hover();
    await page.waitForTimeout(500);
    expect(await count('.gf-hot')).toBeGreaterThan(0);
    expect(await page.locator('.graph-wrap svg.gf.focusing').count()).toBe(1);
    await shot('11-hover-focus');
    await page.mouse.move(5, 5);
  });

  it('shows static coloured lines under prefers-reduced-motion', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForTimeout(300);
    expect(await page.locator('.graph-wrap svg.gf .gf-pk').first().evaluate((el) => getComputedStyle(el).display)).toBe('none');
    expect(await page.locator('.graph-wrap svg.gf .gf-base').first().evaluate((el) => getComputedStyle(el).strokeWidth)).toBe('2px');
    await shot('12-reduced-motion');
    await page.emulateMedia({ reducedMotion: null });
  });
});
