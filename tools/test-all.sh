#!/usr/bin/env bash
# Every automated check, one after the other, each browser suite on its own fresh server, then a report.
#
#   bash tools/test-all.sh               the website: the server from backend/ with web/dist
#   TARGET=exe bash tools/test-all.sh    the Windows app: its bundled server (exe/build/Nirnaya) under wine
#   TARGET=apk bash tools/test-all.sh    the Android app: the web files unpacked from apk/dist/*.apk, served
#                                        by the server and, for the phone suite, from their own origin
#   SUITES="run workflow" ...            only these suites (names of web/e2e/*.mjs, plus "audit")
#   QUICK=1 ...                          skip the two slow ones (fields-office ~25 min, audit ~15 min)
#
# Also runs the backend tests, the typecheck and the build (website only). Starts a real SMTP/IMAP server
# for the email checks (GreenMail, `make mail-server`, needs Java) when none is running. Writes
# test-results/<target>/report.md; screenshots of failures go next to it. Exit code 1 if anything failed.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${TARGET:-web}"
OUT="${OUT:-$ROOT/test-results/$TARGET}"
PORT="${PORT:-8000}"
KPORT=$((PORT + 1))
PY="${PY:-python3}"
WINE="${WINE:-$(command -v /opt/wine-stable/bin/wine wine 2>/dev/null | head -1)}"
ALL="run workflow fields-office fields-workspace fields-flows flows team phone-client channels audit"
SUITES="${SUITES:-$ALL}"
[ "${QUICK:-0}" = "1" ] && SUITES="$(echo " $SUITES " | sed 's/ fields-office / /; s/ audit / /')"
mkdir -p "$OUT/data" "$OUT/shots"
REPORT="$OUT/report.md"
: > "$OUT/log.txt"
rows=()
failed=0
MAILPID=""

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
port_open() { "$PY" -c "import socket,sys; socket.create_connection(('127.0.0.1', int(sys.argv[1])), 1).close()" "$1" 2>/dev/null; }

stop_servers() {
  for pid in ${SRV:-} ${KSRV:-}; do kill "$pid" 2>/dev/null; done
  # wine starts the Windows python as its own process
  pkill -f "^python/python.exe -m nirnaya --port ($PORT|$KPORT) " 2>/dev/null
  for _ in $(seq 1 20); do port_open "$PORT" || port_open "$KPORT" || break; sleep 0.5; done
  SRV="" KSRV=""
}

needs_key() { case "$1" in channels|phone-client) return 0 ;; esac; return 1; } # the lock-screen checks

start_servers() { # name
  stop_servers
  local db="$OUT/data/$1"
  rm -f "$db".db* "$db"-keyed.db*
  case "$TARGET" in
    web|apk)
      local web="$ROOT/web/dist"; [ "$TARGET" = apk ] && web="$APKWWW"
      (cd "$ROOT/backend" && exec "$PY" -m nirnaya --port "$PORT" --db "$db.db" --web "$web" --reset) >> "$OUT/server-$1.log" 2>&1 &
      SRV=$!
      if needs_key "$1"; then
        (cd "$ROOT/backend" && NIRNAYA_ACCESS_KEY=e2e-key exec "$PY" -m nirnaya --port "$KPORT" --db "$db-keyed.db" --web "$web" --reset) >> "$OUT/server-$1.log" 2>&1 &
        KSRV=$!
      fi ;;
    exe)
      local app="$ROOT/exe/build/Nirnaya"
      (cd "$app" && WINEDEBUG=-all WINEPREFIX="${WINEPREFIX:-$ROOT/exe/.cache/wine}" exec "$WINE" python/python.exe -m nirnaya \
        --port "$PORT" --db "C:\\nirnaya-tests\\$1.db" --web web --reset) >> "$OUT/server-$1.log" 2>&1 &
      SRV=$!
      if needs_key "$1"; then
        (cd "$app" && NIRNAYA_ACCESS_KEY=e2e-key WINEDEBUG=-all WINEPREFIX="${WINEPREFIX:-$ROOT/exe/.cache/wine}" exec "$WINE" python/python.exe -m nirnaya \
          --port "$KPORT" --db "C:\\nirnaya-tests\\$1-keyed.db" --web web --reset) >> "$OUT/server-$1.log" 2>&1 &
        KSRV=$!
      fi ;;
  esac
  for _ in $(seq 1 120); do
    curl -sf -m 2 "http://127.0.0.1:$PORT/api/health" >/dev/null && { [ -z "$KSRV" ] || curl -s -m 2 -o /dev/null "http://127.0.0.1:$KPORT/api/health"; } && return 0
    sleep 1
  done
  echo "the server did not start (see $OUT/server-$1.log)"; return 1
}

record() { # name, checks, result, seconds, notes
  rows+=("| $1 | $2 | $3 | $(( $4 / 60 ))m $(( $4 % 60 ))s | $5 |")
  [ "$3" = "pass" ] || failed=1
}

cleanup() { stop_servers; [ -n "$MAILPID" ] && { kill "$MAILPID" 2>/dev/null; pkill -f "greenmail-standalone-.*\.jar" 2>/dev/null; }; }
trap cleanup EXIT

# ── what to test ────────────────────────────────────────────────────────────
case "$TARGET" in
  web) ;;
  exe)
    [ -x "$ROOT/exe/build/Nirnaya/python/python.exe" ] || [ -f "$ROOT/exe/build/Nirnaya/python/python.exe" ] \
      || { echo "no exe/build/Nirnaya: run make exe first"; exit 1; }
    [ -n "$WINE" ] || { echo "TARGET=exe needs wine 10 or newer"; exit 1; } ;;
  apk)
    APK="$(ls "$ROOT"/apk/dist/*.apk | head -1)"
    APKWWW="$OUT/apk-www"
    rm -rf "$APKWWW" "$OUT/apk-unzip" && mkdir -p "$OUT/apk-unzip"
    unzip -q "$APK" 'assets/public/*' -d "$OUT/apk-unzip" && mv "$OUT/apk-unzip/assets/public" "$APKWWW"
    # the APK's web files must be the build the website suites test, apart from Capacitor's own two files
    if diff -rq "$ROOT/web/dist" "$APKWWW" | grep -v -E "Only in $APKWWW: cordova(_plugins)?\.js" | grep -q .; then
      record "apk files = web/dist" 1 fail 0 "$(diff -rq "$ROOT/web/dist" "$APKWWW" | head -3 | tr '\n' ' ')"
    else
      record "apk files = web/dist" 1 pass 0 "$(find "$APKWWW" -type f | wc -l) files, the same bytes"
    fi ;;
  *) echo "TARGET is web, exe or apk"; exit 1 ;;
esac

# ── a real mail server for the email checks ─────────────────────────────────
if ! port_open 3025 || ! port_open 3143; then
  if command -v java >/dev/null; then
    say "mail server (GreenMail)"
    (cd "$ROOT" && exec make -s mail-server) >> "$OUT/mail-server.log" 2>&1 &
    MAILPID=$!
    for _ in $(seq 1 60); do port_open 3025 && port_open 3143 && break; sleep 1; done
  fi
fi
port_open 3025 && port_open 3143 && echo "mail server on :3025 / :3143" || echo "no mail server: the email checks will fail (install Java 17+)"

# ── backend, typecheck, build ───────────────────────────────────────────────
if [ "$TARGET" = web ]; then
  say "backend tests"
  t0=$SECONDS
  out="$(cd "$ROOT/backend" && "$PY" -m pytest -q 2>&1)"; code=$?
  echo "$out" >> "$OUT/log.txt"
  sum="$(echo "$out" | grep -E "passed|failed" | tail -1)"
  echo "$sum"
  record "backend (pytest)" "$(echo "$sum" | grep -oE '[0-9]+ passed' | grep -oE '[0-9]+')" "$([ $code = 0 ] && echo pass || echo fail)" $((SECONDS - t0)) "$sum"
  say "typecheck and build"
  t0=$SECONDS
  out="$(cd "$ROOT/web" && npx tsc -b --noEmit 2>&1 && npm run build 2>&1)"; code=$?
  echo "$out" >> "$OUT/log.txt"
  record "web typecheck + build" 1 "$([ $code = 0 ] && echo pass || echo fail)" $((SECONDS - t0)) "$(echo "$out" | grep -E 'error|built in' | tail -1)"
fi

# ── the browser suites, each on a fresh server ──────────────────────────────
for s in $SUITES; do
  say "$s ($TARGET)"
  t0=$SECONDS
  if ! start_servers "$s"; then record "$s" 0 fail 0 "the server did not start"; continue; fi
  env=(NIRNAYA_URL="http://127.0.0.1:$PORT" SHOTS="$OUT/shots/$s")
  needs_key "$s" && env+=(KEYED_URL="http://127.0.0.1:$KPORT")
  [ "$TARGET" = apk ] && env+=(APP_DIST="$APKWWW")
  if [ "$s" = audit ]; then
    out="$(cd "$ROOT/web" && env "${env[@]}" timeout 3600 node e2e/audit.mjs 2>&1)"; code=$?
    clicks="$(echo "$out" | grep -oE '^[0-9]+ clicks' | grep -oE '[0-9]+')"
    probs="$(echo "$out" | grep -oE '[0-9]+ problem\(s\)' | grep -oE '[0-9]+')"
    notes="$(echo "$out" | grep -E '^\s+! ' | head -5 | sed 's/^ *//' | tr '\n' ' ' | tr '|' '/')"
    echo "$out" | grep -E "clicks|^\s+! " | head -12
    res=pass; { [ "$code" != 0 ] || [ "${probs:-1}" != 0 ]; } && res=fail
    record "audit (every view and button)" "${clicks:-0} clicks" "$res" $((SECONDS - t0)) "${probs:-?} problem(s) ${notes}"
  else
    out="$(cd "$ROOT/web" && env "${env[@]}" timeout 3600 node "e2e/$s.mjs" 2>&1)"; code=$?
    sum="$(echo "$out" | grep -E '^[0-9]+/[0-9]+ passed' | tail -1)"
    bad="$(echo "$out" | grep -E '^\s+✗' | sed 's/^ *✗ //' | head -4 | tr '\n' ';' | tr '|' '/')"
    echo "$out" | grep -E "✗|passed" | head -12
    record "$s" "${sum%% *}" "$([ $code = 0 ] && [ -n "$sum" ] && echo pass || echo fail)" $((SECONDS - t0)) "${bad:-}"
  fi
  echo "$out" >> "$OUT/log.txt"
done
stop_servers

# ── the report ──────────────────────────────────────────────────────────────
{
  echo "# Test report: $TARGET"
  echo
  echo "$(date -u '+%Y-%m-%d %H:%M UTC') · commit $(cd "$ROOT" && git rev-parse --short HEAD 2>/dev/null)$(cd "$ROOT" && git diff --quiet 2>/dev/null || echo ' (with local changes)')"
  echo
  echo "| Suite | Checks | Result | Time | Notes |"
  echo "|---|---|---|---|---|"
  printf '%s\n' "${rows[@]}"
  echo
  [ $failed = 0 ] && echo "**Everything passed.**" || echo "**Something failed:** see log.txt and shots/ next to this report."
} > "$REPORT"
say "report: $REPORT"
cat "$REPORT"
exit $failed
