import { HarvesterMachineConfig, HarvesterMachineInstallPlan } from '../lib/harvesterMachineWizard';

interface NexusMachineWizardProps {
  config: HarvesterMachineConfig;
  plan: HarvesterMachineInstallPlan;
  onChange: (config: HarvesterMachineConfig) => void;
}

function updateListValue(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function NexusMachineWizard({ config, plan, onChange }: NexusMachineWizardProps) {
  return (
    <section className="machine-wizard hud-panel" aria-label="Nexus new machine Harvester wizard">
      <div className="hud-panel-title machine-wizard-title">
        <span>New machine wizard</span>
        <strong>{plan.validationIssues.length === 0 ? 'platform install ready' : 'machine fields required'}</strong>
      </div>

      <div className="machine-wizard-grid">
        <div className="machine-wizard-form">
          <label>
            Install mode
            <select value={config.installMode} onChange={(event) => onChange({ ...config, installMode: event.target.value as HarvesterMachineConfig['installMode'] })}>
              <option value="create">Create new Nexus cluster</option>
              <option value="join">Join existing Nexus cluster</option>
              <option value="binaries">Install binaries only</option>
            </select>
          </label>
          <div className="grid-2">
            <label>
              Host name
              <input value={config.hostName} onChange={(event) => onChange({ ...config, hostName: event.target.value })} />
            </label>
            <label>
              Management NIC
              <input value={config.managementInterface} onChange={(event) => onChange({ ...config, managementInterface: event.target.value })} />
            </label>
          </div>
          <div className="grid-2">
            <label>
              Install disk
              <input value={config.installDisk} onChange={(event) => onChange({ ...config, installDisk: event.target.value })} />
            </label>
            <label>
              Data disk
              <input value={config.dataDisk} onChange={(event) => onChange({ ...config, dataDisk: event.target.value })} />
            </label>
          </div>
          <div className="grid-2">
            <label>
              VIP mode
              <select value={config.vipMode} onChange={(event) => onChange({ ...config, vipMode: event.target.value as HarvesterMachineConfig['vipMode'] })}>
                <option value="static">Static VIP</option>
                <option value="dhcp">DHCP VIP</option>
              </select>
            </label>
            <label>
              Virtual IP
              <input value={config.virtualIp} onChange={(event) => onChange({ ...config, virtualIp: event.target.value })} />
            </label>
          </div>
          <label>
            Cluster token
            <input value={config.clusterToken} onChange={(event) => onChange({ ...config, clusterToken: event.target.value })} />
          </label>
          {config.installMode === 'join' && (
            <label>
              Existing cluster URL
              <input value={config.serverUrl || ''} onChange={(event) => onChange({ ...config, serverUrl: event.target.value })} placeholder="https://10.10.40.20:443" />
            </label>
          )}
          <div className="grid-2">
            <label>
              DNS servers
              <input value={config.dnsServers.join(', ')} onChange={(event) => onChange({ ...config, dnsServers: updateListValue(event.target.value) })} />
            </label>
            <label>
              NTP servers
              <input value={config.ntpServers.join(', ')} onChange={(event) => onChange({ ...config, ntpServers: updateListValue(event.target.value) })} />
            </label>
          </div>
        </div>

        <div className="machine-plan">
          <div className="machine-steps">
            {plan.steps.map((step, index) => (
              <div className={`machine-step ${step.status}`} key={step.id} style={{ animationDelay: `${index * 90}ms` }}>
                <span>{String(index + 1).padStart(2, '0')}</span>
                <div>
                  <strong>{step.title}</strong>
                  <small>{step.detail}</small>
                </div>
              </div>
            ))}
          </div>
          <div className="machine-source-card">
            <span>Harvester source root</span>
            <strong>{plan.sourceRoot}</strong>
            <small>Imported platform source is carried in this Nexus repository, not mounted as an add-on.</small>
          </div>
        </div>
      </div>

      {plan.validationIssues.length > 0 && (
        <div className="machine-issues" role="alert">
          {plan.validationIssues.map((issue) => (
            <p key={issue}>{issue}</p>
          ))}
        </div>
      )}

      <div className="machine-config-preview">
        <div className="cluster-command-ribbon">
          {plan.bootParameters.map((parameter) => (
            <span key={parameter}>{parameter}</span>
          ))}
        </div>
        <pre>{plan.configYaml}</pre>
      </div>
    </section>
  );
}
