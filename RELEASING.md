# Releasing

Releases are GitHub Releases on `github.com/fatty8me2/claude-visualized` (the repo must be public: installed apps fetch the update
feed anonymously, and **no token is ever embedded in the app**). Installed apps check about 30 s after start and then every hour,
download in the background and, with **Install updates automatically** (Settings → Updates, on by default), install the update by
themselves at a quiet moment, on Windows and macOS alike. Nobody has to download or click anything.

**The quiet moment** (`isQuietMoment` in `src/core/updates.ts`), looked for every 30 s once an update is downloaded: the main window is
hidden to the tray, minimized or not focused, or the computer has had no keyboard or mouse input for 2 minutes. Never while you are
working in the window. The app then restarts into the new version the way the window was: hidden to the tray stays hidden, a window in
the background comes back without taking focus, a minimized one comes back minimized. A one-shot `<userData>/restart-update.json` carries
that (and the version being installed) to the next start, which reads and deletes it; one older than 10 minutes only counts for the
version check. If the restart did not install the new version, the app says so ("Update failed" in the title bar, with the reason on
macOS) and does not install that version by itself again in that run, so it never loops; "Restart & update" retries.

For the impatient, the title bar shows the version and, while an update waits, a chip ("Update to vX" → "Updating 42%" → "Restart to
update"); the version opens the update card with "Check now". If the feed goes out of reach (a 404, e.g. the repo was made private), the
chip says "Updates unreachable" instead of staying quiet.

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
4. electron-builder creates a **draft** release (`releaseType: draft`) and uploads the installer, its `.blockmap` and `latest.yml`
   (`latest-mac.yml` on macOS). Publishing straight to a non-draft release races (it tries to create the release twice and one upload
   fails, leaving `latest.yml` out of sync with the installer). Check the three assets (two drafts? see below), write the notes, then publish:
   `gh release edit v<version> --draft=false`. Users only see drafts once published; the "release notes" snippet in Settings → Updates shows them.
   Never build twice into the same `release/<version>` folder before uploading: `latest.yml`'s sha512 must match the uploaded installer.

   **Two drafts for one tag.** Draft mode makes the race rarer but not impossible: 0.4.0 and 0.9.0 each got a second draft holding only
   the `.blockmap`. Commands that take the tag (`gh release edit`, `gh release upload`, the Mac job in step 5) can then pick the wrong one,
   so get back to one draft before publishing. List the drafts, keep the one with the installer and delete the other (its files are all in
   `release/<version>/`, and deleting a release keeps the tag). Upload what the kept draft lacks through the API, which lets you set the
   asset name: the local files have spaces, but `latest.yml` points at the names with dashes.
   ```powershell
   gh api repos/fatty8me2/claude-visualized/releases --jq '.[] | select(.draft) | {id, tag_name, assets: [.assets[].name]}'
   gh api --method DELETE repos/fatty8me2/claude-visualized/releases/<other draft id>
   gh api --method POST -H "Content-Type: application/octet-stream" "https://uploads.github.com/repos/fatty8me2/claude-visualized/releases/<kept draft id>/assets?name=Claude-Visualized-Setup-<version>.exe.blockmap" --input "release/<version>/Claude Visualized Setup <version>.exe.blockmap"
   ```
   Then check the three assets and publish as above. Afterwards
   `https://github.com/fatty8me2/claude-visualized/releases/latest/download/latest.yml` should show the new version.

5. **macOS assets come from CI, after you publish.** Publishing the release triggers `.github/workflows/release-mac.yml` (macos-latest),
   which checks out the tag, builds an unsigned universal build and uploads `Claude-Visualized-<version>-mac-universal.dmg`, `.zip`, both
   `.blockmap`s and `latest-mac.yml` to that release (`--clobber`). Takes a few minutes. To retry or backfill: Actions, release-mac, Run workflow,
   enter the tag. The workflow file must be pushed with a token that has the `workflow` scope. Macs update from the `.zip` and
   `latest-mac.yml` (see below), so a release without them is invisible to Macs. `ci/github-build.yml`'s tag job no longer builds the Mac.
   In those minutes a Mac that checks finds the new release without `latest-mac.yml`: it treats that as "a new version is being
   published" (calm, no error) and checks again 10 minutes later instead of in an hour (`isMacChannelPending`). A feed it cannot see at
   all (private or moved repo) is still the "Updates unreachable" error.

`npm run dist:win` / `dist:mac` build local installers into `release/<version>/` with `--publish never`; nothing is uploaded.

## How updates are found: `latest.yml`

`latest.yml` is generated next to the installer and lists the newest version, the installer file name, its size and SHA-512. The
packaged app contains `resources/app-update.yml` (written by electron-builder from the `publish` config), pointing at the GitHub repo.
`electron-updater` downloads the `latest.yml` attached to the latest release, compares versions (semver), and if newer downloads the
installer (using the `.blockmap` for a differential download when possible) and verifies the SHA-512. The app installs it at the next
quiet moment (silent NSIS run with relaunch), on "Restart & update", or when the app quits.
A release without `latest.yml` is invisible to the updater, so never delete it from a release.

## Unsigned builds: what to expect

- **Windows:** the builds are not code-signed. `electron-updater` only verifies the installer's publisher when `win.publisherName` is
  configured (we do not set it), so unsigned updates install fine; integrity is checked with the SHA-512 from `latest.yml`. The user sees
  SmartScreen ("Windows protected your PC" → More info → Run anyway) only for the **first, manual** install. Later updates run the NSIS
  installer from the already-trusted app (silently for the automatic install, with its progress window for "Restart & update") and
  show no SmartScreen prompt. If you later buy a certificate, add
  `win.publisherName` so updates are also verified against it.
- **macOS:** Squirrel.Mac refuses to apply an update to an app without a valid Developer ID signature, so the ad-hoc signed app updates
  itself (`src/main/macUpdate.ts`, pure parts in `src/core/macUpdate.ts`): it downloads the universal `.zip` that `latest-mac.yml` lists,
  checks its SHA-512, unpacks it with `ditto` into `<userData>/mac-update/`, and checks the bundle's version. At the quiet moment, on
  "Restart & update", or when the app quits, a detached `/bin/sh` script waits for the app to exit, copies the new bundle next to the old
  one, swaps them with two renames (putting the old one back if the second fails), strips the quarantine flag and reopens the app (with
  `open -g`, in the background, for the automatic install). Its log is `<userData>/mac-update/swap.log`, one entry per run starting with
  "update to <version>". At the next start the app reads the last entry: if it is a failure (copy failed, swap failed, could not move
  the old version aside, the app did not quit) and this is still the older version, it shows "Update failed" with that reason. The next
  check downloads it again, and "Restart & update" retries. The download comes from the app itself, so it carries no quarantine flag and
  opens without a Gatekeeper prompt. A copy that cannot replace itself falls back to "manual" mode with the reason. Run from the `.dmg` or
  translocated (opened where it was downloaded), it offers **Move to Applications** in the update card and in Settings (Electron's
  `app.moveToApplicationsFolder()`, which copies it to /Applications, quits and opens the moved copy, which then updates itself). In a
  folder it may not write, it links to the release page. After signing and notarizing, set `MAC_SIGNED = true` in
  `src/main/updater.ts` to use Squirrel.Mac instead.
- **Private repo / no releases:** a 404 from GitHub is shown as an error ("Updates unreachable" in the title bar), because a released app
  that cannot see its releases has silently stopped updating.

## Environment variables

| Variable | Effect |
| --- | --- |
| `CLAUDE_VIS_NO_UPDATES=1` | updates disabled (state `disabled`); e2e sets this |
| `CLAUDE_VIS_UPDATE_URL=<url>` | test only: use a generic feed at this URL instead of GitHub, also in unpackaged builds |
| `CLAUDE_VIS_UPDATE_DELAY_MS` | test only: delay of the first automatic check (default 30000) |
| `CLAUDE_VIS_UPDATE_RECHECK_MS` | test only: minimum gap before re-showing the window re-checks (default 30 minutes) |
| `CLAUDE_VIS_UPDATE_QUIET_MS` | test only (ignored in installed builds): how often a downloaded update looks for a quiet moment (default 30000) |
| `CLAUDE_VIS_UPDATE_FAKE_INSTALL=<file>` | test only (ignored in installed builds): download and install only pretend; the install writes `{auto, window, version, at}` to this file instead of quitting |

Updates are always disabled in unpackaged (dev) builds unless `CLAUDE_VIS_UPDATE_URL` is set.

## Testing an update locally

Automated: `tests/e2e/updates.test.ts` serves a fake `latest.yml` from a local HTTP server and checks the app reaches "available"; with
`CLAUDE_VIS_UPDATE_FAKE_INSTALL` it checks the automatic install stays off when unticked, waits while the window is in use, and fires
once the window is hidden (asking the next start to stay hidden); and that a restart that did not install the new version shows
"Update failed". The real download and install are not covered, they need a packaged app.

Full end to end, on a throwaway machine or VM (the NSIS installer installs per user, no admin):

1. Build and install version `0.1.0`: `npm run dist:win`, run `release/0.1.0/Claude Visualized Setup 0.1.0.exe`.
2. Bump to `0.2.0` (`npm version minor --no-git-tag-version`), `npm run dist:win`.
3. Serve the new output as a fake release: `npx http-server release/0.2.0 -p 8099` (it contains `latest.yml`, the installer and the blockmap).
4. Start the installed app with the feed override: `$env:CLAUDE_VIS_UPDATE_URL='http://127.0.0.1:8099/'; & '<install dir>\Claude Visualized.exe'` (the folder chosen in the installer)
   (set `CLAUDE_VIS_UPDATE_DELAY_MS=2000` to skip the 30 s wait, or use Settings → Updates → Check now).
5. Expect: available → downloading (percent) → "Restart to update" in the title bar. "Restart & update" runs the installer and
   relaunches, and the new version says "Updated to v0.2.0" once.
   Quitting the app normally also installs it (`autoInstallOnAppQuit`). To see the automatic install, leave it downloaded and hide the
   window to the tray (or switch to another app): within about 30 s it installs silently and comes back hidden (or in the background).

Alternative with a real GitHub **draft** release: `npx electron-builder --win --publish always` with `releaseType: draft` (override with
`-c.publish.releaseType=draft`) uploads without publishing; drafts are not visible to the updater, so use this only to check the upload.

electron-updater also supports a `dev-app-update.yml` in the project root for unpackaged runs (needs `autoUpdater.forceDevUpdateConfig`);
this app uses `CLAUDE_VIS_UPDATE_URL` instead, which does the same thing with a generic feed.
