import { describe, expect, it } from 'vitest';
import { classifyGoal, toolCategory, type GoalInput } from '@core/goal';

const agent = (o: Partial<GoalInput>): GoalInput => ({ kind: 'agent', agentType: 'general-purpose', description: '', ...o });

describe('toolCategory', () => {
  it('classifies plain tools and shell commands', () => {
    expect(toolCategory('Grep')).toBe('search');
    expect(toolCategory('Read')).toBe('read');
    expect(toolCategory('Write')).toBe('edit');
    expect(toolCategory('WebFetch')).toBe('web');
    expect(toolCategory('Bash', { command: 'npm test' })).toBe('test');
    expect(toolCategory('Bash', { command: 'npx vitest run --config x' })).toBe('test');
    expect(toolCategory('Bash', { command: 'cargo test -p core' })).toBe('test');
    expect(toolCategory('PowerShell', { command: 'Get-ChildItem -Recurse' })).toBe('search');
    expect(toolCategory('Bash', { command: 'rg foo src' })).toBe('search');
    expect(toolCategory('Bash', { command: 'git commit -m x' })).toBe('run');
  });
});

describe('classifyGoal: agent type', () => {
  it('Explore -> search, Plan -> plan, claude-code-guide -> research', () => {
    expect(classifyGoal(agent({ agentType: 'Explore' })).goal).toBe('search');
    expect(classifyGoal(agent({ agentType: 'Plan' })).goal).toBe('plan');
    expect(classifyGoal(agent({ agentType: 'claude-code-guide' })).goal).toBe('research');
    expect(classifyGoal(agent({ agentType: 'code-reviewer' })).goal).toBe('review');
  });

  it('workflow nodes are always workflow', () => {
    const r = classifyGoal({ kind: 'workflow', agentType: 'review', description: 'x' });
    expect(r).toMatchObject({ goal: 'workflow', confidence: 'high' });
  });

  it('explains itself with the evidence', () => {
    const r = classifyGoal(agent({ agentType: 'Explore', toolMix: { search: 10, read: 4, run: 2 } }));
    expect(r.goal).toBe('search');
    expect(r.confidence).toBe('high');
    expect(r.because).toContain('Explore agent');
    expect(r.because).toMatch(/\d+ of 16 tools were/);
  });
});

describe('classifyGoal: description and prompt keywords', () => {
  it.each([
    ['run tests', 'test'],
    ['Write vitest specs for the parser', 'test'],
    ['Update the README docs', 'docs'],
    ['Fix the crash on startup', 'debug'],
    ['Diagnose flaky login', 'debug'],
    ['Implement retry in the client', 'build'],
    ['Refactor the reducer', 'build'],
    ['Review the diff', 'review'],
    ['Compare Ollama and LM Studio', 'research'],
    ['Locate the auth entry points', 'search'],
    ['Design the schema', 'plan'],
  ])('"%s" -> %s', (description, goal) => {
    expect(classifyGoal(agent({ description })).goal).toBe(goal);
  });

  it('weak prompt keywords only matter when nothing stronger exists', () => {
    expect(classifyGoal(agent({ description: 'Autostart polish', prompt: 'You are fixing a bug in tray code' })).goal).toBe('build');
    expect(classifyGoal(agent({ description: '', prompt: 'Please compare the alternatives found on the web' })).goal).toBe('research');
  });

  it('ignores workflow-harness boilerplate in the prompt', () => {
    const r = classifyGoal(agent({ agentType: 'workflow-subagent', description: '', prompt: '[Workflow harness — user request] fix test docs review' }));
    expect(r.goal).toBe('general');
  });

  it('understands workflow description prefixes and phases', () => {
    expect(classifyGoal(agent({ agentType: 'workflow-subagent', description: 'judge-eng:Mixer safety', phase: 'Judge' })).goal).toBe('review');
    expect(classifyGoal(agent({ agentType: 'workflow-subagent', description: 'impl:B5', phase: 'Implement' })).goal).toBe('build');
    expect(classifyGoal(agent({ agentType: 'workflow-subagent', description: 'x', phase: 'Find' })).goal).toBe('search');
    expect(classifyGoal(agent({ agentType: 'workflow-subagent', description: 'x', phase: 'Fix' })).goal).toBe('debug');
  });
});

describe('classifyGoal: tool mix', () => {
  it('mostly searches and reads -> search', () => {
    expect(classifyGoal(agent({ toolMix: { search: 9, read: 6, run: 1 } })).goal).toBe('search');
  });
  it('web tools -> research, and beat an Explore label', () => {
    expect(classifyGoal(agent({ toolMix: { web: 14, search: 2 } })).goal).toBe('research');
    expect(classifyGoal(agent({ agentType: 'Explore', toolMix: { web: 15, other: 1 } })).goal).toBe('research');
  });
  it('edits -> build', () => {
    expect(classifyGoal(agent({ toolMix: { edit: 12, read: 8, run: 6 } })).goal).toBe('build');
  });
  it('test commands -> test', () => {
    const r = classifyGoal(agent({ toolMix: { test: 6, run: 2 } }));
    expect(r.goal).toBe('test');
    expect(r.because).toContain('test runs');
  });

  it('a low-confidence guess shifts as the tool mix grows', () => {
    const early = classifyGoal(agent({ description: 'Update things', toolMix: { read: 1 } }));
    expect(early.goal).toBe('build');
    expect(early.confidence).not.toBe('high');
    const later = classifyGoal(agent({ description: 'Update things', toolMix: { test: 9, run: 2, read: 2 } }));
    expect(later.goal).toBe('test');
  });

  it('falls back to general when there is no signal', () => {
    expect(classifyGoal(agent({}))).toMatchObject({ goal: 'general', confidence: 'low' });
    expect(classifyGoal(agent({ toolMix: { run: 5, other: 1 } })).goal).toBe('general');
  });

  it('plan mode lifts the main agent to plan', () => {
    expect(classifyGoal({ kind: 'main', agentType: 'main', description: '', planMode: true }).goal).toBe('plan');
  });
});
