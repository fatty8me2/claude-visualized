import type { InboxItem, InboxKind } from '@core/inbox';
import { groupBySession } from '@core/inbox';
import { useInbox, useNow } from '../hooks';
import { ago } from '../util';

export const KIND_ICON: Record<InboxKind, string> = {
  permission: '\u{1F510}',
  input: '\u{1F4AC}',
  reply: '↩',
  'agent-failed': '✗',
  'tool-errors': '✗',
  usage: '◔',
  'api-error': '⚡',
  notice: '•',
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
        {KIND_ICON[item.kind]}
      </span>
      <div className="ttl">
        <b>{item.title}</b>
        {item.count > 1 && <span className="count">x{item.count}</span>}
        {item.resolved && <span className="tag">resolved</span>}
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
            <button title="Open this session in the Claude desktop app" onClick={() => void window.api.openInClaude(item.sessionId!)}>
              {'↗'} open in Claude
            </button>
            <button title="Select this session here" onClick={() => onShow(item.sessionId!, item.agentId)}>
              show
            </button>
          </>
        )}
        <button data-testid="inbox-dismiss" onClick={() => void window.api.dismissInbox(item.id)}>
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
    <div className="inbox-page" data-testid="inbox-page">
      <div className="inbox-head">
        <h2>Inbox</h2>
        <span className="sub">
          {inbox?.count ? `${inbox.count} need${inbox.count === 1 ? 's' : ''} you` : 'nothing needs you'}
          {resolved ? ` · ${resolved} resolved` : ''}
        </span>
        {resolved > 0 && (
          <button data-testid="inbox-clear" onClick={() => void window.api.clearInbox()}>
            dismiss all resolved
          </button>
        )}
      </div>
      {items.length === 0 && (
        <div className="inbox-empty" data-testid="inbox-empty">
          <div className="big">{'✓'}</div>
          All clear. Permission prompts, finished turns waiting for a reply, failures and usage limits from any session will show up here, and clear themselves
          when you answer.
        </div>
      )}
      {groups.map((g) => (
        <div className="inbox-group" key={g.sessionId ?? 'account'}>
          <div className="inbox-group-title">
            <span className="t">{g.title}</span>
          </div>
          {g.items.map((i) => (
            <Row key={i.id} item={i} now={now} onShow={onShow} />
          ))}
        </div>
      ))}
    </div>
  );
}
