# Releasing

Releases are GitHub Releases on `github.com/fatty8me2/claude-visualized` (the repo must be public: installed apps fetch the update
feed anonymously, and **no token is ever embedded in the app**). Installed apps check about 30 s after start and then every 6 hours,
download in the background and offer "Restart to update".

## Cut a release

1. Make sure `master` is green (`npm run check`, `npx electron-vite build`, e2e).
2. Bump the version. This edits `package.json`, commits and tags `vX.Y.Z`:
   ```
   npm version minor        # or patch / major
   git push origin master --follow-tags
   ```
3. Publish, either way:
   - **CI (preferred):** move `ci/github-build.yml` to `.github/workflows/` (needs a token with the `workflow` scope). Pushing a `v*` tag
     runs the `release` job: Windows and macOS builds, published with the built-in `secrets.GITHUB_TOKEN`.
   - **From your machine:** create a fine-grained or classic token with *contents: write* on the repo and keep it out of git:
     ```powershell
     $env:GH_TOKEN = '<token>'
     npm run release:win      # Windows NSIS installer
     npm run release:mac      # on a Mac only
     ```
4. electron-builder creates the release for the tag (`releaseType: release`, so it is published immediately, not a draft) and uploads
   the installer, its `.blockmap` and `latest.yml` (`latest-mac.yml` on macOS). Edit the release notes on GitHub; the "release notes"
   snippet in Settings → Updates shows them.

`npm run dist:win` / `dist:mac` build local installers into `release/<version>/` with `--publish never`; nothing is uploaded.

## How updates are found: `latest.yml`

`latest.yml` is generated next to the installer and lists the newest version, the installer file name, its size and SHA-512. The
packaged app contains `resources/app-update.yml` (written by electron-builder from the `publish` config), pointing at the GitHub repo.
`electron-updater` downloads the `latest.yml` attached to the latest release, compares versions (semver), and if newer downloads the
installer (using the `.blockmap` for a differential download when possible), verifies the SHA-512 and installs it when the app quits.
A release without `latest.yml` is invisible to the updater, so never delete it from a release.

## Unsigned builds: what to expect

- **Windows:** the builds are not code-signed. `electron-updater` only verifies the installer's publisher when `win.publisherName` is
  configured (we do not set it), so unsigned updates install fine; integrity is checked with the SHA-512 from `latest.yml`. The user sees
  SmartScreen ("Windows protected your PC" → More info → Run anyway) only for the **first, manual** install. Later updates run the NSIS
  installer silently-ish from the already-trusted app and show no SmartScreen prompt. If you later buy a certificate, add
  `win.publisherName` so updates are also verified against it.
- **macOS:** Squirrel.Mac refuses to apply an update to an app without a valid Developer ID signature. Unsigned Mac builds therefore run in
  "manual" mode: the app still checks for new versions, and Settings, the sidebar pill and the tray show "Download the new version" with
  a link to the release page. After signing and notarizing, set `MAC_SIGNED = true` in `src/main/updater.ts` to turn on in-app updates.
- **Private repo / no releases:** a 404 from GitHub is shown as "No releases published yet", not as an error.

## Environment variables

| Variable | Effect |
| --- | --- |
| `CLAUDE_VIS_NO_UPDATES=1` | updates disabled (state `disabled`); e2e sets this |
| `CLAUDE_VIS_UPDATE_URL=<url>` | test only: use a generic feed at this URL instead of GitHub, also in unpackaged builds |
| `CLAUDE_VIS_UPDATE_DELAY_MS` | test only: delay of the first automatic check (default 30000) |

Updates are always disabled in unpackaged (dev) builds unless `CLAUDE_VIS_UPDATE_URL` is set.

## Testing an update locally

Automated: `tests/e2e/updates.test.ts` serves a fake `latest.yml` from a local HTTP server and checks the app reaches "available"
(download and install are not covered, they need a packaged app).

Full end to end, on a throwaway machine or VM (the NSIS installer installs per user, no admin):

1. Build and install version `0.1.0`: `npm run dist:win`, run `release/0.1.0/Claude Visualized Setup 0.1.0.exe`.
2. Bump to `0.2.0` (`npm version minor --no-git-tag-version`), `npm run dist:win`.
3. Serve the new output as a fake release: `npx http-server release/0.2.0 -p 8099` (it contains `latest.yml`, the installer and the blockmap).
4. Start the installed app with the feed override: `$env:CLAUDE_VIS_UPDATE_URL='http://127.0.0.1:8099/'; & '<install dir>\Claude Visualized.exe'` (the folder chosen in the installer)
   (set `CLAUDE_VIS_UPDATE_DELAY_MS=2000` to skip the 30 s wait, or use Settings → Updates → Check now).
5. Expect: available → downloading (percent) → "↑ v0.2.0 ready · restart" pill. "Restart & update" runs the installer and relaunches.
   Quitting the app normally also installs it (`autoInstallOnAppQuit`).

Alternative with a real GitHub **draft** release: `npx electron-builder --win --publish always` with `releaseType: draft` (override with
`-c.publish.releaseType=draft`) uploads without publishing; drafts are not visible to the updater, so use this only to check the upload.

electron-updater also supports a `dev-app-update.yml` in the project root for unpackaged runs (needs `autoUpdater.forceDevUpdateConfig`);
this app uses `CLAUDE_VIS_UPDATE_URL` instead, which does the same thing with a generic feed.
