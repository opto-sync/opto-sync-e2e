import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(resolve(here, "fixtures/protocol_v1.json"), "utf8"),
);
const baseUrl = (process.env.BASE_URL || "http://localhost:3003").replace(/\/$/, "");

let assertions = 0;
let cases = 0;

function check(value, message) {
  assertions += 1;
  assert.ok(value, message);
}

function equal(actual, expected, message) {
  assertions += 1;
  assert.deepEqual(actual, expected, message);
}

async function request(method, path, body, extraHeaders = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${method} ${path} returned non-JSON HTTP ${response.status}: ${text}`);
  }
  return { status: response.status, ok: response.ok, json };
}

async function waitForServer() {
  let lastError;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const result = await request("GET", "/health");
      if (result.status === 200) return result;
      lastError = new Error(`health returned HTTP ${result.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw lastError ?? new Error("server did not become ready");
}

function mutation(clientId, mutationId, input, table = "docs") {
  return {
    protocolVersion: fixture.protocolVersion,
    clientId,
    mutations: [{ mutationId: String(mutationId), table, ...input }],
  };
}

async function test(name, run) {
  try {
    await run();
    cases += 1;
    console.log(`  PASS ${name}`);
  } catch (error) {
    console.error(`  FAIL ${name}`);
    throw error;
  }
}

console.log("\n=== opto-sync protocol v1 conformance ===");
console.log(`target: ${baseUrl}`);

await test("health advertises the native core", async () => {
  const result = await waitForServer();
  equal(result.status, 200);
  equal(result.json.syncer, "native");
  equal(result.json.protocolSchemaVersion, 3);
});

await test("test reset clears both documents and protocol state", async () => {
  const result = await request("POST", "/reset", {});
  equal(result.status, 200);
  const pull = await request("GET", "/v1/sync/pull?checkpoint=0");
  equal(pull.status, 200);
  equal(pull.json.checkpoint, "0");
  equal(pull.json.changes, []);
});

let primaryApplied;
await test("an upsert atomically advances revision, watermark, and checkpoint", async () => {
  const body = mutation(fixture.clients.primary, 1, {
    operation: "upsert",
    recordId: fixture.records.primary,
    baseRevision: "0",
    payload: fixture.payloads.primary,
  });
  const result = await request("POST", "/v1/sync/push", body);
  equal(result.status, 200);
  equal(result.json.protocolVersion, 1);
  equal(result.json.lastMutationId, "1");
  equal(result.json.checkpoint, "1");
  equal(result.json.results[0].status, "applied");
  equal(result.json.results[0].document.revision, "1");
  primaryApplied = body;
});

await test("an identical retry is deduplicated and does not add a change", async () => {
  const retry = await request("POST", "/v1/sync/push", primaryApplied);
  equal(retry.status, 200);
  equal(retry.json.lastMutationId, "1");
  equal(retry.json.checkpoint, "1");
  equal(retry.json.results[0].status, "duplicate");
  equal(retry.json.results[0].originalStatus, "applied");

  const pull = await request("GET", "/v1/sync/pull?checkpoint=0");
  equal(pull.json.changes.length, 1);
  equal(pull.json.changes[0].source, {
    clientId: fixture.clients.primary,
    mutationId: "1",
  });
});

await test("reusing a mutation id for different content is a hard conflict", async () => {
  const reused = mutation(fixture.clients.primary, 1, {
    operation: "upsert",
    recordId: fixture.records.primary,
    payload: { title: "different content" },
  });
  const result = await request("POST", "/v1/sync/push", reused);
  equal(result.status, 409);
  equal(result.json.error, "MUTATION_ID_REUSED");
});

await test("a mutation gap rolls the whole push back", async () => {
  const result = await request(
    "POST",
    "/v1/sync/push",
    mutation(fixture.clients.primary, 3, {
      operation: "upsert",
      recordId: fixture.records.primary,
      payload: { gap: true },
    }),
  );
  equal(result.status, 409);
  equal(result.json.error, "MUTATION_GAP");
  equal(result.json.detail.lastMutationId, "1");
});

let rejectedMutation;
await test("a permanent revision rejection advances the client watermark only", async () => {
  rejectedMutation = mutation(fixture.clients.primary, 2, {
    operation: "upsert",
    recordId: fixture.records.primary,
    baseRevision: "0",
    payload: fixture.payloads.primaryConflict,
  });
  const result = await request("POST", "/v1/sync/push", rejectedMutation);
  equal(result.status, 200);
  equal(result.json.lastMutationId, "2");
  equal(result.json.checkpoint, "1");
  equal(result.json.results[0].status, "rejected");
  equal(result.json.results[0].code, "REVISION_CONFLICT");
  equal(result.json.results[0].authoritative.revision, "1");
});

await test("retrying a rejection returns its original durable outcome", async () => {
  const result = await request("POST", "/v1/sync/push", rejectedMutation);
  equal(result.status, 200);
  equal(result.json.results[0].status, "duplicate");
  equal(result.json.results[0].originalStatus, "rejected");
  equal(result.json.checkpoint, "1");
});

await test("a mixed push is transactional when a later id has a gap", async () => {
  const body = {
    protocolVersion: 1,
    clientId: fixture.clients.atomic,
    mutations: [
      {
        mutationId: "1",
        operation: "upsert",
        table: "docs",
        recordId: fixture.records.atomic,
        baseRevision: "0",
        payload: { value: "must roll back" },
      },
      {
        mutationId: "3",
        operation: "upsert",
        table: "docs",
        recordId: fixture.records.atomic,
        payload: { value: "gap" },
      },
    ],
  };
  const result = await request("POST", "/v1/sync/push", body);
  equal(result.status, 409);
  equal(result.json.error, "MUTATION_GAP");
  const absent = await request("GET", `/doc/${fixture.records.atomic}`);
  equal(absent.status, 404);

  const retry = await request(
    "POST",
    "/v1/sync/push",
    mutation(fixture.clients.atomic, 1, {
      operation: "upsert",
      recordId: fixture.records.atomic,
      baseRevision: "0",
      payload: { value: "committed after rollback" },
    }),
  );
  equal(retry.status, 200);
  equal(retry.json.results[0].status, "applied");
});

await test("injected failures roll back effect, ledger, watermark, and checkpoint", async () => {
  for (const [index, failpoint] of [
    "after-effect",
    "after-ledger",
    "before-commit",
  ].entries()) {
    const clientId = `protocol-failure-${index}`;
    const recordId = `protocol-failure-record-${index}`;
    const body = mutation(clientId, 1, {
      operation: "upsert",
      recordId,
      baseRevision: "0",
      payload: { failpoint },
    });
    const failed = await request("POST", "/v1/sync/push", body, {
      "x-syncer-failpoint": failpoint,
    });
    equal(failed.status, 500);
    equal(failed.json.error, "INJECTED_FAILURE");
    equal((await request("GET", `/doc/${recordId}`)).status, 404);

    const retry = await request("POST", "/v1/sync/push", body);
    equal(retry.status, 200);
    equal(retry.json.lastMutationId, "1");
    equal(retry.json.results[0].status, "applied");
  }
});

await test("a lost response after commit is recovered by an identical retry", async () => {
  const clientId = "protocol-response-loss";
  const recordId = "protocol-response-loss-record";
  const body = mutation(clientId, 1, {
    operation: "upsert",
    recordId,
    baseRevision: "0",
    payload: { committedBeforeResponseLoss: true },
  });

  let responseWasLost = false;
  try {
    await request("POST", "/v1/sync/push", body, {
      "x-syncer-failpoint": "after-commit-response-loss",
    });
  } catch {
    responseWasLost = true;
  }
  check(responseWasLost, "the post-commit failpoint returned a response");

  const retry = await request("POST", "/v1/sync/push", body);
  equal(retry.status, 200);
  equal(retry.json.lastMutationId, "1");
  equal(retry.json.results[0].status, "duplicate");
  equal(retry.json.results[0].originalStatus, "applied");

  const snapshot = await request("GET", "/v1/sync/snapshot");
  equal(snapshot.status, 200);
  equal(
    snapshot.json.records.find((record) => record.recordId === recordId).record
      .committedBeforeResponseLoss,
    true,
  );

  const pull = await request("GET", "/v1/sync/pull?checkpoint=0&limit=100");
  equal(
    pull.json.changes.filter((change) => change.recordId === recordId).length,
    1,
  );
});

let deletedRevision;
await test("create and delete produce explicit ordered change operations", async () => {
  const created = await request(
    "POST",
    "/v1/sync/push",
    mutation(fixture.clients.delete, 1, {
      operation: "upsert",
      recordId: fixture.records.delete,
      baseRevision: "0",
      payload: fixture.payloads.created,
    }),
  );
  equal(created.status, 200);
  equal(created.json.results[0].document.revision, "1");

  const deleted = await request(
    "POST",
    "/v1/sync/push",
    mutation(fixture.clients.delete, 2, {
      operation: "delete",
      recordId: fixture.records.delete,
      baseRevision: "1",
    }),
  );
  equal(deleted.status, 200);
  equal(deleted.json.results[0].document.deleted, true);
  deletedRevision = deleted.json.results[0].document.revision;

  const pull = await request("GET", "/v1/sync/pull?checkpoint=0&limit=100");
  const changes = pull.json.changes.filter(
    (change) => change.recordId === fixture.records.delete,
  );
  equal(changes.map((change) => change.operation), ["upsert", "delete"]);
  equal(changes[1].record, null);
});

await test("resurrection requires an explicit flag and exact tombstone revision", async () => {
  const denied = await request(
    "POST",
    "/v1/sync/push",
    mutation(fixture.clients.delete, 3, {
      operation: "upsert",
      recordId: fixture.records.delete,
      baseRevision: deletedRevision,
      payload: fixture.payloads.resurrected,
    }),
  );
  equal(denied.status, 200);
  equal(denied.json.results[0].status, "rejected");
  equal(denied.json.results[0].code, "TOMBSTONED");

  const accepted = await request(
    "POST",
    "/v1/sync/push",
    mutation(fixture.clients.delete, 4, {
      operation: "upsert",
      recordId: fixture.records.delete,
      baseRevision: deletedRevision,
      resurrect: true,
      payload: fixture.payloads.resurrected,
    }),
  );
  equal(accepted.status, 200);
  equal(accepted.json.results[0].status, "applied");
  equal(accepted.json.results[0].resurrected, true);
  equal(accepted.json.results[0].document.deleted, false);
});

await test("unsupported tables reject durably without blocking the next id", async () => {
  const unsupported = {
    protocolVersion: 1,
    clientId: fixture.clients.unsupported,
    mutations: [
      {
        mutationId: "1",
        operation: "upsert",
        table: "secrets",
        recordId: "nope",
        payload: { hidden: true },
      },
    ],
  };
  const rejected = await request("POST", "/v1/sync/push", unsupported);
  equal(rejected.status, 200);
  equal(rejected.json.lastMutationId, "1");
  equal(rejected.json.results[0].code, "UNSUPPORTED_TABLE");

  const recovered = await request(
    "POST",
    "/v1/sync/push",
    mutation(fixture.clients.unsupported, 2, {
      operation: "upsert",
      recordId: fixture.records.unsupportedRecovery,
      baseRevision: "0",
      payload: { supported: true },
    }),
  );
  equal(recovered.status, 200);
  equal(recovered.json.lastMutationId, "2");
  equal(recovered.json.results[0].status, "applied");
});

await test("authenticated identity cannot claim an unbound clientId", async () => {
  const result = await request(
    "POST",
    "/v1/sync/push",
    mutation("claimed-by-request", 1, {
      operation: "upsert",
      recordId: "identity-spoof",
      baseRevision: "0",
      payload: { mustNotExist: true },
    }),
    {
      "x-syncer-test-tenant": "tenant-authz",
      "x-syncer-test-subject": "user-authz",
      "x-syncer-test-client-id": "bound-by-server",
    },
  );
  equal(result.status, 403);
  equal(result.json.error, "CLIENT_ID_FORBIDDEN");

  const snapshot = await request(
    "GET",
    "/v1/sync/snapshot",
    undefined,
    {
      "x-syncer-test-tenant": "tenant-authz",
      "x-syncer-test-subject": "user-authz",
      "x-syncer-test-client-id": "bound-by-server",
    },
  );
  equal(snapshot.status, 200);
  equal(snapshot.json.records, []);
});

await test("tenant scope isolates records, ledgers, pull logs, and snapshots", async () => {
  const recordId = "same-record-id";
  const clientId = "same-client-id";
  const headers = (tenant) => ({
    "x-syncer-test-tenant": tenant,
    "x-syncer-test-subject": `${tenant}-user`,
    "x-syncer-test-client-id": clientId,
  });
  const write = (tenant, value) =>
    request(
      "POST",
      "/v1/sync/push",
      mutation(clientId, 1, {
        operation: "upsert",
        recordId,
        baseRevision: "0",
        payload: { tenant, value },
      }),
      headers(tenant),
    );

  const tenantA = await write("tenant-a", "alpha");
  const tenantB = await write("tenant-b", "bravo");
  equal(tenantA.status, 200);
  equal(tenantB.status, 200);
  equal(tenantA.json.lastMutationId, "1");
  equal(tenantB.json.lastMutationId, "1");

  for (const [tenant, value] of [
    ["tenant-a", "alpha"],
    ["tenant-b", "bravo"],
  ]) {
    const pull = await request(
      "GET",
      "/v1/sync/pull?checkpoint=0",
      undefined,
      headers(tenant),
    );
    equal(pull.status, 200);
    equal(pull.json.changes.length, 1);
    equal(pull.json.changes[0].record, { tenant, value });

    const snapshot = await request(
      "GET",
      "/v1/sync/snapshot",
      undefined,
      headers(tenant),
    );
    equal(snapshot.status, 200);
    equal(snapshot.json.records.length, 1);
    equal(snapshot.json.records[0].record, { tenant, value });
  }
});

await test("a durable client ledger cannot be reassigned to another subject", async () => {
  const headers = (subject) => ({
    "x-syncer-test-tenant": "tenant-owned-client",
    "x-syncer-test-subject": subject,
    "x-syncer-test-client-id": "owned-client",
  });
  const first = await request(
    "POST",
    "/v1/sync/push",
    mutation("owned-client", 1, {
      operation: "upsert",
      recordId: "owned-record",
      baseRevision: "0",
      payload: { owner: "original-subject" },
    }),
    headers("original-subject"),
  );
  equal(first.status, 200);

  const reassigned = await request(
    "POST",
    "/v1/sync/push",
    mutation("owned-client", 2, {
      operation: "upsert",
      recordId: "owned-record",
      payload: { owner: "different-subject" },
    }),
    headers("different-subject"),
  );
  equal(reassigned.status, 403);
  equal(reassigned.json.error, "CLIENT_OWNERSHIP_CONFLICT");
});

await test("direct database writes join the ordered stream and roll back atomically", async () => {
  const recordId = "external-write-record";
  const baseline = await request("GET", "/v1/sync/pull?checkpoint=0");
  const before = baseline.json.checkpoint;
  const write = {
    operation: "upsert",
    recordId,
    payload: { source: "outside-push", value: 1 },
  };

  const failed = await request(
    "POST",
    "/v1/sync/admin/external-write",
    write,
    { "x-syncer-failpoint": "after-external-effect" },
  );
  equal(failed.status, 500);
  equal(failed.json.error, "INJECTED_FAILURE");
  const afterFailure = await request(
    "GET",
    `/v1/sync/pull?checkpoint=${before}`,
  );
  equal(afterFailure.json.changes, []);
  equal(afterFailure.json.checkpoint, before);

  const upserted = await request(
    "POST",
    "/v1/sync/admin/external-write",
    write,
  );
  equal(upserted.status, 200);
  equal(BigInt(upserted.json.checkpoint), BigInt(before) + 1n);
  equal(upserted.json.document.revision, "1");

  const upsertPage = await request(
    "GET",
    `/v1/sync/pull?checkpoint=${before}`,
  );
  equal(upsertPage.json.changes.length, 1);
  equal(upsertPage.json.changes[0].operation, "upsert");
  equal(upsertPage.json.changes[0].record, write.payload);
  equal(
    Object.hasOwn(upsertPage.json.changes[0], "source"),
    false,
    "a non-protocol write must not forge mutation attribution",
  );

  const deleted = await request(
    "POST",
    "/v1/sync/admin/external-write",
    { operation: "delete", recordId },
  );
  equal(deleted.status, 200);
  equal(deleted.json.document.deleted, true);
  equal(deleted.json.document.revision, "2");
  equal(BigInt(deleted.json.checkpoint), BigInt(upserted.json.checkpoint) + 1n);

  const deletePage = await request(
    "GET",
    `/v1/sync/pull?checkpoint=${upserted.json.checkpoint}`,
  );
  equal(deletePage.json.changes.length, 1);
  equal(deletePage.json.changes[0].operation, "delete");
  equal(deletePage.json.changes[0].record, null);
  equal(Object.hasOwn(deletePage.json.changes[0], "source"), false);
});

await test("concurrent clients receive a total commit order", async () => {
  const make = (clientId, recordId) =>
    request(
      "POST",
      "/v1/sync/push",
      mutation(clientId, 1, {
        operation: "upsert",
        recordId,
        baseRevision: "0",
        payload: { clientId },
      }),
    );
  const [a, b] = await Promise.all([
    make(fixture.clients.concurrentA, fixture.records.concurrentA),
    make(fixture.clients.concurrentB, fixture.records.concurrentB),
  ]);
  equal(a.status, 200);
  equal(b.status, 200);
  const checkpoints = [BigInt(a.json.checkpoint), BigInt(b.json.checkpoint)].sort(
    (left, right) => (left < right ? -1 : 1),
  );
  equal(checkpoints[1] - checkpoints[0], 1n);

  const pull = await request(
    "GET",
    `/v1/sync/pull?checkpoint=${checkpoints[0] - 1n}&limit=2`,
  );
  equal(
    pull.json.changes.map((change) => BigInt(change.checkpoint)),
    checkpoints,
  );
});

await test("an allowlisted JSONB table supports merge, conflict, delete, and resurrection", async () => {
  const clientId = "protocol-tasks-lifecycle";
  const recordId = "task-lifecycle";
  const created = await request(
    "POST",
    "/v1/sync/push",
    mutation(
      clientId,
      1,
      {
        operation: "upsert",
        recordId,
        baseRevision: "0",
        payload: {
          title: "initial",
          nested: { retained: true },
          updatedAt: "2026-07-25T10:00:00.000Z",
        },
      },
      "tasks",
    ),
  );
  equal(created.status, 200);
  equal(created.json.results[0].status, "applied");
  equal(created.json.results[0].document.table, "tasks");
  equal(created.json.results[0].document.revision, "1");

  const updated = await request(
    "POST",
    "/v1/sync/push",
    mutation(
      clientId,
      2,
      {
        operation: "upsert",
        recordId,
        baseRevision: "1",
        payload: {
          title: "updated",
          nested: { added: true },
          updatedAt: "2026-07-25T10:01:00.000Z",
        },
      },
      "tasks",
    ),
  );
  equal(updated.status, 200);
  equal(updated.json.results[0].document.revision, "2");
  equal(updated.json.results[0].document.record.nested, {
    retained: true,
    added: true,
  });

  const conflict = await request(
    "POST",
    "/v1/sync/push",
    mutation(
      clientId,
      3,
      {
        operation: "upsert",
        recordId,
        baseRevision: "1",
        payload: { title: "stale" },
      },
      "tasks",
    ),
  );
  equal(conflict.status, 200);
  equal(conflict.json.results[0].status, "rejected");
  equal(conflict.json.results[0].code, "REVISION_CONFLICT");
  equal(conflict.json.results[0].authoritative.revision, "2");

  const deleted = await request(
    "POST",
    "/v1/sync/push",
    mutation(
      clientId,
      4,
      {
        operation: "delete",
        recordId,
        baseRevision: "2",
      },
      "tasks",
    ),
  );
  equal(deleted.status, 200);
  equal(deleted.json.results[0].document.deleted, true);
  equal(deleted.json.results[0].document.revision, "3");
  const deleteCheckpoint = deleted.json.checkpoint;

  const repeatedDelete = await request(
    "POST",
    "/v1/sync/push",
    mutation(
      clientId,
      5,
      {
        operation: "delete",
        recordId,
        baseRevision: "3",
      },
      "tasks",
    ),
  );
  equal(repeatedDelete.status, 200);
  equal(repeatedDelete.json.results[0].status, "applied");
  equal(repeatedDelete.json.results[0].noOp, true);
  equal(repeatedDelete.json.checkpoint, deleteCheckpoint);

  const deniedResurrection = await request(
    "POST",
    "/v1/sync/push",
    mutation(
      clientId,
      6,
      {
        operation: "upsert",
        recordId,
        baseRevision: "3",
        payload: { title: "not yet" },
      },
      "tasks",
    ),
  );
  equal(deniedResurrection.status, 200);
  equal(deniedResurrection.json.results[0].code, "TOMBSTONED");

  const resurrected = await request(
    "POST",
    "/v1/sync/push",
    mutation(
      clientId,
      7,
      {
        operation: "upsert",
        recordId,
        baseRevision: "3",
        resurrect: true,
        payload: {
          title: "resurrected",
          updatedAt: "2026-07-25T10:02:00.000Z",
        },
      },
      "tasks",
    ),
  );
  equal(resurrected.status, 200);
  equal(resurrected.json.results[0].document.deleted, false);
  equal(resurrected.json.results[0].document.revision, "4");
  equal(resurrected.json.results[0].document.record.nested, {
    retained: true,
    added: true,
  });

  const pull = await request("GET", "/v1/sync/pull?checkpoint=0&limit=100");
  const taskChanges = pull.json.changes.filter(
    (change) => change.table === "tasks" && change.recordId === recordId,
  );
  equal(taskChanges.map((change) => change.operation), [
    "upsert",
    "upsert",
    "delete",
    "upsert",
  ]);
  equal(taskChanges.map((change) => change.revision), ["1", "2", "3", "4"]);
  equal(
    taskChanges.every((change) => change.source.clientId === clientId),
    true,
  );
});

await test("rejected handler side effects roll back before ledger acknowledgement", async () => {
  const clientId = "protocol-handler-rollback";
  const recordId = "must-not-survive-handler-rejection";
  const rejected = await request(
    "POST",
    "/v1/sync/push",
    mutation(
      clientId,
      1,
      {
        operation: "upsert",
        recordId,
        payload: { ignored: true },
      },
      "rollback_probe",
    ),
  );
  equal(rejected.status, 200);
  equal(rejected.json.results[0].status, "rejected");
  equal(rejected.json.results[0].code, "TEST_REJECTION");

  const snapshot = await request("GET", "/v1/sync/snapshot");
  equal(
    snapshot.json.records.some(
      (record) => record.table === "tasks" && record.recordId === recordId,
    ),
    false,
  );
  const pull = await request("GET", "/v1/sync/pull?checkpoint=0&limit=100");
  equal(
    pull.json.changes.some(
      (change) => change.table === "tasks" && change.recordId === recordId,
    ),
    false,
  );
});

await test("uncaptured handler success rolls back its watermark and can be retried", async () => {
  const clientId = "protocol-handler-capture-guard";
  const recordId = "captured-after-handler-failure";
  const uncaptured = await request(
    "POST",
    "/v1/sync/push",
    mutation(
      clientId,
      1,
      {
        operation: "upsert",
        recordId,
        payload: { invisible: true },
      },
      "uncaptured_probe",
    ),
  );
  equal(uncaptured.status, 500);
  equal(uncaptured.json.error, "MUTATION_NOT_CAPTURED");

  const retry = await request(
    "POST",
    "/v1/sync/push",
    mutation(
      clientId,
      1,
      {
        operation: "upsert",
        recordId,
        baseRevision: "0",
        payload: { visible: true },
      },
      "tasks",
    ),
  );
  equal(retry.status, 200);
  equal(retry.json.lastMutationId, "1");
  equal(retry.json.results[0].status, "applied");
  equal(retry.json.results[0].document.record.visible, true);
});

let finalCheckpoint;
await test("pull pagination never advances beyond the returned page", async () => {
  const first = await request("GET", "/v1/sync/pull?checkpoint=0&limit=2");
  equal(first.status, 200);
  equal(first.json.changes.length, 2);
  equal(first.json.hasMore, true);
  equal(first.json.checkpoint, first.json.changes[1].checkpoint);

  let checkpoint = first.json.checkpoint;
  let seen = first.json.changes.length;
  while (true) {
    const page = await request(
      "GET",
      `/v1/sync/pull?checkpoint=${checkpoint}&limit=2`,
    );
    seen += page.json.changes.length;
    checkpoint = page.json.checkpoint;
    if (!page.json.hasMore) break;
  }
  check(seen >= 8, "expected the protocol effects produced by earlier cases");
  finalCheckpoint = checkpoint;

  const empty = await request(
    "GET",
    `/v1/sync/pull?checkpoint=${finalCheckpoint}`,
  );
  equal(empty.json.changes, []);
  equal(empty.json.checkpoint, finalCheckpoint);
});

await test("compacted history requires reset and snapshot is self-consistent", async () => {
  const through = String(BigInt(finalCheckpoint) - 1n);
  for (const failpoint of [
    "after-compaction-delete",
    "before-compaction-commit",
  ]) {
    const failed = await request(
      "POST",
      "/v1/sync/admin/compact",
      { throughCheckpoint: through },
      { "x-syncer-failpoint": failpoint },
    );
    equal(failed.status, 500);
    equal(failed.json.error, "INJECTED_FAILURE");
    const historyStillPresent = await request(
      "GET",
      "/v1/sync/pull?checkpoint=0&limit=1",
    );
    equal(historyStillPresent.status, 200);
    equal(historyStillPresent.json.changes.length, 1);
  }

  const compacted = await request("POST", "/v1/sync/admin/compact", {
    throughCheckpoint: through,
  });
  equal(compacted.status, 200);
  equal(compacted.json.minimumCheckpoint, through);

  const stale = await request("GET", "/v1/sync/pull?checkpoint=0");
  equal(stale.status, 409);
  equal(stale.json.error, "RESET_REQUIRED");
  equal(stale.json.resetRequired, true);

  const snapshot = await request("GET", stale.json.snapshotUrl);
  equal(snapshot.status, 200);
  equal(snapshot.json.checkpoint, finalCheckpoint);
  const resurrected = snapshot.json.records.find(
    (record) => record.recordId === fixture.records.delete,
  );
  equal(resurrected.record.title, fixture.payloads.resurrected.title);

  const afterSnapshot = await request(
    "GET",
    `/v1/sync/pull?checkpoint=${snapshot.json.checkpoint}`,
  );
  equal(afterSnapshot.status, 200);
  equal(afterSnapshot.json.changes, []);
});

await test("malformed envelopes are rejected before touching the ledger", async () => {
  const invalid = await request("POST", "/v1/sync/push", {
    protocolVersion: 1,
    clientId: "bad client id",
    mutations: [],
  });
  equal(invalid.status, 400);
  equal(invalid.json.error, "INVALID_PUSH");

  const unsupportedTransactionLabel = mutation("strict-v1", 1, {
    operation: "upsert",
    recordId: "strict-v1-record",
    baseRevision: "0",
    payload: { value: "must not apply" },
  });
  unsupportedTransactionLabel.mutations[0].transactionId = "not-in-v1";
  const transactionLabel = await request(
    "POST",
    "/v1/sync/push",
    unsupportedTransactionLabel,
  );
  equal(transactionLabel.status, 400);
  equal(transactionLabel.json.error, "INVALID_PUSH");
});

console.log(
  `\nProtocol v1: ${cases} cases passed, ${assertions} assertions passed\n`,
);
