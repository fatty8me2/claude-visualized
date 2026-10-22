import { useCallback, useEffect, useRef, useState } from 'react';
import type { HookPreviewView, HookStateView, SetupDetectView } from '@core/api';
import { HOOK_EVENTS } from '@core/hooksConfig';
import { ONBOARDING_VERSION, LOGIN_COMMAND } from '@core/onboarding';
import { claudeCodePresent, SETUP_STEPS, SETUP_VERSION, whoLabel, type SetupStepId } from '@core/setupWizard';
import type { UsageView, UsageWindow } from '@core/usage';
import { useConfig, useUsage } from '../hooks';
import { useDialogFocus } from '../state/dialogFocus';
import { CopyButton } from './CopyButton';
import { Icon, type IconName } from './Icon';
import '../dialogs.css';
import '../setup.css';

const RAIL: Record<SetupStepId, string> = { welcome: 'Welcome', detect: 'Claude Code', account: 'Your account', live: 'Live updates', done: 'All set' };

/** how far off a reset is, in words people use: "2 h 14 min", "3 days" */
function resetsIn(at: number | null, now: number): string | null {
  if (!at) return null;
  const m = Math.max(0, Math.round((at - now) / 60_000));
  if (m < 60) return `${m} min`;
  if (m < 48 * 60) return `${Math.floor(m / 60)} h ${m % 60} min`;
  return `${Math.round(m / 1440)} days`;
}

type Tone = 'ok' | 'warn' | 'idle';
const TONE_ICON: Record<Tone, IconName> = { ok: 'done', warn: 'warn', idle: 'idle' };

function Row({ tone, title, detail, id, children }: { tone: Tone; title: string; detail?: React.ReactNode; id?: string; children?: React.ReactNode }) {
  return (
    <div className={`srow ${tone}`} data-row={id}>
      <span className="sglyph">
        <Icon name={TONE_ICON[tone]} size="sm" />
      </span>
      <div className="sbody">
        <div className="sttl">{title}</div>
        {detail && <div className="sdet">{detail}</div>}
        {children}
      </div>
    </div>
  );
}

function UsageBar({ label, w, now, id }: { label: string; w: UsageWindow | null; now: number; id: string }) {
  const pct = w ? Math.round(w.pct) : null;
  const tone = pct === null ? '' : pct >= 85 ? 'err' : pct >= 60 ? 'warn' : 'ok';
  const reset = w ? resetsIn(w.resetsAt, now) : null;
  return (
    <div className={`ubar ${tone}`} data-testid={`setup-usage-${id}`}>
      <div className="ubar-top">
        <span className="ubar-label">{label}</span>
        <span className="ubar-pct">{pct === null ? 'no reading' : `${pct}% used`}</span>
      </div>
      <div className="ubar-track">
        <i style={{ width: `${Math.min(100, pct ?? 0)}%` }} />
      </div>
      <div className="ubar-sub">{reset ? `resets in ${reset}` : ' '}</div>
    </div>
  );
}

function LoginHelp({ onTerminal, onCheck, checking, expired }: { onTerminal: () => void; onCheck: () => void; checking: boolean; expired: boolean }) {
  return (
    <div className="callout" data-testid="setup-login-help">
      <div className="callout-title">{expired ? 'Your Claude Code sign-in has run out' : 'Sign in to Claude Code'}</div>
      <ol className="steps">
        <li>Open a terminal. The button below opens one in your home folder.</li>
        <li>
          Type <code>claude</code> and press Enter.
        </li>
        <li>
          Then type <code>/login</code> and follow the steps in your browser.
        </li>
      </ol>
      <div className="cmdrow">
        <code>{LOGIN_COMMAND}</code>
        <CopyButton text={LOGIN_COMMAND} label="copy" testId="setup-copy-login" />
      </div>
      <div className="btnrow">
        <button className="primary" data-testid="setup-open-terminal" onClick={onTerminal}>
          <Icon name="cli" size="xs" /> Open a terminal
        </button>
        <button data-testid="setup-recheck" onClick={onCheck} disabled={checking}>
          <Icon name="refresh" size="xs" /> {checking ? 'Checking…' : 'Check again'}
        </button>
      </div>
    </div>
  );
}

export function SetupWizard({
  startStep,
  onTour,
  onClose,
  openSettings,
}: {
  startStep: number;
  onTour: () => void;
  onClose: () => void;
  openSettings: () => void;
}) {
  const config = useConfig();
  const usage = useUsage();
  const [step, setStep] = useState(Math.max(0, Math.min(SETUP_STEPS.length - 1, startStep)));
  const [det, setDet] = useState<SetupDetectView | null>(null);
  const [checking, setChecking] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const id = SETUP_STEPS[step];
  const stepRef = useRef(step);
  stepRef.current = step;

  const detect = useCallback(async (manual = false) => {
    if (manual) setChecking(true);
    const [d] = await Promise.all([window.api.setupDetect(), manual ? new Promise((r) => setTimeout(r, 450)) : null]);
    setDet(d);
    setChecking(false);
    return d;
  }, []);

  // look at the machine right away, and keep looking while the person works through the install / sign-in steps in another window
  useEffect(() => {
    void detect();
    const t = setInterval(() => {
      setNow(Date.now());
      if (['detect', 'account'].includes(SETUP_STEPS[stepRef.current])) void detect();
    }, 3000);
    return () => clearInterval(t);
  }, [detect]);

  // remember where they are, so closing the window or the app resumes here
  useEffect(() => {
    if (id !== 'done') void window.api.setConfig({ setupStep: step });
  }, [step, id]);

  const signedIn = det?.account.login === 'ok' || det?.account.login === 'renewable';
  // entering the account step with a working login: ask the usage service now, so the numbers are real, not stale
  useEffect(() => {
    if (id === 'account' && signedIn) void window.api.refreshUsage();
  }, [id, signedIn]);

  const complete = (skipped: boolean) => {
    void window.api.setConfig({
      setupVersion: SETUP_VERSION,
      onboardingDone: true,
      onboardingVersion: ONBOARDING_VERSION,
      setupStep: skipped ? step : 0,
    });
  };
  const skip = () => {
    complete(true);
    onClose();
  };
  const finish = () => {
    complete(false);
    onClose();
  };
  const startTour = () => {
    complete(false);
    onTour();
  };

  const ref = useDialogFocus(skip);
  const go = (n: number) => setStep(Math.max(0, Math.min(SETUP_STEPS.length - 1, n)));
  const claudeThere = det ? claudeCodePresent({ homeExists: det.homeExists, cliFound: det.cli.found }) : true;

  // ---- live updates step state ----
  const [hs, setHs] = useState<HookStateView | null>(null);
  const [preview, setPreview] = useState<HookPreviewView | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState<{ ok: boolean; text: string } | null>(null);
  const loadHooks = useCallback(async () => {
    const s = await window.api.hookState();
    setHs(s);
    setPreviewErr(null);
    if (s.state === 'error') return setPreview(null);
    try {
      setPreview(await window.api.hookPreview('install'));
    } catch (e) {
      setPreview(null);
      setPreviewErr((e as Error).message);
    }
  }, []);
  useEffect(() => {
    if (id === 'live' || id === 'done') void loadHooks();
  }, [id, loadHooks]);
  const install = async () => {
    setApplying(true);
    const r = await window.api.hookApply('install');
    setApplying(false);
    setApplied(
      r.ok
        ? {
            ok: true,
            text: r.backup ? `Done. Your old settings were saved first (${r.backup}).` : 'Done. There was no settings file yet, so nothing needed a backup.',
          }
        : { ok: false, text: `That did not work: ${r.error}` },
    );
    void loadHooks();
  };

  const installed = hs?.state === 'installed';
  const port = config?.port ?? 47821;
  const nextLabel =
    id === 'detect' && !claudeThere
      ? 'Continue anyway'
      : id === 'account' && !signedIn
        ? 'Continue without signing in'
        : id === 'live' && !installed
          ? 'Not now'
          : 'Continue';

  return (
    <div className="overlay welcome-overlay setup-overlay" data-testid="setup-wizard">
      <div className="dialog dlg panel-raised setup" role="dialog" aria-modal="true" aria-label="Set up Claude Visualized" ref={ref}>
        <div className="setup-head">
          <div className="w-brand">
            <b>◆</b> CLAUDE VISUALIZED
          </div>
          <button className="ghost setup-skip" data-testid="setup-skip" onClick={skip} title="Close setup. Pick it up again from Settings (Esc)">
            Skip for now
          </button>
        </div>
        <ol className="rail" aria-label="Setup steps">
          {SETUP_STEPS.map((s, i) => (
            <li key={s} className={`${i === step ? 'cur' : i < step ? 'past' : ''}`} data-rail={s}>
              <button disabled={i > step} onClick={() => go(i)} aria-current={i === step ? 'step' : undefined}>
                <span className="dot">{i < step ? <Icon name="done" size="xs" strokeWidth={3} /> : i + 1}</span>
                <span className="lbl">{RAIL[s]}</span>
              </button>
            </li>
          ))}
        </ol>

        <div className="setup-body" key={id} data-testid={`setup-step-${id}`}>
          {id === 'welcome' && (
            <>
              <h2>Welcome to Claude Visualized</h2>
              <p className="lede">
                A live picture of what Claude Code is doing: the main agent, every helper it starts, what it is working on, and how much of your 5-hour and
                weekly limits you have left. Setup takes about a minute and every step is optional.
              </p>
              <div className="promises">
                <div className="promise" style={{ ['--tint' as string]: 'var(--opus)' }}>
                  <span className="pi">
                    <Icon name="agent" size="md" />
                  </span>
                  <b>See everything at once</b>
                  <span>Agents, plans, tool calls and costs, drawn as cards that light up while Claude works.</span>
                </div>
                <div className="promise" style={{ ['--tint' as string]: 'var(--fable)' }}>
                  <span className="pi">
                    <Icon name="permission" size="md" />
                  </span>
                  <b>Stays on your computer</b>
                  <span>It reads files Claude Code already saves here. No account with us, no cloud copy of your sessions.</span>
                </div>
                <div className="promise" style={{ ['--tint' as string]: 'var(--sonnet)' }}>
                  <span className="pi">
                    <Icon name="read" size="md" />
                  </span>
                  <b>Looks, never touches</b>
                  <span>It is read-only. The only thing it may ever change is a Claude settings file, and only when you click, with a backup.</span>
                </div>
              </div>
              <p className="fine">
                The one thing that goes online: to show your usage meters it asks Anthropic for your own usage numbers, using the Claude Code login you already
                have. Your login never leaves this computer except to Anthropic.
              </p>
            </>
          )}

          {id === 'detect' && (
            <>
              <h2>Looking for Claude Code</h2>
              <p className="lede">
                This app works with Claude Code, in the terminal or inside the Claude desktop app. Here is what we can see on this computer.
              </p>
              <div className="rows">
                <Row
                  id="home"
                  tone={!det ? 'idle' : det.homeExists ? 'ok' : 'warn'}
                  title="Claude Code folder"
                  detail={
                    !det ? (
                      'Checking…'
                    ) : det.homeExists ? (
                      <code title="Where Claude Code keeps its files">{det.claudeHome}</code>
                    ) : (
                      'Not found yet. This appears once Claude Code has run.'
                    )
                  }
                />
                <Row
                  id="sessions"
                  tone={!det ? 'idle' : det.sessionCount > 0 ? 'ok' : 'warn'}
                  title="Sessions"
                  detail={
                    !det
                      ? 'Checking…'
                      : det.sessionCount > 0
                        ? `${det.sessionCount} found. They show up in the sidebar.`
                        : 'None yet. Start a Claude Code session and it appears here within a second or two.'
                  }
                />
                <Row
                  id="cli"
                  tone={!det ? 'idle' : det.cli.found ? 'ok' : 'idle'}
                  title="The claude command"
                  detail={
                    !det
                      ? 'Checking…'
                      : det.cli.found
                        ? 'Installed.'
                        : det.homeExists
                          ? 'Not found on your PATH. That is fine if you use Claude Code from the desktop app or an editor.'
                          : 'Not found.'
                  }
                />
                <Row
                  id="desktop"
                  tone={!det ? 'idle' : det.desktop.found ? 'ok' : 'idle'}
                  title="Claude desktop app"
                  detail={!det ? 'Checking…' : det.desktop.found ? 'Installed. “Open in Claude” buttons will work.' : 'Not detected (best guess). Optional.'}
                />
              </div>
              {det && !claudeThere && (
                <div className="callout" data-testid="setup-install-help">
                  <div className="callout-title">Claude Code does not seem to be installed yet</div>
                  <p>
                    No problem. Install it, run it once, and this page notices by itself. It takes a few minutes, and you can leave this window open while you
                    do it.
                  </p>
                  <ol className="steps">
                    <li>Download Claude Code from the page below (or use the Code tab in the Claude desktop app).</li>
                    <li>
                      Open a terminal, type <code>claude</code> and press Enter. Sign in when it asks.
                    </li>
                    <li>Ask it anything. Then come back here and press “Check again”.</li>
                  </ol>
                  <div className="btnrow">
                    <button className="primary" data-testid="setup-open-download" onClick={() => void window.api.setupOpenDownload()}>
                      <Icon name="openExternal" size="xs" /> Open download page
                    </button>
                    <button data-testid="setup-recheck" onClick={() => void detect(true)} disabled={checking}>
                      <Icon name="refresh" size="xs" /> {checking ? 'Checking…' : 'Check again'}
                    </button>
                  </div>
                </div>
              )}
              {det && claudeThere && (
                <div className="btnrow">
                  <button data-testid="setup-recheck" onClick={() => void detect(true)} disabled={checking}>
                    <Icon name="refresh" size="xs" /> {checking ? 'Checking…' : 'Check again'}
                  </button>
                </div>
              )}
            </>
          )}

          {id === 'account' && (
            <>
              <h2>Your Claude account</h2>
              <p className="lede">
                The usage meters need the account Claude Code is signed in to. The app uses that login as it is, and never shows or copies it.
              </p>
              {!det && <p className="fine">Checking…</p>}
              {det && signedIn && (
                <>
                  <div className="acct" data-testid="setup-account">
                    <span className="avatar" aria-hidden>
                      {(det.account.email ?? det.account.name ?? det.account.org ?? 'C').charAt(0).toUpperCase()}
                    </span>
                    <div className="acct-main">
                      <div className="acct-label">Signed in as</div>
                      <div className="acct-who" data-testid="setup-who">
                        {whoLabel(det.account) ?? 'your Claude account'}
                      </div>
                    </div>
                    {det.account.plan && (
                      <span className="plan" data-testid="setup-plan">
                        {det.account.plan}
                      </span>
                    )}
                  </div>
                  {det.account.login === 'renewable' && (
                    <p className="fine" data-testid="setup-renewable">
                      Your sign-in pass ran out, which is normal. The app renews it by itself the way Claude Code does.
                    </p>
                  )}
                  <div className="usage-test" data-testid="setup-usage">
                    <div className="ut-head">
                      <span>Live usage check</span>
                      <UsageStatus usage={usage} />
                      <button className="ghost" data-testid="setup-usage-refresh" onClick={() => void window.api.refreshUsage()}>
                        <Icon name="refresh" size="xs" /> test again
                      </button>
                    </div>
                    <div className="ut-bars">
                      <UsageBar id="5h" label="5-hour limit" w={usage?.fiveHour ?? null} now={now} />
                      <UsageBar id="week" label="Weekly limit" w={usage?.sevenDay ?? null} now={now} />
                    </div>
                  </div>
                </>
              )}
              {det && det.account.login === 'expired' && (
                <>
                  <div className="acct warn" data-testid="setup-account">
                    <span className="avatar" aria-hidden>
                      !
                    </span>
                    <div className="acct-main">
                      <div className="acct-label">Last signed in as</div>
                      <div className="acct-who">{whoLabel(det.account) ?? 'your Claude account'}</div>
                    </div>
                  </div>
                  <LoginHelp expired onTerminal={() => void window.api.setupOpenTerminal()} onCheck={() => void detect(true)} checking={checking} />
                </>
              )}
              {det && det.account.login === 'none' && (
                <LoginHelp expired={false} onTerminal={() => void window.api.setupOpenTerminal()} onCheck={() => void detect(true)} checking={checking} />
              )}
              {det && det.account.login === 'api-key' && (
                <div className="callout" data-testid="setup-apikey">
                  <div className="callout-title">You use an API key</div>
                  <p>
                    Claude Code is paid per use through an API key here, not through a Claude subscription. Subscriptions have 5-hour and weekly limits, so
                    those meters are not available for you. Everything else (sessions, agents, plans, costs) works the same.
                  </p>
                  <div className="btnrow">
                    <button data-testid="setup-recheck" onClick={() => void detect(true)} disabled={checking}>
                      <Icon name="refresh" size="xs" /> {checking ? 'Checking…' : 'Check again'}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          {id === 'live' && (
            <>
              <h2>
                Live updates <span className="badge">recommended, optional</span>
              </h2>
              <p className="lede">
                Without this the app already works: it reads Claude Code&rsquo;s files and is about a second behind. Installing small hooks makes Claude Code
                tell the app the moment something happens, and enables “needs your input” alerts.
              </p>
              {hs?.state === 'error' && (
                <div className="callout bad" data-testid="setup-hooks-error">
                  <div className="callout-title">We can&rsquo;t change your Claude settings file</div>
                  <p>{hs.error}. To stay safe, the app will not touch a file it cannot read. You can fix it and run setup again later.</p>
                </div>
              )}
              {hs && hs.state !== 'error' && (
                <div className={`opt-card ${installed ? 'on' : ''}`} data-testid="setup-hooks-card">
                  <div className="opt-head">
                    <span className="opt-ico">
                      <Icon name="live" size="md" />
                    </span>
                    <div className="opt-title">
                      Instant updates and usage line
                      <span className={`pill ${installed ? 'ok' : hs.state === 'none' ? '' : 'warn'}`} data-testid="setup-hooks-state">
                        {installed ? 'installed' : hs.state === 'none' ? 'not installed' : 'needs repair'}
                      </span>
                    </div>
                  </div>
                  <ul className="will">
                    <li>
                      Adds {HOOK_EVENTS.length} small hooks to <code>{hs.settingsFile}</code>. Each one only talks to <code>127.0.0.1:{port}</code>, which is
                      this computer.
                    </li>
                    {hs.statusLine === 'other' ? (
                      <li data-testid="setup-statusline-other">
                        You already have your own status line, so it stays exactly as it is. Your usage meters keep working through your login.
                      </li>
                    ) : hs.statusLine === 'ours' ? (
                      <li>Our status line is already in place.</li>
                    ) : (
                      <li>Adds a small status line script that feeds live 5-hour and weekly numbers, and prints a short status in terminal sessions.</li>
                    )}
                    <li>Before anything is written, your current settings are saved as a backup. You can remove it all again in Settings.</li>
                  </ul>
                  {previewErr && <p className="fine err">{previewErr}</p>}
                  {preview && (
                    <details className="diffbox" data-testid="setup-preview">
                      <summary>Show exactly what changes</summary>
                      <div className="diff">
                        <div>
                          <div className="dtitle">before</div>
                          <pre>{preview.before}</pre>
                        </div>
                        <div>
                          <div className="dtitle">after</div>
                          <pre>{preview.after}</pre>
                        </div>
                      </div>
                    </details>
                  )}
                  <div className="btnrow">
                    <button
                      className="primary"
                      data-testid="setup-install"
                      disabled={applying || (installed && !preview?.changed)}
                      onClick={() => void install()}
                    >
                      {applying ? 'Installing…' : installed ? 'Reinstall' : hs.state === 'none' ? 'Install live updates' : 'Repair'}
                    </button>
                    {applied && (
                      <span className={`result ${applied.ok ? 'ok' : 'err'}`} data-testid="setup-install-result">
                        {applied.text}
                        {applied.ok && ' New Claude Code sessions pick it up.'}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </>
          )}

          {id === 'done' && (
            <>
              <h2>You&rsquo;re all set</h2>
              <p className="lede">Here is where things stand. Anything missing can be fixed later without redoing setup.</p>
              <div className="rows" data-testid="setup-summary">
                <Row
                  id="s-claude"
                  tone={det && claudeThere ? 'ok' : 'warn'}
                  title="Claude Code"
                  detail={
                    det && claudeThere
                      ? det.sessionCount
                        ? `${det.sessionCount} session${det.sessionCount === 1 ? '' : 's'} found.`
                        : 'Found. Start a session and it shows up.'
                      : 'Not found yet. Install it and the app picks it up by itself.'
                  }
                />
                <Row
                  id="s-account"
                  tone={signedIn ? 'ok' : 'idle'}
                  title="Account and usage meters"
                  detail={
                    signedIn
                      ? `Signed in${det && whoLabel(det.account) ? ` as ${whoLabel(det.account)}` : ''}.`
                      : det?.account.login === 'api-key'
                        ? 'API key: meters are for subscriptions, everything else works.'
                        : 'Not signed in. Run claude, then /login, and the meters start on their own.'
                  }
                />
                <Row
                  id="s-live"
                  tone={installed ? 'ok' : 'idle'}
                  title="Live updates"
                  detail={installed ? 'Installed.' : 'Off. The app is about a second behind, which is fine. Turn it on any time in Settings.'}
                />
              </div>
              <div className="tips">
                <div>
                  <b>Ctrl + scroll</b> zooms the agent graph. Drag empty space to move around.
                </div>
                <div>
                  <b>{(config?.miniHotkey ?? 'Ctrl+Alt+V').replace('CommandOrControl', 'Ctrl')}</b> opens the small always-on-top mini view from anywhere.
                </div>
                <div>
                  <b>Settings</b> has “Run setup again” whenever you want this guide back.
                </div>
              </div>
            </>
          )}
        </div>

        <div className="setup-foot">
          {step > 0 && (
            <button data-testid="setup-back" onClick={() => go(step - 1)}>
              <Icon name="chevronLeft" size="xs" /> Back
            </button>
          )}
          <span className="grow" />
          {id === 'done' ? (
            <>
              <button data-testid="setup-finish" onClick={finish}>
                Finish
              </button>
              <button className="primary" data-testid="setup-tour" onClick={startTour}>
                Take the tour <Icon name="chevronRight" size="xs" />
              </button>
            </>
          ) : (
            <button className="primary" data-testid="setup-next" onClick={() => go(step + 1)}>
              {nextLabel} <Icon name="chevronRight" size="xs" />
            </button>
          )}
        </div>
        {/* settings link kept for people who want the full panel */}
        {id === 'live' && (
          <button className="linklike" data-testid="setup-more-settings" onClick={openSettings}>
            More options in Settings
          </button>
        )}
      </div>
    </div>
  );
}

/** one line saying how the usage test went */
function UsageStatus({ usage }: { usage: UsageView | null }) {
  const s = usage?.api;
  if (!s) return <span className="ustat">checking…</span>;
  if (s.state === 'ok')
    return (
      <span className="ustat ok" data-testid="setup-usage-state">
        connected
      </span>
    );
  return (
    <span className="ustat warn" data-testid="setup-usage-state" title={s.message}>
      {s.state === 'error' ? 'could not reach the usage service, retrying' : 'needs a new sign-in'}
    </span>
  );
}
