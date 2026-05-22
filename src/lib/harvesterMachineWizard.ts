import YAML from 'yaml';

export type HarvesterInstallMode = 'create' | 'join' | 'binaries';
export type HarvesterVipMode = 'static' | 'dhcp';

export interface HarvesterMachineConfig {
  installMode: HarvesterInstallMode;
  hostName: string;
  installDisk: string;
  dataDisk: string;
  managementInterface: string;
  vipMode: HarvesterVipMode;
  virtualIp: string;
  serverUrl?: string;
  clusterToken: string;
  dnsServers: string[];
  ntpServers: string[];
  proxyUrl?: string;
  sshKeysUrl?: string;
  customConfigUrl?: string;
}

export interface MachineWizardStep {
  id: 'mode' | 'hardware' | 'storage' | 'network' | 'cluster' | 'source' | 'review';
  title: string;
  detail: string;
  status: 'ready' | 'required' | 'optional';
}

export interface HarvesterMachineInstallPlan {
  productName: 'Nexus';
  sourceRoot: 'platform/harvester';
  steps: MachineWizardStep[];
  configYaml: string;
  bootParameters: string[];
  validationIssues: string[];
}

export function buildDefaultMachineConfig(): HarvesterMachineConfig {
  return {
    installMode: 'create',
    hostName: 'nexus-node-01',
    installDisk: '/dev/sda',
    dataDisk: '/dev/sdb',
    managementInterface: 'eth0',
    vipMode: 'static',
    virtualIp: '192.168.122.100',
    clusterToken: 'nexus-cluster-token',
    dnsServers: ['1.1.1.1'],
    ntpServers: ['0.suse.pool.ntp.org'],
  };
}

export function validateHarvesterMachineConfig(config: HarvesterMachineConfig): string[] {
  const issues: string[] = [];

  if (!config.hostName.trim()) {
    issues.push('Host name is required for Harvester node identity.');
  }
  if (!config.installDisk.trim()) {
    issues.push('Install disk is required so the appliance knows where to write Nexus.');
  }
  if (!config.managementInterface.trim()) {
    issues.push('Management interface is required for the Harvester management network.');
  }
  if (config.vipMode === 'static' && !config.virtualIp.trim()) {
    issues.push('Virtual IP is required when VIP mode is static.');
  }
  if (config.installMode !== 'binaries' && !config.clusterToken.trim()) {
    issues.push('Cluster token is required for create and join modes.');
  }
  if (config.installMode === 'join' && !config.serverUrl?.trim()) {
    issues.push('Server URL is required when joining an existing Nexus cluster.');
  }

  return issues;
}

function buildSteps(config: HarvesterMachineConfig, validationIssues: string[]): MachineWizardStep[] {
  const hasBlockingIssues = validationIssues.length > 0;

  return [
    {
      id: 'mode',
      title: 'Install mode',
      detail: config.installMode === 'create' ? 'Create a new Nexus HCI cluster' : config.installMode === 'join' ? 'Join an existing Nexus cluster' : 'Install platform binaries only',
      status: 'ready',
    },
    {
      id: 'hardware',
      title: 'Hardware profile',
      detail: `${config.hostName || 'unnamed node'} mapped to Harvester hardware checks`,
      status: config.hostName ? 'ready' : 'required',
    },
    {
      id: 'storage',
      title: 'Storage disks',
      detail: `${config.installDisk || 'install disk missing'} + ${config.dataDisk || 'shared data disk not set'}`,
      status: config.installDisk ? 'ready' : 'required',
    },
    {
      id: 'network',
      title: 'Management network',
      detail: `${config.managementInterface || 'interface missing'} / ${config.vipMode.toUpperCase()} VIP`,
      status: config.managementInterface && (config.vipMode === 'dhcp' || config.virtualIp) ? 'ready' : 'required',
    },
    {
      id: 'cluster',
      title: 'Cluster identity',
      detail: config.installMode === 'binaries' ? 'Token skipped for binary-only install' : 'Token staged for create/join flow',
      status: config.installMode === 'binaries' || config.clusterToken ? 'ready' : 'required',
    },
    {
      id: 'source',
      title: 'Harvester source',
      detail: 'Imported platform source is owned in platform/harvester',
      status: 'ready',
    },
    {
      id: 'review',
      title: 'Review and boot',
      detail: hasBlockingIssues ? `${validationIssues.length} required fields pending` : 'Automatic install config ready',
      status: hasBlockingIssues ? 'required' : 'ready',
    },
  ];
}

export function buildHarvesterMachineInstallPlan(config: HarvesterMachineConfig): HarvesterMachineInstallPlan {
  const validationIssues = validateHarvesterMachineConfig(config);
  const configDocument = {
    scheme_version: 1,
    token: config.clusterToken || undefined,
    server_url: config.installMode === 'join' ? config.serverUrl : undefined,
    os: {
      hostname: config.hostName,
      ssh_authorized_keys_url: config.sshKeysUrl || undefined,
      ntp_servers: config.ntpServers,
      dns_nameservers: config.dnsServers,
      http_proxy: config.proxyUrl || undefined,
    },
    install: {
      mode: config.installMode,
      device: config.installDisk,
      data_disk: config.dataDisk,
      management_interface: {
        interfaces: [{ name: config.managementInterface }],
      },
      vip_mode: config.vipMode,
      vip: config.vipMode === 'static' ? config.virtualIp : undefined,
      config_url: config.customConfigUrl || undefined,
    },
    nexus: {
      product: 'Nexus',
      harvester_source_root: 'platform/harvester',
      ui_profile: 'cyberpunk-hud',
    },
  };

  return {
    productName: 'Nexus',
    sourceRoot: 'platform/harvester',
    steps: buildSteps(config, validationIssues),
    configYaml: YAML.stringify(configDocument),
    bootParameters: [
      'harvester.install.automatic=true',
      `harvester.install.mode=${config.installMode}`,
      `harvester.install.device=${config.installDisk || '<install-disk>'}`,
      `harvester.install.management_interface=${config.managementInterface || '<management-interface>'}`,
    ],
    validationIssues,
  };
}
