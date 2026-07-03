import { usePrefs } from '../prefs/PrefsContext.js';
import {
  IMPERIAL_UNITS, METRIC_UNITS, QUANTITY_LABEL, UNITS, type Quantity,
} from '../prefs/units.js';

const QUANTITIES = Object.keys(UNITS) as Quantity[];

export function PreferencesDialog({ onClose }: { onClose: () => void }) {
  const { prefs, setPrefs } = usePrefs();

  return (
    <div className="prefs-overlay" role="presentation" onClick={onClose}>
      <div
        className="prefs-dialog panel"
        role="dialog"
        aria-label="Preferences"
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <h2 style={{ flex: 1 }}>Preferences</h2>
          <button className="file-btn" onClick={onClose} aria-label="Close preferences">✕ Close</button>
        </div>

        <h3 className="prefs-section">Units of measure</h3>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <button className="file-btn" onClick={() => setPrefs({ ...prefs, units: METRIC_UNITS })}>
            Metric defaults
          </button>
          <button className="file-btn" onClick={() => setPrefs({ ...prefs, units: IMPERIAL_UNITS })}>
            Imperial defaults
          </button>
        </div>
        <div className="field-grid">
          {QUANTITIES.map((q) => (
            <div className="field" key={q}>
              <label>{QUANTITY_LABEL[q]}</label>
              <select
                value={prefs.units[q]}
                onChange={(e) => setPrefs({ ...prefs, units: { ...prefs.units, [q]: e.target.value } })}
              >
                {UNITS[q].map((u) => (
                  <option key={u.symbol} value={u.symbol}>{u.symbol}</option>
                ))}
              </select>
            </div>
          ))}
        </div>

        <h3 className="prefs-section">Display</h3>
        <div className="field-grid">
          <div className="field">
            <label>Round components entered as</label>
            <select
              value={prefs.radiusMode}
              onChange={(e) => setPrefs({ ...prefs, radiusMode: e.target.value as 'radius' | 'diameter' })}
            >
              <option value="diameter">Diameter</option>
              <option value="radius">Radius</option>
            </select>
          </div>
          <div className="field">
            <label>Theme</label>
            <select
              value={prefs.theme}
              onChange={(e) => setPrefs({
                ...prefs,
                theme: e.target.value as 'light' | 'dark' | 'system',
                themeExplicit: true,
              })}
            >
              <option value="light">Light</option>
              <option value="dark">Dark</option>
              <option value="system">Follow system</option>
            </select>
          </div>
        </div>

        <p className="prefs-hint">
          Values are stored in SI internally — switching units never changes your design,
          only how numbers are shown and typed.
        </p>
      </div>
    </div>
  );
}
