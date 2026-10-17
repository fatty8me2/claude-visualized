# Building and running on a Mac

CI can't build the Mac app yet (pushing the workflow needs a GitHub token with the `workflow` scope, see the README), so build it on the Mac
itself. Either way works on Apple Silicon and Intel Macs.

## Prerequisites

- macOS 12 or later.
- **Node.js 24**: the installer from <https://nodejs.org>, or `brew install node@24` (then follow brew's note to put it on your `PATH`).
  Check with `node -v` (should print `v24.…`).
- **git**: `xcode-select --install` installs it with the Command Line Tools (or `brew install git`).

## Get the code

```bash
git clone https://github.com/fatty8me2/claude-visualized.git
cd claude-visualized
npm ci
```

`npm ci` downloads the Electron binary for your Mac's architecture. No native modules are compiled.

## Option A: run from source (quickest)

```bash
npx electron-vite build && npx electron .
```

Or `npm run dev` for hot reload while changing code. Running from source needs no signing and shows no Gatekeeper prompt. It runs as "Electron"
in the Dock and in firewall prompts.

## Option B: build the app (.dmg)

```bash
npm run dist:mac
```

This writes two disk images to `release/0.1.0/`, one for Apple Silicon (`…-arm64.dmg`) and one for Intel (no arch suffix, or `…-x64.dmg`).
`dist:mac` never publishes anything. Open the one for your Mac and drag **Claude Visualized** to **Applications**.

The app is **ad-hoc signed** (`"identity": "-"` in `package.json`, so no Apple Developer ID is needed and the build doesn't fail) and **not
notarized**. The first time you open it, macOS refuses. Use one of these:

- Right-click (or Control-click) the app in Applications → **Open** → **Open**.
- On macOS 15 (Sequoia) and later that shortcut is gone: try to open it once, then go to **System Settings → Privacy & Security**, scroll down
  and click **Open Anyway**.
- Or remove the quarantine flag in Terminal:

  ```bash
  xattr -dr com.apple.quarantine "/Applications/Claude Visualized.app"
  ```

In-app updates on an unsigned Mac build don't install themselves: the app shows "Download vX…" and opens the release page instead.

## Share this Mac's sessions with your Windows PC

1. In the app, open **devices** in the sidebar and tick **Share with my other computers**. The sidebar and the tray menu show "sharing" while it
   is on. A pairing code like `7KQ4-M2XD` appears, valid for 10 minutes and usable once.
2. **macOS firewall prompt.** If the firewall is on (System Settings → Network → Firewall), macOS asks _"Do you want the application
   'Claude Visualized' to accept incoming network connections?"_ Click **Allow**. If you clicked Deny, or nothing asked: System Settings →
   Network → Firewall → **Options…**, find Claude Visualized (or "Electron" when running from source) and set it to **Allow incoming
   connections**. "Block all incoming connections" must be off. Because the build is ad-hoc signed, macOS may ask again after you install a new
   build.
3. Find the Mac's address:
   - same network: its local hostname, under System Settings → General → Sharing → **Local hostname** (e.g. `Johns-MacBook-Pro.local`), or its
     IP from `ipconfig getifaddr en0`. The PC's Devices page also lists Macs that are sharing on the same network.
   - Tailscale: the MagicDNS name (e.g. `johns-macbook-pro.tailnet-name.ts.net`) or `tailscale ip -4`. Nothing else to set up.
4. On the PC: **devices** → _Pair with code_ → host, port `47830`, the code → **pair**. The Mac's sessions now show under its name in the PC's
   sidebar, on the all-sessions page and in the inbox. The first time the PC listens for the Mac's discovery beacon, Windows may ask about
   the firewall; you can deny that and type the host instead.

Check that the Mac is listening (while sharing): `nc -vz localhost 47830` in Terminal on the Mac, and `Test-NetConnection <mac> -Port 47830` in
PowerShell on the PC.

Notes:

- The link is read-only: the PC can watch, never act on the Mac's sessions or files.
- When the Mac sleeps, the PC shows it as "offline since …" and reconnects by itself when it wakes. To keep it reachable, see System Settings →
  Battery / Energy → _Prevent automatic sleeping when the display is off_, or run `caffeinate -s` while you need it.
- Turning sharing off closes the port immediately. Un-pair a computer under **devices → Paired computers**.
- Protocol and security details: [PEER-LINK.md](PEER-LINK.md).

## Tests on the Mac

```bash
npm run check        # typecheck + lint + unit tests
npm run test:e2e     # builds, then drives the app with Playwright
```
