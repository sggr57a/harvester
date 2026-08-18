# Harvester-Nexus production-hardening patches

These patches target **`sggr57a/harvester-nexus`**, not this repository.

They are staged here only because the Cloud Agent that produced them was
launched against `sggr57a/harvester` and its GitHub token is scoped to this
repo, so it could not push a branch to `harvester-nexus`. The two repositories
have unrelated git histories and `harvester-nexus` is not a fork, so they are in
separate fork networks and a cross-repo pull request is not possible either.

## Applying them

```bash
git clone https://github.com/sggr57a/harvester-nexus.git
cd harvester-nexus
git checkout -b cursor/nexus-production-hardening main

# Copy the patch files from this repo, then:
git am 0001-*.patch 0002-*.patch 0003-*.patch 0004-*.patch

npm install
npx tsc --noEmit     # clean
npm run test         # 312 passing
npm run build        # succeeds
```

Verified to apply cleanly with `git am` against `harvester-nexus` `main` at
commit `1b865a8a`.

## What each patch does

### 0001 — `fix(security)`: require authentication on all cockpit API routes

The most serious issue found. The cockpit BFF (`serve-cockpit.py`) served every
`/api/v1` route with **no authentication at all** while binding `0.0.0.0` on
ports 8080/8443. `POST /api/v1/resources/apply` pipes its request body into
`kubectl apply` using the node kubeconfig, which runs as `system:admin` in group
`system:masters`. Any host able to reach a Nexus node could therefore apply
arbitrary manifests and take over the cluster. This was confirmed by
exploitation against a live cluster, not inferred: an unauthenticated POST
returned `{"success": true, "output": "configmap/pwned created"}`, and a
server-side dry run accepted a `cluster-admin` ClusterRoleBinding.

Adds `cockpit_auth.py` (PBKDF2-HMAC-SHA256 at 600k iterations, in-memory bearer
sessions with TTL, per-user lockout), gates every route except `auth/login` and
`auth/session`, and refuses to start if the credential store cannot initialise.
Replaces the shipped `admin`/`admin` default with a randomly generated password
flagged for rotation. Redirects the plaintext port to HTTPS when certificates
exist so session tokens cannot travel in the clear.

After the patch, the same unauthenticated calls return `401` and create nothing;
authenticated calls still work.

### 0002 — `fix(ci)`: repair the ISO build pipeline

`Build install ISO` had failed on every recent run on `main`, so no ISO was
being published — which matters because the ISO is the only place the production
code path actually runs. Three independent faults:

- `df -h / /var/lib/docker "${BUILD_ROOT}"` exited 1 because `/var/lib/docker`
  is mode `0710 root:root`. The step runs under `bash -e`, so a diagnostic line
  aborted the job before any build work. Reproduced locally.
- `root-reserve-mb: 512` left `/` at 100% (145G/145G) before the build started,
  with no room for the ~600 MB checkout, `npm install`, or Go caches.
- The `build/` and `dist/` symlinks were created *before* `actions/checkout`,
  which cleans the workspace by default and deleted them.

### 0003 — `feat(telemetry)`: real host metrics, or `null`, never fabricated

Live mode presented several invented figures as measurements:

| Metric | Before | After |
|---|---|---|
| `watts` | `node_count * 220` | Intel RAPL or IPMI DCMI, else `null` |
| `trustScore` | hardcoded `85`, never written | derived from Trivy reports, else `null` |
| `totalIops` | state key only the dashboards endpoint wrote, so `0` | `/proc/diskstats` deltas |
| `ingressMbps` / `egressMbps` | same dead state key | `/proc/net/dev` deltas |
| `cpuPercent` / `ramPercent` | `0.0` when metrics-server absent | `null` with a stated reason |
| `clusterReady` | matched `rke2-server` pod names, so always false on K3s | node `Ready` conditions |

Adds `host_metrics.py` reading real kernel counters, excluding virtual devices
and differencing rates across samples. Adds a `metricSources` map so the UI can
label partial coverage. Also guards `_save_state`, which raised
`PermissionError` and `503`'d the entire endpoint when `/var/lib/nexus` was not
writable.

Verified against a live k3s cluster: `cpuPercent` 5.5 and `ramPercent` 17.5
matched `kubectl top nodes` (5% / 17%); `totalIops` tracked a 400 MB write at
8074 IOPS; `watts` correctly stayed `null` on a VM with no RAPL or BMC.

### 0004 — `test`: cover nullable metrics and cockpit auth invariants

Encodes the null-vs-zero distinction in the type system (`MaybeMetric`,
`snapshot.unavailableMetrics`) so a coerced `0` can never be mistaken for a
measurement, and suppresses deltas when a metric is unavailable on either tick.
Adds 21 tests (291 → 312), including a case asserting that a *measured* zero and
an *unmeasurable* metric stay distinguishable, and contract tests asserting no
hardcoded default password and no plaintext at rest.

## Still outstanding

Not addressed by these patches:

- **AnyRAID does not exist.** There is no source and no build recipe anywhere in
  the repo, yet `installer/manifests/30-anyraid-csi.yaml` deploys a DaemonSet
  pulling `ghcr.io/sggr57a/nexus-anyraid-csi:1.0.0`. On a real install that is a
  guaranteed `ImagePullBackOff`, and any PVC on the `anyraid-default`
  StorageClass hangs `Pending` forever. Recommendation: implement it over LVM,
  whose extents already provide slab allocation across heterogeneous drives with
  RAID levels, rather than writing a new CSI driver from scratch.
- **XDR ingests only Kubernetes events.** `_xdr_sensor_health` counts running
  pods; the deployed Falco / Tetragon / Suricata / Wazuh alert streams are never
  collected, and every ingested event is hardcoded to `sensorSeverity: 'medium'`.
- **Decorative widgets still synthesise data in live mode.** `Oscilloscope` and
  `FftBars` in `src/components/dashboards/Widgets.tsx` generate waveforms from
  `Math.sin` plus `Math.random()` and render "CH1/CH2/CH3" numeric readouts.
- **Consoles are demo-only** (`src/lib/demoConsole.ts`); no real VNC/serial
  attach via KubeVirt.
- **`AGENTS.md` is stale**: it claims "no backend — all data is mock", lists
  three themes that no longer exist, says 41 tests, and documents the wrong
  password.

## Reproducing the live-cluster verification

A real cluster runs in the Cloud Agent VM with:

```bash
curl -sfL https://get.k3s.io | sh -
k3s server --snapshotter=native --flannel-backend=host-gw
```

Both flags are required: the sandbox has no systemd, an overlayfs snapshotter
that containerd cannot use, and no vxlan support.
