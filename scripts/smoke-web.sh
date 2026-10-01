#!/usr/bin/env bash
#
# Smoke-tests a deployed Goal 27 web client. Curl only.
#
#   scripts/smoke-web.sh https://goal27.vercel.app https://goal27-api.onrender.com
#
# The second argument is the API the bundle is supposed to talk to. That check
# is the point of this script: NEXT_PUBLIC_API_URL is inlined at build time, so
# a wrong value produces a site that looks perfect and cannot log in, and
# fixing the variable without rebuilding changes nothing. Everything else here
# is quick reassurance that the deployment is whole.
set -uo pipefail

BASE="${1:-}"
API="${2:-}"
if [ -z "$BASE" ]; then
  echo "usage: $0 https://your-web-host [https://your-api-host]" >&2
  exit 2
fi
BASE="${BASE%/}"
API="${API%/}"

pass=0
fail=0
check() {
  if printf '%s' "$2" | grep -qF "$3"; then
    echo "  ok    $1"
    pass=$((pass + 1))
  else
    echo "  FAIL  $1"
    echo "        expected to find: $3"
    echo "        got: $(printf '%s' "$2" | head -c 200)"
    fail=$((fail + 1))
  fi
}
refute() {
  if printf '%s' "$2" | grep -qF "$3"; then
    echo "  FAIL  $1"
    echo "        found what should not be there: $3"
    fail=$((fail + 1))
  else
    echo "  ok    $1"
    pass=$((pass + 1))
  fi
}

echo "Goal 27 web smoke test — $BASE"
echo
echo "the page is there"
home=$(curl -sL --max-time 60 "$BASE/")
check "GET / serves the app" "$home" "GOAL"

echo
echo "it is installable"
manifest=$(curl -sL --max-time 30 "$BASE/manifest.webmanifest")
check "manifest is served" "$manifest" '"display":"standalone"'
check "manifest points at the lobby" "$manifest" '"start_url":"/lobby"'
sw_status=$(curl -sL --max-time 30 -o /dev/null -w '%{http_code}' "$BASE/sw.js")
check "service worker is served" "$sw_status" '200'
icon_type=$(curl -sL --max-time 30 -o /dev/null -w '%{content_type}' "$BASE/icon-192.png")
check "home-screen icon is served" "$icon_type" 'image/png'

echo
echo "the bundle talks to the right API"
# The API base is inlined into whichever chunk carries the client, so each
# script the page loads is searched in turn. Streaming them one at a time
# keeps a megabyte of JavaScript out of a shell variable.
chunks=$(printf '%s' "$home" | grep -oE '/_next/static/[^"]+\.js' | sort -u | head -40)
if [ -z "$chunks" ]; then
  echo "  FAIL  the page referenced no scripts — is this the Goal 27 client?"
  fail=$((fail + 1))
else
  localhost_found=0
  api_found=0
  for chunk in $chunks; do
    body=$(curl -sL --max-time 30 "$BASE$chunk")
    printf '%s' "$body" | grep -qF 'localhost:4000' && localhost_found=1
    if [ -n "$API" ] && printf '%s' "$body" | grep -qF "$API"; then api_found=1; fi
  done

  if [ "$localhost_found" -eq 0 ]; then
    echo "  ok    no localhost baked into the bundle"
    pass=$((pass + 1))
  else
    echo "  FAIL  the bundle still points at localhost — NEXT_PUBLIC_API_URL was"
    echo "        missing or wrong at BUILD time. Set it and redeploy; setting it"
    echo "        without a rebuild changes nothing."
    fail=$((fail + 1))
  fi

  if [ -z "$API" ]; then
    echo "  skip  bundle points at the expected API (pass it as the 2nd argument)"
  elif [ "$api_found" -eq 1 ]; then
    echo "  ok    bundle points at $API"
    pass=$((pass + 1))
  else
    echo "  FAIL  no chunk mentions $API"
    echo "        the client was built against a different API than you expect."
    fail=$((fail + 1))
  fi
fi

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
