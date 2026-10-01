#!/usr/bin/env bash
#
# Smoke-tests a deployed Goal 27 API. Nothing but curl — run it from anywhere
# that can reach the deployment.
#
#   scripts/smoke-api.sh https://goal27-api.onrender.com
#
# It checks the things a deployment actually gets wrong: the process is up,
# migrations ran, configuration is readable, a real account can be created and
# signed in, and the token that comes back works. It creates one throwaway
# player with a random email and leaves it there — harmless on a test
# deployment, and not something to run against production.
set -uo pipefail

BASE="${1:-}"
if [ -z "$BASE" ]; then
  echo "usage: $0 https://your-api-host" >&2
  exit 2
fi
BASE="${BASE%/}"

pass=0
fail=0
check() { # check <name> <condition-output> <expected-substring>
  if printf '%s' "$2" | grep -q "$3"; then
    echo "  ok    $1"
    pass=$((pass + 1))
  else
    echo "  FAIL  $1"
    echo "        expected to find: $3"
    echo "        got: $(printf '%s' "$2" | head -c 300)"
    fail=$((fail + 1))
  fi
}

echo "Goal 27 API smoke test — $BASE"
echo
echo "reachable and healthy"
# A sleeping free-tier instance takes ~30s to wake, so be patient once.
health=$(curl -s --max-time 60 "$BASE/health")
check "GET /health" "$health" '"status":"ok"'

echo
echo "configuration is readable — migrations ran and settings are seeded"
config=$(curl -s --max-time 30 "$BASE/config")
check "GET /config returns stake tiers" "$config" 'stakeTiersCents'
check "GET /config returns the escrow fee" "$config" 'escrowFeeBps'

echo
echo "a real account round-trips"
email="smoke-$(date +%s)-$RANDOM@goal27.test"
password="smoke-test-$RANDOM-password"
register=$(curl -s --max-time 30 -X POST "$BASE/auth/register" \
  -H 'Content-Type: application/json' \
  -d "{\"handle\":\"smoke$RANDOM\",\"email\":\"$email\",\"password\":\"$password\",\"dateOfBirth\":\"1990-01-01\",\"countryCode\":\"GB\"}")
check "POST /auth/register issues a token" "$register" '"token"'

token=$(printf '%s' "$register" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
if [ -n "$token" ]; then
  me=$(curl -s --max-time 30 "$BASE/me" -H "Authorization: Bearer $token")
  check "GET /me accepts that token" "$me" "$email"
  check "GET /me returns a wallet" "$me" 'availableCents'
else
  echo "  skip  GET /me (no token to test with)"
fi

unauth=$(curl -s --max-time 30 -o /dev/null -w '%{http_code}' "$BASE/me")
check "GET /me without a token is refused" "$unauth" '401'

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
