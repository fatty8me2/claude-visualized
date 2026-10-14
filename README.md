# Claude Visualized

A desktop app (Windows + macOS) that shows what your Claude Code sessions are doing, live:

- **Agent graph**: the main agent, every subagent it spawns (including nested agents, background agents and
  workflow agents), each with its model, status, current tool, elapsed time, token use and an activity sparkline.
- **Mode panel**: PLAN vs BUILD (and the exact permission mode), the session's task checklist, token totals and the
  cost Claude Code reports.
- **Session log**: timestamped prompts, tool calls, spawns, completions, mode changes and replies, filterable by agent and kind.
- **Session picker**: every session under `~/.claude/projects`, live ones first, with an option to follow
  whichever session is active right now.
- **Tray icon + mini view**: a small always-on-top window with the mode, the main agent's current tool and the running subagents.
- **Replay**: scrub or play back any past session at 1–128×.
- **Notifications** when a session needs your input (with hooks) or, optionally, when a subagent finishes.

It works with both the Claude desktop app's Code tab and the `claude` CLI, because both write the same transcripts.

## How it gets data

1. **Transcripts (default, zero setup).** The app tails `~/.claude/projects/<project>/<session>.jsonl`, the
   per-subagent files in `<session>/subagents/` (including `subagents/workflows/<run>/`), their `.meta.json` files
   and workflow journals. Updates show up within about a second. This never writes anything.
2. **Hooks (optional, instant).** Under **⚙ hooks** you can add `http` hooks to `~/.claude/settings.json` that POST
   each event to `127.0.0.1:47821`. The dialog shows a before/after diff, keeps every existing hook (such as an
   existing `Stop` hook) untouched, writes a timestamped backup first, and can remove exactly what it added. The
   receiver always answers `200` with an empty body, so it can never block or deny a tool call. If the app isn't
   running, the hook fails instantly with "connection refused" and Claude Code continues.

The transcript format is internal to Claude Code and changes between versions. The parser treats every field as
optional and counts lines it doesn't understand (shown as "unparsed" in the status bar) instead of failing.

### What "progress" means here

Claude Code doesn't report a percentage for an agent, so the app doesn't invent one:

- A running agent gets an animated striped bar.
- A finished agent gets a solid bar; a failed one gets a red bar.
- The checklist shows real completion (`3/7`) from `TaskCreate`/`TaskUpdate`/`TodoWrite`.
- The sparkline shows tool calls over the last 12 minutes.
- An agent that's still marked running but has been silent for a few minutes is shown as *quiet*.

## Develop

```bash
npm install
npm run dev
```

| script | what |
| --- | --- |
| `npm run dev` | run with hot reload |
| `npm test` | unit tests (parser, reducer, tailer, installer merge, layout) |
| `REAL_DATA=1 npx vitest run tests/unit/real-data.test.ts` | fold every real session on this machine (read-only) |
| `npm run build && npx vitest run --config vitest.e2e.config.ts` | launch the built app against fixture data with Playwright |
| `npm run dist:win` / `npm run dist:mac` | installers in `release/<version>/` |
| `npm run icons` | regenerate `build/icon.png` and the tray icons |

Environment overrides (mainly for tests):

| variable | effect |
| --- | --- |
| `CLAUDE_VIS_HOME` | Claude data directory to read, instead of `~/.claude` (`CLAUDE_CONFIG_DIR` is honored too) |
| `CLAUDE_VIS_USER_DATA` | the app's own profile directory |
| `CLAUDE_VIS_PORT` | hook receiver port |
| `CLAUDE_VIS_NO_HOOK_SERVER` | don't start the hook receiver |
| `CLAUDE_VIS_NO_TRAY` | don't create a tray icon |

### Layout

```
src/core/       pure logic shared by main + renderer: events, normalize (lines/hooks → events),
                reducer (events → SessionState), layout (agent tree), hooksConfig (settings merge)
src/main/       Electron main: indexer (session list), tail + watcher (per-session file following),
                manager (watchers, follow mode, notifications), hookServer, installer, windows/tray
src/preload/    typed window.api bridge
src/renderer/   React UI: AgentGraph, ModePanel, LogPanel, StatusBar, SessionList, SettingsDialog, MiniView, replay
tests/          vitest unit tests with a synthetic ~/.claude fixture, Playwright e2e
```

## Packaging notes

- **Windows:** `npm run dist:win` builds an NSIS installer that installs per user, with no admin needed. It is unsigned, so
  SmartScreen will warn until you sign it with a code-signing certificate.
- **macOS:** build `npm run dist:mac` on a Mac, or in CI by moving `ci/github-build.yml` to `.github/workflows/` (pushing it needs a GitHub token with the `workflow` scope). Without an Apple Developer ID
  the app is unsigned and not notarized. Open it the first time with right-click → Open, or run
  `xattr -dr com.apple.quarantine "/Applications/Claude Visualized.app"`.
