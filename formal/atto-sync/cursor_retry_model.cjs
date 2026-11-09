"use strict";
// Bounded host-only refinement of tenant-scoped mutation and pull admission.
// A successful model run is NOT an AttoLang guest / PostgreSQL E2E result.
const assert = require("node:assert/strict");
const BOUND = 10;
const TENANTS = 2;
const init = {
  commits: [0, 0], effects: [0, 0], inFlight: [0, 0],
  acked: [0, 0], cursor: [0, 0],
  committed: false, retried: false, lost: false, cancelled: false,
  crossDenied: false, futureDenied: false, precommitDenied: false,
  staleDenied: false,
};
function must(value, message) { assert.ok(value, "opto-sync Atto model: " + message); }
function admitAck(state, requesterTenant, responseTenant, mutationId) {
  return Number.isInteger(requesterTenant) && requesterTenant >= 0 && requesterTenant < TENANTS &&
    requesterTenant === responseTenant && mutationId === 1 &&
    state.inFlight[requesterTenant] === mutationId &&
    state.commits[requesterTenant] >= mutationId;
}
function admitPull(state, requesterTenant, cursorTenant, proposed) {
  return Number.isInteger(requesterTenant) && requesterTenant >= 0 && requesterTenant < TENANTS &&
    requesterTenant === cursorTenant && Number.isInteger(proposed) && proposed >= 0 &&
    proposed <= state.commits[requesterTenant];
}
function valid(state) {
  for (let tenant = 0; tenant < TENANTS; tenant++) {
    const committed = state.commits[tenant];
    const ack = state.acked[tenant];
    const cursor = state.cursor[tenant];
    const inFlight = state.inFlight[tenant];
    must(committed === 0 || committed === 1, "mutation must commit at most once");
    must(state.effects[tenant] === committed, "effect must apply exactly once");
    must((ack === 0 || ack === 1) && ack <= committed, "ACK needs durable commit");
    must((cursor === 0 || cursor === 1) && cursor <= committed, "cursor needs durable commit");
    must(inFlight === 0 || inFlight === 1, "in-flight immutable mutation id");
    must(ack === 0 || inFlight === 0, "ACK must retire the exact in-flight request");
  }
}
function write(state, tenant, key, value) {
  return { ...state, [key]: state[key].map((x, i) => i === tenant ? value : x) };
}
function noLedgerMutation(before, after) {
  for (const key of ["commits", "effects", "inFlight", "acked", "cursor"])
    assert.deepEqual(after[key], before[key], "rejected input may not change " + key);
}
function transitions(state) {
  const output = [];
  for (let tenant = 0; tenant < TENANTS; tenant++) {
    const other = (tenant + 1) % TENANTS;
    if (state.inFlight[tenant] === 0 && state.acked[tenant] === 0 && state.commits[tenant] === 0)
      output.push(["send", write(state, tenant, "inFlight", 1)]);
    if (state.inFlight[tenant] === 1 && state.commits[tenant] === 0) {
      const afterCommit = write(write(state, tenant, "commits", 1), tenant, "effects", 1);
      output.push(["commit", { ...afterCommit, committed: true }]);
      must(!admitAck(state, tenant, tenant, 1), "premature ACK admitted");
      output.push(["reject-precommit", { ...state, precommitDenied: true }, true]);
    }
    if (state.inFlight[tenant] === 1 && state.commits[tenant] === 1) {
      must(admitAck(state, tenant, tenant, 1), "committed matching ACK denied");
      output.push(["ack", write(write(state, tenant, "acked", 1), tenant, "inFlight", 0)]);
      output.push(["retry", { ...state, retried: true }]);
      output.push(["response-loss", { ...state, lost: true }]);
      output.push(["cancel-after-commit", { ...state, cancelled: true }]);
    }
    if (state.cursor[tenant] < state.commits[tenant]) {
      must(admitPull(state, tenant, tenant, state.commits[tenant]), "own committed cursor denied");
      output.push(["pull", write(state, tenant, "cursor", state.commits[tenant])]);
    }
    // A real authorization decision must carry the requester and envelope tenant.
    // A boolean 'denied' flag by itself is not evidence of a correct guard.
    must(!admitAck(state, tenant, other, 1), "foreign tenant ACK admitted");
    must(!admitPull(state, tenant, other, 0), "foreign tenant cursor admitted");
    output.push(["reject-cross-tenant", { ...state, crossDenied: true }, true]);
    must(!admitPull(state, tenant, tenant, 2), "future cursor admitted");
    must(!admitPull(state, tenant, tenant, -1), "negative cursor admitted");
    output.push(["reject-future-cursor", { ...state, futureDenied: true }, true]);
    must(!admitAck(state, tenant, tenant, 0), "stale mutation ACK admitted");
    must(!admitAck(state, tenant, tenant, 2), "future mutation ACK admitted");
    output.push(["reject-stale-ack", { ...state, staleDenied: true }, true]);
  }
  return output;
}
function explore() {
  const seen = new Set([JSON.stringify(init)]);
  const queue = [[init, 0]];
  const events = new Set();
  let edges = 0;
  for (let index = 0; index < queue.length; index++) {
    const [state, depth] = queue[index];
    valid(state);
    if (depth === BOUND) continue;
    for (const [event, next, rejected] of transitions(state)) {
      valid(next);
      if (rejected) noLedgerMutation(state, next);
      for (const key of ["commits", "acked", "cursor", "effects"])
        for (let tenant = 0; tenant < TENANTS; tenant++)
          must(next[key][tenant] >= state[key][tenant], key + " must be monotonic");
      events.add(event);
      edges++;
      const key = JSON.stringify(next);
      if (!seen.has(key)) { seen.add(key); queue.push([next, depth + 1]); }
    }
  }
  for (const event of ["send", "commit", "ack", "pull", "retry", "response-loss",
    "cancel-after-commit", "reject-cross-tenant", "reject-future-cursor",
    "reject-precommit", "reject-stale-ack"])
    must(events.has(event), "missing positive/negative action witness: " + event);
  for (const flag of ["committed", "retried", "lost", "cancelled", "crossDenied",
    "futureDenied", "precommitDenied", "staleDenied"])
    must(queue.some(([state]) => state[flag]), "missing witness: " + flag);
  // Deliberately unsafe transitions MUST die; testing only well-behaved transitions is vacuous.
  for (const mutated of [
    { ...init, commits: [2, 0] }, { ...init, effects: [1, 0] },
    { ...init, acked: [1, 0] }, { ...init, cursor: [2, 0] },
    { ...init, inFlight: [1, 0], acked: [1, 0], commits: [1, 0], effects: [1, 0] },
  ]) assert.throws(() => valid(mutated), /opto-sync Atto model/, "unsafe state must be rejected");
  assert.equal(admitAck({ ...init, commits: [1, 1], inFlight: [1, 1] }, 0, 1, 1), false);
  assert.equal(admitPull({ ...init, commits: [1, 1] }, 0, 1, 1), false);
  return { states: seen.size, transitions: edges, tenants: TENANTS,
    mutationIdsPerTenant: 1, bound: BOUND, negativeControls: 7,
    evidence: "HOST_ONLY", guest: "NOT_EXECUTED", claim: "bounded abstract admission; no DB/client replay" };
}
if (require.main === module) console.log(JSON.stringify(explore()));
module.exports = { admitAck, admitPull, valid, transitions, explore };
