import { execFileSync } from 'node:child_process';
import os from 'node:os';

/** This computer's name as shown on the other side: the macOS "Computer Name", else the host name without a domain. */
export function deviceName(): string {
  const env = process.env.CLAUDE_VIS_DEVICE_NAME?.trim();
  if (env) return env.slice(0, 60);
  if (process.platform === 'darwin') {
    try {
      const n = execFileSync('scutil', ['--get', 'ComputerName'], { encoding: 'utf8', timeout: 2000 }).trim();
      if (n) return n.slice(0, 60);
    } catch {
      /* fall back to the host name */
    }
  }
  const h = os.hostname().replace(/\.(local|lan|home)$/i, '');
  return (h.split('.')[0] || 'computer').slice(0, 60);
}
