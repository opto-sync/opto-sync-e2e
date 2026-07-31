#!/bin/sh
# Full E2E tests - covers all in-memory servers.
# rust-mash is opt-in (profile `mash`) and is validated by the Supabase path:
#   docker compose -f docker-compose.yml -f docker-compose.supabase.yml --profile supabasetest ...
set -e

echo "==========================================="
echo " opto-sync Full E2E Integration Tests"
echo " Testing: Node, Rust Fullstack, Dart, Sagitta"
echo " (rust-mash covered by suite/supabase, not here)"
echo "==========================================="
echo "Waiting for all servers to start..."
sleep 10

PASS=0
FAIL=0

# Per-run namespace for scratch subtrees, matching suite/cross-server/run.mjs.
# These documents are long-lived and shared between suites, so any key this
# script seeds with fixed timestamps must live under a fresh key each run —
# otherwise a second run's seed is STALER than the first run's final state and
# is correctly rejected, making the assertions fail on a healthy server.
RUNNS="p$$"

check() {
    if echo "$2" | grep -q "$3"; then
        echo "✅ $1"
        PASS=$((PASS + 1))
    else
        echo "❌ FAIL: $1 — expected '$3' in: $2"
        FAIL=$((FAIL + 1))
    fi
}

# Negative assertion: the pattern must NOT appear. Stale-write rejection can
# only be proven by absence, so `check` alone cannot express it.
check_absent() {
    if echo "$2" | grep -q "$3"; then
        echo "❌ FAIL: $1 — did NOT expect '$3' in: $2"
        FAIL=$((FAIL + 1))
    else
        echo "✅ $1"
        PASS=$((PASS + 1))
    fi
}

# ─────────────────────────────────────────────────────────────
# Helper: test a server's sync endpoints
# Usage: test_server <name> <base_url> <doc_id>
# ─────────────────────────────────────────────────────────────
test_server() {
    NAME="$1"
    URL="$2"
    DOC="$3"

    echo ""
    echo "======================================"
    echo "Testing $NAME at $URL"
    echo "======================================"

    # Health check
    HEALTH=$(curl -s --max-time 10 "$URL/health" 2>/dev/null || echo "FAIL")
    echo "Health: $HEALTH"
    check "$NAME: health ok" "$HEALTH" '"status":"ok"'

    # Get doc
    DOC_RESP=$(curl -s --max-time 10 "$URL/doc/$DOC" 2>/dev/null || echo "FAIL")
    echo "Doc: $DOC_RESP"
    check "$NAME: doc exists" "$DOC_RESP" '"id"'

    # Deep merge
    MERGE=$(curl -s --max-time 10 -X POST "$URL/doc/$DOC/sync" \
        -H "Content-Type: application/json" \
        -d "{\"metadata\": {\"newField\": \"e2e-test\", \"priority\": 99}}" 2>/dev/null || echo "FAIL")
    echo "Merge: $MERGE"
    check "$NAME: merge accepted" "$MERGE" '"merged":true'

    # Verify merged field persists
    AFTER=$(curl -s --max-time 10 "$URL/doc/$DOC" 2>/dev/null || echo "FAIL")
    check "$NAME: newField persisted" "$AFTER" 'newField'

    # CRDT: older nanosecond-epoch timestamp should be rejected at field level
    STALE=$(curl -s --max-time 10 -X POST "$URL/doc/$DOC/sync" \
        -H "Content-Type: application/json" \
        -d '{"updatedAt": "1", "metadata": {"stale": true}}' 2>/dev/null || echo "FAIL")
    echo "CRDT stale: $STALE"
    check "$NAME: CRDT stale update handled" "$STALE" '"merged":true'

    # ── Keyed-array reconciliation (MERGE_BY_KEY) ────────────────────────
    # Asserting only '"merged":true' here would pass even under REPLACE
    # semantics, so seed a two-element array and then prove element-level
    # behavior: stale element rejected, untouched element kept, new appended.
    #
    # Every value carries a `ka-` prefix so it is UNIQUE within the document.
    # These checks are whole-document substring greps, and this doc is shared
    # with the cross-server convergence/commutativity scenarios, which store
    # `xcomm_*` subtrees whose rows legitimately contain "v":"one"/"two"/"three".
    # Bare values therefore matched foreign data: the positive checks passed
    # even when reconciliation was wrong, and the "superseded value is gone"
    # check failed even when it was right. Keep these sentinels unique.
    curl -s --max-time 10 -X POST "$URL/doc/$DOC/sync" \
        -H "Content-Type: application/json" \
        -d '{"rows": [{"id": 1, "createdAt": 100, "updatedAt": 500, "v": "ka-one"},
                      {"id": 2, "createdAt": 100, "updatedAt": 500, "v": "ka-two"}]}' \
        >/dev/null 2>&1 || true

    ARRAY_SYNC=$(curl -s --max-time 10 -X POST "$URL/doc/$DOC/sync" \
        -H "Content-Type: application/json" \
        -d '{"rows": [{"id": 2, "updatedAt": 100, "v": "ka-STALE"},
                      {"id": 3, "createdAt": 900, "updatedAt": 900, "v": "ka-three"}]}' \
        2>/dev/null || echo "FAIL")
    echo "Array Sync: $ARRAY_SYNC"
    check "$NAME: keyed-array merge accepted" "$ARRAY_SYNC" '"merged":true'

    ROWS=$(curl -s --max-time 10 "$URL/doc/$DOC" 2>/dev/null || echo "FAIL")
    echo "Rows after: $ROWS"
    check        "$NAME: keyed-array kept untouched element"   "$ROWS" '"ka-one"'
    check        "$NAME: keyed-array kept fresher element"     "$ROWS" '"ka-two"'
    check_absent "$NAME: keyed-array rejected stale element"   "$ROWS" 'ka-STALE'
    check        "$NAME: keyed-array appended new element"     "$ROWS" '"ka-three"'

    # createdAt is NOT a first-write-wins key in the default policy.
    #
    # It used to be, and that made FWW a node-level VETO rather than protection
    # of one field: the core drops the ENTIRE incoming element when its FWW key
    # is newer, however new its updatedAt is. Any replica that ended up holding a
    # later createdAt for a record could then never write to that record again.
    # So a payload carrying a later createdAt AND a newer updatedAt must now be
    # APPLIED — element 1 goes from "one" to "NEWEST".
    curl -s --max-time 10 -X POST "$URL/doc/$DOC/sync" \
        -H "Content-Type: application/json" \
        -d '{"rows": [{"id": 1, "createdAt": 5000, "updatedAt": 5000, "v": "ka-NEWEST"}]}' \
        >/dev/null 2>&1 || true
    NO_FWW=$(curl -s --max-time 10 "$URL/doc/$DOC" 2>/dev/null || echo "FAIL")
    echo "No-FWW default: $NO_FWW"
    check        "$NAME: later createdAt no longer vetoes a newer write" "$NO_FWW" '"ka-NEWEST"'
    check_absent "$NAME: the superseded value is gone"                   "$NO_FWW" '"ka-one"'

    # The engine feature itself is still exercised, on the one server that lets a
    # request name its own policy (node, in test mode). Everywhere else the
    # server owns the policy and there is nothing to opt into.
    if echo "$HEALTH" | grep -q '"testMode":true'; then
        curl -s --max-time 10 -X POST "$URL/doc/$DOC/sync" \
            -H "Content-Type: application/json" \
            -H 'X-Syncer-Options: {"fwwKeys":"createdAt"}' \
            -d '{"rows": [{"id": 1, "createdAt": 9000, "updatedAt": 9000, "v": "ka-VETOED"}]}' \
            >/dev/null 2>&1 || true
        FWW=$(curl -s --max-time 10 "$URL/doc/$DOC" 2>/dev/null || echo "FAIL")
        echo "Explicit FWW: $FWW"
        check_absent "$NAME: explicit fwwKeys still rejects a later createdAt" "$FWW" 'ka-VETOED'
    fi

    echo "--- $NAME done ---"
}

# ─────────────────────────────────────────────────────────────
# Test each server (in-memory, no Supabase required)
# ─────────────────────────────────────────────────────────────
test_server "Node (Express+pg+native-C)" "http://node:3003" "doc-1"
test_server "Rust Fullstack (Axum SSR)" "http://rust-fullstack:3002" "doc-a"
test_server "Dart Shelf (C FFI)" "http://dart:3004" "doc1"
test_server "Sagitta (Dart SSR)" "http://sagitta:3005" "doc-s1"

# ─────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────
echo ""
echo "==========================================="
echo " Results: $PASS passed, $FAIL failed"
echo "==========================================="
if [ "$FAIL" -eq 0 ]; then
    echo "🎉 All full E2E integration tests passed!"
    exit 0
else
    echo "💥 $FAIL test(s) failed!"
    exit 1
fi
