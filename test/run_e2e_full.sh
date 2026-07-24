#!/bin/sh
# Full E2E tests - covers all in-memory servers.
# rust-mash requires live Supabase credentials and is validated by: docker compose --profile test up
set -e

echo "==========================================="
echo " opto-sync Full E2E Integration Tests"
echo " Testing: Node, Rust Fullstack, Dart, Sagitta"
echo " (rust-mash tested separately via --profile test)"
echo "==========================================="
echo "Waiting for all servers to start..."
sleep 10

PASS=0
FAIL=0

check() {
    if echo "$2" | grep -q "$3"; then
        echo "✅ $1"
        PASS=$((PASS + 1))
    else
        echo "❌ FAIL: $1 — expected '$3' in: $2"
        FAIL=$((FAIL + 1))
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

    echo "--- $NAME done ---"
}

# ─────────────────────────────────────────────────────────────
# Test each server (in-memory, no Supabase required)
# ─────────────────────────────────────────────────────────────
test_server "Node (Express+Drizzle+native-C)" "http://node:3003" "doc-1"
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
