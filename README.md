# Claude Visualized

A desktop app (Windows + macOS) that shows what your Claude Code sessions are doing, live:

- **Agent graph**: the main agent, every subagent it spawns (including nested agents, background agents and
  workflow agents), each with its model, status, current tool, elapsed time, token use and an activity sparkline.
- **Mode panel**: PLAN vs BUILD (and the exact permission mode), the session's task checklist, token totals and the
  cost Claude Code reports.
- **Plan rail**: when the session has a plan (plan mode's plan file or the approved `ExitPlanMode` plan, else its todo list) it is drawn as a metro line beside the agent graph: sections are stations, steps are nodes (done / in progress / pending) and the agents doing each step hang under it as chips. A step counts as done or in progress only on evidence: a ticked `[x]`, a matching todo, or a matching agent (keyword overlap with the agent's description). Hover a step to light up its agents in the graph, hover an agent to light up its step. Toggle it with **plan** in the graph toolbar, drag its edge to resize, and flip it to the other side with the arrows button.
- **Session log**: timestamped prompts, tool calls, spawns, completions, mode changes and replies, filterable by agent and kind.
- **Session picker**: every session under `~/.claude/projects`, live ones first, with an option to follow
  whichever session is active right now.
- **Tray icon + mini view**: a small always-on-top window with the mode, the main agent's current tool and the running subagents.
- **Replay**: scrub or play back any past session at 1–128×.
- **Notifications** when a session needs your input (with hooks) or, optionally, when a subagent finishes.

It works with both the Claude desktop app's Code tab and the `claude` CLI, because both write the same transcripts.

## Local models

Claude Code can run against local models through a gateway or proxy (LiteLLM, Ollama's Anthropic-compatible endpoint, claude-code-router, LM Studio, ...) via `ANTHROPIC_BASE_URL` / `ANTHROPIC_MODEL`. The transcripts then carry non-Claude model ids such as `qwen2.5-coder:32b` or `ollama/llama3.1:70b`.

- **Recognition** (`src/core/models.ts`): model ids are classified as `anthropic`, `local` (qwen, llama, mistral/mixtral/codestral/devstral, deepseek, gemma, phi, gpt-oss, granite, starcoder, codellama, command-r, glm, kimi, or any `ollama/`, `lmstudio-community/`, `hf.co/` id) or `other` (hosted gateways such as `openrouter/...`, `gpt-4o`). Labels are prettified (`qwen2.5-coder:32b` becomes "Qwen2.5 Coder 32B"). Local agents get a teal colour (`--local`), a "⌂ local" tag on cards, legend, overview panels and the mini view, and their tokens are shown as "local tokens", separate from Claude's. They are never attributed to the 5-hour / weekly meters.
- **Context**: a local agent shows a context percentage only when a running server reported the model's context length (Ollama `/api/ps` `context_length`, `/api/show` `num_ctx` or `model_info.*.context_length`, LM Studio `loaded_context_length` / `max_context_length`, llama.cpp `n_ctx`). Otherwise just the token count.
- **Local models view** (sidebar, "⌂ local models"; top-bar chip "⌂ N models loaded", hidden when no server is up): the main process polls, read-only and only the URLs in settings (loopback by default; remote hosts only if you add them):
  - **Ollama** `127.0.0.1:11434`: `GET /api/version`, `/api/ps` (loaded models: `size`, `size_vram`, `expires_at`, `details`, `context_length` if present), `/api/tags` (installed), `POST /api/show` (context, capabilities; cached).
  - **LM Studio** `127.0.0.1:1234`: `GET /api/v0/models` (`state`, `max_context_length`, `quantization`, `arch`), falling back to `/api/v1/models` and then OpenAI-compatible `/v1/models`.
  - **OpenAI-compatible endpoints** you add (llama.cpp server, vLLM, LocalAI, Jan, ...): `GET /v1/models`, plus llama.cpp's `/health`, `/props`, `/slots` and `/metrics` when they answer.
  - Ollama and LM Studio do not expose live tokens/sec or request counts, so the view does not show any for them; llama.cpp's `/slots` and `/metrics` give requests in flight and server-reported average tokens/sec, labelled as such.
  - Interval defaults to 5 s and backs off to 60 s while a server is down. With nothing running the view says so and offers "check again".
  - An agent whose model a server has loaded shows "loaded in Ollama · 18.2 GB VRAM" on its card, and the view lists "used by: session / agent".
  - Test hooks: `CLAUDE_VIS_OLLAMA_URL`, `CLAUDE_VIS_LMSTUDIO_URL` (`off` disables).

## First run

On first launch the app shows a welcome screen with a live setup checklist:

- **Claude Code data**: it found `~/.claude/projects` and N sessions. If not, install Claude Code (the Code tab in the Claude desktop app, or the `claude` CLI) and run one session.
- **Usage meters**: if they say "login needed", open a terminal (Windows Terminal is recommended), run `claude /login` (the welcome screen has a copy button) and paste the code with Ctrl+Shift+V.
- **Live hooks** (optional): without them the app is about a second behind. The button opens the hooks dialog, which shows a preview before writing anything.

Then "Take the tour" walks through the sidebar, the agent graph, the mode panel, the log, the usage meters and the buttons in the top bar. Reopen it any time with **? help** in the sidebar, **Show welcome & tour** in the tray menu, or the button in the settings dialog. Tour versions are tracked in `src/core/onboarding.ts` (`ONBOARDING_VERSION`); bumping it shows the welcome screen again to existing users.

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

## Everyday use

Settings (the **⚙ hooks** dialog, section **App**) and the tray menu expose:

- **Start with Windows / Start at login** (`launchAtLogin`, default off). Registers a login item that launches the app
  with `--hidden`, so it starts in the tray without opening the window (on macOS it also honours "opened at login").
  The checkbox reflects the real OS state, which you can also change in Task Manager > Startup apps or System Settings.
  Only packaged builds register anything; a dev run keeps the setting but shows "takes effect in the installed app".
- **Mini view hotkey** (`miniHotkey`, default `CommandOrControl+Alt+V`). A global shortcut that toggles the
  always-on-top mini view from any app. Type an [Electron accelerator](https://www.electronjs.org/docs/latest/api/accelerator)
  and press **Apply**; it must contain a modifier plus one key, and plain copy/paste combos are refused. If another app
  already owns the shortcut you get an error and the previous hotkey stays active.
- **Tray menu**: *Mini view (hotkey)*, *Open settings*, and the start-at-login checkbox, next to *Show window*,
  *Follow active session* and *Quit*.

A second launch of the app focuses the running window; a second launch with `--hidden` (what the login item uses) does not.
Set `CLAUDE_VIS_NO_SYSTEM_INTEGRATION=1` to skip login-item and global-hotkey registration (the e2e tests do).

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
| `CLAUDE_VIS_SKIP_ONBOARDING` | don't show the first-run welcome screen (tests) |

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
