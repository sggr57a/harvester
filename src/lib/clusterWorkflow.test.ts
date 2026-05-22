import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../types';
import {
  buildApplyTestRun,
  buildCsiTemplatePreview,
  buildLivePreview,
  buildNexusClusterOperationBundle,
  buildVClusterPlan,
  validateKubernetesManifest,
} from './clusterWorkflow';

const manifest = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: demo-app
  namespace: default
spec:
  selector:
    matchLabels:
      app: demo-app
  template:
    metadata:
      labels:
        app: demo-app
    spec:
      containers:
        - name: demo-app
          image: nginx
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: demo-app-pvc
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 5Gi
`;

describe('cluster workflow helpers', () => {
  it('validates Kubernetes manifests and returns a live resource preview', () => {
    const validation = validateKubernetesManifest(manifest);
    const preview = buildLivePreview(manifest);

    expect(validation.valid).toBe(true);
    expect(validation.resources).toHaveLength(2);
    expect(preview.resourceCount).toBe(2);
    expect(preview.resources.map((resource) => resource.kind)).toEqual(['Deployment', 'PersistentVolumeClaim']);
  });

  it('builds a kubectl dry-run/apply test run with commands and successful checks', () => {
    const run = buildApplyTestRun(manifest, defaultConfig);

    expect(run.status).toBe('passed');
    expect(run.commands[0]).toContain('kubectl apply --dry-run=server');
    expect(run.checks.every((check) => check.passed)).toBe(true);
  });

  it('rejects structurally invalid Kubernetes workload specs before live preview', () => {
    const validation = validateKubernetesManifest(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: broken
spec: {}
`);

    expect(validation.valid).toBe(false);
    expect(validation.issues.map((issue) => issue.message)).toContain('Deployment requires spec.selector and spec.template for server-side dry-run.');
  });

  it('builds vcluster and CSI driver previews from application configuration', () => {
    const config = {
      ...defaultConfig,
      storage: { ...defaultConfig.storage, storageType: 'ceph' as const },
      multiCluster: {
        enableMultiCluster: true,
        clusters: [{ name: 'edge-a' }, { name: 'edge-b' }],
        federationType: 'kubefed' as const,
        serviceDiscovery: true,
      },
    };

    const vclusterPlan = buildVClusterPlan(config);
    const csiPreview = buildCsiTemplatePreview(config.storage);

    expect(vclusterPlan.virtualClusters.map((cluster) => cluster.name)).toEqual(['edge-a', 'edge-b']);
    expect(vclusterPlan.commands[0]).toContain('vcluster create edge-a');
    expect(csiPreview.driverName).toContain('rook-ceph');
    expect(csiPreview.templates.some((template) => template.kind === 'StorageClass')).toBe(true);
  });

  it('builds a live-adapter operation bundle for the completed README next steps', () => {
    const bundle = buildNexusClusterOperationBundle(manifest, {
      ...defaultConfig,
      namespace: 'apps',
      multiCluster: {
        enableMultiCluster: true,
        clusters: [{ name: 'edge-a' }],
        serviceDiscovery: true,
      },
    });

    expect(bundle.mode).toBe('live-adapter');
    expect(bundle.harvesterSourceRoot).toBe('platform/harvester');
    expect(bundle.apiEndpoints).toEqual([
      '/api/nexus/kubernetes/validate',
      '/api/nexus/kubectl/apply',
      '/api/nexus/vclusters',
      '/api/nexus/storage/csi',
    ]);
    expect(bundle.kubectlCommands).toContain('kubectl auth can-i create deployments -n apps');
    expect(bundle.vclusterCommands[0]).toContain('vcluster create edge-a --namespace edge-a-vcluster');
    expect(bundle.csiSourceFiles).toContain('platform/harvester/deploy/charts/harvester/templates/harvester-storageclass.yaml');
    expect(bundle.validation.valid).toBe(true);
  });

  it('uses workload-specific completion probes for Job and CronJob apply runs', () => {
    const jobBundle = buildNexusClusterOperationBundle(manifest, {
      ...defaultConfig,
      workloadType: 'Job',
      appName: 'batch-demo',
    });
    const cronJobBundle = buildNexusClusterOperationBundle(manifest, {
      ...defaultConfig,
      workloadType: 'CronJob',
      appName: 'nightly-demo',
    });

    expect(jobBundle.kubectlCommands).toContain('kubectl wait --for=condition=complete job/batch-demo -n default --timeout=180s');
    expect(cronJobBundle.kubectlCommands).toContain('kubectl get cronjob/nightly-demo -n default -o yaml');
    expect(cronJobBundle.kubectlCommands.some((command) => command.includes('rollout status cronjob'))).toBe(false);
  });
});
