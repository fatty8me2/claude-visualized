// Guards against shipping the owner's data or any credential: scans git-tracked files and the built output (out/, when present)
// for owner-identifying strings and token shapes, and pins the privacy-relevant defaults and packaging rules.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

// patterns are assembled from pieces so this file does not match itself
const j = (...p: string[]) => p.join('');
const OWNER_USER = new RegExp(j('fat', 'ty(?!8me2)'), 'i'); // the owner's OS user name (the public GitHub handle ends in 8me2)
const NOREPLY = new RegExp(j('users\\.', 'noreply\\.github'), 'i');
const WIN_HOME = /[A-Za-z]:[\\/]+Users[\\/]+(?!me\b|x\b|you\b|user\b|name\b|demo\b|<)[A-Za-z0-9._-]+/;
const POSIX_HOME = /\/(?:Users|home)\/(?!me\b|x\b|you\b|user\b|name\b|demo\b|<)[A-Za-z0-9._-]+/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.(?:com|net|org|io|dev|me|co|app|ai|edu|gov)\b/gi;
const EMAIL_OK = /@(?:example\.|users\.noreply\.github)/i;
const TOKENS: [string, RegExp][] = [
  ['anthropic key/token', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['github token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}/],
  ['aws key', /\bAKIA[0-9A-Z]{16}\b/],
  ['slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

function tracked(): string[] | null {
  try {
    return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
      .split('\0')
      .filter(Boolean);
  } catch {
    return null; // not a git checkout (e.g. a source tarball)
  }
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const TEXT = /\.(?:ts|tsx|js|mjs|cjs|json|md|css|html|yml|yaml|cmd|txt|svg)$|^\.[a-z]+$/i;
const SELF = 'tests/unit/privacy.test.ts';

/** what a text file leaks, as labels (never the matched value itself, which may be a secret) */
function leaks(text: string, opts: { emails: boolean }): string[] {
  const found: string[] = [];
  if (OWNER_USER.test(text)) found.push('owner user name');
  if (NOREPLY.test(text) && /\d{6,}\+/.test(text)) found.push('owner noreply email');
  if (WIN_HOME.test(text)) found.push('windows home path');
  if (POSIX_HOME.test(text)) found.push('posix home path');
  for (const [label, re] of TOKENS) if (re.test(text)) found.push(label);
  if (opts.emails) {
    for (const m of text.match(EMAIL) ?? []) if (!EMAIL_OK.test(m) && !/^tray@\dx/.test(m)) found.push('email address');
  }
  return found;
}

describe('privacy: tracked files', () => {
  const files = tracked();
  it.skipIf(!files)('contain no owner identity, home paths, emails or tokens', () => {
    const bad: string[] = [];
    for (const f of files!) {
      if (f === SELF || f === 'package-lock.json' || !TEXT.test(f)) continue;
      const l = leaks(read(f), { emails: true });
      if (l.length) bad.push(`${f}: ${[...new Set(l)].join(', ')}`);
    }
    expect(bad).toEqual([]);
  });

  it.skipIf(!files)('do not track local-only folders or data', () => {
    const bad = files!.filter((f) => /^(?:\.claude\/|release\/|out\/|node_modules\/|tests\/e2e\/artifacts)|\.(?:log|sqlite|db|jsonl|pem|key)$|credentials|\.env$/i.test(f));
    expect(bad).toEqual([]);
  });

  it('git ignores build output, logs and e2e artifacts', () => {
    const ig = read('.gitignore');
    for (const p of ['node_modules/', 'out/', 'release/', '*.log', 'tests/e2e/artifacts/']) expect(ig).toContain(p);
  });
});

describe('privacy: built output', () => {
  const out = path.join(root, 'out');
  const built = fs.existsSync(out);
  it.skipIf(!built)('contains no owner identity, home paths or tokens', () => {
    const bad: string[] = [];
    for (const f of walk(out)) {
      if (!/\.(?:js|css|html|map)$/.test(f)) continue;
      let text = fs.readFileSync(f, 'utf8');
      // the public repo and the app id legitimately name the GitHub handle
      text = text.replaceAll(j('fat', 'ty8me2/claude-visualized'), '').replaceAll(j('com.fat', 'ty8me2.claudevisualized'), '');
      const l = leaks(text, { emails: false });
      if (/\.map$/.test(f)) l.push('source map shipped');
      if (l.length) bad.push(`${path.relative(root, f)}: ${[...new Set(l)].join(', ')}`);
    }
    expect(bad).toEqual([]);
  });
});

describe('privacy: packaging', () => {
  const pkg = JSON.parse(read('package.json')) as { build: { files: string[]; extraResources: { from: string }[]; publish: object[] } };
  it('ships only the build output, package.json and the tray icons', () => {
    const include = pkg.build.files.filter((p) => !p.startsWith('!'));
    expect([...include].sort()).toEqual(['out/**/*', 'package.json']);
    expect(pkg.build.extraResources.map((r) => r.from)).toEqual(['build/tray']);
  });
  it('updates come from public GitHub releases with no embedded token', () => {
    expect(pkg.build.publish.map((p) => (p as { provider: string }).provider)).toEqual(['github']);
    expect(JSON.stringify(pkg.build.publish)).not.toMatch(/token/i);
  });
});

describe('privacy: per-user runtime defaults', () => {
  it('peer sharing is off by default and only starts when the user turned it on', () => {
    expect(read('src/main/config.ts')).toMatch(/shareEnabled: false/);
    expect(read('src/main/index.ts')).toMatch(/if \(config\.shareEnabled\) void peers\.setSharing\(true\)/);
  });
  it('the device name comes from the OS, not a constant', () => {
    expect(read('src/main/peer/name.ts')).toMatch(/os\.hostname\(\)/);
  });
  it("the Claude home honors CLAUDE_CONFIG_DIR and falls back to the current user's ~/.claude", () => {
    const p = read('src/main/paths.ts');
    expect(p).toMatch(/CLAUDE_CONFIG_DIR/);
    expect(p).toMatch(/os\.homedir\(\)/);
  });
  it('the peer link never carries credentials or settings', () => {
    const svc = read('src/main/peer/service.ts');
    expect(svc).not.toMatch(/credentials|oauthToken|accessToken|refreshToken|settingsPath|loadConfig/);
  });
  it('credentials never reach logs or the app data folder', () => {
    for (const f of ['src/main/usageApi.ts', 'src/main/oauthRefresh.ts']) {
      const src = read(f);
      expect(src).not.toMatch(/console\.(?:log|error|warn|info)/);
      expect(src).not.toMatch(/userData/);
    }
  });
});

describe('test-only URL overrides', () => {
  it('cannot redirect the login token in an installed build', async () => {
    const { testOverride } = await import('../../src/main/paths');
    const saved = { electron: process.versions.electron, defaultApp: (process as { defaultApp?: boolean }).defaultApp, url: process.env.CLAUDE_VIS_USAGE_URL };
    process.env.CLAUDE_VIS_USAGE_URL = 'http://127.0.0.1:1/usage';
    try {
      expect(testOverride('CLAUDE_VIS_USAGE_URL')).toBe('http://127.0.0.1:1/usage');
      Object.defineProperty(process.versions, 'electron', { value: '44.0.0', configurable: true });
      (process as { defaultApp?: boolean }).defaultApp = undefined;
      expect(testOverride('CLAUDE_VIS_USAGE_URL')).toBeUndefined();
    } finally {
      Object.defineProperty(process.versions, 'electron', { value: saved.electron, configurable: true });
      (process as { defaultApp?: boolean }).defaultApp = saved.defaultApp;
      if (saved.url === undefined) delete process.env.CLAUDE_VIS_USAGE_URL;
      else process.env.CLAUDE_VIS_USAGE_URL = saved.url;
    }
  });
});
