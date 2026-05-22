export interface LaunchStep {
  label: string;
  progress: number;
  signal: string;
}

export interface LaunchSequence {
  durationMs: number;
  steps: LaunchStep[];
}

export function buildLaunchSequence(): LaunchSequence {
  return {
    durationMs: 3200,
    steps: [
      { label: 'Authenticating identity', progress: 12, signal: 'credential-lock' },
      { label: 'Charging interface meter', progress: 34, signal: 'meter-rise' },
      { label: 'Resolving cluster topology', progress: 58, signal: 'topology-scan' },
      { label: 'Synchronizing HUD layers', progress: 82, signal: 'hud-compose' },
      { label: 'Launching Nexus HUD', progress: 100, signal: 'interface-ready' },
    ],
  };
}
