#!/bin/sh
# Install or update Claude Visualized on a Mac in one step, no .dmg, no right-click → Open:
#
#   curl -fsSL https://raw.githubusercontent.com/fatty8me2/claude-visualized/master/scripts/install-mac.sh | sh
#
# Downloads the latest release's universal .zip, checks it against the SHA-512 in latest-mac.yml, quits the running app,
# puts the new one in /Applications (keeping the old one until the new one is in place), and opens it. curl does not set
# the quarantine flag, so macOS opens it without the "unidentified developer" prompt. From 0.13.0 on the app also updates
# itself; this is for the first install and for getting off an older version.
#
# Test hooks: CV_FEED (where latest-mac.yml and the .zip are), CV_APP_DIR (instead of /Applications), CV_NO_OPEN=1.
set -eu

NAME="Claude Visualized"
FEED="${CV_FEED:-https://github.com/fatty8me2/claude-visualized/releases/latest/download}"
if [ -n "${CV_APP_DIR:-}" ]; then
  DIR="$CV_APP_DIR"
elif [ -d "$HOME/Applications/$NAME.app" ] && [ ! -d "/Applications/$NAME.app" ]; then
  DIR="$HOME/Applications"
else
  DIR="/Applications"
fi
APP="$DIR/$NAME.app"

say() { printf '%s\n' "$*"; }
fail() { printf 'Claude Visualized install: %s\n' "$*" >&2; exit 1; }

tmp=$(mktemp -d "${TMPDIR:-/tmp}/cv-install.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

say "Checking the latest version..."
curl -fsSL "$FEED/latest-mac.yml" -o "$tmp/latest-mac.yml" || fail "could not reach the releases ($FEED)."
version=$(sed -n 's/^version:[[:space:]]*//p' "$tmp/latest-mac.yml" | head -n 1 | tr -d "'\"\r")
zip=$(sed -n 's/^[[:space:]]*-[[:space:]]*url:[[:space:]]*\(.*\.zip\)[[:space:]]*$/\1/p' "$tmp/latest-mac.yml" | head -n 1 | tr -d "'\"\r")
sha=$(awk -v z="$zip" '
  /^[[:space:]]*-[[:space:]]*url:/ { hit = (index($0, z) > 0) }
  hit && /^[[:space:]]*sha512:/ { sub(/^[[:space:]]*sha512:[[:space:]]*/, ""); gsub(/[\r"'"'"']/, ""); print; exit }
' "$tmp/latest-mac.yml")
[ -n "$version" ] && [ -n "$zip" ] && [ -n "$sha" ] || fail "the release has no macOS download yet. Try again in a few minutes."

installed=""
if [ -f "$APP/Contents/Info.plist" ]; then
  installed=$(plutil -extract CFBundleShortVersionString raw "$APP/Contents/Info.plist" 2>/dev/null || true)
fi
if [ "$installed" = "$version" ]; then
  say "$NAME $version is already installed."
  exit 0
fi
say "Downloading $NAME $version${installed:+ (you have $installed)}..."
curl -fL --progress-bar "$FEED/$zip" -o "$tmp/update.zip" || fail "the download failed."
got=$(openssl dgst -sha512 -binary "$tmp/update.zip" | base64 | tr -d '\n')
[ "$got" = "$sha" ] || fail "the download did not match its checksum, so nothing was changed."
ditto -x -k "$tmp/update.zip" "$tmp/x" || fail "could not unpack the download."
new=$(find "$tmp/x" -maxdepth 1 -name '*.app' | head -n 1)
[ -n "$new" ] || fail "the download held no app."

# quit the running app (it may sit in the menu bar); give it 20 s, then stop it
if pgrep -x "$NAME" >/dev/null 2>&1; then
  say "Quitting $NAME..."
  osascript -e "tell application \"$NAME\" to quit" >/dev/null 2>&1 || true
  i=0
  while pgrep -x "$NAME" >/dev/null 2>&1; do
    i=$((i + 1))
    [ "$i" -gt 40 ] && { pkill -x "$NAME" 2>/dev/null || true; sleep 1; break; }
    sleep 0.5
  done
fi

mkdir -p "$DIR" 2>/dev/null || true
[ -w "$DIR" ] || fail "cannot write to $DIR. Run it again with CV_APP_DIR=\"\$HOME/Applications\" in front of sh."
rm -rf "$APP.cv-new" "$APP.cv-old"
ditto "$new" "$APP.cv-new" || { rm -rf "$APP.cv-new"; fail "could not copy the app into $DIR; nothing was changed."; }
if [ -d "$APP" ]; then
  mv "$APP" "$APP.cv-old" || { rm -rf "$APP.cv-new"; fail "could not move the old version aside; nothing was changed."; }
fi
if ! mv "$APP.cv-new" "$APP"; then
  [ -d "$APP.cv-old" ] && mv "$APP.cv-old" "$APP"
  rm -rf "$APP.cv-new"
  fail "could not put the new version in place; the old one is back."
fi
rm -rf "$APP.cv-old"
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

say "$NAME $version is installed in $DIR. From now on it updates itself."
[ "${CV_NO_OPEN:-}" = 1 ] || open "$APP"
