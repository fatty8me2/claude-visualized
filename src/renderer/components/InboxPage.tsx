import type { InboxItem, InboxKind } from '@core/inbox';
import { groupBySession } from '@core/inbox';
import { useInbox, useNow } from '../hooks';
import { ago } from '../util';
import { openInClaude } from '../state/toast';
import { MachineChip } from './MachineChip';
import { Icon, type IconName } from './Icon';

export const KIND_ICON: Record<InboxKind, IconName> = {
  permission: 'permission',
  input: 'input',
  reply: 'reply',
  'agent-failed': 'error',
  'tool-errors': 'warn',
  usage: 'checklist',
  'api-error': 'apiError',
  notice: 'notice',
};

const KIND_LABEL: Record<InboxKind, string> = {
  permission: 'permission',
  input: 'needs input',
  reply: 'awaiting reply',
  'agent-failed': 'failed agent',
  'tool-errors': 'tool errors',
  usage: 'usage limit',
  'api-error': 'API error',
  notice: 'notice',
};

function Row({ item, now, onShow }: { item: InboxItem; now: number; onShow: (sessionId: string, agentId: string | null) => void }) {
  return (
    <div
      className={`inbox-item sev-${item.severity} ${item.resolved ? 'resolved' : ''}`}
      data-testid="inbox-item"
      data-kind={item.kind}
      data-resolved={item.resolved}
      data-id={item.id}
    >
      <span className="ico" title={KIND_LABEL[item.kind]}>
        <Icon name={KIND_ICON[item.kind]} size="sm" />
      </span>
      <div className="ttl">
        <MachineChip machine={item.machine} />
        <b>{item.title}</b>
        {item.count > 1 && <span className="count">×{item.count}</span>}
        {item.resolved && (
          <span className="tag chip" data-tone="ok">
            resolved
          </span>
        )}
        {item.agentName && item.agentName !== 'main' && <span className="agent">{item.agentName}</span>}
      </div>
      <span className="time" title={new Date(item.lastSeen).toLocaleString()}>
        {ago(item.lastSeen, now)}
      </span>
      <div className="detail" title={item.detail}>
        {item.detail}
      </div>
      <div className="acts">
        {item.sessionId && (
          <>
            <button
              title={item.machine ? `This session is running on ${item.machine}` : 'Open this session in the Claude desktop app'}
              onClick={() => void openInClaude(item.sessionId!)}
            >
              <Icon name="openExternal" size="xs" />
              open in Claude
            </button>
            <button title="Select this session here" onClick={() => onShow(item.sessionId!, item.agentId)}>
              show
            </button>
          </>
        )}
        <button className="ghost" data-testid="inbox-dismiss" onClick={() => void window.api.dismissInbox(item.id)}>
          dismiss
        </button>
      </div>
    </div>
  );
}

/** Everything that needs you, across all sessions. */
export function InboxPage({ onShow }: { onShow: (sessionId: string, agentId: string | null) => void }) {
  const inbox = useInbox();
  const now = useNow(5000);
  const items = inbox?.items ?? [];
  const resolved = items.filter((i) => i.resolved).length;
  const groups = groupBySession(items);
  return (
    <div className="page" data-testid="inbox-page">
      <div className="page-head">
        <h2>
          <Icon name="inbox" size="md" />
          Inbox
        </h2>
        <span className="sub">
          {!inbox ? '' : inbox.count ? `${inbox.count} need${inbox.count === 1 ? 's' : ''} you` : 'nothing needs you'}
          {resolved ? ` · ${resolved} resolved` : ''}
        </span>
        <div className="actions">
          {resolved > 0 && (
            <button data-testid="inbox-clear" onClick={() => void window.api.clearInbox()}>
              dismiss all resolved
            </button>
          )}
        </div>
      </div>
      <div className="inbox-page">
        {!inbox && <span className="loading">loading…</span>}
        {inbox && items.length === 0 && (
          <div className="inbox-empty empty-card" data-testid="inbox-empty">
            <span className="big">
              <Icon name="done" size="lg" />
            </span>
            <div className="empty-title">All clear</div>
            <div>
              Permission prompts, finished turns waiting for a reply, failures and usage limits from any session show up here, and clear themselves when you
              answer.
            </div>
          </div>
        )}
        {groups.map((g) => (
          <div className="inbox-group" key={g.sessionId ?? 'account'}>
            <div className="inbox-group-title">
              <span className="t">{g.title}</span>
              <MachineChip machine={g.items[0]?.machine} />
            </div>
            {g.items.map((i) => (
              <Row key={i.id} item={i} now={now} onShow={onShow} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
