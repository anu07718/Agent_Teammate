#!/usr/bin/env bash
# Build the Android app:  bash apk/build.sh      ->  apk/dist/Nirnaya-<ver>.apk
#
# Needs node, JDK 21 and the Android SDK (platform 36 and build tools). ANDROID_HOME defaults to
# /opt/android-sdk or ~/Android/Sdk. The APK is signed with the debug key, which is fine to install
# by hand ("install unknown apps"); for the Play Store set NIRNAYA_KEYSTORE, NIRNAYA_KEYSTORE_PASS,
# NIRNAYA_KEY_ALIAS and NIRNAYA_KEY_PASS to also get a signed release APK.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
VERSION="$(node -p 'require(process.argv[1]).version' "$HERE/package.json")"
for d in "${ANDROID_HOME:-}" "${ANDROID_SDK_ROOT:-}" /opt/android-sdk "$HOME/Android/Sdk"; do
  [ -n "$d" ] && [ -d "$d/platforms" ] && { export ANDROID_HOME="$d"; break; }
done
[ -n "${ANDROID_HOME:-}" ] || { echo "Android SDK not found: set ANDROID_HOME" >&2; exit 1; }

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

say "web app"
if [ "${SKIP_WEB:-0}" != "1" ] || [ ! -f "$ROOT/web/dist/index.html" ]; then
  (cd "$ROOT/web" && { [ -d node_modules ] || npm ci --no-audit --no-fund; } && npm run build)
fi
rm -rf "$HERE/www" && mkdir -p "$HERE/www" && cp -r "$ROOT/web/dist/." "$HERE/www/"

say "native project"
cd "$HERE"
[ -d node_modules ] || npm ci --no-audit --no-fund
npx --no-install cap sync android
echo "sdk.dir=$ANDROID_HOME" > android/local.properties

say "gradle"
cd android
./gradlew --no-daemon -q assembleDebug
mkdir -p "$HERE/dist"
cp app/build/outputs/apk/debug/app-debug.apk "$HERE/dist/Nirnaya-$VERSION.apk"
if [ -n "${NIRNAYA_KEYSTORE:-}" ]; then
  ./gradlew --no-daemon -q assembleRelease
  BT="$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)"
  "$BT/zipalign" -f -p 4 app/build/outputs/apk/release/app-release-unsigned.apk "$HERE/dist/.aligned.apk"
  "$BT/apksigner" sign --ks "$NIRNAYA_KEYSTORE" --ks-pass "pass:$NIRNAYA_KEYSTORE_PASS" --ks-key-alias "$NIRNAYA_KEY_ALIAS" \
    --key-pass "pass:${NIRNAYA_KEY_PASS:-$NIRNAYA_KEYSTORE_PASS}" --out "$HERE/dist/Nirnaya-$VERSION-release.apk" "$HERE/dist/.aligned.apk"
  rm -f "$HERE/dist/.aligned.apk"
fi
ls -la "$HERE/dist"
