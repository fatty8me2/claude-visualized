import fs from 'node:fs/promises';
import path from 'node:path';
import { STATUSLINE_FILE } from '@core/hooksConfig';
import { claudeHome } from './paths';

/**
 * Claude Code runs the statusLine command with a JSON blob on stdin (model, context window,
 * rate_limits.five_hour / seven_day ...). This script forwards it to the app and prints a short
 * status line for terminal sessions. If the app isn't running it just prints and exits.
 */
function forwarderSource(port: number): string {
  return `// Claude Visualized status line (generated; safe to delete with "Remove hooks" in the app).
// Forwards Claude Code's status JSON to the app on 127.0.0.1 and prints a short status line.
import http from 'node:http';
const PORT = ${port};
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  let d = {};
  try { d = JSON.parse(raw); } catch {}
  const pct = (w) => (w && typeof w.used_percentage === 'number' ? Math.round(w.used_percentage) + '%' : null);
  const parts = [];
  if (d.model && d.model.display_name) parts.push(d.model.display_name);
  if (d.context_window && typeof d.context_window.used_percentage === 'number') parts.push('ctx ' + Math.round(d.context_window.used_percentage) + '%');
  const rl = d.rate_limits || {};
  if (pct(rl.five_hour)) parts.push('5h ' + pct(rl.five_hour));
  if (pct(rl.seven_day)) parts.push('wk ' + pct(rl.seven_day));
  process.stdout.write(parts.join(' · '));
  const done = () => process.exit(0);
  const req = http.request({ host: '127.0.0.1', port: PORT, path: '/statusline', method: 'POST', timeout: 400, headers: { 'content-type': 'application/json' } }, (r) => { r.resume(); r.on('end', done); });
  req.on('error', done);
  req.on('timeout', () => { req.destroy(); done(); });
  req.end(raw || '{}');
});
`;
}

export function statusLineScriptPath(): string {
  return path.join(claudeHome(), STATUSLINE_FILE);
}

/** Command for settings.json; forward slashes and quotes work under both Git Bash and PowerShell. */
export function statusLineCommand(): string {
  return `node "${statusLineScriptPath().replace(/\\/g, '/')}"`;
}

export async function writeStatusLineScript(port: number) {
  await fs.mkdir(path.dirname(statusLineScriptPath()), { recursive: true });
  await fs.writeFile(statusLineScriptPath(), forwarderSource(port), 'utf8');
}

export async function removeStatusLineScript() {
  await fs.rm(statusLineScriptPath(), { force: true });
}
