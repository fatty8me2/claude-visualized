import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useDialogFocus } from '../state/dialogFocus';
import type { SetupStatusView } from '@core/api';
import { buildChecklist, LOGIN_COMMAND, type CheckItem } from '@core/onboarding';
import type { HookInstallState } from '@core/hooksConfig';
import { useUsage, useConfig } from '../hooks';
import { CopyButton } from './CopyButton';
import { Icon } from './Icon';
import '../dialogs.css';

const CHECK_ICON = { ok: 'done', warn: 'warn', todo: 'idle' } as const;

function CheckRow({ item, children }: { item: CheckItem; children?: React.ReactNode }) {
  return (
    <div className={`check ${item.status}`} data-check={item.id}>
      <span className="glyph">
        <Icon name={CHECK_ICON[item.status]} size="sm" />
      </span>
      <div className="cbody">
        <div className="ttl">
          {item.title}
          {item.optional && <span className="opt">optional</span>}
        </div>
        <div className="det">{item.detail}</div>
        {children}
      </div>
    </div>
  );
}

export function Welcome({ onTour, onSkip, onOpenSettings }: { onTour: () => void; onSkip: () => void; onOpenSettings: () => void }) {
  const usage = useUsage();
  const config = useConfig();
  const [setup, setSetup] = useState<SetupStatusView | null>(null);
  const [hooks, setHooks] = useState<HookInstallState | 'error' | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = () => {
      void window.api.setupStatus().then((s) => alive && setSetup(s));
      void window.api.hookState().then((h) => alive && setHooks(h.state));
    };
    poll();
    const t = setInterval(poll, 2500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const items = buildChecklist({
    claude: setup ? { projectsDirExists: setup.projectsDirExists, sessionCount: setup.sessionCount } : null,
    usageState: usage ? usage.api?.state : undefined,
    hooks,
    launchAtLogin: config?.launchAtLogin,
    hotkey: config?.miniHotkey,
  });
  const by = (id: string) => items.find((i) => i.id === id)!;
  const usageItem = by('usage');

  return (
    <div className="overlay welcome-overlay" data-testid="welcome">
      <div className="dialog dlg welcome panel-raised" role="dialog" aria-modal="true" aria-label="Welcome" ref={useDialogFocus(onSkip)}>
        <div className="w-brand">
          <b>◆</b> CLAUDE VISUALIZED
        </div>
        <h2>Welcome</h2>
        <p>
          This app shows what Claude Code is doing, live. You get a picture of the main agent and every helper it starts, whether it is planning or building,
          and how much of your 5-hour and weekly limits you have used.
        </p>
        <p>
          It reads files Claude Code already writes on your computer and never edits your sessions. Online it only does three things: it asks Anthropic (api.anthropic.com) for your usage numbers, renews your Claude Code sign-in when it is about to expire (platform.claude.com; Windows and Linux only), and checks GitHub for app updates. Your sessions are never uploaded.
        </p>

        <div className="w-sub">SETUP CHECKLIST</div>
        <div className="checks">
          <CheckRow item={by('claude')} />
          <CheckRow item={usageItem}>
            {usageItem.status === 'warn' && (
              <div className="fix">
                <div className="cmdrow">
                  <code>{LOGIN_COMMAND}</code>
                  <CopyButton text={LOGIN_COMMAND} label="copy command" testId="copy-login" />
                </div>
                <div className="hint">
                  Open a terminal (Windows Terminal is recommended), paste the command with <b>Ctrl+Shift+V</b>, press Enter and follow the steps. This page
                  updates by itself afterwards.
                </div>
              </div>
            )}
          </CheckRow>
          <CheckRow item={by('hooks')}>
            <div className="fix">
              <button onClick={onOpenSettings}>{hooks === 'installed' ? 'open hooks settings' : 'set up live hooks…'}</button>
            </div>
          </CheckRow>
          <CheckRow item={by('mini')} />
        </div>

        <div className="w-actions">
          <button className="primary" data-testid="take-tour" onClick={onTour}>
            Take the tour
          </button>
          <button data-testid="skip-welcome" onClick={onSkip}>
            Skip
          </button>
          <span className="note">You can reopen this any time with “help &amp; tour” at the bottom of the sidebar.</span>
        </div>
      </div>
    </div>
  );
}

interface Step {
  target: string;
  title: string;
  text: string;
  /** shown on the centered card when the target is not on screen */
  missing?: string;
}

export const TOUR_STEPS: Step[] = [
  {
    target: 'sessions',
    title: 'Your sessions',
    text: 'Every Claude Code session on this computer. “Live” ones were active in the last 10 minutes; the rest are recent history. Click one to look at it. “Follow the active session” makes the view jump to whichever one is working right now.',
  },
  {
    target: 'overview',
    title: 'All sessions at once',
    text: '“all sessions” puts every live session side by side, so you can watch several at the same time. “one session” goes back to the detailed view.',
  },
  {
    target: 'graph',
    title: 'The agent graph',
    text: 'Each card is an agent: the main one, and the helpers (subagents) it starts. A shimmering bar means it is working; solid means finished, red means it failed. Claude does not report a percentage, so none is invented. “ctx 46%” shows how full that agent’s memory (context window) is; near 100% Claude compacts it. Hold Ctrl and scroll to zoom, drag empty space to move around.',
    missing: 'Open a session and its agents appear here as cards, with a line from each helper back to the agent that started it.',
  },
  {
    target: 'mode',
    title: 'Plan or build',
    text: 'PLAN means Claude is thinking and proposing without changing files. BUILD means it is allowed to edit. Below that is the real task checklist (like 3/7 done) and token totals.',
    missing: 'Once a session is open, this panel shows PLAN or BUILD plus Claude’s task checklist.',
  },
  {
    target: 'log',
    title: 'The session log',
    text: 'A timestamped diary of prompts, tool calls, helpers starting and finishing, and replies. Use the filter chips to hide what you do not care about, or click a line to follow one agent.',
    missing: 'Once a session is open, the log of everything it does appears here, with filters.',
  },
  {
    target: 'usage',
    title: 'Usage meters',
    text: 'Your 5-hour and weekly limits, at the top of the window on every page. Green is fine, yellow is getting there, red is nearly used up. The thin marker shows how far through the window you are. Click to refresh.',
    missing: 'Your 5-hour and weekly meters sit at the top of the window.',
  },
  {
    target: 'open-in-claude',
    title: 'Open in Claude',
    text: 'Jumps to this exact session in the Claude desktop app, so you can reply or give permission. The open button that appears when you point at a session in the list does the same.',
    missing: 'Open a session to get an “open in Claude” button that jumps to it in the Claude desktop app.',
  },
  {
    target: 'mini',
    title: 'Mini view',
    text: 'This button, at the top right, opens a small window that stays on top of everything else and shows the mode and what the agents are doing. The tray icon menu has it too, and Ctrl+Alt+V (changeable in settings) opens it from anywhere.',
    missing: 'The mini view button at the top right opens a small always-on-top window. The tray icon menu has it too.',
  },
  {
    target: 'hooks',
    title: 'Hooks and settings',
    text: 'The settings button (top right) is where you set up live hooks and app settings. Hooks make Claude Code tell this app about events instantly and enable “needs your input” notifications. Without them the app is about a second behind. You choose when, and it shows a preview first.',
    missing: 'The settings button at the top right is where optional instant updates are set up.',
  },
];

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const CARD_W = 340;
const PAD = 6;
const GAP = 14;

function findTarget(name: string): Box | null {
  const el = document.querySelector<HTMLElement>(`[data-tour="${name}"]`);
  if (!el) return null;
  let r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return null;
  if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) {
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    r = el.getBoundingClientRect();
  }
  // clip to the viewport so a huge target still gets a visible outline
  const x = Math.max(0, r.left - PAD);
  const y = Math.max(0, r.top - PAD);
  const x2 = Math.min(window.innerWidth, r.right + PAD);
  const y2 = Math.min(window.innerHeight, r.bottom + PAD);
  return { x, y, w: x2 - x, h: y2 - y };
}

function placeCard(box: Box | null, cardH: number): { left: number; top: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (!box) return { left: (vw - CARD_W) / 2, top: Math.max(12, (vh - cardH) / 2) };
  const clampX = (x: number) => Math.max(12, Math.min(vw - CARD_W - 12, x));
  const clampY = (y: number) => Math.max(12, Math.min(vh - cardH - 12, y));
  const cx = box.x + box.w / 2 - CARD_W / 2;
  const cy = box.y + box.h / 2 - cardH / 2;
  if (box.x + box.w + GAP + CARD_W <= vw - 12) return { left: box.x + box.w + GAP, top: clampY(cy) };
  if (box.y + box.h + GAP + cardH <= vh - 12) return { left: clampX(cx), top: box.y + box.h + GAP };
  if (box.x - GAP - CARD_W >= 12) return { left: box.x - GAP - CARD_W, top: clampY(cy) };
  if (box.y - GAP - cardH >= 12) return { left: clampX(cx), top: box.y - GAP - cardH };
  // target fills the window: sit in its bottom-right corner
  return { left: vw - CARD_W - 24, top: vh - cardH - 24 };
}

export function Tour({ onDone }: { onDone: () => void }) {
  const [i, setI] = useState(0);
  const [box, setBox] = useState<Box | null>(null);
  const [, setTick] = useState(0);
  const cardRef = useRef<HTMLDivElement>(null);
  const [cardH, setCardH] = useState(190);
  const step = TOUR_STEPS[i];
  const last = i === TOUR_STEPS.length - 1;

  useLayoutEffect(() => {
    const measure = () => {
      setBox((prev) => {
        const b = findTarget(step.target);
        if (!b && !prev) return prev;
        if (b && prev && b.x === prev.x && b.y === prev.y && b.w === prev.w && b.h === prev.h) return prev;
        return b;
      });
      if (cardRef.current) setCardH(cardRef.current.offsetHeight);
      setTick((t) => t + 1);
    };
    measure();
    window.addEventListener('resize', measure);
    const t = setInterval(measure, 400);
    return () => {
      window.removeEventListener('resize', measure);
      clearInterval(t);
    };
  }, [i]);

  const next = () => (last ? onDone() : setI(i + 1));
  const back = () => setI(Math.max(0, i - 1));
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDone();
      else if (e.key === 'ArrowRight' || e.key === 'Enter') next();
      else if (e.key === 'ArrowLeft') back();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  const pos = placeCard(box, cardH);
  return (
    <div className="tour" data-testid="tour">
      <div className="tour-block" />
      {box ? <div className="tour-spot" style={{ left: box.x, top: box.y, width: box.w, height: box.h }} /> : <div className="tour-dim" />}
      <div className="tour-card" ref={cardRef} style={{ left: pos.left, top: pos.top, width: CARD_W }} data-step={i}>
        <div className="tc-top">
          <span className="tc-n" data-testid="tour-count">
            step {i + 1} of {TOUR_STEPS.length}
          </span>
          <button className="tc-x" onClick={onDone} title="Skip the tour (Esc)">
            skip
          </button>
        </div>
        {/* keyed by step: the text eases in fresh on every step */}
        <div className="tc-step" key={i}>
          <div className="tc-title">{step.title}</div>
          <div className="tc-text">{box ? step.text : (step.missing ?? step.text)}</div>
        </div>
        <div className="tc-nav">
          <button onClick={back} disabled={i === 0} data-testid="tour-back">
            <Icon name="chevronLeft" size="xs" />
            back
          </button>
          <button className="primary" onClick={next} data-testid="tour-next">
            {last ? 'done' : 'next'}
            {!last && <Icon name="chevronRight" size="xs" />}
          </button>
        </div>
      </div>
    </div>
  );
}
