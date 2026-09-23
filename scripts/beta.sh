#!/usr/bin/env bash
set -euo pipefail

# Builds a signed + notarized beta DMG and publishes it as a GitHub PRE-RELEASE
# on this repo. Pre-releases are excluded from the updater endpoint
# (/releases/latest/...), so a beta can never be served to end users. Install
# the DMG by hand, verify the build actually contains what you expect, then
# promote by opening a PR from `test` into `main` and cutting the real v* tag.

REPO="${BETA_REPO:-mithril-studio/powerhouse}"
NOTES="${1:-}"
KEY_PATH="${TAURI_SIGNING_PRIVATE_KEY_PATH:?TAURI_SIGNING_PRIVATE_KEY_PATH is required}"

fail() {
  echo "error: $*" >&2
  exit 1
}

[ -f "$KEY_PATH" ] || fail "updater signing key not found"

VERSION="$(node -p "require('./src-tauri/tauri.conf.json').version")"
SHORT_SHA="$(git rev-parse --short HEAD)"
TAG="beta-v${VERSION}-${SHORT_SHA}"
if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  echo "beta ${TAG} already exists; nothing to do"
  exit 0
fi

export TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY_PATH")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD

echo "==> Building Powerhouse beta ${TAG}"
npx tauri build --bundles app

BUNDLE_ROOT="src-tauri/target/release/bundle"
APP_PATH="$BUNDLE_ROOT/macos/Powerhouse.app"
[ -d "$APP_PATH" ] || fail "app bundle was not built"

echo "==> Verifying Developer ID signature"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"
SIGN_INFO="$(codesign -dvvv "$APP_PATH" 2>&1)"
BUNDLE_ID="$(node -p "require('./src-tauri/tauri.conf.json').identifier")"
grep -Fqx "Identifier=${BUNDLE_ID}" <<< "$SIGN_INFO" || fail "bundle identifier is not bound to the signature"
grep -Fqx "Authority=${APPLE_SIGNING_IDENTITY:?APPLE_SIGNING_IDENTITY is required}" <<< "$SIGN_INFO" \
  || fail "bundle is not signed by the configured Developer ID identity"
grep -q '^CodeDirectory.*runtime' <<< "$SIGN_INFO" || fail "hardened runtime is not enabled"

ARCH="$(uname -m)"
DMG_DIR="$BUNDLE_ROOT/dmg"
mkdir -p "$DMG_DIR"
DMG_OUT="$DMG_DIR/Powerhouse_${VERSION}-beta_${SHORT_SHA}_${ARCH}.dmg"
STAGE_DIR="$(mktemp -d)"
trap 'rm -rf "$STAGE_DIR"' EXIT
cp -R "$APP_PATH" "$STAGE_DIR/"
ln -s /Applications "$STAGE_DIR/Applications"
hdiutil create -volname "Powerhouse Beta" -srcfolder "$STAGE_DIR" -ov -format UDZO "$DMG_OUT" >/dev/null

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

echo "==> Publishing pre-release ${TAG}"
gh release create "$TAG" \
  --repo "$REPO" \
  --prerelease \
  --target "$(git rev-parse HEAD)" \
  --title "Powerhouse Beta ${VERSION} (${SHORT_SHA})" \
  --notes "${NOTES:-Beta build of ${VERSION} from ${SHORT_SHA}. Pre-release: not shipped to users.}" \
  "$DMG_OUT"
