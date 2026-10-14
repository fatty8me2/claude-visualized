import { classifyModel } from '@core/models';
import { loadedText, localSummary } from '@core/localModels';
import type { AgentNode } from '@core/state';
import { useLocalLink, useLocalModels } from '../localStore';

export const isLocalModel = (model: string | null | undefined) => classifyModel(model).provider === 'local';

/** Small "⌂ local" tag: this agent runs on a local model (no Anthropic cost or limits). */
export function LocalTag({ title }: { title?: string }) {
  return (
    <span className="local-tag" data-testid="local-tag" title={title ?? 'Runs on a local model: no Anthropic cost, no 5-hour or weekly limits'}>
      ⌂ local
    </span>
  );
}

/** Agent card rows: the model id, and where (if anywhere) a monitored server has it loaded. */
export function LocalLinkLine({ agent }: { agent: AgentNode }) {
  const link = useLocalLink(agent.model);
  const { servers } = useLocalModels();
  if (!isLocalModel(agent.model)) return null;
  const anyUp = servers.some((s) => s.state === 'up');
  const text = link ? loadedText(link) : anyUp ? 'not loaded right now' : 'no local server detected';
  return (
    <div className={`local-link ${link ? 'linked' : ''}`} data-testid="local-link" title={`${agent.model}\n${text}`}>
      <span className="ll-top">
        <LocalTag /> <span className="ll-id">{agent.model}</span>
      </span>
      <span className="ll-sub">{text}</span>
    </div>
  );
}

/** Top-bar chip: "⌂ 2 models loaded". Hidden when no local server is up. */
export function LocalChip({ onOpen }: { onOpen: () => void }) {
  const { servers } = useLocalModels();
  const { up, loaded } = localSummary(servers);
  if (up === 0) return null;
  const names = servers.filter((s) => s.state === 'up').map((s) => `${s.name} ${s.loaded.length} loaded`).join(' · ');
  return (
    <button className={`local-chip ${loaded ? 'active' : ''}`} data-testid="local-chip" onClick={onOpen} title={`${names}\nClick for the local models view`}>
      ⌂ {loaded === 0 ? 'no model loaded' : `${loaded} model${loaded === 1 ? '' : 's'} loaded`}
    </button>
  );
}
