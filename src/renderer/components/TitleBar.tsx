import { Icon, type IconName } from './Icon';
import { LocalChip } from './LocalBits';
import { UsageMeters } from './UsageMeters';

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
export function TitleBar({ page, icon, onSettings, onLocal }: { page: string; icon: IconName; onSettings: () => void; onLocal: () => void }) {
  return (
    <header className="titlebar" data-testid="titlebar">
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
