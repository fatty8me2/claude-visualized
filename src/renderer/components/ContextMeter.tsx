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

/** Bar + "context 46% · 457k / 1M" line for the side panel. */
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
  return (
    <div className={`ctx ctxbar ${c.level}`} title={contextTitle(c)}>
      <span className="track">
        <i style={{ width: `${Math.min(100, c.fraction * 100)}%` }} />
      </span>
      <span>
        context {c.pct}% · {formatTokens(c.tokens)} / {sizeText(c.size)}
        {c.estimated ? ' (est.)' : ''}
      </span>
    </div>
  );
}
