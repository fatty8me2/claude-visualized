import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { hookStatus, hookUrl, HOOK_EVENTS, installHooks, uninstallHooks } from '@core/hooksConfig';
import { normalizeLine, parseTaskNotification } from '@core/normalize';
import { modelLabel, summarizeTool, toolLabel } from '@core/summarize';
import { FileTail } from '../../src/main/tail';

// shape of the user's real settings.json (an existing async Stop command hook with args)
const USER_SETTINGS = {
  model: 'opus[1m]',
  hooks: {
    Stop: [
      {
        hooks: [
          {
            type: 'command',
            command: 'node',
            args: ['C:/Users/me/tools/export.mjs', '--quiet'],
            timeout: 120,
            statusMessage: 'Archiving session to Markdown',
            async: true,
          },
        ],
      },
    ],
  },
  autoUpdatesChannel: 'latest',
  tui: 'fullscreen',
  skipWorkflowUsageWarning: true,
};

describe('hooks installer merge', () => {
  it('adds our hooks without touching existing ones, and uninstall restores the original', () => {
    const installed = installHooks(USER_SETTINGS, 47821);
    expect(hookStatus(installed, 47821)).toBe('installed');
    expect(installed.hooks.Stop[0]).toEqual(USER_SETTINGS.hooks.Stop[0]);
    expect(installed.hooks.Stop).toHaveLength(2);
    for (const ev of HOOK_EVENTS) expect(installed.hooks[ev].at(-1).hooks[0]).toEqual({ type: 'http', url: hookUrl(47821), timeout: 2 });
    expect(installed.model).toBe('opus[1m]');
    expect(uninstallHooks(installed)).toEqual(USER_SETTINGS);
    expect(USER_SETTINGS.hooks.Stop).toHaveLength(1); // input not mutated
  });

  it('is idempotent and handles port changes and empty settings', () => {
    const twice = installHooks(installHooks(USER_SETTINGS, 47821), 47821);
    expect(twice.hooks.Stop).toHaveLength(2);
    expect(hookStatus(USER_SETTINGS, 47821)).toBe('none');
    expect(hookStatus(installHooks(USER_SETTINGS, 5000), 47821)).toBe('other-port');
    const fresh = installHooks({}, 47821);
    expect(Object.keys(fresh.hooks)).toHaveLength(HOOK_EVENTS.length);
    expect(uninstallHooks(fresh)).toEqual({});
  });
});

describe('normalizer', () => {
  const ctx = { sessionId: 's', agentId: null };
  it('ignores bookkeeping lines and bad JSON', () => {
    expect(normalizeLine('{"type":"file-history-snapshot","snapshot":{}}', ctx)).toEqual([]);
    expect(normalizeLine('not json', ctx)).toEqual([]);
    expect(normalizeLine('', ctx)).toEqual([]);
    expect(normalizeLine('{"type":"mode","mode":"normal"}', ctx)).toEqual([]);
  });
  it('flags unknown types instead of throwing', () => {
    const e = normalizeLine('{"type":"brand-new"}', ctx);
    expect(e[0].k).toBe('unknown');
  });
  it('parses task notifications only at the start of the text', () => {
    expect(parseTaskNotification('<task-notification>\n<task-id>abc</task-id>\n<status>completed</status>\n</task-notification>')).toEqual({
      taskId: 'abc',
      status: 'completed',
      summary: undefined,
    });
    expect(parseTaskNotification('echo "<task-notification><task-id>x</task-id><status>completed</status>"')).toBeNull();
  });
  it('compacts large tool inputs', () => {
    const big = 'x'.repeat(5000);
    const e = normalizeLine(
      JSON.stringify({
        type: 'assistant',
        message: { id: 'm', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 't', name: 'Write', input: { file_path: 'a.ts', content: big } }] },
      }),
      ctx,
    );
    const start = e.find((x) => x.k === 'tool.start');
    expect(start && start.k === 'tool.start' && (start.input as { content: string }).content.length).toBe(300);
  });
  it('strips system reminders from prompts', () => {
    const e = normalizeLine(JSON.stringify({ type: 'user', message: { content: '<system-reminder>secret</system-reminder>hello there' } }), ctx);
    expect(e.find((x) => x.k === 'prompt')).toMatchObject({ text: 'hello there' });
  });
});

describe('summaries', () => {
  it('labels models and tools', () => {
    expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(modelLabel('claude-fable-5-1')).toBe('Fable 5.1');
    expect(toolLabel('mcp__Claude_Browser__navigate')).toBe('Browser:navigate');
    expect(summarizeTool('Read', { file_path: 'C:\\a\\b\\api.ts' })).toBe('api.ts');
    expect(summarizeTool('Agent', { subagent_type: 'Explore', description: 'find files' })).toBe('Explore: find files');
  });
});

describe('FileTail', () => {
  it('handles partial lines, split multi-byte chars and truncation', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-tail-'));
    const f = path.join(dir, 't.jsonl');
    const line = JSON.stringify({ t: 'héllo ✓ 日本' });
    const bytes = Buffer.from(line + '\n', 'utf8');
    // split inside a multi-byte character
    const cut = bytes.indexOf(Buffer.from('✓')) + 1;
    fs.writeFileSync(f, bytes.subarray(0, cut));
    const t = new FileTail(f);
    expect(await t.read()).toEqual([]);
    fs.appendFileSync(f, bytes.subarray(cut));
    expect(await t.read()).toEqual([line]);
    fs.writeFileSync(f, 'x\n');
    expect(await t.read()).toBe('truncated');
    t.reset();
    expect(await t.read()).toEqual(['x']);
    expect(await new FileTail(path.join(dir, 'missing')).read()).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
