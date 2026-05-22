import { describe, expect, it } from 'vitest';
import { buildLaunchSequence } from './launchSequence';

describe('buildLaunchSequence', () => {
  it('returns staged loading steps that end at a complete dashboard launch', () => {
    const sequence = buildLaunchSequence();

    expect(sequence.steps).toHaveLength(5);
    expect(sequence.steps[0].progress).toBe(12);
    expect(sequence.steps.at(-1)).toEqual({
      label: 'Launching Nexus HUD',
      progress: 100,
      signal: 'interface-ready',
    });
    expect(sequence.durationMs).toBeGreaterThanOrEqual(2500);
  });
});
