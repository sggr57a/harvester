# Nexus

A Nexus-branded Harvester-derived system with imported Harvester platform source, a React + TypeScript cyberpunk/HUD interface, wizard-driven machine provisioning, Kubernetes manifest generation, storage backend provisioning, and multi-cluster deployment workflows.

## Nexus release overview

Nexus is the updated Harvester fork with:

- Extended storage backend support: iSCSI, GlusterFS, Longhorn, OpenEBS, Portworx, NVMe-oF, RDMA, Ceph, ZFS, NFS, SMB, and local storage.
- Networking and service mesh support: Istio, Linkerd, Cilium, Service, Ingress, and NetworkPolicy.
- Security and compliance scaffolding: RBAC, Pod Security Standards, service accounts, and workload annotations.
- Observability tooling templates: Prometheus monitoring, Fluentd/Loki/Splunk logging.
- GitOps support: ArgoCD, Flux, Jenkins X integration manifests.
- Multi-cluster provisioning: federated deployment templates and cluster targeting.

## What is included

- In-tree Harvester platform source under `platform/harvester` so Nexus is tracked as a standalone system instead of a UI-only add-on.
- Nexus new-machine wizard for Harvester create/join/binaries install flows with generated automatic install configuration.
- Wizard-driven workload and manifest configuration.
- Storage selection for local, NFS, SMB, Ceph, NVMe-oF, RDMA, ZFS, iSCSI, GlusterFS, Longhorn, OpenEBS, and Portworx.
- Auto-generated `Deployment`, `StatefulSet`, `DaemonSet`, `Job`, and `CronJob` manifests.
- PVC, Service, Ingress, NetworkPolicy, RBAC, monitoring, logging, GitOps, and multi-cluster manifest generation.
- Service mesh integration support for Istio, Linkerd, and Cilium.
- CodeMirror YAML editor preview with dark mode styling.
- Live-adapter operation planning for Kubernetes API validation, `kubectl` apply/test runs, `vcluster` workflows, and CSI templates sourced from the imported Harvester tree.

## Quick start

1. Install dependencies: `npm install`
2. Run the dev server: `npm run dev`
3. Open the browser at `http://localhost:4173`

## Verified build

- Production build passes with `npm run build`.
- The generated bundle is ready for local demo and review.

## Demo installation

This prototype is intended as a front-end Nexus demo for Harvester-style workload generation. After launching the app locally, use the wizard to select storage, networking, security, monitoring, GitOps, and multi-cluster options, then review generated manifests in the built-in YAML editor.

### Run locally

1. Clone or navigate to the project folder.
2. Install dependencies: `npm install`
3. Start the app: `npm run dev`
4. Open the browser at `http://localhost:4173`

### GitHub branch and pull request

The updated Nexus version is available on the `nexus` branch in the forked repository:

- `https://github.com/sggr57a/harvester/tree/nexus`
- Pull request: `https://github.com/sggr57a/harvester/pull/1`

### Run locally

1. Clone or navigate to the project folder.
2. Install dependencies: `npm install`
3. Start the app: `npm run dev`
4. Open the browser at `http://localhost:4173`

### GitHub branch and pull request

The updated Nexus version is available on the `nexus` branch in the forked repository:

- `https://github.com/sggr57a/harvester/tree/nexus`

A pull request can be created from this branch to merge Nexus back into the main repository.

## Completed next steps

- Kubernetes validation and live preview now combine local structural prechecks with Nexus live-adapter endpoints and server-side dry-run command generation.
- Manifest apply / test runner commands are generated for `kubectl auth can-i`, server-side dry-run, diff, apply, and rollout status.
- Virtual cluster support generates `vcluster` create/connect operations from multi-cluster targets.
- Editor enhancements are implemented with CodeMirror YAML editing.
- Storage backend templates include CSI StorageClass, VolumeSnapshotClass, PVC manifests, and Harvester source references under `platform/harvester/deploy/charts/harvester`.
