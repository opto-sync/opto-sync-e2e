"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {admitAck, admitPull, valid, transitions, explore} = require("./cursor_retry_model.cjs");
const state = Object.freeze({
  commits: [1, 1], effects: [1, 1], inFlight: [1, 1],
  acked: [0, 0], cursor: [0, 0],
});
test("exhaustive tenant and mutation identity matrix denies foreign/stale ACKs", () => {
  for (const requester of [-1, 0, 1, 2, "0", null])
    for (const responseTenant of [-1, 0, 1, 2, "0", null])
      for (const mutationId of [-1, 0, 1, 2, "1", null])
        assert.equal(admitAck(state, requester, responseTenant, mutationId),
          Number.isInteger(requester) && requester >= 0 && requester <= 1 &&
            responseTenant === requester && mutationId === 1);
});
test("pull checkpoint must be integral, nonnegative and tenant scoped", () => {
  for (const requester of [-1, 0, 1, 2, "1", null])
    for (const cursorTenant of [-1, 0, 1, 2, "1", null])
      for (const checkpoint of [-1, 0, 1, 2, 0.5, "1", null])
        assert.equal(admitPull(state, requester, cursorTenant, checkpoint),
          Number.isInteger(requester) && requester >= 0 && requester <= 1 &&
            cursorTenant === requester && (checkpoint === 0 || checkpoint === 1));
});
test("denial never alters committed outcomes or in-flight identities", () => {
  for (const [action, next, rejected] of transitions(state)) {
    if (!rejected) continue;
    assert.match(action, /^reject-/);
    for (const key of ["commits", "effects", "inFlight", "acked", "cursor"])
      assert.deepEqual(next[key], state[key]);
  }
});
test("model rejects duplicate effects and premature client observation", () => {
  const mutants = [
    {...state, effects: [2, 1]},
    {...state, acked: [2, 0]},
    {...state, cursor: [0, 2]},
    {...state, inFlight: [1, 1], acked: [1, 0]},
  ];
  for (const mutant of mutants) assert.throws(() => valid(mutant));
});
test("bounded exploration is non-vacuous and explicitly host-only", () => {
  const result = explore();
  assert.ok(result.states > 1000);
  assert.ok(result.transitions > result.states);
  assert.equal(result.evidence, "HOST_ONLY");
  assert.equal(result.guest, "NOT_EXECUTED");
});
