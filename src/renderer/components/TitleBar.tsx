import { Icon, type IconName } from './Icon';
import { LocalChip } from './LocalBits';
import { UsageMeters } from './UsageMeters';
import { useSessions } from '../hooks';
import '../chrome.css';

/** The app's mark: a main agent with two subagents. */
export function BrandMark({ size = 16 }: { size?: number }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <path d="M8 4.6v2.6M8 7.2H4.2v3.4M8 7.2h3.8v3.4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" opacity="0.65" />
      <circle cx="8" cy="3.2" r="2.2" fill="var(--opus)" />
      <circle cx="4.2" cy="12.4" r="2" fill="var(--sonnet)" />
      <circle cx="11.8" cy="12.4" r="2" fill="var(--haiku)" />
    </svg>
  );
}

/**
 * The window's title bar (the native one is hidden, see createMain in main/index.ts). It is a drag region; everything interactive
 * opts out with -webkit-app-region: no-drag. Global things live here so every page has them: usage meters, local models, mini
 * view and settings. The native window buttons sit to the right (Windows) or left (macOS); env(titlebar-area-*) keeps clear of them.
 */
/** Live-session count with a heartbeat; the beat quickens while agents run and turns amber while one waits on you. */
function LiveBeat({ live, running, waiting }: { live: number; running: number; waiting: boolean }) {
  if (live === 0) return null;
  const state = waiting ? 'wait' : running > 0 ? 'busy' : 'calm';
  const tip = `${live} live session${live === 1 ? '' : 's'}${running ? `, ${running} subagent${running === 1 ? '' : 's'} running` : ''}${waiting ? ', waiting for you' : ''}`;
  return (
    <span className="tb-live" data-state={state} data-testid="tb-live" title={tip}>
      <i className="tb-beat" aria-hidden />
      <b>{live}</b>
      <span>live</span>
    </span>
  );
}

export function TitleBar({ page, icon, onSettings, onLocal }: { page: string; icon: IconName; onSettings: () => void; onLocal: () => void }) {
  const sessions = useSessions();
  const liveList = (sessions ?? []).filter((x) => x.live && !x.offlineSince);
  const running = liveList.reduce((n, x) => n + (x.running ?? 0), 0);
  const waiting = liveList.some((x) => x.waiting);
  const activity = waiting ? 'wait' : running > 0 ? 'busy' : liveList.length > 0 ? 'live' : 'idle';
  return (
    <header className="titlebar" data-testid="titlebar" data-activity={activity}>
      <i className="tb-scan" aria-hidden />
      <div className="tb-inner">
        <span className="tb-brand">
          <BrandMark />
          Claude Visualized
        </span>
        <span className="tb-crumb">
          <Icon name="chevronRight" size="xs" />
          <Icon name={icon} size="xs" />
          {page}
        </span>
        <span className="tb-spacer" />
        <LiveBeat live={liveList.length} running={running} waiting={waiting} />
        <UsageMeters />
        <LocalChip onOpen={onLocal} />
        <button
          className="btn-icon ghost"
          data-tour="mini"
          onClick={() => void window.api.toggleMini()}
          aria-label="mini view"
          title="Mini view: a small always-on-top window"
        >
          <Icon name="mini" />
        </button>
        <button className="btn-icon ghost" data-tour="hooks" onClick={onSettings} aria-label="hooks and settings" title="Hooks and settings">
          <Icon name="settings" />
        </button>
      </div>
    </header>
  );
}
