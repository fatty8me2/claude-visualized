import http from 'node:http';

export interface HookServerStatus {
  listening: boolean;
  port: number;
  error: string | null;
  received: number;
  lastAt: number | null;
}

const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

/**
 * Receives Claude Code "http" hooks. Always answers 200 with an empty body right away, so a hook
 * can never block, deny or slow down a tool call; payloads are processed after responding.
 */
export class HookServer {
  private server: http.Server | null = null;
  status: HookServerStatus = { listening: false, port: 0, error: null, received: 0, lastAt: null };

  constructor(
    private onPayload: (payload: Record<string, unknown>) => void,
    private onStatusline: (payload: Record<string, unknown>) => void,
    private onStatus: (s: HookServerStatus) => void,
  ) {}

  start(port: number) {
    this.stop();
    this.status = { ...this.status, port, listening: false, error: null };
    const server = http.createServer((req, res) => {
      // This port is for local tools only. A web page (it sends an Origin header) or a DNS-rebinding trick (a foreign Host)
      // must not be able to feed events in.
      if (req.headers.origin || !LOCAL_HOST.test(req.headers.host ?? '')) {
        res.writeHead(403);
        res.end();
        return;
      }
      if (req.method === 'GET' && req.url?.startsWith('/health')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, app: 'claude-visualized' }));
        return;
      }
      const isStatusline = req.url?.startsWith('/statusline') ?? false;
      if (req.method !== 'POST' || !(req.url?.startsWith('/hook') || isStatusline)) {
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
          if (isStatusline) {
            this.onStatusline(payload);
            return;
          }
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
