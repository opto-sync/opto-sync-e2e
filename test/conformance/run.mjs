#!/usr/bin/env node
/**
 * opto-sync conformance suite — entry point.
 *
 * Zero dependencies: node 22 built-ins only (global fetch, node:assert).
 *
 *   BASE_URL=http://localhost:3003 node run.mjs          # all scenarios
 *   BASE_URL=http://node:3003      node run.mjs          # in-network (docker)
 *   node run.mjs 3 6 7                                   # only those groups
 *
 * Exits non-zero on any failed assertion. Waits for /health (~30s) before
 * starting, and resets the server between scenario groups for isolation.
 *
 * These scenarios target the DB-backed node server specifically, because it is
 * the only one that round-trips every merge through real Postgres `jsonb` — so
 * it proves the C core's output survives key reordering, numeric normalization
 * and unicode, not just that the merge function returns the right thing.
 */

import { createClient, waitForHealth } from "./lib/client.mjs";
import { runGroups } from "./lib/harness.mjs";

import health from "./scenarios/01-health.mjs";
import deepMerge from "./scenarios/02-deep-merge.mjs";
import keyedArrays from "./scenarios/03-keyed-arrays.mjs";
import jsonbFidelity from "./scenarios/04-jsonb-fidelity.mjs";
import idempotency from "./scenarios/05-idempotency.mjs";
import convergence from "./scenarios/06-convergence.mjs";
import concurrency from "./scenarios/07-concurrency.mjs";
import batch from "./scenarios/08-batch.mjs";
import tombstones from "./scenarios/09-tombstones.mjs";
import identity from "./scenarios/10-identity.mjs";
import strategies from "./scenarios/11-strategies.mjs";
import robustness from "./scenarios/12-robustness.mjs";

const ALL_GROUPS = [
  health,
  deepMerge,
  keyedArrays,
  jsonbFidelity,
  idempotency,
  convergence,
  concurrency,
  batch,
  tombstones,
  identity,
  strategies,
  robustness,
];

const BASE_URL = process.env.BASE_URL || "http://localhost:3003";

/** Optional positional args select groups by their leading number. */
function selectGroups(argv) {
  const wanted = argv.filter((a) => /^\d+$/.test(a)).map(Number);
  if (wanted.length === 0) return ALL_GROUPS;
  return ALL_GROUPS.filter((g) => wanted.includes(Number(g.name.split(".")[0])));
}

async function main() {
  const groups = selectGroups(process.argv.slice(2));
  const totalCases = groups.reduce((n, g) => n + g.cases.length, 0);

  console.log("═".repeat(64));
  console.log("  opto-sync CONFORMANCE SUITE");
  console.log("═".repeat(64));
  console.log(`  target      : ${BASE_URL}`);
  console.log(`  node        : ${process.version}`);
  console.log(`  groups      : ${groups.length}${groups.length !== ALL_GROUPS.length ? ` (filtered from ${ALL_GROUPS.length})` : ""}`);
  console.log(`  cases       : ${totalCases}`);

  if (groups.length === 0) {
    console.error("\n  no scenario groups matched the given filter\n");
    process.exit(2);
  }

  let info;
  try {
    info = await waitForHealth(BASE_URL, 30_000);
  } catch (err) {
    console.error(`\n  ✗ ${err.message}`);
    console.error(
      "\n  The node server must already be running. Start the stack with:\n" +
        "    docker compose up -d postgres node\n"
    );
    process.exit(2);
  }

  console.log(`  server      : ${info.server} / syncer=${info.syncer} / core=${info.coreVersion}`);
  console.log(`  test mode   : ${info.testMode}`);

  // Hard gate: the entire suite is meaningless against a JS fallback merge, so
  // refuse to produce a green result that would imply the C core was tested.
  if (info.syncer !== "native") {
    console.error(
      `\n  ✗ FATAL: server reports syncer="${info.syncer}", expected "native".\n` +
        "    A JS fallback merge would let this suite pass without ever exercising\n" +
        "    the C core. Start the server with SYNCER_REQUIRE_NATIVE=1.\n"
    );
    process.exit(2);
  }
  if (info.testMode !== true) {
    console.error(
      "\n  ✗ FATAL: server is not in test mode, so /reset and X-Syncer-Options are\n" +
        "    unavailable and scenarios cannot be isolated.\n" +
        "    Start the server with E2E_ALLOW_OPTION_OVERRIDE=1.\n"
    );
    process.exit(2);
  }

  const client = createClient(BASE_URL);
  const started = Date.now();
  const passed = await runGroups(groups, client);
  console.log(`  elapsed: ${((Date.now() - started) / 1000).toFixed(1)}s\n`);

  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  console.error("\n  ✗ suite crashed:", err?.stack || err);
  process.exit(3);
});
