// Plan view data: parse a plan (markdown, or a todo list) into sections and steps, and work out
// each step's status from honest evidence (checkboxes, todos, the agents doing the work).
// Everything here is pure so it can be unit-tested and run in the renderer.

export interface PlanStep {
  id: string;
  /** cleaned text of the item (markdown stripped, capped) */
  text: string;
  /** short label for the rail */
  title: string;
  /** nested notes and continuation lines, used for display and weak matching */
  detail: string;
  /** index into ParsedPlan.sections, -1 = before any heading */
  section: number;
  /** nesting depth, 0 = top level */
  depth: number;
  /** true/false for `[x]` / `[ ]` items, null otherwise */
  checked: boolean | null;
  /** set when the step comes straight from a todo */
  todoId?: string;
}

export interface PlanSection {
  title: string;
  level: number;
}

export interface ParsedPlan {
  title: string | null;
  sections: PlanSection[];
  steps: PlanStep[];
}

export const MAX_STEPS = 80;
const TEXT_CAP = 200;
const TITLE_CAP = 90;
const DETAIL_CAP = 400;

/** sections that describe the situation instead of the work */
const INFO_RE =
  /^(?:(?:part|section|phase|step)\s+\w+\s*[:.\-–—]\s*)?(context|background|overview|goals?|non-?goals?|summary|findings?|stack|data sources?|(?:user |key )?decisions?(?: \(.*\))?|notes?|risks?|assumptions?|open (?:questions?|problems?)|current state|measured|constraints?|out of scope|references?|motivation|problem|what (?:already )?exists|what the .* does|the experience|critical files|why|execution model|how (?:it|this) works)\b/i;

/** sections that hold the actual work, when a plan has them the other sections are reference material */
const WORK_RE =
  /^(?:\d+[.)]?\s*)?(?:the\s+)?(milestones?|steps?|phases?|tasks?|implementation(?:\s+(?:plan|steps|order))?|work\s*plan|roadmap|to-?dos?|order of work|execution plan|build order)\b/i;

export function isWorkHeading(title: string): boolean {
  return WORK_RE.test(title.trim().replace(/^[§#]\s*\d*\s*/, ''));
}

/** a list item that is just a file path or path list ("src/main/{a,b}.ts"), not a piece of work */
function isPathItem(raw: string): boolean {
  const t = stripMd(raw).replace(/[:,;]\s*$/, '');
  return !/\s/.test(t) && /[/]|\.[a-z]{1,5}$/i.test(t);
}

export function isInfoHeading(title: string): boolean {
  return INFO_RE.test(
    title
      .trim()
      .replace(/^\d+[.)]?\s*/, '')
      .replace(/^[§#]\s*\d*\s*/, ''),
  );
}

/** drop markdown decoration, keep the words */
export function stripMd(s: string): string {
  return s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,;:]|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

function cap(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
}

function makeTitle(raw: string): string {
  const bold = /^(?:\*\*|__)(.+?)(?:\*\*|__)/.exec(raw.trim());
  let t = stripMd(bold ? bold[1] : raw);
  if (!bold) {
    const cut = /[:.]\s|\s[—–]\s|\s-\s|;/.exec(t);
    if (cut && cut.index >= 12) t = t.slice(0, cut.index);
  }
  t = t.replace(/[:.;,]$/, '');
  if ((t.match(/\(/g) ?? []).length > (t.match(/\)/g) ?? []).length) t = t.slice(0, t.lastIndexOf('(')).trim();
  return cap(t, TITLE_CAP);
}

interface RawItem {
  indent: number;
  numbered: boolean;
  checked: boolean | null;
  raw: string;
  notes: string[];
  parent: RawItem | null;
  depth: number;
}

interface RawSection {
  title: string;
  level: number;
  info: boolean;
  items: RawItem[];
  firstLine: string;
}

const HEAD_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const ITEM_RE = /^(\s*)([-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/;

/** Markdown plan -> sections and steps. Tolerant: anything it can't make sense of yields fewer steps, never an error. */
export function parsePlan(md: string): ParsedPlan {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  let title: string | null = null;
  const secs: RawSection[] = [{ title: '', level: 0, info: false, items: [], firstLine: '' }];
  let cur = secs[0];
  let stack: RawItem[] = [];
  let last: RawItem | null = null;
  let fence = false;

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const h = HEAD_RE.exec(line);
    if (h) {
      const level = h[1].length;
      const text = stripMd(h[2]);
      if (level === 1 && title === null) {
        title = text.replace(/^plan\s*[:\-–—]\s*/i, '');
        continue;
      }
      if (level > 3) continue; // #### and deeper stay inside their parent section
      cur = { title: text, level, info: isInfoHeading(text), items: [], firstLine: '' };
      secs.push(cur);
      stack = [];
      last = null;
      continue;
    }
    const m = ITEM_RE.exec(line);
    if (m) {
      const indent = m[1].replace(/\t/g, '    ').length;
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      const parent = stack[stack.length - 1] ?? null;
      const it: RawItem = {
        indent,
        numbered: /\d/.test(m[2]),
        checked: m[3] === undefined ? null : m[3] !== ' ',
        raw: m[4].trim(),
        notes: [],
        parent,
        depth: parent ? parent.depth + 1 : 0,
      };
      stack.push(it);
      cur.items.push(it);
      last = it;
      continue;
    }
    if (!line.trim()) continue;
    // free text: a continuation of the previous item if indented, otherwise the section's lead line
    if (last && /^\s+\S/.test(line)) last.raw += ' ' + line.trim();
    else {
      if (!cur.firstLine) cur.firstLine = stripMd(line.trim());
      last = null;
      stack = [];
    }
  }

  const sections: PlanSection[] = [];
  const steps: PlanStep[] = [];
  const secIndex = new Map<RawSection, number>();
  const addStep = (sec: RawSection, text: string, detail: string, depth: number, checked: boolean | null) => {
    if (steps.length >= MAX_STEPS) return;
    let si = -1;
    if (sec.title || sec.level) {
      if (!secIndex.has(sec)) {
        secIndex.set(sec, sections.length);
        sections.push({ title: sec.title, level: sec.level });
      }
      si = secIndex.get(sec)!;
    }
    steps.push({
      id: `s${steps.length + 1}`,
      text: cap(stripMd(text), TEXT_CAP),
      title: makeTitle(text),
      detail: cap(stripMd(detail), DETAIL_CAP),
      section: si,
      depth,
      checked,
    });
  };

  // when the plan names its work sections (Milestones, Steps, Phases…), only those hold steps;
  // subsections nested under them count too
  const workSecs = new Set<RawSection>();
  let workLevel = 0;
  for (const sec of secs) {
    if (sec.level && workLevel && sec.level <= workLevel) workLevel = 0;
    if (sec.level && isWorkHeading(sec.title)) workLevel = sec.level;
    if (workLevel && !sec.info) workSecs.add(sec);
  }
  const workOnly = [...workSecs].some((x) => x.items.length > 0);

  for (const sec of secs) {
    // items before the first heading are preamble, not steps
    if (sec.info || !sec.items.length || (!sec.title && !sec.level)) continue;
    if (workOnly && !workSecs.has(sec)) continue;
    const strong = sec.items.some((i) => i.depth === 0 && (i.numbered || i.checked !== null));
    // attach non-step items to their nearest step ancestor as detail
    const isStep = (i: RawItem) =>
      (strong ? i.numbered || i.checked !== null : i.depth === 0) && (i.depth === 0 || i.numbered || i.checked !== null) && !isPathItem(i.raw);
    for (const it of sec.items) {
      if (isStep(it)) continue;
      let p = it.parent;
      while (p && !isStep(p)) p = p.parent;
      if (p) p.notes.push(it.raw);
    }
    for (const it of sec.items) {
      if (!isStep(it)) continue;
      // depth among steps only: a step nested under a non-step belongs at depth 0
      let d = 0;
      for (let p = it.parent; p; p = p.parent) if (isStep(p)) d++;
      addStep(sec, it.raw, it.notes.join(' '), Math.min(d, 3), it.checked);
    }
  }

  if (!steps.length) {
    // free-form plan: the headings are the steps
    const heads = secs.filter((s) => s.level > 0 && !s.info);
    const top = heads.some((s) => s.level === 2) ? 2 : 3;
    for (const sec of heads) if (sec.level === top) addStep(sec, sec.title, sec.firstLine, 0, null);
    sections.length = 0;
    for (const s of steps) s.section = -1;
  }

  return { title, sections, steps };
}

/** A todo list is a plan too: used when the session has no plan text. */
export function todosToPlan(todos: { id: string; text: string; status: string }[]): ParsedPlan {
  const steps: PlanStep[] = todos
    .filter((t) => t.text.trim())
    .slice(0, MAX_STEPS)
    .map((t, i) => ({
      id: `t${i + 1}`,
      text: cap(stripMd(t.text), TEXT_CAP),
      title: makeTitle(t.text),
      detail: '',
      section: -1,
      depth: 0,
      checked: null,
      todoId: t.id,
    }));
  return { title: null, sections: [], steps };
}

// ---------- matching ----------

const STOP = new Set(
  (
    'the and for with from that this these those into onto over under about after before then than also just only more most some any all each every both ' +
    'are was were been being has have had does did doing can could should would will shall may might must not but nor yet its our your their his her ' +
    'you they them she him who whom whose which what when where why how there here out off per via too very own same such ' +
    'step steps phase part parts plan task tasks work works need needs needed ensure make makes made get gets got use used uses using ' +
    'add adds added update updates updated create creates created new old implement implements implemented file files code change changes changed ' +
    'one two first second third next last final finally now still keep keeps see set sets let lets like etc eg ie via per ' +
    'fix fixes ask asks write writes owner own owns only each agent agents subagent subagents claude'
  ).split(' '),
);

/** crude stemmer: enough to make test/tests/testing and run/running meet */
export function stem(w: string): string {
  let s = w;
  if (s.length > 4 && s.endsWith('ies')) s = s.slice(0, -3) + 'y';
  else if (s.length > 4 && s.endsWith('sses')) s = s.slice(0, -2);
  else if (s.length > 5 && s.endsWith('ing')) s = s.slice(0, -3);
  else if (s.length > 4 && s.endsWith('ed')) s = s.slice(0, -2);
  else if (s.length > 4 && s.endsWith('es') && /(?:ch|sh|x|z|ss)es$/.test(s)) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith('s') && !s.endsWith('ss') && !s.endsWith('us') && !s.endsWith('is')) s = s.slice(0, -1);
  if (s.length > 4 && s.endsWith('ly')) s = s.slice(0, -2);
  if (s.length > 3 && /([^aeiou])\1$/.test(s) && !/(ll|ss|ff|zz)$/.test(s)) s = s.slice(0, -1); // running -> runn -> run
  if (s.length > 4 && s.endsWith('e')) s = s.slice(0, -1);
  return s;
}

/** meaningful tokens of a text, as a set */
export function tokens(text: string): Set<string> {
  const out = new Set<string>();
  const spaced = text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  for (const raw of spaced.split(/[^a-z0-9]+/)) {
    if (!raw) continue;
    if (raw.length < 3 && !/^\d+$/.test(raw)) continue;
    if (STOP.has(raw)) continue;
    const st = stem(raw);
    if (st.length < 2 || STOP.has(st)) continue;
    out.add(st);
  }
  return out;
}

export interface MatchScore {
  shared: number;
  jaccard: number;
  ok: boolean;
}

/** at least 2 shared meaningful tokens, or a Jaccard score of 0.3 */
export function matchScore(a: Set<string>, b: Set<string>): MatchScore {
  if (!a.size || !b.size) return { shared: 0, jaccard: 0, ok: false };
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  const jaccard = shared / (a.size + b.size - shared);
  return { shared, jaccard, ok: shared >= 2 || jaccard >= 0.3 };
}

const scoreKey = (m: MatchScore) => m.shared + m.jaccard;

// ---------- status ----------

export type StepState = 'done' | 'in_progress' | 'pending';

export interface PlanAgent {
  id: string;
  kind?: string;
  agentType: string;
  description: string;
  status: string;
  lastText?: string | null;
  prompt?: string | null;
  startedAt?: number;
}

export interface PlanTodo {
  id: string;
  text: string;
  status: string;
}

export interface StepStatus {
  status: StepState;
  linkedAgents: string[];
  /** why: "checked off in the plan", "todo 'X' completed", "agent Explore: 'search repo' running" */
  reasons: string[];
}

const FINISHED = new Set(['done']);
const FAILED = new Set(['error']);

function todoState(status: string): StepState {
  const s = status.toLowerCase();
  if (s === 'completed' || s === 'complete' || s === 'done') return 'done';
  if (s === 'in_progress' || s === 'in-progress' || s === 'active') return 'in_progress';
  return 'pending';
}

/**
 * Status of every step. Evidence order: checked box > matching todo > matching agents > nothing (pending).
 * Agents are linked to the step(s) they match best, so one agent does not light up the whole plan.
 */
export function computeStepStatus(steps: PlanStep[], todos: PlanTodo[], agents: PlanAgent[], opts: { since?: number } = {}): StepStatus[] {
  const stepTok = steps.map((s) => tokens(s.text));
  const stepTokWide = steps.map((s) => tokens(s.text + ' ' + s.detail));
  const result: StepStatus[] = steps.map(() => ({ status: 'pending', linkedAgents: [], reasons: [] }));

  // todos -> best step(s)
  const todoFor: { todo: PlanTodo; score: number }[][] = steps.map(() => []);
  const todoTok = todos.map((t) => tokens(t.text));
  todos.forEach((todo, ti) => {
    let best = 0;
    const ok: [number, number][] = [];
    steps.forEach((st, si) => {
      if (st.todoId !== undefined) {
        if (st.todoId === todo.id) ok.push([si, 99]);
        return;
      }
      const m = matchScore(stepTok[si], todoTok[ti]);
      if (m.ok) {
        ok.push([si, scoreKey(m)]);
        best = Math.max(best, scoreKey(m));
      }
    });
    for (const [si, sc] of ok) if (sc >= best - 0.01 || sc === 99) todoFor[si].push({ todo, score: sc });
  });

  // agents -> best step(s)
  const agentFor: { agent: PlanAgent; why: string }[][] = steps.map(() => []);
  for (const agent of agents) {
    if (agent.kind === 'main') continue;
    // an agent that started before the plan was submitted was researching for it, not carrying it out
    if (opts.since && agent.startedAt !== undefined && agent.startedAt > 0 && agent.startedAt < opts.since - 1000) continue;
    const head = tokens(agent.description);
    // prompts are long and noisy: only a fallback for agents with no usable description
    const body = head.size >= 2 ? new Set<string>() : tokens(agent.prompt ?? '');
    let best = 0;
    const ok: [number, number][] = [];
    steps.forEach((_, si) => {
      let m = matchScore(stepTok[si], head);
      let sc = m.ok ? scoreKey(m) : 0;
      if (!m.ok && body.size) {
        // the prompt is longer and noisier than a description: ask for more overlap
        const pm = matchScore(stepTokWide[si], body);
        if (pm.shared >= 3) {
          m = pm;
          sc = scoreKey(pm) * 0.9;
        }
      }
      if (sc > 0) {
        ok.push([si, sc]);
        best = Math.max(best, sc);
      }
    });
    for (const [si, sc] of ok) if (sc >= best - 0.01) agentFor[si].push({ agent, why: agent.description || agent.agentType });
  }

  steps.forEach((st, i) => {
    const r = result[i];
    const reasons = r.reasons;
    const linked = agentFor[i];
    r.linkedAgents = linked.map((x) => x.agent.id);
    const agentLine = (a: PlanAgent) => `agent ${a.agentType || 'agent'}: '${cap(a.description || a.lastText || a.id, 60)}' ${a.status}`;

    if (st.checked === true) {
      r.status = 'done';
      reasons.push('checked off in the plan');
    }
    const tds = todoFor[i];
    const states = tds.map((t) => todoState(t.todo.status));
    for (const t of tds) reasons.push(`todo '${cap(t.todo.text, 60)}' ${t.todo.status.replace('_', ' ')}`);
    for (const l of linked) reasons.push(agentLine(l.agent));

    if (r.status === 'done') return;
    if (states.length && states.every((s) => s === 'done')) r.status = 'done';
    else if (states.includes('in_progress')) r.status = 'in_progress';
    else if (states.includes('done') && !states.includes('pending')) r.status = 'done';
    if (r.status !== 'pending') return;

    const live = linked.filter((l) => !FINISHED.has(l.agent.status) && !FAILED.has(l.agent.status));
    const finished = linked.filter((l) => FINISHED.has(l.agent.status));
    if (live.length) r.status = 'in_progress';
    else if (finished.length && !states.includes('pending')) r.status = 'done';
    else if (finished.length && states.length === 0) r.status = 'done';
  });
  return result;
}

export interface PlanProgress {
  done: number;
  active: number;
  total: number;
}

export function planProgress(st: StepStatus[]): PlanProgress {
  return { done: st.filter((s) => s.status === 'done').length, active: st.filter((s) => s.status === 'in_progress').length, total: st.length };
}

export type PlanOrigin = 'file' | 'approved' | 'proposed' | 'todos';

export interface PlanSourceInfo {
  text: string | null;
  since?: number;
  source: 'exit' | 'file' | 'reference' | null;
  approved: boolean | null;
}

/** Pick the plan to show: plan text first, the todo list as the fallback. Null = nothing to show. */
export function resolvePlan(plan: PlanSourceInfo | null, todos: PlanTodo[]): { parsed: ParsedPlan; origin: PlanOrigin } | null {
  if (plan?.text) {
    const parsed = parsePlan(plan.text);
    if (parsed.steps.length) {
      const origin: PlanOrigin = plan.source === 'file' || plan.source === 'reference' ? 'file' : plan.approved === false ? 'proposed' : 'approved';
      return { parsed, origin };
    }
  }
  const t = todosToPlan(todos);
  return t.steps.length ? { parsed: t, origin: 'todos' } : null;
}

export const ORIGIN_LABEL: Record<PlanOrigin, string> = { file: 'plan file', approved: 'approved plan', proposed: 'proposed plan', todos: 'todo list' };
