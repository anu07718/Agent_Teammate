#!/usr/bin/env bash
# Build the Windows desktop app and its installer:  bash exe/build.sh
#
#   exe/build/Nirnaya/                    the app folder (runs as is: Nirnaya.exe)
#   exe/dist/Nirnaya-Setup-<ver>-x64.exe  the installer
#
# Runs on Linux (or WSL / Git Bash with the same tools): needs node, python3 with pip, curl, unzip and
# makensis. With wine installed it also stamps the Nirnaya icon onto Nirnaya.exe and checks that the
# bundled Python imports the server. Downloads are cached in exe/.cache.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
CACHE="$HERE/.cache"
STAGE="$HERE/build/Nirnaya"
VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$HERE/neutralino.config.json")"
NEU_VERSION="6.9.0"
PY_VERSION="3.12.10"
PY_TAG="312"
RCEDIT_VERSION="2.0.0"

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
fetch() { # url file
  [ -s "$CACHE/$2" ] || { echo "downloading $2"; curl -fSL --retry 4 -o "$CACHE/$2.part" "$1" && mv "$CACHE/$2.part" "$CACHE/$2"; }
}

for tool in node npm python3 curl unzip makensis; do
  command -v "$tool" >/dev/null || { echo "missing: $tool" >&2; exit 1; }
done
mkdir -p "$CACHE" "$HERE/dist"

say "web app"
if [ "${SKIP_WEB:-0}" != "1" ] || [ ! -f "$ROOT/web/dist/index.html" ]; then
  (cd "$ROOT/web" && { [ -d node_modules ] || npm ci --no-audit --no-fund; } && npm run build)
fi

say "downloads"
fetch "https://github.com/neutralinojs/neutralinojs/releases/download/v$NEU_VERSION/neutralinojs-v$NEU_VERSION.zip" "neutralinojs-v$NEU_VERSION.zip"
fetch "https://www.python.org/ftp/python/$PY_VERSION/python-$PY_VERSION-embed-amd64.zip" "python-$PY_VERSION-embed-amd64.zip"
fetch "https://go.microsoft.com/fwlink/p/?LinkId=2124703" "MicrosoftEdgeWebview2Setup.exe"
WINE="$(command -v /opt/wine-stable/bin/wine wine 2>/dev/null | head -1 || true)"  # wine 10+ (numpy needs a newer ucrtbase than wine 9 has)
[ -n "$WINE" ] && fetch "https://github.com/electron/rcedit/releases/download/v$RCEDIT_VERSION/rcedit-x64.exe" "rcedit-x64.exe"

say "window (Neutralino $NEU_VERSION)"
(cd "$HERE" && { [ -d node_modules ] || npm ci --no-audit --no-fund; })
mkdir -p "$HERE/bin" "$HERE/resources/js"
unzip -o -q "$CACHE/neutralinojs-v$NEU_VERSION.zip" neutralino-win_x64.exe neutralino-linux_x64 -d "$HERE/bin"
chmod +x "$HERE/bin/neutralino-linux_x64"
cp "$HERE/node_modules/@neutralinojs/lib/dist/neutralino.js" "$HERE/resources/js/neutralino.js"
rm -rf "$HERE/dist/nirnaya"
(cd "$HERE" && npx --no-install neu build)

say "app folder"
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp "$HERE/dist/nirnaya/nirnaya-win_x64.exe" "$STAGE/Nirnaya.exe"
cp "$HERE/dist/nirnaya/resources.neu" "$STAGE/"
rm -rf "$HERE/dist/nirnaya"
cp -r "$ROOT/web/dist" "$STAGE/web"
mkdir -p "$STAGE/backend"
(cd "$ROOT/backend" && tar --exclude='__pycache__' --exclude='*.pyc' -cf - nirnaya) | tar -xf - -C "$STAGE/backend"
cp "$HERE/assets/nirnaya.ico" "$STAGE/"
cp "$HERE/THIRD-PARTY.txt" "$STAGE/"

say "Python $PY_VERSION (embedded, win_amd64)"
unzip -q "$CACHE/python-$PY_VERSION-embed-amd64.zip" -d "$STAGE/python"
# the ._pth file is Python's whole search path in the embedded build: add site-packages and the server
printf 'python%s.zip\n.\nLib\\site-packages\n..\\backend\nimport site\n' "$PY_TAG" > "$STAGE/python/python$PY_TAG._pth"
python3 -m pip install --quiet --disable-pip-version-check --no-compile \
  --only-binary=:all: --platform win_amd64 --python-version "${PY_VERSION%.*}" --implementation cp --abi "cp$PY_TAG" \
  --target "$STAGE/python/Lib/site-packages" -r "$HERE/requirements-win.txt"
find "$STAGE/python/Lib/site-packages" -depth \( -name '__pycache__' -o -name 'tests' -path '*numpy*' \) -type d -exec rm -rf {} +
rm -rf "$STAGE/python/Lib/site-packages/bin"

if [ -n "$WINE" ]; then
  say "icon and a check with $("$WINE" --version)"
  export WINEDEBUG=-all WINEPREFIX="${WINEPREFIX:-$CACHE/wine}"
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-$CACHE/xdg}"
  mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"
  "$WINE" "$CACHE/rcedit-x64.exe" "$STAGE/Nirnaya.exe" --set-icon "$HERE/assets/nirnaya.ico" \
    --set-file-version "$VERSION" --set-product-version "$VERSION" \
    --set-version-string ProductName Nirnaya --set-version-string FileDescription Nirnaya \
    --set-version-string CompanyName Nirnaya --set-version-string OriginalFilename Nirnaya.exe
  "$WINE" "$STAGE/python/python.exe" -c "import nirnaya.api, numpy, fastapi, uvicorn; print('bundled python ok')"
  find "$STAGE" -name '__pycache__' -type d -exec rm -rf {} +
else
  echo "wine not found: Nirnaya.exe keeps the default icon, and the bundled Python was not test-run"
fi

say "installer"
makensis -V2 -DVERSION="$VERSION" -DSTAGE="$STAGE" -DCACHE="$CACHE" -DOUT="$HERE/dist/Nirnaya-Setup-$VERSION-x64.exe" "$HERE/installer.nsi"
ls -la "$HERE/dist"
echo "app folder: $STAGE ($(du -sh "$STAGE" | cut -f1))"
