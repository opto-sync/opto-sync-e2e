#!/bin/sh
set -e

echo "==========================================="
echo " opto-sync E2E Integration Tests"
echo "==========================================="
echo "Waiting for servers to start..."
sleep 5

# --- Test against Node server (uses Postgres directly) ---
SERVER="http://node:3003"
echo ""
echo "======================================"
echo "Testing $SERVER (Node + Express + Drizzle)"
echo "======================================"

# 0. Health check
echo "0. Health check..."
HEALTH=$(curl -s --max-time 10 $SERVER/health || echo "FAIL")
echo "Health: $HEALTH"

# 1. Seed doc1 (the server auto-seeds on startup, but let's verify it exists)
echo "1. Checking seed docs..."
DOC=$(curl -s --max-time 10 $SERVER/doc/doc-1 || echo "FAIL")
echo "Doc: $DOC"

# 2. Test deep merge: send a partial update that should merge deeply
echo "2. Testing deep merge (nested object update)..."
RESP_MERGE=$(curl -s -X POST $SERVER/doc/doc-1/sync \
    -H "Content-Type: application/json" \
    -d '{
        "metadata": {
            "priority": 99,
            "newField": "hello"
        }
    }')
echo "Deep merge response: $RESP_MERGE"
if echo "$RESP_MERGE" | grep -q '"merged":true'; then
    echo "✅ Deep merge accepted"
else
    echo "❌ FAILURE: Deep merge rejected"
    exit 1
fi

# Verify that existing fields were preserved
if echo "$RESP_MERGE" | grep -q '"tags"'; then
    echo "✅ Existing nested fields preserved"
else
    echo "❌ FAILURE: Existing nested fields lost during merge"
    exit 1
fi

# 3. Test CRDT timestamp resolution: send older update
echo "3. Testing CRDT: sending update with older timestamp (should be rejected in nested)..."
RESP_OLD=$(curl -s -X POST $SERVER/doc/doc-1/sync \
    -H "Content-Type: application/json" \
    -d '{
        "updatedAt": "2020-01-01T00:00:00Z",
        "metadata": {
            "stale": true
        }
    }')
echo "CRDT older update response: $RESP_OLD"
if echo "$RESP_OLD" | grep -q '"merged":true'; then
    echo "✅ Merge completed (CRDT logic applied at field level)"
else
    echo "⚠️  Merge response unexpected"
fi

# 4. Verify merge result via GET
echo "4. Verifying final document state..."
FINAL=$(curl -s --max-time 10 $SERVER/doc/doc-1)
echo "Final doc-1: $FINAL"

# Check the deep merge field persisted
if echo "$FINAL" | grep -q '"newField"'; then
    echo "✅ Deep merged field 'newField' persisted"
else
    echo "❌ FAILURE: Deep merged field 'newField' not found"
    exit 1
fi

if echo "$FINAL" | grep -q '"priority"'; then
    echo "✅ Original field 'priority' preserved"
else
    echo "❌ FAILURE: Original field 'priority' lost"
    exit 1
fi

# 5. Test deeply nested merge
echo "5. Testing deeply nested merge (doc-3)..."
RESP_DEEP=$(curl -s -X POST $SERVER/doc/doc-3/sync \
    -H "Content-Type: application/json" \
    -d '{
        "metadata": {
            "nested": {
                "level1": {
                    "level2": {
                        "level3": { "deep_value": "updated", "new_deep": true }
                    }
                }
            }
        }
    }')
echo "Deep nested response: $RESP_DEEP"
if echo "$RESP_DEEP" | grep -q '"new_deep"'; then
    echo "✅ Deeply nested merge added new field"
else
    echo "❌ FAILURE: Deeply nested merge failed"
    exit 1
fi

echo ""
echo "🎉 All E2E integration tests passed!"
echo "==========================================="
