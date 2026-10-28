// Model classification: which provider/family a transcript's model id belongs to, and a readable label.
// Claude Code can run against local models through a gateway (LiteLLM, Ollama's Anthropic-compatible
// endpoint, claude-code-router, LM Studio ...), in which case message.model holds a non-Claude id such
// as "qwen2.5-coder:32b" or "ollama/llama3.1:70b".

export type ModelProvider = 'anthropic' | 'local' | 'other';

export interface ModelClass {
  provider: ModelProvider;
  /** anthropic: opus|sonnet|haiku|fable; local: qwen|llama|...|'local' (unknown open model); other: 'other' */
  family: string;
  label: string;
}

const ANTHROPIC_FAMILY = /(opus|sonnet|haiku|fable)/i;

/** [family key, id pattern, display name, version glued to the name ("Qwen2.5") instead of spaced ("Llama 3.1")] */
const LOCAL_FAMILIES: [string, RegExp, string, boolean][] = [
  ['gpt-oss', /^gpt-?oss/, 'GPT-OSS', false],
  ['codellama', /^code-?llama/, 'Code Llama', false],
  ['codestral', /^codestral/, 'Codestral', false],
  ['devstral', /^devstral/, 'Devstral', false],
  ['mistral', /^(mistral|mixtral|ministral)/, 'Mistral', false],
  ['qwen', /^(qwen|qwq)/, 'Qwen', true],
  ['llama', /^(llama|tinyllama)/, 'Llama', false],
  ['deepseek', /^deepseek/, 'DeepSeek', false],
  ['gemma', /^(gemma|codegemma)/, 'Gemma', false],
  ['phi', /^phi(?=\d|[-_:.]|$)/, 'Phi', false],
  ['granite', /^granite/, 'Granite', false],
  ['starcoder', /^(starcoder|starcoder2)/, 'StarCoder', true],
  ['command-r', /^command-?r/, 'Command R', false],
  ['glm', /^(glm|chatglm)/, 'GLM', false],
  ['kimi', /^kimi/, 'Kimi', false],
];

/** Path prefixes that mean the model is served from this machine. */
const LOCAL_PREFIX =
  /^(ollama|ollama_chat|lm[-_]?studio|lmstudio-community|lmstudio|llamacpp|llama[-_.]cpp|llamafile|jan|localai|vllm|hosted_vllm|mlx-community|local|llama-server|llama-swap|koboldcpp|tabbyapi|oobabooga|mlx|mlx-lm|exo|hf\.co|huggingface\.co|bartowski|unsloth|thebloke)$/i;
/** Prefixes of hosted gateways: the model is not local, but the label is still prettified. */
const CLOUD_PREFIX =
  /^(openrouter|together|togetherai|groq|fireworks|fireworks_ai|deepinfra|openai|azure|vertex_ai|gemini|google|bedrock|mistralai|meta-llama|deepseek-ai|qwen|huggingface)$/i;

const QUANT = /^(q\d(?:_[a-z0-9]+)*|iq\d(?:_[a-z0-9]+)*|fp16|f16|bf16|fp8|int4|int8|\d+bit)$/i;
const SIZE = /^\d+(?:\.\d+)?[bkmt]$/i;
const NOISE = new Set(['gguf', 'mlx', 'awq', 'gptq', 'latest', 'ggml']);

export function isAnthropicModel(id: string): boolean {
  return /claude/i.test(id) || ANTHROPIC_FAMILY.test(id);
}

function splitPrefixes(id: string): { prefixes: string[]; name: string } {
  const parts = id.trim().split('/').filter(Boolean);
  const name = parts.pop() ?? '';
  return { prefixes: parts, name };
}

function titleWord(w: string): string {
  if (!w) return w;
  if (/^\d/.test(w)) return w.replace(/(\d)([a-z])$/i, (_m, d: string, l: string) => d + l.toUpperCase());
  if (/^a\d+(?:\.\d+)?b$/i.test(w)) return w.toUpperCase(); // MoE active params: a3b
  if (/^v\d/i.test(w)) return 'V' + w.slice(1);
  if (/^[a-z]\d+$/i.test(w) && w.length <= 3) return w.toUpperCase(); // r1, k2
  return w[0].toUpperCase() + w.slice(1);
}

const SPECIAL_HEAD: Record<string, string> = {
  mixtral: 'Mixtral',
  ministral: 'Ministral',
  qwq: 'QwQ',
  codegemma: 'CodeGemma',
  chatglm: 'ChatGLM',
  tinyllama: 'TinyLlama',
};

function prettyLocalLabel(name: string, famIdx: number): string {
  // "model@q4_k_m" (LM Studio) and "model:tag" (Ollama)
  let rest = name;
  let quant = '';
  const at = rest.indexOf('@');
  if (at > 0) {
    quant = rest.slice(at + 1);
    rest = rest.slice(0, at);
  }
  let tag = '';
  const colon = rest.indexOf(':');
  if (colon > 0) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }
  const out: string[] = [];
  const quants: string[] = [];
  const word = (tok: string) => {
    if (!tok || NOISE.has(tok.toLowerCase())) return;
    if (QUANT.test(tok)) quants.push(tok.toUpperCase());
    else if (tok.includes('_')) tok.split('_').forEach(word);
    else if (SIZE.test(tok) || /^\d+x\d+[bm]$/i.test(tok)) out.push(tok.replace(/[a-z]$/i, (c) => c.toUpperCase()));
    else out.push(titleWord(tok));
  };
  let tail = rest;
  const fam = famIdx >= 0 ? LOCAL_FAMILIES[famIdx] : null;
  const m = fam ? fam[1].exec(rest.toLowerCase()) : null;
  if (fam && m) {
    const matched = m[0];
    tail = rest.slice(matched.length);
    const head = SPECIAL_HEAD[matched] ?? fam[2];
    const ver = fam[0] === 'command-r' || fam[0] === 'gpt-oss' || fam[0] === 'codellama' ? null : /^\d+(?:\.\d+)*(?=$|[-_a-z])/i.exec(tail);
    if (ver && /^\d+(?:\.\d+)*$/.test(ver[0])) {
      out.push(fam[3] ? head + ver[0] : `${head} ${ver[0]}`);
      tail = tail.slice(ver[0].length);
    } else out.push(head);
  }
  for (const tok of tail.split(/[-\s]+/)) word(tok);
  for (const tok of `${tag}-${quant}`.split(/[-\s]+/)) word(tok);
  return [...out, ...quants].join(' ');
}

/** "claude-opus-5-5" -> "Opus 5.5" (kept here so summarize.ts and the classifier agree). */
export function claudeLabel(model: string): string {
  const m = /claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?/i.exec(model);
  if (!m) return model.replace(/^claude-/, '');
  const fam = m[1][0].toUpperCase() + m[1].slice(1);
  return m[3] ? `${fam} ${m[2]}.${m[3]}` : `${fam} ${m[2]}`;
}

export function classifyModel(model: string | null | undefined): ModelClass {
  const raw = (model ?? '').trim();
  if (!raw) return { provider: 'other', family: 'other', label: '—' };
  const { prefixes, name } = splitPrefixes(raw);
  const prefixLocal = prefixes.some((p) => LOCAL_PREFIX.test(p));
  const prefixCloud = !prefixLocal && prefixes.some((p) => CLOUD_PREFIX.test(p));

  // Claude ids, including "anthropic/claude-..." and Bedrock/Vertex spellings
  if (!prefixLocal && isAnthropicModel(raw)) {
    const fam = ANTHROPIC_FAMILY.exec(raw)?.[1]?.toLowerCase() ?? 'other';
    return { provider: 'anthropic', family: fam, label: claudeLabel(name || raw) };
  }

  const lowName = name.toLowerCase();
  const famIdx = LOCAL_FAMILIES.findIndex(([, re]) => re.test(lowName));
  const famKey = famIdx >= 0 ? LOCAL_FAMILIES[famIdx][0] : null;
  // an Ollama-style "name:tag" id is a strong hint when the family is unknown
  const isLocal = prefixLocal || (!prefixCloud && famKey !== null) || (!prefixCloud && /^[\w.-]+:[\w.-]+$/.test(name) && !/^(gpt|o\d|gemini|grok)/i.test(name));
  const label = prettyLocalLabel(name, famIdx);
  if (isLocal) return { provider: 'local', family: famKey ?? 'local', label: label || raw };
  return { provider: 'other', family: 'other', label: famKey ? label : name || raw };
}

/** Keys two model ids can be compared by: servers and transcripts spell the same model differently. */
export function modelMatchKeys(model: string | null | undefined): string[] {
  const raw = (model ?? '').trim().toLowerCase();
  if (!raw) return [];
  const { name } = splitPrefixes(raw);
  const keys = new Set<string>();
  const add = (s: string) => {
    if (!s) return;
    keys.add(s);
    keys.add(s.replace(/:latest$/, ''));
    keys.add(s.replace(/@[\w.]+$/, ''));
    keys.add(s.replace(/-gguf$/, ''));
  };
  add(name);
  // "ollama/qwen3" -> "qwen3"; keep the multi-segment form too for LM Studio "publisher/model" ids
  const noProvider = raw
    .split('/')
    .filter(Boolean)
    .filter((p, i, a) => i === a.length - 1 || (!LOCAL_PREFIX.test(p) && !CLOUD_PREFIX.test(p)))
    .join('/');
  add(noProvider);
  return [...keys];
}

export function sameModel(a: string | null | undefined, b: string | null | undefined): boolean {
  const ka = modelMatchKeys(a);
  if (ka.length === 0) return false;
  const kb = new Set(modelMatchKeys(b));
  return ka.some((k) => kb.has(k));
}
