import { contextInfo, type ContextInfo } from '@core/context';
import type { AgentNode } from '@core/state';
import { formatTokens } from '@core/summarize';
import { useLocalWindow } from '../localStore';

// the user's default model alias, fetched once: "opus[1m]" means Opus agents run with the 1M window
let settingsModel: string | null = null;
void window.api?.claudeModelSetting().then((m) => (settingsModel = m));

const sizeText = (size: number) => (size >= 1_000_000 ? `${size / 1_000_000}M` : formatTokens(size));

export function contextTitle(c: ContextInfo): string {
  if (!c.windowKnown) return `context ${formatTokens(c.tokens)} tokens (window size unknown: no running server reported one for this model)`;
  return `context ${formatTokens(c.tokens)} / ${sizeText(c.size)}${c.estimated ? ' (est.)' : ''}`;
}

function useCtx(agent: AgentNode | undefined): ContextInfo | null {
  // local models: the window is whatever a running server reports; otherwise tokens only
  const win = useLocalWindow(agent?.model);
  return agent ? contextInfo(agent, settingsModel, win) : null;
}

/** Compact "ctx 46%" label, coloured by how close the window is to auto-compaction. Tokens only when the window is unknown. */
export function CtxChip({ agent, label = 'ctx' }: { agent: AgentNode | undefined; label?: string }) {
  const c = useCtx(agent);
  if (!c) return null;
  return (
    <span className={`ctx ${c.level}`} title={contextTitle(c)}>
      {label} {c.windowKnown ? `${c.pct}%` : formatTokens(c.tokens)}
    </span>
  );
}

// arc gauge geometry: a 270 degree sweep (gap at the bottom), r = 25 in a 64 box, pathLength normalised to 100
const SWEEP = 75;
const tickAt = (p: number) => {
  const a = ((135 + 270 * p) * Math.PI) / 180;
  const pt = (r: number) => `${(32 + r * Math.cos(a)).toFixed(2)}`;
  const pty = (r: number) => `${(32 + r * Math.sin(a)).toFixed(2)}`;
  return { x1: pt(21), y1: pty(21), x2: pt(29.5), y2: pty(29.5) };
};
const TICKS = [0.7, 0.9].map(tickAt);
const LEVEL_NOTE = { ok: 'room to spare', warn: 'getting full', hot: 'compacting soon' } as const;

/** Radial gauge + "46% · 457k / 1M" for the side panel; glows as the window nears auto-compaction. */
export function CtxBar({ agent }: { agent: AgentNode | undefined }) {
  const c = useCtx(agent);
  if (!c) return null;
  if (!c.windowKnown) {
    return (
      <div className="ctx ctxbar" title={contextTitle(c)}>
        <span>context {formatTokens(c.tokens)} tokens · window unknown</span>
      </div>
    );
  }
  const f = Math.min(1, c.fraction);
  return (
    <div className={`ctx ctxbar ctxgauge ${c.level}`} title={contextTitle(c)} data-testid="ctx-gauge">
      <div className="cg-dial">
        <i className="cg-halo" aria-hidden />
        <svg viewBox="0 0 64 64" aria-hidden>
          <circle className="cg-track" cx="32" cy="32" r="25" pathLength={100} strokeDasharray={`${SWEEP} 100`} transform="rotate(135 32 32)" />
          <circle className="cg-fill" cx="32" cy="32" r="25" pathLength={100} strokeDasharray={`${(SWEEP * f).toFixed(2)} 100`} transform="rotate(135 32 32)" />
          {TICKS.map((t, i) => (
            <line key={i} className="cg-tick" {...t} />
          ))}
        </svg>
        <span className="cg-pct">
          {c.pct}
          <small>%</small>
        </span>
      </div>
      <div className="cg-tx">
        <span className="cg-k">context</span>
        <span className="cg-v">
          {formatTokens(c.tokens)} <em>/ {sizeText(c.size)}</em>
          {c.estimated ? <small> est.</small> : null}
        </span>
        <span className="cg-note">{LEVEL_NOTE[c.level]}</span>
      </div>
    </div>
  );
}
