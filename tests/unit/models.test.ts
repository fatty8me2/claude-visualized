import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { contextInfo } from '@core/context';
import { DEFAULT_LAYOUT, layoutAgents } from '@core/layout';
import { classifyModel, modelMatchKeys, sameModel } from '@core/models';
import { modelFamily, modelLabel } from '@core/summarize';
import { SessionWatcher } from '../../src/main/watcher';
import { LOCAL_MAIN_MODEL, LOCAL_SID, LOCAL_SUB_MODEL, writeLocalFixture } from '../fixtures/build';

const c = classifyModel;

describe('classifyModel', () => {
  it('keeps Claude models as anthropic', () => {
    expect(c('claude-opus-5-5')).toEqual({ provider: 'anthropic', family: 'opus', label: 'Opus 5.5' });
    expect(c('claude-haiku-4-5-20251001')).toMatchObject({ provider: 'anthropic', family: 'haiku', label: 'Haiku 4.5' });
    expect(c('anthropic/claude-sonnet-5-5')).toMatchObject({ provider: 'anthropic', family: 'sonnet' });
    expect(c('opus[1m]').provider).toBe('anthropic');
  });

  it.each([
    ['qwen2.5-coder:32b', 'qwen', 'Qwen2.5 Coder 32B'],
    ['llama3.1:70b', 'llama', 'Llama 3.1 70B'],
    ['llama3.1:8b', 'llama', 'Llama 3.1 8B'],
    ['deepseek-coder-v2', 'deepseek', 'DeepSeek Coder V2'],
    ['gpt-oss:20b', 'gpt-oss', 'GPT-OSS 20B'],
    ['ollama/qwen3', 'qwen', 'Qwen3'],
    ['ollama/qwen3:30b-a3b-q4_K_M', 'qwen', 'Qwen3 30B A3B Q4_K_M'],
    ['lmstudio-community/Qwen2.5-Coder-32B-Instruct-GGUF', 'qwen', 'Qwen2.5 Coder 32B Instruct'],
    ['mistral:7b-instruct', 'mistral', 'Mistral 7B Instruct'],
    ['mixtral:8x7b', 'mistral', 'Mixtral 8x7B'],
    ['codestral:22b', 'codestral', 'Codestral 22B'],
    ['devstral:24b', 'devstral', 'Devstral 24B'],
    ['gemma3:27b', 'gemma', 'Gemma 3 27B'],
    ['phi4:14b', 'phi', 'Phi 4 14B'],
    ['granite3.3:8b', 'granite', 'Granite 3.3 8B'],
    ['starcoder2:15b', 'starcoder', 'StarCoder2 15B'],
    ['codellama:13b', 'codellama', 'Code Llama 13B'],
    ['command-r:35b', 'command-r', 'Command R 35B'],
    ['glm-4.6', 'glm', 'GLM 4.6'],
    ['kimi-k2', 'kimi', 'Kimi K2'],
    ['hf.co/bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M', 'llama', 'Llama 3.2 3B Instruct Q4_K_M'],
    ['qwen2.5-coder-32b-instruct@q4_k_m', 'qwen', 'Qwen2.5 Coder 32B Instruct Q4_K_M'],
  ])('%s is a local %s model', (id, family, label) => {
    expect(c(id)).toEqual({ provider: 'local', family, label });
  });

  it('treats explicit local prefixes as local even for unknown families', () => {
    expect(c('ollama/some-weird-model:7b')).toMatchObject({ provider: 'local', family: 'local' });
    expect(c('ollama/some-weird-model:7b').label).toBe('Some Weird Model 7B');
  });

  it('does not call hosted gateways local', () => {
    expect(c('openrouter/qwen/qwen3-coder')).toMatchObject({ provider: 'other', label: 'Qwen3 Coder' });
    expect(c('gpt-4o')).toMatchObject({ provider: 'other', family: 'other' });
    expect(c('gemini-2.5-pro').provider).toBe('other');
    expect(c('openrouter/anthropic/claude-sonnet-5-5').provider).toBe('anthropic');
  });

  it('handles empty input', () => {
    expect(c(null).label).toBe('—');
    expect(c('').provider).toBe('other');
  });
});

describe('summarize integration', () => {
  it('maps local models to the local family and a pretty label', () => {
    expect(modelFamily('qwen2.5-coder:32b')).toBe('local');
    expect(modelFamily('claude-opus-5-5')).toBe('opus');
    expect(modelFamily('gpt-4o')).toBe('other');
    expect(modelLabel('qwen2.5-coder:32b')).toBe('Qwen2.5 Coder 32B');
    expect(modelLabel('claude-haiku-5-5')).toBe('Haiku 5.5');
  });
});

describe('a session on local models (fixture)', () => {
  it('folds without errors and classifies each agent', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-local-'));
    try {
      const { mainFile } = writeLocalFixture(home);
      const w = new SessionWatcher(LOCAL_SID, mainFile);
      await w.poll();
      const a = w.state.agents;
      expect(Object.keys(a).sort()).toEqual(['l1', 'main']);
      expect(a.main.model).toBe(LOCAL_MAIN_MODEL);
      expect(a.l1.model).toBe(LOCAL_SUB_MODEL);
      expect(modelFamily(a.main.model)).toBe('local');
      expect(modelLabel(a.l1.model)).toBe('Llama 3.1 8B');
      expect(w.state.warnings).toBe(0);
      expect(a.main.tokens.in).toBeGreaterThan(0);
      // no server knows these models: tokens, no percentage
      expect(contextInfo(a.main, null, null)).toMatchObject({ windowKnown: false });
      expect(layoutAgents(a, DEFAULT_LAYOUT).nodes.length).toBe(2);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('model matching', () => {
  it('matches the same model across spellings', () => {
    expect(sameModel('qwen2.5-coder:32b', 'qwen2.5-coder:32b')).toBe(true);
    expect(sameModel('ollama/qwen2.5-coder:32b', 'qwen2.5-coder:32b')).toBe(true);
    expect(sameModel('llama3.2', 'llama3.2:latest')).toBe(true);
    expect(sameModel('qwen/qwen2.5-coder-32b-instruct', 'qwen2.5-coder-32b-instruct')).toBe(true);
    expect(sameModel('llama3.1:8b', 'llama3.1:70b')).toBe(false);
    expect(sameModel(null, 'x')).toBe(false);
    expect(modelMatchKeys('')).toEqual([]);
  });
});
