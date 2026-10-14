import http from 'node:http';

export interface HookServerStatus {
  listening: boolean;
  port: number;
  error: string | null;
  received: number;
  lastAt: number | null;
}

/**
 * Receives Claude Code "http" hooks. Always answers 200 with an empty body right away, so a hook
 * can never block, deny or slow down a tool call; payloads are processed after responding.
 */
export class HookServer {
  private server: http.Server | null = null;
  status: HookServerStatus = { listening: false, port: 0, error: null, received: 0, lastAt: null };

  constructor(
    private onPayload: (payload: Record<string, unknown>) => void,
    private onStatus: (s: HookServerStatus) => void,
  ) {}

  start(port: number) {
    this.stop();
    this.status = { ...this.status, port, listening: false, error: null };
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url?.startsWith('/health')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, app: 'claude-visualized' }));
        return;
      }
      if (req.method !== 'POST' || !req.url?.startsWith('/hook')) {
        res.writeHead(404);
        res.end();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size <= 8 * 1024 * 1024) chunks.push(c);
      });
      req.on('end', () => {
        res.writeHead(200);
        res.end();
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          this.status.received++;
          this.status.lastAt = Date.now();
          this.onPayload(payload);
          this.onStatus(this.status);
        } catch {
          /* not JSON: ignore */
        }
      });
      req.on('error', () => {
        /* client went away */
      });
    });
    server.on('error', (err: NodeJS.ErrnoException) => {
      this.status = { ...this.status, listening: false, error: err.code === 'EADDRINUSE' ? `port ${port} is in use` : err.message };
      this.onStatus(this.status);
    });
    server.listen(port, '127.0.0.1', () => {
      this.status = { ...this.status, listening: true, error: null };
      this.onStatus(this.status);
    });
    this.server = server;
  }

  stop() {
    this.server?.close();
    this.server = null;
  }
}
