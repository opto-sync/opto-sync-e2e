import type {
  ProtocolMutationDecision,
  ProtocolMutationHandler,
  ProtocolMutationHandlerContext,
} from "./protocol.js";

const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const LOGICAL_TABLE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type JsonbTableMutationHandlerOptions = {
  /** Stable logical table name used on the protocol wire and in the mirror. */
  logicalTable: string;
  /** One- or two-part PostgreSQL relation name, restricted and quoted. */
  relation: string;
  tenantColumn: string;
  idColumn: string;
  /** JSON/JSONB object column reconciled through the C merge engine. */
  recordColumn: string;
  /** Optional nullable timestamp column used for soft deletion. */
  deletedColumn?: string;
  /**
   * Optional application-specific record authorization. Authentication and
   * tenant/client binding have already succeeded; return false to durably
   * reject this mutation without retaining handler side effects.
   */
  authorize?: (
    context: Readonly<ProtocolMutationHandlerContext>,
  ) => boolean | Promise<boolean>;
};

type MirrorRow = {
  record: Record<string, unknown> | null;
  revision: string | number | bigint;
  deleted_at: Date | string | null;
};

type SourceRow = {
  record: Record<string, unknown>;
  deleted_at: Date | string | null;
};

function quoteIdentifier(identifier: string, name: string): string {
  if (!SQL_IDENTIFIER.test(identifier)) {
    throw new Error(`${name} must be a simple PostgreSQL identifier`);
  }
  return `"${identifier.replaceAll('"', '""')}"`;
}

function quoteRelation(relation: string): string {
  const parts = relation.split(".");
  if (parts.length < 1 || parts.length > 2) {
    throw new Error("relation must contain one table or schema.table");
  }
  return parts
    .map((part) => quoteIdentifier(part, "relation component"))
    .join(".");
}

function rejected(
  code: string,
  message: string,
  authoritative?: Record<string, unknown>,
): ProtocolMutationDecision {
  return {
    status: "rejected",
    code,
    message,
    ...(authoritative === undefined ? {} : { authoritative }),
  };
}

function publicDocument(
  logicalTable: string,
  recordId: string,
  row: MirrorRow,
): Record<string, unknown> {
  const deleted = row.deleted_at !== null;
  return {
    table: logicalTable,
    recordId,
    record: deleted ? null : row.record,
    revision: String(row.revision),
    deleted,
    deletedAt: row.deleted_at,
  };
}

function requireObject(
  value: unknown,
  name: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

/**
 * Build an allowlisted protocol-v1 handler for the common table shape:
 * tenant id + record id + JSONB object + optional soft-delete timestamp.
 *
 * The source table must be registered with
 * `syncer_protocol_register_capture(...)`. The protocol dispatcher verifies
 * that every non-no-op success advanced the captured checkpoint, so a missing
 * trigger fails the whole push instead of acknowledging an invisible write.
 */
export function createPostgresJsonbMutationHandler(
  options: JsonbTableMutationHandlerOptions,
): ProtocolMutationHandler {
  if (!LOGICAL_TABLE.test(options.logicalTable)) {
    throw new Error("logicalTable is not a valid protocol scope id");
  }
  const relation = quoteRelation(options.relation);
  const tenantColumn = quoteIdentifier(
    options.tenantColumn,
    "tenantColumn",
  );
  const idColumn = quoteIdentifier(options.idColumn, "idColumn");
  const recordColumn = quoteIdentifier(
    options.recordColumn,
    "recordColumn",
  );
  const deletedColumn =
    options.deletedColumn === undefined
      ? undefined
      : quoteIdentifier(options.deletedColumn, "deletedColumn");

  return async (
    context: ProtocolMutationHandlerContext,
  ): Promise<ProtocolMutationDecision> => {
    const { connection, identity, mutation, merge } = context;
    if (mutation.table !== options.logicalTable) {
      throw new Error("mutation handler was dispatched for another table");
    }
    if (
      options.authorize !== undefined &&
      !(await options.authorize(context))
    ) {
      return rejected(
        "FORBIDDEN",
        "the authenticated subject cannot mutate this record",
      );
    }

    const mirrorResult = await connection.query<MirrorRow>(
      `SELECT record, revision, deleted_at
         FROM syncer_protocol_records
        WHERE tenant_id = $1 AND table_name = $2 AND record_id = $3
        FOR UPDATE`,
      [identity.tenantId, options.logicalTable, mutation.recordId],
    );
    const mirror = mirrorResult.rows[0];
    const sourceResult = await connection.query<SourceRow>(
      `SELECT ${recordColumn} AS record,
              ${deletedColumn ?? "NULL::TIMESTAMPTZ"} AS deleted_at
         FROM ${relation}
        WHERE ${tenantColumn} = $1 AND ${idColumn} = $2
        FOR UPDATE`,
      [identity.tenantId, mutation.recordId],
    );
    const source = sourceResult.rows[0];
    if (source !== undefined) {
      requireObject(source.record, "source record");
    }
    if ((mirror === undefined) !== (source === undefined) && !mirror?.deleted_at) {
      throw new Error(
        "authoritative source and protocol mirror disagree; repair capture before accepting writes",
      );
    }

    const expectedRevision =
      mutation.baseRevision == null ? null : BigInt(mutation.baseRevision);
    const authoritative =
      mirror === undefined
        ? undefined
        : publicDocument(options.logicalTable, mutation.recordId, mirror);

    if (mutation.operation === "delete") {
      if (mirror === undefined) {
        return rejected(
          "NOT_FOUND",
          "cannot delete a record that does not exist",
        );
      }
      if (
        expectedRevision !== null &&
        expectedRevision !== BigInt(mirror.revision)
      ) {
        return rejected(
          "REVISION_CONFLICT",
          `baseRevision ${expectedRevision} does not match ${mirror.revision}`,
          authoritative,
        );
      }
      if (mirror.deleted_at !== null) {
        return {
          status: "applied",
          noOp: true,
          document: authoritative,
        };
      }
      if (source === undefined) {
        throw new Error("live protocol mirror has no authoritative source row");
      }
      if (deletedColumn === undefined) {
        await connection.query(
          `DELETE FROM ${relation}
            WHERE ${tenantColumn} = $1 AND ${idColumn} = $2`,
          [identity.tenantId, mutation.recordId],
        );
      } else {
        await connection.query(
          `UPDATE ${relation}
              SET ${deletedColumn} = NOW()
            WHERE ${tenantColumn} = $1 AND ${idColumn} = $2`,
          [identity.tenantId, mutation.recordId],
        );
      }
    } else {
      const payload = requireObject(mutation.payload, "mutation payload");
      if (mirror === undefined) {
        if (expectedRevision !== null && expectedRevision !== 0n) {
          return rejected(
            "NOT_FOUND",
            "record is absent; creation requires baseRevision 0 or no baseRevision",
          );
        }
        await connection.query(
          `INSERT INTO ${relation}
             (${tenantColumn}, ${idColumn}, ${recordColumn}${
               deletedColumn === undefined ? "" : `, ${deletedColumn}`
             })
           VALUES ($1, $2, $3::JSONB${
             deletedColumn === undefined ? "" : ", NULL"
           })`,
          [identity.tenantId, mutation.recordId, JSON.stringify(payload)],
        );
      } else if (mirror.deleted_at !== null) {
        if (!mutation.resurrect) {
          return rejected(
            "TOMBSTONED",
            "record is deleted; set resurrect=true with its current baseRevision",
            authoritative,
          );
        }
        if (expectedRevision === null) {
          return rejected(
            "REVISION_REQUIRED",
            "resurrection requires the tombstone baseRevision",
            authoritative,
          );
        }
        if (expectedRevision !== BigInt(mirror.revision)) {
          return rejected(
            "REVISION_CONFLICT",
            `baseRevision ${expectedRevision} does not match ${mirror.revision}`,
            authoritative,
          );
        }
        if (source === undefined) {
          await connection.query(
            `INSERT INTO ${relation}
               (${tenantColumn}, ${idColumn}, ${recordColumn}${
                 deletedColumn === undefined ? "" : `, ${deletedColumn}`
               })
             VALUES ($1, $2, $3::JSONB${
               deletedColumn === undefined ? "" : ", NULL"
             })`,
            [identity.tenantId, mutation.recordId, JSON.stringify(payload)],
          );
        } else {
          const merged = requireObject(
            JSON.parse(
              merge(JSON.stringify(source.record), JSON.stringify(payload)),
            ),
            "merged record",
          );
          await connection.query(
            `UPDATE ${relation}
                SET ${recordColumn} = $3::JSONB${
                  deletedColumn === undefined
                    ? ""
                    : `, ${deletedColumn} = NULL`
                }
              WHERE ${tenantColumn} = $1 AND ${idColumn} = $2`,
            [
              identity.tenantId,
              mutation.recordId,
              JSON.stringify(merged),
            ],
          );
        }
      } else {
        if (
          expectedRevision !== null &&
          expectedRevision !== BigInt(mirror.revision)
        ) {
          return rejected(
            "REVISION_CONFLICT",
            `baseRevision ${expectedRevision} does not match ${mirror.revision}`,
            authoritative,
          );
        }
        if (source === undefined) {
          throw new Error("live protocol mirror has no authoritative source row");
        }
        const merged = requireObject(
          JSON.parse(
            merge(JSON.stringify(source.record), JSON.stringify(payload)),
          ),
          "merged record",
        );
        await connection.query(
          `UPDATE ${relation}
              SET ${recordColumn} = $3::JSONB${
                deletedColumn === undefined ? "" : `, ${deletedColumn} = NULL`
              }
            WHERE ${tenantColumn} = $1 AND ${idColumn} = $2`,
          [identity.tenantId, mutation.recordId, JSON.stringify(merged)],
        );
      }
    }

    const updated = await connection.query<MirrorRow>(
      `SELECT record, revision, deleted_at
         FROM syncer_protocol_records
        WHERE tenant_id = $1 AND table_name = $2 AND record_id = $3`,
      [identity.tenantId, options.logicalTable, mutation.recordId],
    );
    if (updated.rows.length !== 1) {
      throw new Error("captured mutation did not produce a protocol mirror row");
    }
    return {
      status: "applied",
      document: publicDocument(
        options.logicalTable,
        mutation.recordId,
        updated.rows[0],
      ),
    };
  };
}
