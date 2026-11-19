// Pure pieces of the unsigned macOS self-update (src/main/macUpdate.ts does the downloading and spawning).
//
// Squirrel.Mac only installs updates into apps signed with a Developer ID, and this app is ad-hoc signed. So the app updates
// itself the plain way: download the release's universal .zip (listed in latest-mac.yml with its sha512), check the hash,
// unpack it with ditto, and when the app quits, a small detached shell script swaps the bundle in place and (on "Restart &
// update") opens it again. The new bundle is downloaded by the app itself, so it carries no quarantine flag and opens
// without a Gatekeeper prompt.

/** The .app bundle the running executable lives in (…/Name.app/Contents/MacOS/Name), or null. */
export function macBundlePath(execPath: string): string | null {
  const m = /^(.*?\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath);
  return m ? m[1] : null;
}

/** The folder that holds a bundle. */
export function bundleParent(bundle: string): string {
  return bundle.replace(/\/[^/]+$/, '') || '/';
}

/**
 * Why this copy cannot replace its own bundle, as advice for the user, or null when it can. `parentWritable`: the folder that
 * holds the bundle can be written (the swap renames the bundle in that folder).
 */
export function macSelfInstallBlocker(bundle: string | null, parentWritable: boolean): string | null {
  if (!bundle) return 'This copy is not running from an app bundle, so it cannot update itself. Get new versions from the releases page.';
  if (bundle.includes('/AppTranslocation/'))
    return 'macOS is running this copy from a temporary location because it was opened where it was downloaded. Move Claude Visualized to Applications and open it from there, and it will update itself.';
  if (bundle.startsWith('/Volumes/'))
    return 'This copy is running from the disk image. Drag Claude Visualized to Applications and open it from there, and it will update itself.';
  if (!parentWritable) return `This copy cannot write to ${bundleParent(bundle)}, so it cannot update itself. Get new versions from the releases page.`;
  return null;
}

export interface FeedFile {
  url: string;
  sha512: string;
  size?: number;
}

/** The universal .zip a release lists for macOS (latest-mac.yml), or null. */
export function macZipAsset(files: readonly FeedFile[] | undefined): FeedFile | null {
  return (files ?? []).find((f) => /\.zip$/i.test(f.url) && !!f.sha512) ?? null;
}

/** Where to download a release file: the GitHub release's assets, or the test feed (CLAUDE_VIS_UPDATE_URL) when one is set. */
export function macAssetUrl(releasesUrl: string, version: string, file: string, feedOverride?: string): string {
  if (/^https?:\/\//i.test(file)) return file;
  if (feedOverride) return feedOverride.replace(/\/?$/, '/') + encodeURIComponent(file);
  return `${releasesUrl}/download/v${version}/${encodeURIComponent(file)}`;
}

/**
 * The swap, run by /bin/sh after the app has quit: sh <script> <pid> <target.app> <staged.app> <relaunch 0|1> <log>.
 * Waits up to a minute for the app to exit, copies the staged bundle next to the old one, swaps the two with renames (putting
 * the old one back if the second rename fails), and opens the app again when asked. Never leaves the user without an app.
 */
export const MAC_SWAP_SCRIPT = `#!/bin/sh
pid="$1"; target="$2"; staged="$3"; relaunch="$4"; log="$5"
exec >>"$log" 2>&1
echo "$(date) update: $staged -> $target"
i=0
while kill -0 "$pid" 2>/dev/null; do
  i=$((i+1))
  if [ "$i" -gt 600 ]; then echo "the app did not quit; update left for next time"; exit 1; fi
  sleep 0.1
done
new="$target.cv-new"; old="$target.cv-old"
rm -rf "$new" "$old"
if ! ditto "$staged" "$new"; then
  echo "copy failed"; rm -rf "$new"
  [ "$relaunch" = 1 ] && open "$target"
  exit 1
fi
xattr -dr com.apple.quarantine "$new" 2>/dev/null
if mv "$target" "$old"; then
  if mv "$new" "$target"; then
    rm -rf "$old" "$staged"
    echo "updated"
  else
    echo "swap failed: putting the old version back"
    mv "$old" "$target"; rm -rf "$new"
  fi
else
  echo "could not move the old version aside"; rm -rf "$new"
fi
[ "$relaunch" = 1 ] && open "$target"
exit 0
`;
