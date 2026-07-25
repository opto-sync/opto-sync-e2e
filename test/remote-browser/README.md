# Remote browser e2e

Runs the `@opto-sync/client` browser bundle inside a **real browser on real
remote infrastructure**, driven by the `dd-selenium-server` Selenium grid
already deployed in the `ores/k8s-cluster` Kubernetes clusters.

```sh
./run.sh aws       # AWS single-node kubeadm cluster (us-east-1)
./run.sh hetzner   # Hetzner multi-node cluster (control-plane over SSH)
```

Both targets currently pass **15/15** against headless Chromium 131.

## What this proves that the local suites do not

`opto-sync-clients/clients/ts` already drives local headless Chromium. This
layer adds the things only remote infrastructure can show:

| | Local browser test | This suite |
|---|---|---|
| Browser build | whatever the dev machine downloaded | the grid's pinned `selenium/standalone-chromium` |
| Kernel / CPU | the developer's macOS arm64 | Linux x86_64 in someone else's cluster |
| Origin | `127.0.0.1` on the same host | a pod IP across the cluster network |
| Reproduces "works on my machine" bugs | no | yes |
| Cross-cloud agreement | no | AWS and Hetzner compared |

The suite asserts the WebAssembly engine initializes, that reconciliation
(stale-write rejection, keyed-array reconciliation, `createdAt` FWW, digit-string
nanosecond precision, idempotency) produces the same answers as Node, and that
**real IndexedDB** persists a queued mutation across close/reopen and across a
status transition — with `indexedDB.databases()` used to confirm the store
genuinely existed, which an in-memory shim cannot fake.

## Design constraints (why it is built this way)

**The test runs as a Job in the cluster, not from a laptop.** The page needs an
HTTP origin the browser can reach: IndexedDB is unavailable on the opaque
origins of `file:` and `data:` URLs, and a laptop's `localhost` is not routable
from a pod. `kubectl port-forward` tunnels the wrong direction. So the Job
serves the page on its own pod IP (`runner.mjs` discovers it) and points the
remote browser at that.

**It drives the grid's `:4444` directly, not the Java API on `:8105`.** That API
ships with `SELENIUM_ALLOW_EVALUATE=false` — arbitrary in-page script execution
is deliberately off in production manifests — and collecting results out of the
page requires exactly that. The grid's own WebDriver endpoint is not exposed
through the Service, so the Job dials the grid **pod IP**.

**Zero dependencies.** W3C WebDriver is plain HTTP+JSON, so `runner.mjs` uses
`fetch` and needs no npm install and no egress inside the cluster.

**The bundle is shipped gzipped.** `kubectl apply` records the whole object in a
256 KiB-capped annotation, and the bundle is ~332 KB; gzipped it is ~100 KB. The
runner serves it with `Content-Encoding: gzip` and the browser decompresses it
natively. The ConfigMap is created with `create` rather than `apply` so no
last-applied annotation is written at all.

## Footprint in the cluster

Exactly two objects, both named `opto-sync-remote-browser`, in `default`:

- a **ConfigMap** with the page, the suite, the gzipped bundle and the runner;
- a **Job** (`node:22-alpine`, 25m CPU / 128Mi requested, `ttlSecondsAfterFinished: 600`).

Both are deleted on exit; `KEEP=1` leaves them for debugging. The pod satisfies
the `restricted` PodSecurity level (`runAsNonRoot`, all capabilities dropped,
`RuntimeDefault` seccomp) so it logs no policy warning. Nothing existing is
modified — the grid Deployment is only read.

## Access

| Target | Path | Requirement |
|---|---|---|
| `aws` | direct `kubectl --context dd-ec2-runtime` | `AWS_PROFILE=dd-codex`; the API server security group must allow your IP |
| `hetzner` | `ssh hetzner-k8s-bastion` → `sudo kubectl` on the control-plane | `~/.ssh/id_hetzner`; the API server is not exposed publicly |

Per the cluster repo's access posture, AWS credentials come from
`~/.aws/credentials` (profile `dd-codex`, `us-east-1`). If the API endpoint is
unreachable from your IP, that repo documents an SSM Run Command fallback; this
script does not implement it.

## Known upstream issue (not caused by this suite)

On **Hetzner**, the `dd-selenium-server` pods report `1/2 Ready` and have
accumulated thousands of restarts over weeks. The `selenium-api` sidecar
crashloops with:

```
/bin/bash: line 2: cd: /opt/dd-next-1/remote/deployments/selenium-server: No such file or directory
```

It expects a repo volume that exists only on the AWS node. The **grid container
itself is healthy** (`ready=true`, 1 restart), which is why this suite works
there anyway — it selects a pod whose `selenium` container is ready and ignores
the sidecar. The crashloop predates this suite and is worth fixing in the
cluster repo, since it makes the authenticated `:8105` API unavailable on
Hetzner entirely.

## Files

| File | Role |
|---|---|
| `run.sh` | builds the bundle, finds a ready grid pod, creates the ConfigMap + Job, tails logs, cleans up |
| `runner.mjs` | in-cluster driver: static server + raw WebDriver client |
| `page/index.html` | loads the suite as an ES module |
| `page/suite.mjs` | the assertions that run inside the browser |
| `page/opto-sync-browser.mjs*` | build output (gitignored) |

## Not covered

Only Chromium — the grid image bundles no Firefox or WebKit node, so
cross-engine differences are out of scope here (the local suite covers a
worker context; neither covers Safari). The suite is client-side only: it does
not reach an opto-sync server, because the e2e servers are not deployed in these
clusters. Client-to-server flows are covered by `../clients/` against a local
stack.
