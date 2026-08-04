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
          <div className="field">
            <label>High contrast (daylight)</label>
            <select
              value={prefs.highContrast === undefined ? 'system' : prefs.highContrast ? 'on' : 'off'}
              onChange={(e) => setPrefs({
                ...prefs,
                highContrast: e.target.value === 'system' ? undefined : e.target.value === 'on',
              })}
            >
              <option value="off">Off</option>
              <option value="on">On — bright sunlight</option>
              <option value="system">Follow system</option>
            </select>
          </div>
        </div>
        <p className="prefs-hint">
          <strong>High contrast</strong> is the launch-site mode: pure black-on-white (or
          white-on-black in the dark theme), heavier borders, bolder small type, and darker
          chart lines so a phone screen stays readable in direct sun. It layers on top of
          whichever theme you picked — the <strong>Daylight</strong> button in the header is
          the same switch. &ldquo;Follow system&rdquo; tracks your device&rsquo;s
          increase-contrast accessibility setting.
        </p>

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
          <label>Aerodynamics model (beta)</label>
          <select
            value={prefs.aeroModel ?? 'classic'}
            onChange={(e) => setPrefs({
              ...prefs,
              aeroModel: e.target.value as 'classic' | 'supersonic' | 'auto',
            })}
          >
            <option value="classic">Classic — Extended Barrowman (desktop parity)</option>
            <option value="auto">Auto — supersonic model when the flight goes past Mach 0.9</option>
            <option value="supersonic">Supersonic — RASAero-class model at all speeds</option>
          </select>
        </div>
        <p className="prefs-hint">
          The <strong>supersonic model</strong> adds corrected supersonic fin lift (2D
          Busemann level), exact NACA&nbsp;1307 body-fin interference, Mach-dependent nose
          lift, per-shape wave drag with physical hypersonic decay, and
          Van&nbsp;Driest&nbsp;II friction — CP and drag then move with Mach the way wind
          tunnels measure (validated against NASA ARCAS and Basic Finner data to
          Mach&nbsp;4.6). A model applies to the <strong>entire flight</strong>, subsonic
          portions included (the interference term raises fin lift modestly even at low
          speed), so expect stability and apogee to shift when the model changes.
          <strong> Auto</strong> flies classic first and re-flies the whole flight on the
          supersonic model only when it's projected past Mach&nbsp;0.9 — subsonic flights
          keep exact desktop parity. Each saved run records which model flew it. The
          supersonic model supersedes the Kbf option above when active.
        </p>

        <p className="prefs-hint">
          Values are stored in SI internally — switching units never changes your design,
          only how numbers are shown and typed.
        </p>
      </div>
    </div>
  );
}
