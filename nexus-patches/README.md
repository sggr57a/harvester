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
git am 000*.patch

npm install
npx tsc --noEmit     # clean
npm run test         # 359 passing (was 346 after 0007–0009; 291 on unpatched main)
npm run build        # succeeds
```

Verified end to end in a fresh clone of `harvester-nexus` at `main` (`1b865a8a`):
all nine patches apply cleanly with `git am`, `tsc --noEmit` is clean, 346 tests
pass, and the production build succeeds. Patch **0010** is additional work on
top of 0001–0009: `tsc --noEmit` clean, **359** tests, `npm run build` succeeds.
On this Cloud Agent node, `memory_tiering.py --discover-only` saw DRAM node 0,
`memory_tier4`, zswap/DAMON/weighted-interleave/demotion sysfs present, and
correctly waited for CXL/PMem/NVMe.

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

### 0005 — `feat(storage)`: implement AnyRAID on LVM, remove the phantom CSI driver

`installer/manifests/30-anyraid-csi.yaml` declared a CSIDriver plus a DaemonSet
running `ghcr.io/sggr57a/nexus-anyraid-csi:1.0.0`. **That image is never built** —
no source and no build recipe for it exists anywhere in the repo, and the only
Dockerfile is the ISO builder. On a real install the DaemonSet went to
`ImagePullBackOff` and every PVC on the `anyraid-default` StorageClass stayed
`Pending` forever, so AnyRAID was advertised but non-functional.

Implemented over LVM rather than as a new block layer, because LVM already
provides the primitive AnyRAID describes: a volume group pools physical volumes
of differing sizes and allocates in fixed-size *extents* (the "slabs"), and its
RAID targets sit on dm-raid — the same kernel code mdadm drives. Profiles map as
`mirror→raid1`, `striped-mirror→raid10`, `raidz1→raid5`, `raidz2→raid6`.

`raidz3` is **rejected rather than silently downgraded**: dm-raid has no
triple-parity target, and quietly delivering two-drive tolerance for a
three-parity request would misrepresent the redundancy an operator selected.

`plan_pool` reports stranded capacity per drive, because equal-leg layouts are
bounded by the smallest member and a raw-sum total would over-promise. Device
paths are validated against a strict pattern and every call uses argument lists,
so wizard input cannot smuggle flags or escape `/dev`. Pool health is served from
`GET /api/v1/storage/anyraid` by the cockpit, which already runs on the host,
instead of by a privileged `hostPID` DaemonSet.

Verified on real heterogeneous loop devices (640M / 640M / 1.12G / 1.94G):
`pvcreate` and `vgcreate` created a genuine 4-PV volume group, confirmed with
`pvs`/`vgs`. **`lvcreate` is unverified here** — this container kernel exposes no
device-mapper target at all (`dmsetup targets` fails), so the RAID LV creation
path needs a node with dm-raid. Planning, validation, and capacity accounting are
covered by 16 tests.

### 0006 — `docs`: correct stale AGENTS.md claims

`AGENTS.md` stated "There is no backend — all data is mock/computed locally",
which is wrong and actively misleading for anyone working on the repo. It also
listed three themes that no longer exist, claimed 41 tests, and documented the
wrong credentials.

### 0007 — `feat(xdr)`: ingest Falco / Tetragon / Suricata / Wazuh alerts

The cockpit counted sensor pods but only ingested Kubernetes `Warning` events,
every one hardcoded to `sensorSeverity: 'medium'`. Adds `xdr_ingest.py` which
parses Falco JSON, Tetragon `process_exec`/`process_kprobe`, Suricata `eve`
alerts, and Wazuh `alerts.json`, keeping the severity the sensor assigned
(Falco priority, Suricata 1–3, Wazuh rule level). Kubernetes warnings still
appear, but severity is derived from the reason (`OOMKilling` → high,
`BackOff` → medium, `Pulling` → low).

Verified against a live k3s cluster with four log-emitting sensor pods: the
collector returned Falco `critical`, Suricata `high`, Tetragon `medium`, and
Wazuh `info` in one poll — four distinct severities, not a wall of medium.

### 0008 — `feat(telemetry)`: Oscilloscope / FftBars plot measured series

`Oscilloscope` and `FftBars` generated `Math.sin` + `Math.random()` traces and
labelled them CH1/CH2/CH3 even in live mode. They now follow the snapshot's
CPU, DRAM, and NIC RX series (or render `—` when a metric is in
`unavailableMetrics`). The FFT is a deterministic DFT of those same samples.
Live Mission Control mounts both widgets so the CH1/CH2/CH3 readouts are
real measurements.

### 0009 — `feat(console)`: KubeVirt VNC/serial websocket proxy

Live consoles stopped at `src/lib/demoConsole.ts`. The cockpit now upgrades
`/api/v1/console/{vnc,serial,exec}` (session-authenticated) and proxies to the
KubeVirt subresource API (`…/virtualmachineinstances/{name}/vnc` or
`/console`) or `kubectl exec` for pods. Names are DNS-1123-validated so a
console URL cannot smuggle flags. The SPA uses noVNC for graphical attach and
xterm.js on the same websocket for serial/exec. Demo mode is unchanged.

### 0010 — `feat(memory)`: Linux CXL / PMem / zswap / NVMe tiering

The wizard already wrote `nexus.memory_tiering` and
`nexus.features.memory_tiering=nvme|phase-change`, but the installer never
consumed those flags. This patch implements the Linux model (not vSphere
NVMe-as-RAM):

- **CXL Type-3 / memory-only NUMA** — enable `demotion_enabled` and
  `kernel.numa_balancing=2` (capacity policy) when a slower node exists.
- **Phase-change / Optane PMem** — bind leftover DAX devices to `dax/kmem`.
- **HBM** — advertised when the kernel places a CPU-less node in a faster
  memory tier; otherwise listed under `waitingForHardware`.
- **zswap + bounded swap file** — last safety net. Never wipes an NVMe
  namespace. Dedicated unused NVMe is recorded for operators who want a
  partition.
- **DAMON, weighted interleave, pghot, CXL pooling, guest CXL/NVDIMM** —
  probed; applied when sysfs appears, otherwise waiting.

Live Processor & Memory no longer hides behind the demo catalog. It plots
meminfo, vmstat demote/promote/swap/zswap, PSI, hugepages, and tier
nodelists, using `null` for counters the kernel does not export.

See `docs/memory-tiering.md` in harvester-nexus after applying the patch.

## Still outstanding

Not addressed by these patches:

- **KubeVirt itself is not installed in the verification VM**, so the VNC/
  serial proxy is covered by handshake, path, and frame-roundtrip tests plus
  a live `kubectl exec` path. End-to-end RFB against a running VMI needs a
  node with `/dev/kvm` and the KubeVirt operator.
- **`lvcreate` for AnyRAID** is still unverified on kernels without
  device-mapper (see 0005).

## Reproducing the live-cluster verification

A real cluster runs in the Cloud Agent VM with:

```bash
curl -sfL https://get.k3s.io | sh -
k3s server --snapshotter=native --flannel-backend=host-gw
```

Both flags are required: the sandbox has no systemd, an overlayfs snapshotter
that containerd cannot use, and no vxlan support.
