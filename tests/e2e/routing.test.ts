// Connector routing in the real app: 9 running + 39 finished subagents under main (the grid case). Every connector must stay clear
// of every card (sampled along the drawn SVG path). Screenshot: tests/e2e/artifacts/routing-grid.png. Run `npx electron-vite build` first.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mainLines, PROJECT, SID, writeFixture } from '../fixtures/build';

const ROOT = path.resolve(__dirname, '../..');
const ART = path.join(ROOT, 'tests/e2e/artifacts');
const PORT = Number(process.env.E2E_PORT ?? 47899) + 2;
const hook = (body: object) => fetch(`http://127.0.0.1:${PORT}/hook?src=claude-visualized`, { method: 'POST', body: JSON.stringify(body) });

const sideLine = (id: string) =>
  JSON.stringify({
    type: 'assistant',
    isSidechain: true,
    agentId: id,
    sessionId: SID,
    timestamp: new Date().toISOString(),
    message: {
      id: `m_${id}`,
      model: 'claude-haiku-5-5',
      content: [{ type: 'tool_use', id: `toolu_${id}`, name: 'Grep', input: { pattern: 'retry', path: 'src' } }],
      usage: { input_tokens: 400, output_tokens: 12, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  }) + '\n';

describe('connector routing (9 running + 39 finished)', () => {
  let home: string;
  let userData: string;
  let app: ElectronApplication;
  let page: Page;

  beforeAll(async () => {
    fs.mkdirSync(ART, { recursive: true });
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-route-home-'));
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-route-ud-'));
    writeFixture(home);
    const pdir = path.join(home, 'projects', PROJECT);
    // main agent only (the fixture's own subagents would make main's children a non-grid group)
    const sub = path.join(pdir, SID, 'subagents');
    fs.rmSync(path.join(pdir, SID), { recursive: true, force: true });
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(pdir, `${SID}.jsonl`), mainLines()[0] + '\n');
    fs.appendFileSync(path.join(pdir, `${SID}.jsonl`), JSON.stringify({ type: 'system', subtype: 'turn_duration', sessionId: SID, timestamp: new Date().toISOString() }) + '\n');
    for (let i = 0; i < 48; i++) {
      const id = `r${String(i).padStart(2, '0')}`;
      fs.writeFileSync(path.join(sub, `agent-${id}.meta.json`), JSON.stringify({ agentType: 'general-purpose', description: `task ${i}`, toolUseId: `toolu_n_${id}` }));
      fs.writeFileSync(path.join(sub, `agent-${id}.jsonl`), sideLine(id));
    }
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
    await page.setViewportSize({ width: 1700, height: 1100 }).catch(() => {});
    await page.evaluate(() => localStorage.setItem('cvis.graph.v1', JSON.stringify({ zoom: 'fit', compact: 'off', hideFinished: false })));
    await page.reload();
  });

  afterAll(async () => {
    await app?.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(userData, { recursive: true, force: true });
  });

  /** distance from every sampled point of every drawn connector into any card; returns offenders */
  const offenders = () =>
    page.evaluate(() => {
      const cards = [...document.querySelectorAll('.node[data-agent], [data-chip]')].map((n) => n.getBoundingClientRect());
      const bad: string[] = [];
      let edges = 0;
      for (const base of document.querySelectorAll('svg.gf .gf-base') as NodeListOf<SVGPathElement>) {
        edges++;
        const len = base.getTotalLength();
        const m = base.getScreenCTM()!;
        for (let l = 3; l < len - 3; l += 3) {
          const p = base.getPointAtLength(l);
          const x = p.x * m.a + m.e;
          const y = p.y * m.d + m.f;
          if (cards.some((r) => x > r.left + 1 && x < r.right - 1 && y > r.top + 1 && y < r.bottom - 1)) {
            bad.push(`${Math.round(x)},${Math.round(y)}`);
            break;
          }
        }
      }
      return { edges, bad };
    });

  it('draws every connector clear of the cards and saves a screenshot', async () => {
    await page.locator('[data-agent="r00"]').waitFor({ timeout: 30_000 });
    for (let i = 9; i < 48; i++) await hook({ session_id: SID, hook_event_name: 'SubagentStop', agent_id: `r${String(i).padStart(2, '0')}` });
    await page.waitForTimeout(2500);
    const res = await offenders();
    expect(res.edges).toBe(10);
    expect(res.bad).toEqual([]);
    const box = (await page.locator('.graph-canvas > div').first().boundingBox())!;
    const clip = { x: Math.max(0, box.x), y: Math.max(0, box.y), width: Math.min(box.width, 1700), height: Math.min(box.height, 1100), scale: 1 };
    const cdp = await page.context().newCDPSession(page);
    const r = await cdp.send('Page.captureScreenshot', { format: 'png', clip });
    fs.writeFileSync(path.join(ART, 'routing-grid.png'), Buffer.from(r.data, 'base64'));
  });

  it('stays clear when the finished group is expanded into a 10-row grid', async () => {
    const chip = page.locator('[data-chip]').first();
    await chip.click();
    await page.waitForTimeout(2000);
    const res = await offenders();
    expect(res.bad).toEqual([]);
    expect(await page.locator('.node[data-agent]').count()).toBeGreaterThan(40);
    const box = (await page.locator('.graph-canvas > div').first().boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    const r = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: box.x, y: box.y, width: Math.min(box.width, 1700), height: Math.min(box.height, 1100), scale: 1 } });
    fs.writeFileSync(path.join(ART, 'routing-grid-expanded.png'), Buffer.from(r.data, 'base64'));
  });
});
