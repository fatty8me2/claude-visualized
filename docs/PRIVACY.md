# Privacy

Claude Visualized is a local app. It reads what Claude Code already writes on your computer, shows it to you, and sends almost nothing
anywhere. This page lists every read, write and network call the app makes, so you can check it yourself. The short version is in the
README's [Privacy](../README.md#privacy) section.

There is no analytics, telemetry or crash reporting in the code. Nothing about your sessions, prompts or files is sent to the
project's author or to any service of ours.

## Files the app reads

Paths below use `~/.claude` as shorthand for your Claude Code data folder. It is `%USERPROFILE%\.claude` on Windows and `~/.claude` on
macOS. The app honours `CLAUDE_CONFIG_DIR` and the test variable `CLAUDE_VIS_HOME`.

| What | Where | Why |
| --- | --- | --- |
| Session transcripts | `~/.claude/projects/<project>/<session>.jsonl`, the `subagents/` folders beside them, and their `.meta.json` files | The session list, the agent graph, the log and the history index. Read continuously while the app runs, and never modified. |
| Claude Code settings | `~/.claude/settings.json` | Read to show which hooks and status line are installed. Written only as described under "Files the app writes". |
| Claude Code login | `~/.claude/.credentials.json` on Windows and Linux; the macOS login keychain item `Claude Code-credentials` on macOS | The usage meters need your own login to call Anthropic's usage endpoint. The token is held in memory for that call and is never logged or shown. |

## Files the app writes

Everything the app keeps for itself lives in its own profile folder (Electron's `userData`):

- Windows: `%APPDATA%\Claude Visualized\`
- macOS: `~/Library/Application Support/Claude Visualized/`

Inside it: `config.json` (your settings), `usage.json` (the last usage reading), `inbox-dismissed.json` (inbox items you dismissed),
`peers.json` (paired computers, owner-only permissions), `history.db` (a local search and usage index built from the transcripts) and a
`backups/` folder. The history index is rebuilt from the transcripts if you delete it.

Outside that folder, the app writes only in these cases:

| File | When | Notes |
| --- | --- | --- |
| `~/.claude/settings.json` | Only when you click **Install hooks**, **Reinstall hooks** or **Remove hooks** and confirm the preview | The preview shows the exact before and after. Your existing hooks are kept. The file is backed up first to `backups/settings-<timestamp>.json` in the profile folder, written atomically, and re-read to check. |
| `~/.claude/claude-visualized-statusline.mjs` | Written when you install hooks with the status line; removed when you remove them | A small forwarder that Claude Code runs to pass its status data to `127.0.0.1`. Removing hooks deletes it. |
| `~/.claude/.credentials.json` (or the macOS keychain item) | Only when the app renews Claude Code's login, and only when the access token is close to expiry | This is the one write to a file Claude Code owns. It keeps the usage meters working when Claude Code's saved login has gone stale. The write is atomic, every other field is kept, and it is skipped if Claude Code renewed the login first. A lock file `.credentials.claude-visualized.lock` may appear next to it while this runs. |

The app never writes to transcripts, project folders or anything else in `~/.claude`.

## Sync with Google Drive (off by default)

When you turn on **Settings > Sync** and pick a folder, the app writes two kinds of file into `<folder>/Claude Visualized/`: `settings.<device id>.json` (one per computer) and a shared `settings.json`. Syncing them between computers is done by Google Drive for desktop (or whichever client owns the folder); the app itself makes no network call for this and has no Google account access.

- **What is written**: an explicit allowlist (`src/core/settingsSync.ts`, pinned by `tests/unit/settingsSync.test.ts`): panel layout, overview grid and density, plan rail, graph view options, pinned and hidden session ids, collapsed sections, the "active only" filter, and these switches: follow active session, notify on attention, notify on subagent done, mini view on top, auto-download updates. Each file also holds this computer's name, a random device id and the time of its last sync, so the other computers can list it.
- **What is never written**: anything from `~/.claude`, Claude login credentials or tokens, `peers.json` (the peer-link private key and paired computers), the history database (a live SQLite file that cloud sync can corrupt), the hook port, the peer port, window position, the global hotkey, the login-item setting, local model server addresses.
- Files from the folder are validated before use: unknown keys, wrong types and broken JSON are ignored. Turning sync off leaves the files in the folder; delete them from Drive to remove them.
- The app keeps its own sync bookkeeping (device id, folder, last values) in `sync-state.json` in the profile folder, which is never synced.

## Network calls

Every outbound connection the source makes, and when it happens:

| Destination | When | What is sent |
| --- | --- | --- |
| `https://api.anthropic.com/api/oauth/usage` | The usage meters, on the app's read schedule (`src/core/usageScheduler.ts`) and when you click the meters to refresh | An authorization header with your Claude Code login token and nothing else from your sessions. The reply is the usage numbers the meters show. |
| `https://platform.claude.com/v1/oauth/token` | During a usage read, only when Claude Code's access token is about to expire (within five minutes) | A standard token refresh request: Claude Code's public client id, the saved refresh token and the scopes. The reply is written back as described above. |
| `https://github.com/fatty8me2/claude-visualized` (the update feed and the releases page) | 30 seconds after start, then every 6 hours, unless updates are turned off | The app's version and what the update client sends normally (your IP address, the request itself). With "Automatically download updates" on (the default), a newer installer is downloaded in the background. |
| `http://127.0.0.1:11434` (Ollama) and `http://127.0.0.1:1234` (LM Studio) | Polled every 5 seconds while those servers are used | Read-only status requests (for example `/api/ps`). Nothing leaves your computer. |
| Endpoints you add under local model settings | Polled the same way, read-only | Whatever you typed. If you enter a remote address, requests go there. Only add hosts you trust. |
| Links you click (release notes, the `claude://` deep link to the Claude desktop app) | When you click them | Opened in your browser or the Claude app by the operating system. The app sends nothing itself. |

### Only when you turn sharing on (off by default)

The peer link lets you watch another computer's sessions. It does nothing until you tick **Share with my other computers** on the
machine being watched.

| What | When | What is sent |
| --- | --- | --- |
| Listening on TCP port `47830` (all interfaces by default; `CLAUDE_VIS_PEER_BIND` narrows it) | While sharing is on | Pairing requests from computers that enter the one-time code |
| LAN broadcast beacon (UDP) | While sharing is on | This computer's name, its port and a hash of its device id. No session data. |
| Listening for beacons | While the Devices page of a viewing computer is open | Nothing is sent |
| Connection from a viewer to a paired host | While the viewer watches that host | Session data from the host, encrypted with AES-256-GCM. The keys come from a fresh key exchange on every connection (the pairing code only authenticates the first one). Read-only: the viewer cannot change anything on the host. |

Design and security notes: [PEER-LINK.md](PEER-LINK.md).

### Listening on your computer

- The hook receiver listens on `127.0.0.1:47821` only, so other computers cannot reach it. It accepts the events Claude Code sends and always answers `200` with an empty body. It never blocks or approves a tool call.
- The peer link is the only listener that can accept connections from other computers, and only while sharing is on.

## What you can turn off

- **Usage meters:** leave them alone and no usage calls or token renewals happen. Setting `CLAUDE_VIS_NO_USAGE_API=1` turns them off for a run (the e2e tests use this).
- **Updates:** set `CLAUDE_VIS_NO_UPDATES=1` to turn off update checks entirely. The settings page has "Automatically download updates" to stop background downloads while still checking.
- **Hooks:** remove them from the hooks dialog. The app then reads transcripts only, which is about a second behind.
- **Sync:** off by default; turn it off in Settings > Sync. The files stay in the folder.
- **Sharing:** off by default, and it stops listening as soon as you untick it.
- **Local model servers:** remove the endpoints you added in local model settings.
