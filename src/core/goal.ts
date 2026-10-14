// What is this agent for? A pure, weighted-evidence classifier. Every signal (agent type, workflow
// phase, description / prompt keywords, tool mix) adds weight to one or more goals; the heaviest
// goal wins and the heaviest evidence for it becomes the human-readable "because".

export type Goal = 'search' | 'research' | 'plan' | 'build' | 'test' | 'review' | 'debug' | 'docs' | 'workflow' | 'general';
export type Confidence = 'high' | 'medium' | 'low';

export interface GoalResult {
  goal: Goal;
  confidence: Confidence;
  because: string;
}

/** Tool categories the reducer counts per agent. */
export type ToolCategory = 'search' | 'read' | 'edit' | 'test' | 'run' | 'web' | 'agent' | 'plan' | 'other';
export type ToolMix = Partial<Record<ToolCategory, number>>;

export const GOALS: Goal[] = ['search', 'research', 'plan', 'build', 'test', 'review', 'debug', 'docs', 'workflow', 'general'];

export const GOAL_INFO: Record<Goal, { glyph: string; word: string; title: string }> = {
  search: { glyph: '⌕', word: 'search', title: 'Finding things in the code' },
  research: { glyph: '◈', word: 'research', title: 'Researching and comparing' },
  plan: { glyph: '☰', word: 'plan', title: 'Designing a plan' },
  build: { glyph: '✎', word: 'build', title: 'Writing or changing code' },
  test: { glyph: '⚗', word: 'test', title: 'Running or writing tests' },
  review: { glyph: '✓', word: 'review', title: 'Reviewing or verifying work' },
  debug: { glyph: '⚑', word: 'debug', title: 'Finding and fixing a bug' },
  docs: { glyph: '❡', word: 'docs', title: 'Reading or writing documentation' },
  workflow: { glyph: '⧉', word: 'workflow', title: 'A workflow run' },
  general: { glyph: '◇', word: 'general', title: 'General task' },
};

const TEST_CMD = /\b(npm (run )?test|npm t\b|pnpm (run )?test|yarn test|vitest|jest|mocha|playwright test|pytest|py\.test|unittest|cargo test|go test|dotnet test|mvn test|gradle test|rspec|phpunit|ctest|npx (vitest|jest|playwright)|tsc --noEmit|gut\b|godot .*(--test|gut))/i;
const SEARCH_CMD = /^\s*(rg|grep|egrep|fgrep|find|fd|ls|dir|tree|where|which|Select-String|Get-ChildItem|gci|sls|git (grep|ls-files|log|blame))\b/i;
const READ_CMD = /^\s*(cat|head|tail|less|more|sed -n|type|Get-Content|gc|wc|stat|file)\b/i;

/** Category of one tool call. Shell calls are classified by what they run. */
export function toolCategory(name: string, input?: unknown): ToolCategory {
  switch (name) {
    case 'Grep':
    case 'Glob':
      return 'search';
    case 'Read':
      return 'read';
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return 'edit';
    case 'WebSearch':
    case 'WebFetch':
      return 'web';
    case 'Agent':
    case 'Task':
    case 'SendMessage':
    case 'Workflow':
      return 'agent';
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TodoWrite':
    case 'ExitPlanMode':
      return 'plan';
    case 'Bash':
    case 'PowerShell': {
      const cmd = String(((input ?? {}) as { command?: unknown }).command ?? '');
      if (TEST_CMD.test(cmd)) return 'test';
      if (SEARCH_CMD.test(cmd)) return 'search';
      if (READ_CMD.test(cmd)) return 'read';
      return 'run';
    }
  }
  return 'other';
}

export function isTestCommand(cmd: string): boolean {
  return TEST_CMD.test(cmd);
}

export interface GoalInput {
  kind: 'main' | 'agent' | 'workflow';
  agentType: string;
  description: string;
  phase?: string | null;
  prompt?: string | null;
  toolMix?: ToolMix;
  /** main agent in plan mode */
  planMode?: boolean;
}

type Scores = Record<Goal, number>;
interface Evidence {
  goal: Goal;
  weight: number;
  label: string;
}

const KEYWORDS: { goal: Goal; re: RegExp; weight?: number }[] = [
  { goal: 'test', re: /\b(tests?|testing|specs?|vitest|jest|pytest|e2e|coverage|unit[- ]tests?|regression suite)\b/i },
  { goal: 'docs', re: /\b(docs?|documentation|readme|changelog|docstrings?|jsdoc|release notes)\b/i },
  { goal: 'debug', re: /\b(fix(es|ing)?|bugs?|debug(ging)?|diagnos\w*|crash(es|ing)?|broken|regressions?|root cause|stack ?trace|flak(e|y))\b/i },
  { goal: 'build', re: /\b(implement\w*|build(ing)?|create|refactor\w*|port(ing)?|polish\w*|migrat\w*|scaffold|feature)\b/i },
  // generic verbs and nouns: enough to lean build, not enough to beat a specific subject (tests, docs)
  { goal: 'build', re: /\b(add(ing)?|new|update|write|wire|finish|level|world)\b/i, weight: 1.6 },
  { goal: 'review', re: /\b(review\w*|audit\w*|verify|verification|judge|critique|validate|sanity[- ]check|double[- ]check)\b/i },
  { goal: 'research', re: /\b(research\w*|compare|comparison|investigat\w*|web|survey|alternatives|community|look up|best practices?|state of the art)\b/i },
  { goal: 'search', re: /\b(find|search\w*|locate|map|explore|where|trace|inventory|look for|discover)\b/i },
  { goal: 'plan', re: /\b(plan|design|architect\w*|outline|strategy|roadmap|propose|proposal)\b/i },
];

/** description prefixes workflow scripts use ("impl:foo", "judge-eng:bar", "verify:bug:baz") */
const DESC_PREFIX: { re: RegExp; goal: Goal; weight: number }[] = [
  { re: /^impl(ement)?\b/i, goal: 'build', weight: 4 },
  { re: /^(judge|review|audit|critic|R\d)\b/i, goal: 'review', weight: 4 },
  { re: /^verif/i, goal: 'review', weight: 3 },
  { re: /^(fix|bugfix)\b/i, goal: 'debug', weight: 4 },
  { re: /^(find|scan|search|scout)\b/i, goal: 'search', weight: 3 },
  { re: /^(test|qa)\b/i, goal: 'test', weight: 4 },
  { re: /^(doc|docs)\b/i, goal: 'docs', weight: 4 },
];

const PHASES: { re: RegExp; ev: [Goal, number][] }[] = [
  { re: /implement|build|construct|content|generate|write/i, ev: [['build', 3.5]] },
  { re: /fix|repair|patch/i, ev: [['debug', 3], ['build', 1]] },
  { re: /review|judge|select|critique|audit|dedup/i, ev: [['review', 3.5]] },
  { re: /verif|validate|check/i, ev: [['review', 2.5], ['test', 1.5]] },
  { re: /find|scan|search|discover|map/i, ev: [['search', 3.5]] },
  { re: /research|investigat/i, ev: [['research', 3.5]] },
  { re: /plan|design/i, ev: [['plan', 3.5]] },
  { re: /test/i, ev: [['test', 3.5]] },
  { re: /doc/i, ev: [['docs', 3.5]] },
];

const MIX_WORD: Partial<Record<ToolCategory, string>> = {
  search: 'searches',
  read: 'file reads',
  edit: 'edits',
  test: 'test runs',
  web: 'web lookups',
};

function emptyScores(): Scores {
  return { search: 0, research: 0, plan: 0, build: 0, test: 0, review: 0, debug: 0, docs: 0, workflow: 0, general: 0 };
}

/** The harness wraps computed workflow tasks in boilerplate that says nothing about the task. */
function usablePrompt(prompt: string | null | undefined): string {
  const p = (prompt ?? '').trim();
  if (!p || /^\[Workflow harness/i.test(p)) return '';
  // file paths and urls say where the work is, not what it is
  return p.slice(0, 500).replace(/\S*[\\/]\S*/g, ' ').slice(0, 400);
}

function words(re: RegExp, text: string): string | null {
  const m = re.exec(text);
  return m ? m[0].toLowerCase() : null;
}

export function classifyGoal(input: GoalInput): GoalResult {
  if (input.kind === 'workflow') {
    return { goal: 'workflow', confidence: 'high', because: `workflow run${input.agentType && input.agentType !== 'workflow' ? ': ' + input.agentType : ''}` };
  }
  const ev: Evidence[] = [];
  const add = (goal: Goal, weight: number, label: string) => ev.push({ goal, weight, label });
  const type = input.agentType || '';

  // 1. agent type
  if (type === 'Explore') add('search', 4, 'Explore agent');
  else if (type === 'Plan') add('plan', 5, 'Plan agent');
  else if (type === 'claude-code-guide') {
    add('research', 3, 'claude-code-guide agent');
    add('docs', 2.5, 'claude-code-guide agent');
  } else if (/review|audit|critic/i.test(type)) add('review', 5, `${type} agent`);
  else if (/test|qa/i.test(type)) add('test', 4, `${type} agent`);
  else if (/debug/i.test(type)) add('debug', 4, `${type} agent`);
  else if (/doc/i.test(type)) add('docs', 4, `${type} agent`);
  else if (/statusline|setup|config/i.test(type)) add('build', 2, `${type} agent`);
  if (input.planMode) add('plan', 4, 'plan mode');

  // 2. workflow phase
  const phase = (input.phase ?? '').trim();
  if (phase) {
    const hit = PHASES.find((p) => p.re.test(phase));
    if (hit) for (const [g, w] of hit.ev) add(g, w, `${phase} phase`);
  }

  // 3. description prefix + keywords (strong), prompt keywords (weak)
  const desc = input.description || '';
  for (const p of DESC_PREFIX) if (p.re.test(desc)) add(p.goal, p.weight, `task "${desc.split(/[:\s]/)[0]}"`);
  for (const k of KEYWORDS) {
    const w = words(k.re, desc);
    if (w) add(k.goal, k.weight ?? 3, `"${w}" in the task`);
  }
  const prompt = usablePrompt(input.prompt);
  if (prompt) {
    for (const k of KEYWORDS) {
      const hits = prompt.match(new RegExp(k.re.source, 'gi'));
      if (hits) add(k.goal, Math.min(2, hits.length) * 0.8 * ((k.weight ?? 3) / 3 + 0.2), `"${hits[0].toLowerCase()}" in the prompt`);
    }
  }

  // 4. tool mix: share of calls, scaled up as the sample grows
  const mix = input.toolMix ?? {};
  const total = Object.values(mix).reduce((n, v) => n + (v ?? 0), 0);
  if (total > 0) {
    const sample = Math.min(1, total / 8);
    const share = (c: ToolCategory) => (mix[c] ?? 0) / total;
    const n = (c: ToolCategory) => mix[c] ?? 0;
    const mixLabel = (cats: ToolCategory[]) => {
      const k = cats.reduce((s, c) => s + n(c), 0);
      const word = cats.length === 1 ? MIX_WORD[cats[0]] : 'searches and reads';
      return `${k} of ${total} tools were ${word}`;
    };
    const searchy = share('search') + 0.5 * share('read');
    if (searchy >= 0.3) add('search', Math.min(5, searchy * 6) * sample, mixLabel(share('search') >= 0.15 ? ['search', 'read'] : ['read']));
    if (share('web') >= 0.25) add('research', Math.min(5, share('web') * 6.5) * sample, mixLabel(['web']));
    if (share('edit') >= 0.05) add('build', Math.min(4.5, share('edit') * 14) * sample, mixLabel(['edit']));
    // builders run tests too, so a few test runs are weak evidence; mostly-test agents are clear
    if (n('test') > 0) add('test', Math.min(5, 0.8 + share('test') * 6.5) * Math.max(sample, 0.5), mixLabel(['test']));
    if (share('plan') >= 0.5) add('plan', 1 * sample, 'mostly checklist updates');
  }

  const scores = emptyScores();
  for (const e of ev) scores[e.goal] += e.weight;
  const ranked = (Object.keys(scores) as Goal[]).filter((g) => g !== 'general' && g !== 'workflow').sort((a, b) => scores[b] - scores[a]);
  const top = ranked[0];
  const second = ranked[1];
  const topScore = scores[top];
  if (topScore < 1.5) {
    return { goal: 'general', confidence: 'low', because: total ? `no clear pattern in ${total} tool calls` : 'no clear signal yet' };
  }
  const margin = topScore - scores[second];
  const confidence: Confidence = topScore >= 5 && margin >= 2 ? 'high' : topScore >= 3 && margin >= 1 ? 'medium' : 'low';
  const labels = ev
    .filter((e) => e.goal === top)
    .sort((a, b) => b.weight - a.weight)
    .map((e) => e.label);
  const because = [...new Set(labels)].slice(0, 2).join(' · ');
  return { goal: top, confidence, because };
}
