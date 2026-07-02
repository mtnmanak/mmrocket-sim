import { useState } from 'react';
import type { MotorSpec } from '@online-openrocket/engine';
import { BUILT_IN_MOTORS } from '../motors.js';
import {
  delayOptions,
  fetchMotorSpec,
  searchMotors,
  type TcMotor,
} from '../services/thrustcurve.js';

/**
 * Motor selection: built-ins (instant, offline) or a thrustcurve.org search.
 * The search is pre-filtered to the mount's diameter.
 */
export function MotorPicker({ mountDiameterMm, selectedLabel, onSelect }: {
  mountDiameterMm: number;
  selectedLabel: string;
  onSelect: (label: string, spec: MotorSpec) => void;
}) {
  const [mode, setMode] = useState<'builtin' | 'search'>('builtin');
  const [name, setName] = useState('');
  const [impulseClass, setImpulseClass] = useState('');
  const [results, setResults] = useState<TcMotor[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runSearch = async () => {
    setBusy(true);
    setError(null);
    try {
      const found = await searchMotors({
        commonName: name || undefined,
        impulseClass: impulseClass || undefined,
        diameter: mountDiameterMm,
        maxResults: 20,
      });
      setResults(found);
      if (found.length === 0) setError('No motors found — try a different class or name.');
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const pick = async (motor: TcMotor, delay: number) => {
    setBusy(true);
    setError(null);
    try {
      const spec = await fetchMotorSpec(motor, delay);
      onSelect(`${motor.manufacturerAbbrev} ${motor.designation}-${delay}`, spec);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="field">
        <label>Motor source</label>
        <select value={mode} onChange={(e) => setMode(e.target.value as 'builtin' | 'search')}>
          <option value="builtin">Built-in (offline)</option>
          <option value="search">thrustcurve.org search</option>
        </select>
      </div>

      {mode === 'builtin' ? (
        <div className="field" style={{ marginTop: 8 }}>
          <label>Motor</label>
          <select
            value={selectedLabel in BUILT_IN_MOTORS ? selectedLabel : ''}
            onChange={(e) => {
              const key = e.target.value;
              const m = BUILT_IN_MOTORS[key];
              if (m) onSelect(key, m);
            }}
          >
            <option value="" disabled>{selectedLabel in BUILT_IN_MOTORS ? '' : `(current: ${selectedLabel})`}</option>
            {Object.keys(BUILT_IN_MOTORS).map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
        </div>
      ) : (
        <div style={{ marginTop: 8 }}>
          <div className="field-grid">
            <div className="field">
              <label>Name (e.g. C6)</label>
              <input value={name} onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && runSearch()} />
            </div>
            <div className="field">
              <label>Impulse class</label>
              <select value={impulseClass} onChange={(e) => setImpulseClass(e.target.value)}>
                <option value="">Any</option>
                {['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
          </div>
          <button className="launch-btn" style={{ marginTop: 8, fontSize: 13, padding: 7 }}
              onClick={runSearch} disabled={busy}>
            {busy ? 'Searching…' : `Search ${mountDiameterMm} mm motors`}
          </button>

          {error && <p className="stability-bad" style={{ fontSize: 12 }}>{error}</p>}

          {results.length > 0 && (
            <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0 0', maxHeight: 220, overflowY: 'auto' }}>
              {results.map((m) => (
                <li key={m.motorId}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 2px', borderBottom: '1px solid var(--border)', fontSize: 12 }}>
                  <span style={{ flex: 1 }}>
                    <strong>{m.manufacturerAbbrev} {m.designation}</strong>
                    <span style={{ color: 'var(--text-muted)' }}>
                      {' '}· {m.totImpulseNs.toFixed(1)} N·s · {m.burnTimeS.toFixed(1)} s
                    </span>
                  </span>
                  <select
                    defaultValue=""
                    disabled={busy}
                    onChange={(e) => {
                      if (e.target.value !== '') pick(m, Number(e.target.value));
                    }}
                    aria-label={`Use ${m.designation} with delay`}
                  >
                    <option value="" disabled>delay…</option>
                    {delayOptions(m).map((d) => (
                      <option key={d} value={d}>{d} s</option>
                    ))}
                  </select>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '6px 0 0' }}>
        Selected: <strong>{selectedLabel}</strong>
      </p>
    </div>
  );
}
