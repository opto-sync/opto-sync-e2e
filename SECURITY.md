# Security policy

## Supported versions

Security fixes are made on `main`. Use the newest reviewed tag and current
container definitions when reproducing a report.

## Reporting a vulnerability

Use GitHub's private **Report a vulnerability** / Security Advisory flow. Do not
open a public issue containing credentials, signed tokens, private endpoints,
customer records, production dumps, exploit steps, or CI logs that expose
secrets.

Include:

- the affected commit, workflow, server profile, and client/runtime;
- the smallest safe reproduction and whether it also reproduces outside tests;
- which trust boundary failed (tenant, subject/client, JWT, database, transport,
  local queue, package artifact, or CI runner);
- whether the issue requires test-only configuration or affects production-safe
  defaults; and
- sanitized logs plus a mitigation that does not weaken the adversarial suites.

Report these privately even when they appear to be test defects:

- cross-tenant, cross-client, or cross-subject reads/writes;
- JWT/JWKS validation bypass, confused-deputy behavior, or authorization drift
  between server implementations;
- replay/idempotency/checkpoint failures that duplicate or lose protected data;
- recovery/backup tests that expose or restore data into the wrong scope;
- secrets, `.env`, credentials, dumps, or signed tokens entering package or
  workflow artifacts;
- malicious fixture or service output escaping the expected container/network
  boundary; and
- CI dependency or checkout substitution that causes tests to validate code
  other than the pinned revisions.

The repository's example credentials and local `.env.example` values are for
isolated tests only. A report must never include live production secrets merely
to demonstrate that the harness would accept them.

## Coordinated disclosure

Maintainers will acknowledge a usable private report, reproduce it against the
supported branch, identify affected engine/client/server repositories, and
coordinate fixes and disclosure. Please withhold public technical details until
a patched release or agreed disclosure date exists.
