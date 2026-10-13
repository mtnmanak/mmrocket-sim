import { useEffect, useRef, useState } from 'react';
import { usePrefs } from '../prefs/PrefsContext.js';
import type { StabilityRange, StabilityRangeInput, StabilityCaseResult } from '../services/configStabilityRange.js';
import { Note } from './Note.js';

type Answer = { input: StabilityRangeInput; attempt: number; result?: StabilityRange; error?: string };

/** N024: typing only schedules work; the flight's engine stays on the main thread. */
export function ConfigStabilityRange({ input }: { input: StabilityRangeInput }) {
  const { prefs } = usePrefs();
  const [answer, setAnswer] = useState<Answer>();
  const [attempt, setAttempt] = useState(0);
  const worker = useRef<Worker>();
  const sequence = useRef(0);
  useEffect(() => {
    const id = ++sequence.current;
    const timer = setTimeout(() => {
      try {
        worker.current ??= new Worker(new URL('../services/configStabilityRange.worker.ts', import.meta.url), { type: 'module' });
        worker.current.onmessage = (event: MessageEvent<{ id: number; result?: StabilityRange; error?: string }>) => {
          if (event.data.id !== sequence.current) return;
          setAnswer({ input, attempt, result: event.data.result, error: event.data.error });
        };
        worker.current.onerror = () => {
          if (id !== sequence.current) return;
          setAnswer({ input, attempt, error: 'Could not calculate the range. The selected configuration readout still applies only to that configuration.' });
          worker.current?.terminate();
          worker.current = undefined;
        };
        worker.current.postMessage({ id, input });
      } catch {
        setAnswer({ input, attempt, error: 'Could not start the range calculation.' });
      }
    }, 200);
    return () => {
      clearTimeout(timer);
      sequence.current = id + 1;
      worker.current?.postMessage({ id: id + 1 });
    };
  }, [input, attempt]);
  useEffect(() => () => { worker.current?.terminate(); worker.current = undefined; }, []);
  const current = answer?.input === input && answer.attempt === attempt ? answer : undefined;
  const result = current?.result;
  const format = (c: StabilityCaseResult) => prefs.stabilityUnit === 'pct'
    ? c.pct == null ? 'unavailable' : `${c.pct.toFixed(1)}% of length`
    : `${c.cal!.toFixed(2)} cal${prefs.stabilityUnit === 'both' && c.pct != null ? ` (${c.pct.toFixed(1)}% of length)` : ''}`;
  const rangeText = result?.min && result.max
    ? prefs.stabilityUnit === 'pct'
      ? result.min.pct == null || result.max.pct == null ? 'unavailable'
        : `${result.min.pct.toFixed(1)}–${result.max.pct.toFixed(1)}% of length`
      : `${result.min.cal!.toFixed(2)}–${result.max.cal!.toFixed(2)} cal${prefs.stabilityUnit === 'both'
        && result.min.pct != null && result.max.pct != null
        ? ` (${result.min.pct.toFixed(1)}–${result.max.pct.toFixed(1)}% of length)` : ''}`
    : 'unavailable';
  return <section className="config-stability-range" aria-label="Stability across configurations">
    <div role="status" aria-live="polite">
      <strong>{result && !result.complete ? 'Partial stability range' : 'Stability range'}</strong>{' · '}
      {!current ? 'Calculating…' : current.error ? 'unavailable' : rangeText}
      {result?.min && <span className="range-worst">Lowest margin: {result.min.label}</span>}
    </div>
    <p className="hint">Static, at Mach 0.3, using the most-forward CP across roll planes. Includes the empty rocket and all saved flight configurations; this is not the margin throughout a flight.</p>
    {current?.error && <p className="hint">{current.error}{' '}
      <button type="button" className="file-btn" onClick={() => setAttempt(a => a + 1)}>Retry</button></p>}
    {result && <>
      {!result.complete && <Note tier="caution" as="p">Some cases are unavailable and excluded. The calculated minimum may show more margin than the rocket really has in an uncalculated case.</Note>}
      <details>
        <summary>Configuration margins ({result.cases.length})</summary>
        <ul>{result.cases.map((c, i) => <li key={`${c.id}-${i}`}>
          <strong>{c.label}</strong>: {c.unavailable ? `unavailable — ${c.unavailable}` : format(c)}
        </li>)}</ul>
      </details>
    </>}
  </section>;
}
