#!/usr/bin/env bash
# Run the opto-sync browser suite inside a REAL remote browser, driven by the
# `dd-selenium-server` Selenium grid already deployed in a Kubernetes cluster.
#
#   ./run.sh aws        # direct kubectl, context dd-ec2-runtime (AWS single node)
#   ./run.sh hetzner    # kubectl on the fsn1 control-plane over SSH
#
# Why a Job in the cluster instead of driving the grid from a laptop: the page
# needs an HTTP origin the browser can reach. IndexedDB is unavailable on the
# opaque origins of file:/data: URLs, and a laptop's localhost is not routable
# from a pod. So the Job serves the page on its own pod IP.
#
# Why the grid's :4444 and not the Java API on :8105: that API sets
# SELENIUM_ALLOW_EVALUATE=false by design, and collecting results out of the
# page requires in-page script execution.
#
# Creates exactly two objects (a ConfigMap and a Job) in `default`, both named
# opto-sync-remote-browser*, and deletes them on exit.
set -euo pipefail

TARGET="${1:-aws}"
HERE="$(cd "$(dirname "$0")" && pwd)"
CLIENT_TS="$HERE/../../../opto-sync-clients/clients/ts"
NAME=opto-sync-remote-browser
NS=default
KEEP="${KEEP:-0}"
BUILD="${BUILD:-1}"

log() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

# ---------------------------------------------------------------------------
# Cluster access. AWS is reachable directly; the Hetzner API server is not
# exposed to us, so kubectl runs on the control-plane node over SSH.
# ---------------------------------------------------------------------------
case "$TARGET" in
  aws)
    export AWS_PROFILE="${AWS_PROFILE:-dd-codex}"
    kube() { kubectl --context dd-ec2-runtime -n "$NS" "$@"; }
    # stdin-consuming variant
    kube_apply() { kubectl --context dd-ec2-runtime -n "$NS" apply -f -; }
    kube_create() { kubectl --context dd-ec2-runtime -n "$NS" create -f -; }
    ;;
  hetzner)
    SSH_HOST="${SSH_HOST:-hetzner-k8s-bastion}"
    # Each argument is shell-quoted before it crosses SSH: jsonpath contains
    # parentheses, quotes and braces that the remote shell would otherwise try
    # to interpret.
    kube() {
      local quoted=() a
      for a in "$@"; do quoted+=("$(printf '%q' "$a")"); done
      ssh -o BatchMode=yes "$SSH_HOST" "sudo -n kubectl -n $NS ${quoted[*]}"
    }
    kube_apply() { ssh -o BatchMode=yes "$SSH_HOST" "sudo -n kubectl -n $NS apply -f -"; }
    kube_create() { ssh -o BatchMode=yes "$SSH_HOST" "sudo -n kubectl -n $NS create -f -"; }
    ;;
  *)
    echo "usage: $0 [aws|hetzner]" >&2
    exit 2
    ;;
esac

# ---------------------------------------------------------------------------
# Build the browser bundle. This is the real @opto-sync/client browser entry,
# so the remote browser exercises the shipped product, not a stub.
# ---------------------------------------------------------------------------
BUNDLE="$HERE/page/opto-sync-browser.mjs"
if [ "$BUILD" = "1" ]; then
  log "building browser bundle"
  ( cd "$CLIENT_TS" && ./node_modules/.bin/esbuild src/browser.ts \
      --bundle --format=esm --platform=browser --minify \
      --outfile="$BUNDLE" )
fi
[ -f "$BUNDLE" ] || { echo "missing $BUNDLE (run with BUILD=1)" >&2; exit 1; }
# Pre-gzip: `kubectl apply` embeds the whole object in a 256KiB-capped
# annotation, and a 340KB bundle blows through it. Gzipped it is ~100KB, which
# also keeps the ConfigMap small on a single-node cluster's etcd. The runner
# serves it with Content-Encoding: gzip.
gzip -9 -c "$BUNDLE" > "$BUNDLE.gz"
echo "bundle: $(wc -c <"$BUNDLE") bytes raw, $(wc -c <"$BUNDLE.gz") bytes gzipped"

# ---------------------------------------------------------------------------
# Find a grid pod whose `selenium` container is actually ready. On Hetzner the
# `selenium-api` sidecar crashloops (it expects a repo volume that only exists
# on the AWS node), so pods report 1/2 — the grid itself is still healthy, and
# it is all this suite needs.
# ---------------------------------------------------------------------------
log "locating a ready selenium grid pod ($TARGET)"
GRID_IP="$(kube get pods -l app=dd-selenium-server \
  -o 'jsonpath={range .items[*]}{.status.podIP}{" "}{range .status.containerStatuses[?(@.name=="selenium")]}{.ready}{end}{"\n"}{end}' \
  | awk '$2=="true" {print $1; exit}')"
[ -n "$GRID_IP" ] || { echo "no pod with a ready selenium container found" >&2; exit 1; }
echo "grid pod IP: $GRID_IP"

# ---------------------------------------------------------------------------
# Ship the page + runner as a ConfigMap, then run the Job.
# ---------------------------------------------------------------------------
log "creating ConfigMap $NAME"
kube delete configmap "$NAME" --ignore-not-found >/dev/null 2>&1 || true
# --dry-run + apply keeps this declarative and avoids a 1MiB-limit surprise on
# a stale object.
# `create -f -`, not `apply`: apply would record the entire object (bundle
# included) in the kubectl.kubernetes.io/last-applied-configuration annotation,
# which is capped at 256KiB.
kubectl create configmap "$NAME" \
  --from-file="$HERE/page/index.html" \
  --from-file="$HERE/page/suite.mjs" \
  --from-file="$BUNDLE.gz" \
  --from-file="$HERE/runner.mjs" \
  --dry-run=client -o yaml | kube_create

cleanup() {
  if [ "$KEEP" = "1" ]; then
    echo "KEEP=1, leaving $NAME objects in place"
    return
  fi
  log "cleaning up"
  kube delete job "$NAME" --ignore-not-found >/dev/null 2>&1 || true
  kube delete configmap "$NAME" --ignore-not-found >/dev/null 2>&1 || true
}
trap cleanup EXIT

log "running Job $NAME"
kube delete job "$NAME" --ignore-not-found >/dev/null 2>&1 || true

JOB_YAML=$(cat <<YAML
apiVersion: batch/v1
kind: Job
metadata:
  name: $NAME
  labels:
    app: $NAME
spec:
  backoffLimit: 0
  ttlSecondsAfterFinished: 600
  template:
    metadata:
      labels:
        app: $NAME
    spec:
      restartPolicy: Never
      automountServiceAccountToken: false
      containers:
        - name: runner
          image: node:22-alpine
          command: ['node', '/cfg/runner.mjs']
          env:
            - name: GRID_URL
              value: http://$GRID_IP:4444
            - name: PAGE_DIR
              value: /page
            - name: PORT
              value: '8080'
          ports:
            - containerPort: 8080
          volumeMounts:
            - name: cfg
              mountPath: /cfg
            - name: page
              mountPath: /page
          resources:
            requests:
              cpu: 25m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 512Mi
          securityContext:
            # Satisfies the cluster's `restricted` PodSecurity level so this
            # Job does not log a policy warning. Nothing here needs root: it
            # serves read-only files and binds a port above 1024.
            runAsNonRoot: true
            runAsUser: 1000
            allowPrivilegeEscalation: false
            capabilities:
              drop: ['ALL']
            seccompProfile:
              type: RuntimeDefault
      volumes:
        - name: cfg
          configMap:
            name: $NAME
        # The page directory intentionally excludes runner.mjs so the driver is
        # not itself downloadable by the browser under test.
        - name: page
          configMap:
            name: $NAME
            items:
              - key: index.html
                path: index.html
              - key: suite.mjs
                path: suite.mjs
              - key: opto-sync-browser.mjs.gz
                path: opto-sync-browser.mjs.gz
YAML
)
printf '%s\n' "$JOB_YAML" | kube_apply

log "waiting for completion (up to 5m)"
set +e
kube wait --for=condition=complete "job/$NAME" --timeout=300s >/dev/null 2>&1
COMPLETE=$?
set -e
if [ "$COMPLETE" -ne 0 ]; then
  kube wait --for=condition=failed "job/$NAME" --timeout=10s >/dev/null 2>&1 || true
fi

log "job logs ($TARGET)"
kube logs "job/$NAME" --tail=200 || true

STATUS="$(kube get job "$NAME" -o 'jsonpath={.status.succeeded}' 2>/dev/null || echo '')"
if [ "$STATUS" = "1" ]; then
  printf '\n\033[32mREMOTE BROWSER SUITE PASSED (%s)\033[0m\n' "$TARGET"
  exit 0
fi
printf '\n\033[31mREMOTE BROWSER SUITE FAILED (%s)\033[0m\n' "$TARGET"
exit 1
