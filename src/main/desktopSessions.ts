import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * The Claude desktop app keeps one record per Code session at
 *   <appData>/Claude/claude-code-sessions/<account>/<org>/local_<id>.json
 * with { sessionId: "local_…", cliSessionId: <transcript uuid>, title, isArchived, lastActivityAt }.
 * That maps transcripts to the desktop's own ids, which the claude://code/continue?session=local_…
 * deep link needs, and gives an activity time that app updates don't disturb.
 */
export interface DesktopSession {
  localId: string;
  title: string | null;
  archived: boolean;
  lastActivityAt: number | null;
}

export function desktopSessionsDir(): string {
  if (process.env.CLAUDE_VIS_DESKTOP_DIR) return process.env.CLAUDE_VIS_DESKTOP_DIR;
  const base =
    process.platform === 'win32'
      ? process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support')
        : process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  return path.join(base, 'Claude', 'claude-code-sessions');
}

export class DesktopSessionIndex {
  private cache = new Map<string, { mtime: number; cli: string | null; rec: DesktopSession | null }>();
  byCliId = new Map<string, DesktopSession>();

  async scan(): Promise<void> {
    const files: string[] = [];
    const walk = async (dir: string, depth: number) => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory() && depth < 3) await walk(p, depth + 1);
        else if (e.isFile() && /^local_[A-Za-z0-9-]+\.json$/.test(e.name)) files.push(p);
      }
    };
    await walk(desktopSessionsDir(), 0);
    const next = new Map<string, DesktopSession>();
    for (const f of files) {
      let mtime = 0;
      try {
        mtime = (await fs.stat(f)).mtimeMs;
      } catch {
        continue;
      }
      let c = this.cache.get(f);
      if (!c || c.mtime !== mtime) {
        c = { mtime, cli: null, rec: null };
        try {
          const j = JSON.parse(await fs.readFile(f, 'utf8'));
          if (typeof j?.cliSessionId === 'string' && typeof j?.sessionId === 'string') {
            c.cli = j.cliSessionId;
            c.rec = {
              localId: j.sessionId,
              title: typeof j.title === 'string' ? j.title : null,
              archived: j.isArchived === true,
              lastActivityAt: typeof j.lastActivityAt === 'number' ? j.lastActivityAt : null,
            };
          }
        } catch {
          /* half-written: keep trying next scan */
          continue;
        }
        this.cache.set(f, c);
      }
      if (c.cli && c.rec) next.set(c.cli, c.rec);
    }
    this.byCliId = next;
  }
}

/** Deep link that opens a session in the Claude desktop app (imports CLI-only sessions). */
export function claudeDeepLink(transcriptId: string, desktop: DesktopSession | undefined): string {
  return desktop ? `claude://code/continue?session=${encodeURIComponent(desktop.localId)}` : `claude://resume?session=${encodeURIComponent(transcriptId)}`;
}
