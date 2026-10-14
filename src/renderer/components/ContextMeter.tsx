import { contextInfo, type ContextInfo } from '@core/context';
import type { AgentNode } from '@core/state';
import { formatTokens } from '@core/summarize';

// the user's default model alias, fetched once: "opus[1m]" means Opus agents run with the 1M window
let settingsModel: string | null = null;
void window.api?.claudeModelSetting().then((m) => (settingsModel = m));

export function contextTitle(c: ContextInfo): string {
  const size = c.size >= 1_000_000 ? `${c.size / 1_000_000}M` : formatTokens(c.size);
  return `context ${formatTokens(c.tokens)} / ${size}${c.estimated ? ' (est.)' : ''}`;
}

/** Compact "ctx 46%" label, coloured by how close the window is to auto-compaction. */
export function CtxChip({ agent, label = 'ctx' }: { agent: AgentNode | undefined; label?: string }) {
  const c = agent ? contextInfo(agent, settingsModel) : null;
  if (!c) return null;
  return (
    <span className={`ctx ${c.level}`} title={contextTitle(c)}>
      {label} {c.pct}%
    </span>
  );
}

/** Bar + "context 46% · 457k / 1M" line for the side panel. */
export function CtxBar({ agent }: { agent: AgentNode | undefined }) {
  const c = agent ? contextInfo(agent, settingsModel) : null;
  if (!c) return null;
  return (
    <div className={`ctx ctxbar ${c.level}`} title={contextTitle(c)}>
      <span className="track">
        <i style={{ width: `${Math.min(100, c.fraction * 100)}%` }} />
      </span>
      <span>
        context {c.pct}% · {formatTokens(c.tokens)} / {c.size >= 1_000_000 ? `${c.size / 1_000_000}M` : formatTokens(c.size)}
        {c.estimated ? ' (est.)' : ''}
      </span>
    </div>
  );
}
