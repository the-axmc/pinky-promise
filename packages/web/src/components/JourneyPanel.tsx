import { useEffect, useRef, useState } from 'react';
import { type JourneyStatus, driveJourney, driveKeyFromPage, fetchJourney } from '../lib/journey';

/** Walks a lot through its journey from the page, on a demo served by `pnpm showcase`. */
export function JourneyPanel({
  gatewayUrl,
  onLot,
  onStepDone,
}: {
  gatewayUrl: string;
  /** The journey moved to this lot: show it. */
  onLot: (assetId: string) => void;
  /** Something changed on the chains: read them again. */
  onStepDone: () => void;
}) {
  const [status, setStatus] = useState<JourneyStatus>();
  const [problem, setProblem] = useState<string>();
  const [key] = useState(driveKeyFromPage);
  const logEnd = useRef<HTMLDivElement>(null);
  const seen = useRef<{ assetId: string | null; running: string | null }>({ assetId: null, running: null });

  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      const next = await fetchJourney(gatewayUrl).catch(() => undefined);
      if (stopped) return;
      setStatus(next);
      if (next?.assetId && next.assetId !== seen.current.assetId) onLot(next.assetId);
      if (next && seen.current.running && !next.running) onStepDone();
      seen.current = { assetId: next?.assetId ?? null, running: next?.running ?? null };
    };
    void poll();
    const timer = setInterval(() => document.visibilityState === 'visible' && void poll(), 1_500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [gatewayUrl, onLot, onStepDone]);

  const lines = status?.log.length ?? 0;
  useEffect(() => {
    logEnd.current?.parentElement?.scrollTo({ top: logEnd.current.offsetTop });
  }, [lines]);

  if (!status) return null;

  const drive = async (action: 'next' | 'restart') => {
    setProblem(undefined);
    try {
      await driveJourney(gatewayUrl, action, key);
      setStatus(await fetchJourney(gatewayUrl));
    } catch (caught) {
      setProblem((caught as Error).message);
    }
  };

  const { steps, step, running, mode, driving } = status;
  const canDrive = driving === 'open' || (driving === 'key' && Boolean(key));
  const over = step >= steps.length;
  const next = step >= 0 && !over ? steps[step] : undefined;
  const last = step > 0 ? steps[step - 1] : undefined;

  return (
    <section className="card journey" aria-label="The journey">
      <div className="card-head">
        <h2>Walk a lot through its journey</h2>
        {mode === 'stand-in' ? (
          <span className="pill pill-warn">Simulated networks</span>
        ) : (
          <span className="pill pill-good">Live testnets</span>
        )}
      </div>
      <p className="muted">
        {mode === 'stand-in'
          ? 'Nothing here is on a public network. The Arkiv node and the Hedera chain are disposable stand-ins on this server, running the unmodified Arkiv SDK and the real ATS contract bytecode; the device and the decision model are simulated too. The page below checks every record exactly as it would on testnet.'
          : `Everything here is on public testnets. Decisions: ${status.decisions}. The device is simulated.`}
      </p>

      <ol className="journey-steps">
        {steps.map((item, index) => {
          const state =
            running && index === step ? 'running' : index < step ? 'done' : index === step ? 'next' : 'later';
          return (
            <li key={item.title} className={`journey-step journey-step-${state}`}>
              <span className="journey-mark" aria-hidden="true">
                {state === 'done' ? '✓' : index + 1}
              </span>
              <span>{item.title}</span>
            </li>
          );
        })}
      </ol>

      {running ? <p aria-live="polite">Working: {running}…</p> : null}
      {!running && last ? (
        <p aria-live="polite">
          <strong>Look at the page below.</strong> {last.look}
        </p>
      ) : null}
      {!running && next ? (
        <p className="muted">
          Next: {next.title}. {next.does}
        </p>
      ) : null}
      {status.error ? <p className="banner banner-bad">{status.error}</p> : null}
      {problem ? <p className="banner banner-bad">{problem}</p> : null}

      {canDrive ? (
        <div className="row">
          {next ? (
            <button disabled={Boolean(running)} onClick={() => void drive('next')}>
              {status.error ? 'Try again' : `Run step ${step + 1}: ${next.title}`}
            </button>
          ) : null}
          {step !== 0 ? (
            <button
              className={next ? 'ghost' : ''}
              disabled={Boolean(running)}
              onClick={() => void drive('restart')}
            >
              {step < 0 ? 'Start a new lot' : 'Start over with a new lot'}
            </button>
          ) : null}
        </div>
      ) : (
        <p className="muted">
          This demo is read-only: every lot below was walked through its journey by the operator, and what you
          see is what is on chain.
        </p>
      )}

      {status.log.length > 0 ? (
        <details>
          <summary>What the system did</summary>
          <div className="journey-log">
            {status.log.map((line, index) => (
              <div key={index}>{line}</div>
            ))}
            <div ref={logEnd} />
          </div>
        </details>
      ) : null}
    </section>
  );
}
