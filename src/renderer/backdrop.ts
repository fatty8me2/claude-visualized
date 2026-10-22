// Canvas painter for the graph backdrop: a parallax dot grid, ripples for spawn / done / error, a faint heat glow around running agents,
// data dust drifting toward them and an occasional radar sweep. One canvas, no React state: the component feeds it through plain method
// calls and it runs its own capped requestAnimationFrame loop. All maths lives in core/backdrop.ts.
import {
  BACKDROP_HEAVY,
  RIPPLE,
  addRipple,
  bandAt,
  dustAlpha,
  frameInterval,
  gridLayer,
  pruneRipples,
  rippleFront,
  shockPush,
  spawnDust,
  stepDust,
  sweepPos,
  type Dust,
  type Ripple,
} from '@core/backdrop';

type RGB = [number, number, number];

export interface BackdropNode {
  id: string;
  /** centre, in graph (world) coordinates */
  x: number;
  y: number;
  fam: string;
  running: boolean;
}

const FALLBACK: Record<string, RGB> = {
  opus: [180, 156, 255],
  sonnet: [240, 149, 106],
  haiku: [122, 167, 255],
  fable: [111, 208, 140],
  local: [94, 200, 190],
  other: [160, 150, 200],
  ok: [111, 208, 140],
  err: [255, 107, 122],
  bg: [14, 12, 20],
};

function parseColor(v: string, fb: RGB): RGB {
  const m = /^#([0-9a-f]{6})$/i.exec(v.trim());
  if (!m) return fb;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const rgb = (c: RGB, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const MAX_DUST = 36;
const GRID_NEAR: RGB = [150, 142, 205];
const GRID_FAR: RGB = [112, 128, 200];

export class BackdropEngine {
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private w = 0;
  private h = 0;
  private colors: Record<string, RGB> = { ...FALLBACK };
  private targets: { x: number; y: number; fam: string }[] = [];
  private ripples: Ripple[] = [];
  private dust: Dust[] = [];
  private raf = 0;
  private last = 0;
  private lastDraw = 0;
  private scaled: HTMLElement | null = null;
  private visible = true;
  private ro: ResizeObserver;
  private io: IntersectionObserver | null = null;
  private lit = new Float32Array(4096);
  private shown = '';
  private rev = 0;
  private stillKey = '';
  /** reduced motion, or paused (replay): a still grid, redrawn only when the view moves */
  frozen = false;
  paused = false;

  constructor(
    private wrap: HTMLElement,
    private canvas: HTMLCanvasElement,
  ) {
    this.ctx = canvas.getContext('2d', { alpha: true })!;
    const cs = getComputedStyle(wrap);
    for (const k of ['opus', 'sonnet', 'haiku', 'fable', 'local', 'ok', 'err']) this.colors[k] = parseColor(cs.getPropertyValue(`--${k}`), FALLBACK[k]);
    this.colors.bg = parseColor(cs.getPropertyValue('--bg'), FALLBACK.bg);
    this.ro = new ResizeObserver(() => {
      this.resize();
      this.invalidate();
    });
    this.ro.observe(wrap);
    if (typeof IntersectionObserver !== 'undefined') {
      this.io = new IntersectionObserver((e) => {
        this.visible = e[e.length - 1]?.isIntersecting ?? true;
        this.sync();
      });
      this.io.observe(wrap);
    }
    wrap.addEventListener('scroll', this.onScroll, { passive: true });
    document.addEventListener('visibilitychange', this.sync);
    this.resize();
    this.sync();
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.ro.disconnect();
    this.io?.disconnect();
    this.wrap.removeEventListener('scroll', this.onScroll);
    document.removeEventListener('visibilitychange', this.sync);
  }

  setNodes(nodes: BackdropNode[]) {
    this.rev++;
    this.targets = nodes.filter((n) => n.running).map((n) => ({ x: n.x, y: n.y, fam: n.fam }));
    if (!this.targets.length) this.dust.length = 0;
    this.sync();
  }

  addRipples(list: Ripple[]) {
    if (this.frozen || this.paused) return;
    for (const r of list) this.ripples = addRipple(this.ripples, r);
    this.sync();
  }

  /** a redraw is needed (scroll, zoom, resize): the loop does it by itself, a frozen backdrop draws once */
  invalidate() {
    if (!this.raf) this.raf = requestAnimationFrame(this.tick);
  }

  setFrozen(frozen: boolean, paused: boolean) {
    this.frozen = frozen;
    this.paused = paused;
    if (frozen || paused) this.ripples = [];
    this.sync();
    this.invalidate();
  }

  private onScroll = () => {
    if (!this.looping()) this.invalidate();
  };

  private looping() {
    return !this.frozen && !this.paused && this.visible && !document.hidden;
  }

  /** start or stop the loop depending on visibility and mode */
  private sync = () => {
    if (!this.raf) this.raf = requestAnimationFrame(this.tick);
  };

  private resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.wrap.clientWidth;
    const h = this.wrap.clientHeight;
    if (w === this.w && h === this.h && dpr === this.dpr) return;
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
  }

  private busy() {
    return this.ripples.length > 0;
  }

  private tick = (now: number) => {
    this.raf = 0;
    const live = this.looping();
    const running = this.targets.length;
    const interval = frameInterval(running, this.busy());
    if (live && now - this.lastDraw < interval - 2) {
      this.raf = requestAnimationFrame(this.tick);
      return;
    }
    const dt = Math.min(0.1, (now - (this.last || now)) / 1000);
    this.last = now;
    this.lastDraw = now;
    this.ripples = pruneRipples(this.ripples, now);
    this.draw(now, dt, live);
    if (live) this.raf = requestAnimationFrame(this.tick);
    else this.last = 0;
  };

  private frame() {
    if (!this.scaled || !this.scaled.isConnected) this.scaled = this.wrap.querySelector<HTMLElement>('.graph-scaled');
    const el = this.scaled;
    if (!el) return { ox: this.w / 2, oy: 40, s: 1 };
    const r = el.getBoundingClientRect();
    const b = this.wrap.getBoundingClientRect();
    const s = el.offsetWidth > 0 ? r.width / el.offsetWidth : 1;
    return { ox: r.left - b.left - this.wrap.clientLeft, oy: r.top - b.top - this.wrap.clientTop, s: s || 1 };
  }

  private draw(now: number, dt: number, animate: boolean) {
    const { ctx, w, h } = this;
    if (!w || !h) return;
    const fx = animate && !this.frozen;
    const heavy = this.targets.length > BACKDROP_HEAVY;
    const { ox, oy, s } = this.frame();
    // cheap mode with nothing moving is a still image: redraw only when the view or the agents changed
    const key = `${Math.round(ox)}|${Math.round(oy)}|${s.toFixed(3)}|${w}|${h}|${this.rev}`;
    if (heavy && fx && !this.ripples.length && key === this.stillKey) return;
    this.stillKey = key;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
    const t = fx ? now / 1000 : 0;

    // ---- heat: a faint glow under running agents, a map of where work is happening ----
    if (fx && this.targets.length) {
      ctx.globalCompositeOperation = 'lighter';
      const cap = heavy ? 10 : 24;
      const step = Math.max(1, Math.ceil(this.targets.length / cap));
      for (let i = 0; i < this.targets.length; i += step) {
        const n = this.targets[i];
        const cx = n.x * s + ox;
        const cy = n.y * s + oy;
        const r = (heavy ? 240 : 300) * s;
        if (cx < -r || cx > w + r || cy < -r || cy > h + r) continue;
        const c = this.colors[n.fam] ?? this.colors.other;
        const pulse = heavy ? 1 : 0.85 + 0.15 * Math.sin(t * 1.3 + i);
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
        g.addColorStop(0, rgb(c, 0.15 * pulse));
        g.addColorStop(0.45, rgb(c, 0.05 * pulse));
        g.addColorStop(1, rgb(c, 0));
        ctx.fillStyle = g;
        ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    // ---- ripples in screen space ----
    const rp = this.ripples.map((r) => {
      const f = rippleFront(r, now);
      return {
        r,
        cx: r.x * s + ox,
        cy: r.y * s + oy,
        rad: f.radius * s,
        wid: RIPPLE[r.kind].width * s,
        str: f.strength,
        col: this.colors[r.tone] ?? this.colors.other,
      };
    });

    // ---- grid: a far layer that lags behind the cards and a near one that sticks to them ----
    const breathe = fx && !heavy;
    this.grid(gridLayer({ x: ox, y: oy }, s, 38, 0.55), GRID_FAR, 0.12, 1, false, rp, s, t, breathe);
    this.grid(gridLayer({ x: ox, y: oy }, s, 22, 1), GRID_NEAR, 0.2, 1.35, true, rp, s, t, breathe);

    // ---- ripple rings ----
    if (rp.length) {
      ctx.globalCompositeOperation = 'lighter';
      for (const q of rp) {
        if (q.str <= 0.003) continue;
        const kind = q.r.kind;
        if (kind === 'done') {
          const br = 190 * s * (0.5 + 0.5 * Math.min(1, q.rad / (RIPPLE.done.reach * s)));
          const g = ctx.createRadialGradient(q.cx, q.cy, 0, q.cx, q.cy, br);
          g.addColorStop(0, rgb(q.col, 0.32 * q.str));
          g.addColorStop(1, rgb(q.col, 0));
          ctx.fillStyle = g;
          ctx.fillRect(q.cx - br, q.cy - br, br * 2, br * 2);
        }
        ctx.lineWidth = q.wid * 0.8;
        ctx.strokeStyle = rgb(q.col, 0.05 * q.str);
        ctx.beginPath();
        ctx.arc(q.cx, q.cy, q.rad, 0, Math.PI * 2);
        ctx.stroke();
        ctx.lineWidth = kind === 'error' ? 2 : 1.4;
        ctx.strokeStyle = rgb(q.col, (kind === 'done' ? 0.3 : 0.4) * q.str);
        ctx.beginPath();
        ctx.arc(q.cx, q.cy, q.rad, 0, Math.PI * 2);
        ctx.stroke();
        if (kind === 'error' && q.rad > 40 * s) {
          ctx.lineWidth = 1;
          ctx.strokeStyle = rgb(q.col, 0.32 * q.str);
          ctx.beginPath();
          ctx.arc(q.cx, q.cy, q.rad * 0.72, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    // ---- dust: faint motes drifting toward running agents ----
    if (fx && !heavy && this.targets.length) {
      const want = Math.min(MAX_DUST, 6 + this.targets.length * 5);
      const rng = Math.random;
      while (this.dust.length < want) {
        const d: Dust = { x: 0, y: 0, target: 0, born: now, speed: 50, swirl: 0 };
        spawnDust(d, this.targets, rng, now);
        d.born = now - rng() * 700;
        this.dust.push(d);
      }
      if (this.dust.length > want) this.dust.length = want;
      ctx.globalCompositeOperation = 'lighter';
      for (const d of this.dust) {
        if (d.target >= this.targets.length || !stepDust(d, this.targets, dt)) spawnDust(d, this.targets, rng, now);
        const a = dustAlpha(d, this.targets, now) * 0.4;
        const x = d.x * s + ox;
        const y = d.y * s + oy;
        if (a < 0.01 || x < -4 || y < -4 || x > w + 4 || y > h + 4) continue;
        const c = this.colors[this.targets[d.target]?.fam] ?? this.colors.other;
        ctx.fillStyle = rgb(c, a);
        ctx.fillRect(x - 0.7, y - 0.7, 1.6, 1.6);
        ctx.fillStyle = rgb(c, a * 0.35);
        ctx.fillRect(x - 3.2, y - 0.5, 2.4, 1);
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    // ---- radar sweep ----
    if (fx && !heavy) {
      const p = sweepPos(now);
      if (p >= 0) {
        const x = p * (w + 240) - 120;
        const g = ctx.createLinearGradient(x - 120, 0, x, 0);
        g.addColorStop(0, rgb(GRID_NEAR, 0));
        g.addColorStop(1, rgb(GRID_NEAR, 0.045));
        ctx.fillStyle = g;
        ctx.fillRect(x - 120, 0, 120, h);
        ctx.fillStyle = rgb(GRID_NEAR, 0.08);
        ctx.fillRect(x, 0, 1, h);
      }
    }

    // ---- vignette: focus the centre ----
    const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.72);
    g.addColorStop(0, rgb(this.colors.bg, 0));
    g.addColorStop(1, rgb(this.colors.bg, 0.62));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    const shown = `${this.ripples.length}|${this.targets.length}|${this.dust.length}|${this.frozen ? 'f' : this.paused ? 'p' : heavy ? 'h' : 'n'}`;
    if (shown !== this.shown) {
      this.shown = shown;
      this.canvas.dataset.bd = shown;
    }
  }

  private grid(
    L: ReturnType<typeof gridLayer>,
    col: RGB,
    baseA: number,
    size: number,
    marks: boolean,
    rp: { cx: number; cy: number; rad: number; wid: number; str: number; col: RGB; r: Ripple }[],
    s: number,
    t: number,
    breathe: boolean,
  ) {
    const { ctx, w, h } = this;
    ctx.fillStyle = rgb(col, 1);
    let nl = 0;
    const half = size / 2;
    const lit = this.lit;
    for (let j = 0, y = L.oy; y < h + L.step; j++, y += L.step) {
      for (let i = 0, x = L.ox; x < w + L.step; i++, x += L.step) {
        let a = baseA;
        if (breathe) a *= 0.78 + 0.22 * Math.sin(t * 0.55 + (i + L.i0) * 0.21 + (j + L.j0) * 0.17);
        let px = x;
        let py = y;
        let glow = 0;
        let who = -1;
        for (let k = 0; k < rp.length; k++) {
          const q = rp[k];
          if (q.str <= 0.003) continue;
          const dx = x - q.cx;
          const dy = y - q.cy;
          const d = Math.sqrt(dx * dx + dy * dy);
          const band = bandAt(d, q.rad, q.wid) * q.str;
          if (band > glow) {
            glow = band;
            who = k;
          }
          if (q.r.kind === 'error' && d > 0.5) {
            const push = shockPush(d / s, q.rad / s, q.str) * s;
            px += (dx / d) * push;
            py += (dy / d) * push;
          }
        }
        ctx.globalAlpha = a;
        ctx.fillRect(px - half, py - half, size, size);
        if (marks && ((i + L.i0) & 3) === 0 && ((j + L.j0) & 3) === 0) {
          ctx.globalAlpha = a * 1.7;
          ctx.fillRect(px - 3, py - 0.5, 6, 1);
          ctx.fillRect(px - 0.5, py - 3, 1, 6);
        }
        if (glow > 0.02 && nl < lit.length - 4) {
          lit[nl++] = px;
          lit[nl++] = py;
          lit[nl++] = glow;
          lit[nl++] = who;
        }
      }
    }
    ctx.globalAlpha = 1;
    if (nl) {
      ctx.globalCompositeOperation = 'lighter';
      let cur = -2;
      for (let n = 0; n < nl; n += 4) {
        const who = lit[n + 3];
        if (who !== cur) {
          cur = who;
          ctx.fillStyle = rgb(rp[who].col, 1);
        }
        const g = lit[n + 2];
        const sz = size + 2.2 * g;
        ctx.globalAlpha = Math.min(0.9, 0.7 * g + 0.1);
        ctx.fillRect(lit[n] - sz / 2, lit[n + 1] - sz / 2, sz, sz);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
  }
}
