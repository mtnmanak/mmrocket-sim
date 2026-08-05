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
            <label>Daylight mode</label>
            <select
              value={prefs.daylight ? 'on' : 'off'}
              onChange={(e) => setPrefs({ ...prefs, daylight: e.target.value === 'on' })}
            >
              <option value="off">Off</option>
              <option value="on">On — bright sunlight</option>
            </select>
          </div>
        </div>
        <p className="prefs-hint">
          <strong>Daylight</strong> is the launch-site mode: black on white at maximum
          contrast, with heavier borders, bolder small type, and darker, thicker chart lines,
          so a phone screen stays readable in direct sun. It <strong>overrides the theme
          above</strong> while it&rsquo;s on — a high-contrast <em>dark</em> screen is the
          right answer indoors and the wrong one on the field. Turning it off puts your theme
          back. The <strong>Daylight</strong> button in the header is the same switch.
        </p>

        <h3 className="prefs-section">Aerodynamics</h3>
        {/* The MODEL is the primary choice; Kbf is a refinement OF the classic
            model and is greyed out when the supersonic model supersedes it
            (issue 2026-08-05a #9: the live-looking checkbox with zero effect
            was the confusion). */}
        <div className="field">
          <label>Aerodynamics model (beta)</label>
          <select
            value={prefs.aeroModel ?? 'classic'}
            onChange={(e) => setPrefs({
              ...prefs,
              aeroModel: e.target.value as 'classic' | 'supersonic' | 'auto',
            })}
          >
            <option value="classic">Classic — Extended Barrowman (the default)</option>
            <option value="auto">Auto — supersonic model when the flight goes past Mach 0.9</option>
            <option value="supersonic">Supersonic — RASAero-class model at all speeds</option>
          </select>
        </div>
        <div className="field">
          <label style={{
            display: 'flex', alignItems: 'center', gap: 8,
            cursor: (prefs.aeroModel ?? 'classic') === 'supersonic' ? 'not-allowed' : 'pointer',
            opacity: (prefs.aeroModel ?? 'classic') === 'supersonic' ? 0.5 : 1,
          }}>
            <input
              type="checkbox"
              checked={prefs.rogersKbf ?? true}
              disabled={(prefs.aeroModel ?? 'classic') === 'supersonic'}
              onChange={(e) => setPrefs({ ...prefs, rogersKbf: e.target.checked })}
            />
            Classic model: add Rogers Modified Barrowman body-fin interference (Kbf)
          </label>
        </div>
        <p className="prefs-hint">
          Adds the body-in-presence-of-fins lift carryover (NACA&nbsp;1307) that classic
          Barrowman drops. Gives a slightly more aft, more conservative CP and stability
          margin — affects the reported stability and the flight simulation. <strong>On by
          default</strong> (it tracks real flight data better); turn it off for exact
          desktop-OpenRocket parity.
          {(prefs.aeroModel ?? 'classic') === 'supersonic' && (
            <strong> Disabled: the supersonic model already contains the full
            NACA&nbsp;1307 interference.</strong>
          )}
          {(prefs.aeroModel ?? 'classic') === 'auto' && (
            <strong> Under Auto it applies only to flights that stay classic
            (below Mach&nbsp;0.9).</strong>
          )}
        </p>
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
          keep exact desktop parity. Each saved run records which model flew it.
        </p>

        <p className="prefs-hint">
          Values are stored in SI internally — switching units never changes your design,
          only how numbers are shown and typed.
        </p>
      </div>
    </div>
  );
}
