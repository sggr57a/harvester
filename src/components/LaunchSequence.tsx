import { buildLaunchSequence } from '../lib/launchSequence';

const launchSequence = buildLaunchSequence();

export function LaunchSequence() {
  return (
    <section className="launch-sequence" aria-label="Nexus interface loading sequence">
      <div className="launch-grid" />
      <div className="launch-wordmark">ELEVATE</div>
      <div className="launch-meter-shell">
        <div className="launch-meter">
          <span />
        </div>
        <div className="launch-meter-labels">
          <span>00</span>
          <strong>loading interface</strong>
          <span>100</span>
        </div>
      </div>
      <div className="launch-lab-elements">
        <div className="launch-reticle">
          <i />
          <b />
        </div>
        <div className="launch-waveform">
          {launchSequence.steps.map((step, index) => (
            <span key={step.signal} style={{ height: `${28 + index * 15}%`, animationDelay: `${index * 120}ms` }} />
          ))}
        </div>
      </div>
      <ol className="launch-steps">
        {launchSequence.steps.map((step, index) => (
          <li key={step.signal} style={{ animationDelay: `${index * 360}ms` }}>
            <span>{String(index + 1).padStart(2, '0')}</span>
            <p>{step.label}</p>
            <strong>{step.progress}%</strong>
          </li>
        ))}
      </ol>
    </section>
  );
}
