// Tuning aid: parses the real plans and sessions under ~/.claude (read-only) and prints what the plan view would show.
// Skipped unless PLAN_REAL=1.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'vitest';
import { computeStepStatus, parsePlan, planProgress } from '@core/plan';
import { normalizeLine } from '@core/normalize';
import { apply } from '@core/reducer';
import { newSession } from '@core/state';

const home = path.join(os.homedir(), '.claude');

describe.skipIf(!process.env.PLAN_REAL)('real plans', () => {
  it('parses every plan file', () => {
    const dir = path.join(home, 'plans');
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md'))) {
      const p = parsePlan(fs.readFileSync(path.join(dir, f), 'utf8'));
      console.log(`\n=== ${f.slice(0, 50)} title=${p.title} sections=${p.sections.length} steps=${p.steps.length}`);
      p.steps
        .slice(0, 40)
        .forEach((s) => console.log(`  ${'  '.repeat(s.depth)}[${s.section}] ${s.checked === null ? '' : s.checked ? '[x] ' : '[ ] '}${s.title}`));
    }
  });

  it('matches agents in sessions that used plan mode', () => {
    const root = path.join(home, 'projects');
    for (const d of fs.readdirSync(root)) {
      const pd = path.join(root, d);
      for (const f of fs.readdirSync(pd).filter((x) => x.endsWith('.jsonl'))) {
        const file = path.join(pd, f);
        if (fs.statSync(file).size > 60_000_000) continue;
        const raw = fs.readFileSync(file, 'utf8');
        if (!raw.includes('ExitPlanMode","input"') && !raw.includes('"name":"ExitPlanMode"')) continue;
        const sid = f.replace('.jsonl', '');
        const s = newSession(sid);
        for (const line of raw.split('\n')) for (const e of normalizeLine(line, { sessionId: sid, agentId: null })) apply(s, e);
        const subDir = path.join(pd, sid, 'subagents');
        if (fs.existsSync(subDir)) {
          for (const sf of fs.readdirSync(subDir).filter((x) => x.endsWith('.meta.json'))) {
            try {
              const m = JSON.parse(fs.readFileSync(path.join(subDir, sf), 'utf8'));
              const id = sf.replace('agent-', '').replace('.meta.json', '');
              s.agents[id] ??= {
                ...s.agents.main,
                id,
                kind: 'agent',
                parentId: 'main',
                agentType: m.agentType ?? 'agent',
                description: m.description ?? '',
                status: 'done',
                prompt: undefined,
              } as never;
              s.agents[id].description = m.description ?? '';
              s.agents[id].agentType = m.agentType ?? 'agent';
            } catch {
              /* skip */
            }
          }
        }
        const text = s.plan?.text;
        if (!text) continue;
        const p = parsePlan(text);
        const agents = Object.values(s.agents).filter((a) => a.kind !== 'main');
        const st = computeStepStatus(p.steps, s.todos, agents, { since: s.plan?.since });
        const prog = planProgress(st);
        console.log(
          `\n### ${sid.slice(0, 8)} ${s.title?.slice(0, 50)} steps=${p.steps.length} agents=${agents.length} todos=${s.todos.length} done=${prog.done} active=${prog.active}`,
        );
        p.steps.forEach((step, i) => {
          if (st[i].linkedAgents.length || st[i].status !== 'pending')
            console.log(`  ${st[i].status.padEnd(11)} ${step.title.slice(0, 60)}  <- ${st[i].reasons.slice(0, 3).join(' | ').slice(0, 160)}`);
        });
        const linked = new Set(st.flatMap((x) => x.linkedAgents));
        console.log(
          `  UNLINKED agents: ${agents
            .filter((a) => !linked.has(a.id))
            .map((a) => a.description.slice(0, 40))
            .slice(0, 12)
            .join(' ; ')}`,
        );
      }
    }
  });
});
