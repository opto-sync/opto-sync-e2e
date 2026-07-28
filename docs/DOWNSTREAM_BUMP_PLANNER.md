# Downstream opto-sync bump planner

The downstream updater is intentionally split into two trust layers:

1. this credential-free planner, safe on pull requests; and
2. a future protected dispatcher that may create branches and pull requests only
   after the coordinated release set is published.

The planner never calls GitHub or Linear mutation APIs.

## Reviewed consumers

`operations/downstream-consumers.v1.json` declares each repository, its `main`
base, direct `syncer.c` and `opto-sync-clients` gitlink paths, expected-SHA files,
required checks, matching Linear project, and `autoMerge: false`.

The initial inventory is:

- `sonus-auris/sonus-auris-sync`;
- `voxletra/voxletra-sync`.

Adding a consumer requires a reviewed manifest change. Duplicate repositories,
one-sided or identical gitlinks, unsafe paths, empty checks, non-`main` bases, and
auto-merge are rejected.

## Release input and blockers

The input is `release/opto-sync-release-set.candidate.json`. The planner validates:

- exact 40-hex core, client, and E2E commits;
- embedded and pinned core/client parity;
- successful certification runs against the package SHAs;
- non-placeholder artifact checksums;
- approved rollback ownership and procedure; and
- release status `published`.

A candidate or approved-but-unpublished release still produces a complete review
plan. `dispatchAllowed` remains false and the output enumerates every blocker.
This exposes the exact future downstream change without granting write authority.

## Deterministic plan

Every consumer entry contains:

- a feature branch derived from the immutable release-set ID;
- two mode-160000 gitlink updates, always core and clients together;
- expected-SHA replacements for CI files;
- required checks and Linear routing;
- a complete PR title/body;
- `draft: false` and `autoMerge: false`.

Rollback is the paired revert of the downstream PR. A dispatcher must never
advance or revert only one gitlink.

## Commands

```sh
python3 scripts/plan-downstream-bumps.py validate
python3 scripts/plan-downstream-bumps.py plan \
  --out /tmp/opto-sync-downstream-plan.json
python3 -m unittest test.operations.test_downstream_bump_plan -v
```

`.github/workflows/downstream-bump-plan.yml` uploads the current plan for review.
It has read-only contents permission and no registry, GitHub-write, or Linear
credential.

## Dispatcher boundary

The future DEN-313 dispatcher must consume this exact plan, re-read each
consumer's current `main`, refuse stale evidence, create a feature branch from
that commit, apply both gitlinks plus expected-SHA assertions, run the declared
checks, and open a reviewable PR. It must never auto-merge and must update the
matching Linear project without duplicate issues.

The mutation layer remains blocked by DEN-309. Merging the planner does not
permit or imply downstream writes.
