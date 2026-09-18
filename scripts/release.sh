#!/usr/bin/env bash
set -euo pipefail

RELEASES_REPO="mithril-studio/powerhouse-releases"
NOTES="${1:-}"
KEY_PATH="${TAURI_SIGNING_PRIVATE_KEY_PATH:?TAURI_SIGNING_PRIVATE_KEY_PATH is required}"

fail() {
  echo "error: $*" >&2
  exit 1
}

[ -f "$KEY_PATH" ] || fail "updater signing key not found"

VERSION="$(node -p "require('./src-tauri/tauri.conf.json').version")"
TAG="v${VERSION}"
if gh release view "$TAG" --repo "$RELEASES_REPO" >/dev/null 2>&1; then
  fail "release ${TAG} already exists; bump the app version first"
fi

export TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY_PATH")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD

echo "==> Building Powerhouse ${TAG}"
npx tauri build --bundles app

BUNDLE_ROOT="src-tauri/target/release/bundle"
APP_PATH="$BUNDLE_ROOT/macos/Powerhouse.app"
APP_TAR="$APP_PATH.tar.gz"
APP_SIG="$APP_TAR.sig"
APP_PLIST="$APP_PATH/Contents/Info.plist"
[ -d "$APP_PATH" ] || fail "app bundle was not built"
[ -f "$APP_TAR" ] || fail "updater artifact was not built"
[ -f "$APP_SIG" ] || fail "updater signature was not built"

echo "==> Verifying Developer ID signature"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"
SIGN_INFO="$(codesign -dvvv "$APP_PATH" 2>&1)"
BUNDLE_ID="$(node -p "require('./src-tauri/tauri.conf.json').identifier")"
grep -Fqx "Identifier=${BUNDLE_ID}" <<< "$SIGN_INFO" || fail "bundle identifier is not bound to the signature"
grep -Fqx "Authority=${APPLE_SIGNING_IDENTITY:?APPLE_SIGNING_IDENTITY is required}" <<< "$SIGN_INFO" \
  || fail "bundle is not signed by the configured Developer ID identity"
grep -q '^CodeDirectory.*runtime' <<< "$SIGN_INFO" || fail "hardened runtime is not enabled"

DMG_DIR="$BUNDLE_ROOT/dmg"
mkdir -p "$DMG_DIR"
DMG_OUT="$DMG_DIR/Powerhouse_${VERSION}_$(uname -m).dmg"
STAGE_DIR="$(mktemp -d)"
trap 'rm -rf "$STAGE_DIR"' EXIT
cp -R "$APP_PATH" "$STAGE_DIR/"
ln -s /Applications "$STAGE_DIR/Applications"
hdiutil create -volname "Powerhouse" -srcfolder "$STAGE_DIR" -ov -format UDZO "$DMG_OUT" >/dev/null

[ -r "${NOTARY_API_KEY_PATH:-}" ] || fail "notarization API key is unavailable"
[ -n "${NOTARY_API_KEY_ID:-}" ] || fail "NOTARY_API_KEY_ID is required"
[ -n "${NOTARY_API_ISSUER:-}" ] || fail "NOTARY_API_ISSUER is required"
echo "==> Notarizing and stapling the DMG"
xcrun notarytool submit "$DMG_OUT" \
  --key "$NOTARY_API_KEY_PATH" \
  --key-id "$NOTARY_API_KEY_ID" \
  --issuer "$NOTARY_API_ISSUER" \
  --wait
xcrun stapler staple "$DMG_OUT"
xcrun stapler validate "$DMG_OUT"

ARCH="$(uname -m)"
case "$ARCH" in
  arm64) RUST_TARGET="aarch64" ;;
  x86_64) RUST_TARGET="x86_64" ;;
  *) fail "unsupported macOS architecture: $ARCH" ;;
esac

RELEASE_TAR="Powerhouse_${VERSION}_${RUST_TARGET}.app.tar.gz"
RELEASE_SIG="${RELEASE_TAR}.sig"
RELEASE_DIR="$BUNDLE_ROOT/macos"
cp "$APP_TAR" "$RELEASE_DIR/$RELEASE_TAR"
cp "$APP_SIG" "$RELEASE_DIR/$RELEASE_SIG"

SIGNATURE="$(cat "$APP_SIG")"
LATEST_DIR="$(mktemp -d)"
LATEST_JSON="$LATEST_DIR/latest.json"
trap 'rm -rf "$STAGE_DIR" "$LATEST_DIR"' EXIT
cat > "$LATEST_JSON" <<EOF
{
  "version": "${VERSION}",
  "notes": $(printf '%s' "${NOTES:-Release ${TAG}}" | jq -Rs .),
  "pub_date": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "platforms": {
    "darwin-${RUST_TARGET}": {
      "signature": $(printf '%s' "$SIGNATURE" | jq -Rs .),
      "url": "https://github.com/${RELEASES_REPO}/releases/download/${TAG}/${RELEASE_TAR}"
    }
  }
}
EOF

echo "==> Publishing ${TAG}"
gh release create "$TAG" \
  --repo "$RELEASES_REPO" \
  --title "Powerhouse ${TAG}" \
  --notes "${NOTES:-Release ${TAG}}" \
  "$RELEASE_DIR/$RELEASE_TAR" \
  "$RELEASE_DIR/$RELEASE_SIG" \
  "$DMG_OUT" \
  "$LATEST_JSON"
