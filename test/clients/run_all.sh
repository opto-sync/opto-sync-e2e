#!/usr/bin/env bash
#
# CLIENT-IN-THE-LOOP e2e orchestrator.
#
# Runs the TypeScript, Dart and Rust client suites against an ALREADY-RUNNING
# opto-sync server and exits non-zero if any of them fails.
#
#   ./run_all.sh                 # everything
#   ./run_all.sh ts              # one language (ts | dart | rust)
#   ./run_all.sh --no-converge   # skip the cross-client convergence phase
#
# Environment:
#   OPTO_SYNC_SERVER_URL    default http://localhost:3003
#   OPTO_SYNC_REQUIRE_SERVER=1
#       treat an unreachable server as a FAILURE instead of a skip (for CI)
#   SYNCER_LIB_PATH         override the syncer.c core shared library location
#
# This script never touches the stack: it does not run docker compose, and it
# does NOT call POST /reset (which TRUNCATEs the shared tables and would yank the
# ground out from under other suites running concurrently). Every document it
# uses is namespaced -- `cl-<lang>-<scenario>` for scenarios 1-6 and `cl-converge`
# for scenario 7 -- and is created with PUT /doc/:id immediately before use.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLIENTS_ROOT="$(cd "$HERE/../../../opto-sync-clients/clients" && pwd)"
SERVER_URL="${OPTO_SYNC_SERVER_URL:-http://localhost:3003}"
export OPTO_SYNC_SERVER_URL="$SERVER_URL"

ONLY=""
RUN_CONVERGE=1
for arg in "$@"; do
  case "$arg" in
    ts|dart|rust) ONLY="$arg" ;;
    --no-converge) RUN_CONVERGE=0 ;;
    -h|--help) sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $arg (try --help)" >&2; exit 2 ;;
  esac
done

# ── output helpers ───────────────────────────────────────────────────────
if [ -t 1 ]; then BOLD=$'\033[1m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; OFF=$'\033[0m'
else BOLD=""; RED=""; GREEN=""; YELLOW=""; DIM=""; OFF=""; fi

banner() { printf '\n%s=== %s ===%s\n' "$BOLD" "$1" "$OFF"; }
info()   { printf '%s%s%s\n' "$DIM" "$1" "$OFF"; }
pass()   { printf '%s  PASS%s  %s\n' "$GREEN" "$OFF" "$1"; }
fail()   { printf '%s  FAIL%s  %s\n' "$RED" "$OFF" "$1"; }

FAILURES=()
STEPS=0

# Run a step; record a failure but keep going, so one broken language does not
# hide the state of the other two.
step() {
  local label="$1"; shift
  STEPS=$((STEPS + 1))
  printf '%s--> %s%s\n' "$DIM" "$label" "$OFF"
  if "$@"; then
    pass "$label"
    return 0
  fi
  fail "$label"
  FAILURES+=("$label")
  return 1
}

# A convergence phase must not run if an earlier phase failed: the document
# would be in an unknown state and the follow-on failures would be noise.
step_strict() {
  local label="$1"; shift
  if [ ${#FAILURES[@]} -gt 0 ] && [ -n "${CONVERGE_STARTED:-}" ]; then
    printf '%s  SKIP%s  %s (an earlier convergence phase failed)\n' "$YELLOW" "$OFF" "$label"
    return 1
  fi
  step "$label" "$@"
}

# ── preflight ────────────────────────────────────────────────────────────
banner "Preflight"

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required for the preflight check" >&2
  exit 2
fi

HEALTH="$(curl -fsS --max-time 5 "$SERVER_URL/health" 2>/dev/null)"
if [ -z "$HEALTH" ]; then
  printf '\n%sSKIPPED: the opto-sync server at %s is unreachable.%s\n' "$YELLOW" "$SERVER_URL" "$OFF"
  cat <<EOF

  The client-in-the-loop suites need a live server; they skip rather than hang.
  Start the stack from the repo root:

      docker compose up -d postgres node

  ...or point the suites elsewhere with OPTO_SYNC_SERVER_URL.
  Set OPTO_SYNC_REQUIRE_SERVER=1 to make this a hard failure in CI.
EOF
  [ "${OPTO_SYNC_REQUIRE_SERVER:-0}" = "1" ] && exit 1
  exit 0
fi

info "server:  $SERVER_URL"
info "health:  $HEALTH"

case "$HEALTH" in
  *'"syncer":"native"'*) ;;
  *)
    printf '\n%sABORT: the server is not using the native syncer.c core.%s\n' "$RED" "$OFF"
    echo "Every convergence assertion here compares the clients' native merge against"
    echo "the server's; against a JS fallback the whole suite would be false confidence."
    exit 1
    ;;
esac

# ── per-language preparation ─────────────────────────────────────────────
want() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }

if want ts; then
  if [ ! -f "$CLIENTS_ROOT/ts/dist/index.js" ]; then
    info "building @opto-sync/client (dist/ is missing)"
    if ! (cd "$CLIENTS_ROOT/ts" && npm run --silent build); then
      fail "npm run build in $CLIENTS_ROOT/ts"
      FAILURES+=("ts build")
    fi
  fi
  if [ ! -d "$CLIENTS_ROOT/ts/node_modules/fake-indexeddb" ]; then
    printf '\n%sABORT: %s/node_modules/fake-indexeddb is missing.%s\n' "$RED" "$CLIENTS_ROOT/ts" "$OFF"
    echo "The TypeScript suite borrows the client's own fake-indexeddb devDependency."
    echo "Run: (cd $CLIENTS_ROOT/ts && npm install)"
    exit 1
  fi
fi

if want dart; then
  if [ ! -f "$HERE/dart/.dart_tool/package_config.json" ]; then
    info "resolving Dart dependencies (offline)"
    (cd "$HERE/dart" && dart pub get --offline >/dev/null) || {
      info "offline resolution failed, retrying online"
      (cd "$HERE/dart" && dart pub get >/dev/null)
    }
  fi
fi

# ── scenarios 1-6, per language ──────────────────────────────────────────
banner "Scenarios 1-6 (per language, independent documents)"

run_ts_scenarios()   { (cd "$HERE/ts"   && node --test); }
run_dart_scenarios() { (cd "$HERE/dart" && dart test --reporter expanded); }
run_rust_scenarios() { (cd "$HERE/rust" && cargo test --offline --test scenarios -- --test-threads=1 --nocapture); }

want ts   && step "ts   scenarios 1-6"  run_ts_scenarios
want dart && step "dart scenarios 1-6"  run_dart_scenarios
want rust && step "rust scenarios 1-6"  run_rust_scenarios

# ── scenario 7: cross-client convergence ─────────────────────────────────
# The strongest test in the suite, and the only one that has to be orchestrated
# across processes: three different client libraries queue three different
# payloads against ONE document, flushed in the fixture's declared order, then
# all three independently verify the final state.
ts_converge()   { (cd "$HERE/ts"   && node converge.mjs "$1"); }
dart_converge() { (cd "$HERE/dart" && dart run bin/converge.dart "$1"); }
rust_converge() { (cd "$HERE/rust" && cargo run --offline --quiet --bin converge -- "$1"); }

if [ "$RUN_CONVERGE" = 1 ] && [ -z "$ONLY" ]; then
  banner "Scenario 7: cross-client convergence (ts -> dart -> rust)"
  CONVERGE_STARTED=1

  # Fresh document via PUT, deliberately NOT POST /reset: /reset truncates the
  # tables other suites are using.
  step_strict "converge/setup   (PUT the fresh fixture document)" ts_converge setup &&
  step_strict "converge/flush   ts"                              ts_converge flush &&
  step_strict "converge/flush   dart"                            dart_converge flush &&
  step_strict "converge/flush   rust"                            rust_converge flush

  # Final verification: each client independently asserts the server's final
  # document against the SHARED fixture expectation, and reconciles it into its
  # own local copy. Run all three even if one fails -- a disagreement between
  # languages is exactly what this phase exists to expose.
  banner "Scenario 7: final verification (all three clients agree)"
  step "converge/verify  ts"   ts_converge verify
  step "converge/verify  dart" dart_converge verify
  step "converge/verify  rust" rust_converge verify
elif [ "$RUN_CONVERGE" = 1 ]; then
  printf '\n%sSKIP%s scenario 7 (cross-client convergence needs all three languages)\n' "$YELLOW" "$OFF"
fi

# ── summary ──────────────────────────────────────────────────────────────
banner "Summary"
if [ ${#FAILURES[@]} -eq 0 ]; then
  printf '%sAll %d step(s) passed%s against %s\n' "$GREEN$BOLD" "$STEPS" "$OFF" "$SERVER_URL"
  exit 0
fi
printf '%s%d of %d step(s) FAILED%s\n' "$RED$BOLD" "${#FAILURES[@]}" "$STEPS" "$OFF"
for f in "${FAILURES[@]}"; do printf '  - %s\n' "$f"; done
exit 1
