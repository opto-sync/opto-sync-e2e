import { createHash, timingSafeEqual } from "node:crypto";

import {
  createLocalJWKSet,
  createRemoteJWKSet,
  errors,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload,
} from "jose";
import { z } from "zod";

const ScopeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const ClientId = ScopeId;
const ClaimPath = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/)
  .refine(
    (path) => path !== "user_metadata" && !path.startsWith("user_metadata."),
    "authorization claims must not come from user_metadata",
  );
const Algorithm = z.enum(["ES256", "ES384", "ES512", "RS256", "RS384", "RS512", "EdDSA"]);

export type ProtocolIdentity = {
  subject: string;
  tenantId: string;
  clientIds: ReadonlySet<string> | null;
};

export type AuthenticationResult =
  | { status: "authenticated"; identity: ProtocolIdentity }
  | { status: "denied" }
  | { status: "unavailable" };

export interface ProtocolAuthenticator {
  readonly mode: "static" | "jwt";
  authenticateAuthorization(
    authorization: string | undefined,
  ): Promise<AuthenticationResult>;
}

const AuthEntrySchema = z
  .object({
    token: z.string().min(16).max(4096),
    subject: ScopeId,
    tenantId: ScopeId,
    clientIds: z.array(ClientId).min(1).max(100),
  })
  .strict();
const AuthConfigSchema = z.array(AuthEntrySchema).min(1).max(1000);

const JwksSchema = z
  .object({
    keys: z.array(z.record(z.unknown())).min(1).max(100),
  })
  .strict();

const JwtConfigSchema = z
  .object({
    jwksUrl: z.string().url().max(2048).optional(),
    jwks: JwksSchema.optional(),
    issuer: z.string().url().max(2048),
    audience: z.union([
      z.string().min(1).max(256),
      z.array(z.string().min(1).max(256)).min(1).max(20),
    ]),
    algorithms: z.array(Algorithm).min(1).max(7).default(["ES256", "RS256"]),
    roles: z.array(ScopeId).min(1).max(20).default(["authenticated"]),
    tenantClaim: ClaimPath.default("app_metadata.opto_sync_tenant_id"),
    clientIdsClaim: ClaimPath.nullable().default(
      "app_metadata.opto_sync_client_ids",
    ),
    clockToleranceSeconds: z.number().int().min(0).max(300).default(5),
    maxTokenAgeSeconds: z.number().int().min(60).max(86_400).default(3_600),
  })
  .strict()
  .superRefine((config, context) => {
    if ((config.jwksUrl === undefined) === (config.jwks === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "configure exactly one of jwksUrl or jwks",
      });
    }
    if (config.jwksUrl !== undefined && new URL(config.jwksUrl).protocol !== "https:") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["jwksUrl"],
        message: "remote JWKS discovery requires HTTPS",
      });
    }
  });

type AuthEntry = z.infer<typeof AuthEntrySchema> & { tokenHash: Buffer };
type JwtConfig = z.infer<typeof JwtConfigSchema>;

function tokenHash(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

/** Parse one and only one RFC 6750-style bearer credential. */
export function readBearerToken(
  authorization: string | undefined,
): string | null {
  if (authorization === undefined) return null;
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  return match?.[1] ?? null;
}

function parseJson(raw: string, variable: string): unknown {
  if (raw.length > 1_048_576) {
    throw new Error(`${variable} exceeds its 1 MiB configuration limit`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${variable} is not valid JSON`);
  }
}

function loadStaticEntries(env: NodeJS.ProcessEnv): AuthEntry[] {
  const configured = env.SYNCER_PROTOCOL_AUTH_JSON;
  let raw: unknown;
  if (configured !== undefined) {
    raw = parseJson(configured, "SYNCER_PROTOCOL_AUTH_JSON");
  } else {
    const token = env.SYNCER_PROTOCOL_BEARER_TOKEN;
    const subject = env.SYNCER_PROTOCOL_SUBJECT;
    const tenantId = env.SYNCER_PROTOCOL_TENANT_ID;
    const clientIds = env.SYNCER_PROTOCOL_CLIENT_IDS
      ?.split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    raw = [{ token, subject, tenantId, clientIds }];
  }

  const parsed = AuthConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      "protocol auth requires token, subject, tenantId, and one or more exact clientIds",
    );
  }
  const hashes = new Set<string>();
  const owners = new Map<string, string>();
  const entries: AuthEntry[] = [];
  for (const entry of parsed.data) {
    const hash = tokenHash(entry.token);
    const encoded = hash.toString("hex");
    if (hashes.has(encoded)) {
      throw new Error("protocol auth contains a duplicate bearer token");
    }
    hashes.add(encoded);
    for (const clientId of entry.clientIds) {
      const binding = `${entry.tenantId}\u0000${clientId}`;
      const existing = owners.get(binding);
      if (existing !== undefined && existing !== entry.subject) {
        throw new Error("a tenant/clientId cannot be assigned to multiple subjects");
      }
      owners.set(binding, entry.subject);
    }
    entries.push({ ...entry, tokenHash: hash });
  }
  return entries;
}

function claimAt(payload: JWTPayload, path: string): unknown {
  let current: unknown = payload;
  for (const part of path.split(".")) {
    if (
      current === null ||
      typeof current !== "object" ||
      !Object.prototype.hasOwnProperty.call(current, part)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function identityFromJwt(
  payload: JWTPayload,
  config: JwtConfig,
): ProtocolIdentity | null {
  const subject = ScopeId.safeParse(payload.sub);
  const role = ScopeId.safeParse(payload.role);
  const tenantId = ScopeId.safeParse(claimAt(payload, config.tenantClaim));
  if (
    !subject.success ||
    !role.success ||
    !config.roles.includes(role.data) ||
    !tenantId.success
  ) {
    return null;
  }

  let clientIds: ReadonlySet<string> | null = null;
  if (config.clientIdsClaim !== null) {
    const parsed = z
      .array(ClientId)
      .min(1)
      .max(100)
      .safeParse(claimAt(payload, config.clientIdsClaim));
    if (!parsed.success || new Set(parsed.data).size !== parsed.data.length) {
      return null;
    }
    clientIds = new Set(parsed.data);
  }
  return {
    subject: subject.data,
    tenantId: tenantId.data,
    clientIds,
  };
}

function createStaticAuthenticator(entries: AuthEntry[]): ProtocolAuthenticator {
  return {
    mode: "static",
    async authenticateAuthorization(authorization) {
      const token = readBearerToken(authorization);
      if (token === null) return { status: "denied" };
      const actual = tokenHash(token);
      const entry = entries.find((candidate) =>
        timingSafeEqual(actual, candidate.tokenHash),
      );
      return entry === undefined
        ? { status: "denied" }
        : {
            status: "authenticated",
            identity: {
              subject: entry.subject,
              tenantId: entry.tenantId,
              clientIds: new Set(entry.clientIds),
            },
          };
    },
  };
}

function createJwtAuthenticator(config: JwtConfig): ProtocolAuthenticator {
  const key =
    config.jwks !== undefined
      ? createLocalJWKSet(config.jwks as JSONWebKeySet)
      : createRemoteJWKSet(new URL(config.jwksUrl!), {
          timeoutDuration: 5_000,
          cooldownDuration: 30_000,
          cacheMaxAge: 10 * 60_000,
        });
  return {
    mode: "jwt",
    async authenticateAuthorization(authorization) {
      const token = readBearerToken(authorization);
      if (token === null) return { status: "denied" };
      try {
        const verified = await jwtVerify(token, key, {
          issuer: config.issuer,
          audience: config.audience,
          algorithms: config.algorithms,
          clockTolerance: config.clockToleranceSeconds,
          maxTokenAge: config.maxTokenAgeSeconds,
          requiredClaims: ["sub", "exp", "iat", "role"],
        });
        const identity = identityFromJwt(verified.payload, config);
        return identity === null
          ? { status: "denied" }
          : { status: "authenticated", identity };
      } catch (error) {
        // A remote key service outage is operationally different from a bad
        // token. Everything else from jose is an authentication denial:
        // malformed token, wrong key/algorithm, expired/not-yet-valid claims,
        // issuer/audience mismatch, or an unknown kid.
        if (
          error instanceof errors.JWKSTimeout ||
          error instanceof errors.JWKSInvalid ||
          !(error instanceof errors.JOSEError)
        ) {
          return { status: "unavailable" };
        }
        return { status: "denied" };
      }
    },
  };
}

/**
 * Load exactly one production authentication mode.
 *
 * Static credentials remain useful for isolated deployments and deterministic
 * tests. JWT mode verifies asymmetric Supabase access tokens locally. If both
 * are configured, startup fails instead of selecting a surprising fallback.
 */
export function createProtocolAuthenticator(
  env: NodeJS.ProcessEnv = process.env,
): ProtocolAuthenticator {
  const jwtRaw = env.SYNCER_PROTOCOL_JWT_JSON;
  const staticConfigured =
    env.SYNCER_PROTOCOL_AUTH_JSON !== undefined ||
    env.SYNCER_PROTOCOL_BEARER_TOKEN !== undefined ||
    env.SYNCER_PROTOCOL_SUBJECT !== undefined ||
    env.SYNCER_PROTOCOL_TENANT_ID !== undefined ||
    env.SYNCER_PROTOCOL_CLIENT_IDS !== undefined;

  if (jwtRaw !== undefined && staticConfigured) {
    throw new Error(
      "configure either SYNCER_PROTOCOL_JWT_JSON or static protocol auth, not both",
    );
  }
  if (jwtRaw !== undefined) {
    const parsed = JwtConfigSchema.safeParse(
      parseJson(jwtRaw, "SYNCER_PROTOCOL_JWT_JSON"),
    );
    if (!parsed.success) {
      throw new Error(
        `SYNCER_PROTOCOL_JWT_JSON is invalid: ${parsed.error.issues
          .map((issue) => issue.message)
          .join("; ")}`,
      );
    }
    return createJwtAuthenticator(parsed.data);
  }
  if (!staticConfigured) {
    throw new Error("protocol authentication is not configured");
  }
  return createStaticAuthenticator(loadStaticEntries(env));
}
