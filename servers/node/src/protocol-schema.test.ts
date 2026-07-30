import assert from "node:assert/strict";
import test from "node:test";

import { validateSchemaMigrationHistory } from "./protocol.js";

const expected = [
  {
    version: 1,
    name: "protocol_v1_tenant_ledger_and_capture",
    checksum: "a".repeat(64),
  },
  {
    version: 2,
    name: "generic_application_table_capture",
    checksum: "b".repeat(64),
  },
  {
    version: 3,
    name: "ordered_capture_registration",
    checksum: "c".repeat(64),
  },
];

test("exact migration history is accepted", () => {
  assert.doesNotThrow(() =>
    validateSchemaMigrationHistory([...expected], expected),
  );
  assert.doesNotThrow(() => validateSchemaMigrationHistory([], expected));
});

test("edited migration name or SQL checksum fails closed", () => {
  assert.throws(
    () =>
      validateSchemaMigrationHistory(
        [{ ...expected[0], checksum: "b".repeat(64) }],
        expected,
      ),
    /checksum\/name mismatch/,
  );
  assert.throws(
    () =>
      validateSchemaMigrationHistory(
        [{ ...expected[0], name: "silently_edited" }],
        expected,
      ),
    /checksum\/name mismatch/,
  );
});

test("a database migrated by a newer server prevents downgrade startup", () => {
  assert.throws(
    () =>
      validateSchemaMigrationHistory(
        [...expected, { version: 4, name: "future", checksum: "d".repeat(64) }],
        expected,
      ),
    /migration 4 is newer than this server/,
  );
});
