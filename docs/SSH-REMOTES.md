# SSH remotes: watching a computer without the app on it

The peer link ([PEER-LINK.md](PEER-LINK.md)) needs Claude Visualized running on both computers. An SSH remote needs it on one: the
computer you look from logs in to the other over SSH, reads its Claude Code transcripts and shows its sessions in the sidebar, on the
all-sessions page and in the inbox, under that computer's name.

## Setting one up

1. The other computer must accept SSH logins with a key.
   - Mac: System Settings → General → Sharing → Remote Login.
   - Windows: in an Administrator PowerShell, `Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0`, then
     `Start-Service sshd` and `Set-Service -Name sshd -StartupType Automatic`. For an account that is an administrator, the public
     key goes in `C:\ProgramData\ssh\administrators_authorized_keys`, not in the user's `.ssh` folder.
2. From a terminal on this computer, `ssh user@host` must work without typing a password (an SSH key, an agent, or Tailscale SSH). The
   first time, ssh asks you to accept the other computer's key: do that once in the terminal.
3. In the app: **Devices → Watch a computer without the app**, enter `user@host` (a Tailscale name or 100.x address works) and add it.

The other side can be macOS or Linux (a POSIX `sh` with `find`, `stat`, `tail` and `head`) or Windows (Windows PowerShell 5.1,
which every Windows 10 and 11 has). The app tries `sh` first; when the other computer answers that it does not know `sh`, it switches
to PowerShell and remembers that for the computer.

## How it works

- The app starts the system `ssh` client (`ssh -T -o BatchMode=yes user@host sh`, or `... powershell -NoProfile -Command -` for Windows). `BatchMode` means ssh never prompts: a missing key or
  an unknown host key fails with a message on the Devices page. The app never sees, asks for or stores a password or a key.
- The remote shell is sent a small script (`REMOTE_SCRIPT` / `REMOTE_SCRIPT_PS` in `src/core/sshRemote.ts`) with three read-only requests: list the transcript
  files under `~/.claude/projects` with their size and time, read a byte range of one of them, and read a byte range of
  [Kiln](https://github.com/fatty8me2/kiln)'s events file (or its rotation `events.jsonl.1`), found the way Kiln finds it. Nothing is installed, written or
  changed on the other computer, and nothing keeps running there after the connection closes.
- What is new is copied into a mirror folder in this computer's app data folder (`ssh-mirror/<id>/projects`), laid out like
  `~/.claude/projects`. A second, passive session manager follows that folder exactly like local sessions, and the main one merges it
  the same way it merges a paired computer (`remote:<id>:<sessionId>`).
- Recently changed files are listed every 1.5 seconds and everything from the last 14 days once a minute, so a live session shows up
  with a second or two of lag.

## What is copied

- **Live sessions** (active in the last 15 minutes) and **the session you select**: the main transcript, subagent transcripts, workflow
  journals and titles.
- **The 30 most recent other sessions**: the main transcript and title only, enough for the session list.
- **Kiln's events file** (local-model hand-offs), when the other computer has one: the new bytes as often as the quick listing, into
  `ssh-mirror/<id>/kiln/`. When Kiln rotates it, the local copy is rotated too and the rest of the old file is read from `.1`. Runs
  show under the remote session that handed them off, and runs nobody claims get a Kiln session of their own. A run with no news for
  30 minutes counts as failed (its process cannot be checked from here). "Show Kiln runs" in Settings switches this off too.
- Transcripts only grow, so only the new bytes are fetched. A file that is not here yet is downloaded as `.part` and renamed when
  complete. Copies of files the other computer no longer lists (deleted, or older than 14 days) are removed.
- Removing the remote on the Devices page deletes its whole mirror folder.

## Known limits

- No hooks from the other computer, so states that only hooks report arrive when the transcript shows them.
- Usage meters stay per computer: the other computer's login is never read.
- The first connection copies the recent backlog, which can be tens of megabytes; the Devices page shows what is left.
- History and search cover this computer's sessions only.
- "Open in Claude" is off for remote sessions, like on the peer link.
