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

        <h3 className="prefs-section">Aerodynamics</h3>
        <div className="field">
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={prefs.rogersKbf ?? false}
              onChange={(e) => setPrefs({ ...prefs, rogersKbf: e.target.checked })}
            />
            Rogers Modified Barrowman — body-fin interference (Kbf)
          </label>
        </div>
        <p className="prefs-hint">
          Adds the body-in-presence-of-fins lift carryover (NACA&nbsp;1307) that classic
          Barrowman drops. Gives a slightly more aft, more conservative CP and stability
          margin — affects the reported stability and the flight simulation. Off = standard
          Barrowman.
        </p>
        <div className="field">
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={prefs.supersonicAero ?? false}
              onChange={(e) => setPrefs({ ...prefs, supersonicAero: e.target.checked })}
            />
            Supersonic aerodynamics (beta) — RASAero-class CP &amp; drag, Mach&nbsp;0–25
          </label>
        </div>
        <p className="prefs-hint">
          Corrected supersonic fin lift (2D Busemann level), exact NACA&nbsp;1307 body-fin
          interference, Mach-dependent nose lift, per-shape wave drag with physical
          hypersonic decay, and Van&nbsp;Driest&nbsp;II friction. CP and drag then move with
          Mach the way wind tunnels measure (validated against NASA ARCAS and Basic Finner
          data to Mach&nbsp;4.6). Affects stability, drag analysis and the flight sim at all
          speeds — including a modest subsonic lift increase from the interference term.
          Off&nbsp;=&nbsp;classic OpenRocket, identical to the desktop app. Recommended for
          flights beyond Mach&nbsp;1; supersedes the Kbf option above when on.
        </p>

        <p className="prefs-hint">
          Values are stored in SI internally — switching units never changes your design,
          only how numbers are shown and typed.
        </p>
      </div>
    </div>
  );
}
