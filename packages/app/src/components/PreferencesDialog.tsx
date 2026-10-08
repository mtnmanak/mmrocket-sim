import { useId } from 'react';
import { clearTourDone, markTourDone } from './FirstRunTour.js';
import { NumField } from './NumField.js';
import { useBackdropClose, useDialog } from './useDialog.js';
import { UnitChip } from './UnitChip.js';
import { AERO_SHORT, aeroChoiceOf, prefsForAeroChoice, usePrefs, type AeroChoice } from '../prefs/PrefsContext.js';
import {
  CUSTOM_PRESET, DEFAULT_PRINT_CLEARANCE, DEFAULT_PRINT_MARGIN, PRINTER_PRESETS,
  presetMatching, printerFromPreset, type PrinterPrefs,
} from '../prefs/printers.js';
import {
  IMPERIAL_UNITS, METRIC_UNITS, QUANTITY_LABEL, UNITS, niceStep, siToUi, uiToSi,
  type Quantity,
} from '../prefs/units.js';

const QUANTITIES = Object.keys(UNITS) as Quantity[];

/** Placeholder volume for "Custom" started from nothing — meant to be typed over. */
const CUSTOM_SEED: PrinterPrefs = {
  preset: CUSTOM_PRESET,
  x: 0.2, y: 0.2, z: 0.2,
  margin: DEFAULT_PRINT_MARGIN,
  clearance: DEFAULT_PRINT_CLEARANCE,
};

export function PreferencesDialog({ onClose }: { onClose: () => void }) {
  const { prefs, setPrefs, aeroOverride, setAeroOverride } = usePrefs();
  /**
   * Every field's `<label htmlFor>` points at its own control (audit
   * 2026-09-30), and the control carries no aria-label: the words on screen
   * are its one name. A label with no `for` names its first labelable
   * descendant — the unit chip, so clicking "Bed X" focused the chip, not the
   * box — or nothing at all, which was every select here: each named by a
   * second copy of its label's words in an aria-label, the label itself tied
   * to nothing.
   */
  const uid = useId();
  const idFor = (key: string) => `${uid}-${key}`;

  // Build volumes are stored in metres and edited through the same
  // siToUi/uiToSi plumbing as every other length (prefs/printers.ts explains
  // why metres) — so a builder who works in inches types inches here too.
  const lengthSym = prefs.units.length;
  const toUi = (si: number) => siToUi('length', lengthSym, si);
  const printer = prefs.printer;
  const setPrinter = (next: PrinterPrefs | undefined) => setPrefs({ ...prefs, printer: next });
  // Typing over any axis means this is no longer the preset's machine.
  const setAxis = (axis: 'x' | 'y' | 'z', si: number) => {
    if (!printer) return;
    const next = { ...printer, [axis]: si };
    setPrinter({ ...next, preset: presetMatching(next.x, next.y, next.z) });
  };
  const axisField = (axis: 'x' | 'y' | 'z', label: string) => (
    <div className="field">
      <label htmlFor={idFor(`printer-${axis}`)}>{label} <UnitChip quantity="length" /></label>
      <NumField
        id={idFor(`printer-${axis}`)}
        value={printer ? toUi(printer[axis]) : undefined}
        step={niceStep(toUi(0.001))}
        min={toUi(0.001)}
        onCommit={(v) => { if (v !== null && v > 0) setAxis(axis, uiToSi('length', lengthSym, v)); }}
      />
    </div>
  );

  const dialogRef = useDialog(onClose);
  const backdrop = useBackdropClose(onClose);

  return (
    <div className="prefs-overlay" role="presentation" {...backdrop}>
      <div
        className="prefs-dialog panel"
        role="dialog"
        aria-modal="true"
        aria-label="Preferences"
        ref={dialogRef}
        tabIndex={-1}
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
              {/* Tied to its select, or these read as combo boxes announcing
                  only "m" / "kg" / "m/s" with no clue which quantity they set. */}
              <label htmlFor={idFor(`unit-${q}`)}>{QUANTITY_LABEL[q]}</label>
              <select
                id={idFor(`unit-${q}`)}
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
            <label htmlFor={idFor('radius-mode')}>Round components entered as</label>
            <select
              id={idFor('radius-mode')}
              value={prefs.radiusMode}
              onChange={(e) => setPrefs({ ...prefs, radiusMode: e.target.value as 'radius' | 'diameter' })}
            >
              <option value="diameter">Diameter</option>
              <option value="radius">Radius</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor={idFor('stability-unit')}>Stability shown as</label>
            <select
              id={idFor('stability-unit')}
              value={prefs.stabilityUnit ?? 'cal'}
              onChange={(e) => setPrefs({
                ...prefs,
                stabilityUnit: e.target.value as 'cal' | 'pct' | 'both',
              })}
            >
              <option value="cal">Calibers</option>
              <option value="pct">% of length</option>
              <option value="both">Both</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor={idFor('markers-3d')}>CG / CP markers in 3D</label>
            <select
              id={idFor('markers-3d')}
              value={prefs.markers3d ?? 'both'}
              onChange={(e) => setPrefs({
                ...prefs,
                markers3d: e.target.value as 'both' | 'callout' | 'axis' | 'off',
              })}
            >
              <option value="both">Markers and callout</option>
              <option value="axis">Markers only</option>
              <option value="callout">Callout only</option>
              <option value="off">Off — clean shell</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor={idFor('theme')}>Theme</label>
            <select
              id={idFor('theme')}
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
            <label htmlFor={idFor('daylight')}>Daylight mode</label>
            <select
              id={idFor('daylight')}
              value={prefs.daylight ? 'on' : 'off'}
              onChange={(e) => setPrefs({ ...prefs, daylight: e.target.value === 'on' })}
            >
              <option value="off">Off</option>
              <option value="on">On — bright sunlight</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor={idFor('tour')}>First-run tour</label>
            <select
              id={idFor('tour')}
              value={prefs.tourOff ? 'off' : 'on'}
              onChange={(e) => {
                // The preference and the tour's "seen" flag were two separate
                // localStorage keys, and this select only ever wrote one of
                // them. So Off looked like it did nothing (the seen flag was
                // already suppressing the tour anyway) and On could never
                // re-show it. The preference now owns both.
                const off = e.target.value === 'off';
                setPrefs({ ...prefs, tourOff: off });
                if (off) markTourDone();
                else clearTourDone();
              }}
            >
              <option value="on">On — show once to new visitors</option>
              <option value="off">Off</option>
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
        <p className="prefs-hint">
          <strong>CG / CP markers in 3D</strong> controls the two things the 3D view draws on
          top of the rocket: the spheres on the axis, and the floating callout beside the hull
          that repeats them with the stability margin. They are separable because a clean shell
          for a photo and a shell with the numbers are different requests. The
          <strong> ◉ CG/CP</strong> button on the 3D view itself is the same switch, on and off.
        </p>

        <h3 className="prefs-section">Aerodynamics</h3>
        {/* ONE pulldown, four explicit choices (2026-08-05c #9 — the separate
            Kbf checkbox next to a "Classic" option read as two things both
            called classic). The select derives from and writes BOTH stored
            prefs (aeroModel + rogersKbf) — no migration needed. */}
        <div className="field">
          <label htmlFor={idFor('aero-model')}>Aerodynamics model</label>
          <select
            id={idFor('aero-model')}
            value={aeroChoiceOf(prefs)}
            onChange={(e) => {
              // Both stored fields from the ONE mapping the strip's override
              // flies through too (PrefsContext.prefsForAeroChoice).
              setPrefs({ ...prefs, ...prefsForAeroChoice(e.target.value as AeroChoice) });
            }}
          >
            <option value="eb">Classic Extended Barrowman</option>
            <option value="kbf">Rogers Modified Barrowman (Kbf) — the default</option>
            <option value="auto">Auto — Rogers Kbf, switching to our supersonic model past Mach 0.9</option>
            <option value="supersonic">Supersonic — our extended model at all speeds (validated to Mach 4.6)</option>
                <option value="hybrid">Hybrid (experimental)</option>
          </select>
        </div>
        {aeroOverride && aeroOverride !== aeroChoiceOf(prefs) && (
          // Two selects on screen showing different models, with nothing
          // saying why, is the collision the strip switch could most easily
          // have introduced. The strip is session-scoped; this is the durable
          // setting; say so, and offer the one action that resolves it.
          // (Choosing anything above ALSO clears the override — the newer,
          // more deliberate act wins. See PrefsContext.setPrefs.)
          <p className="prefs-hint">
            The vitals strip is flying <strong>{AERO_SHORT[aeroOverride]}</strong> for this
            session only, so it is overriding the setting above. The setting above is the
            durable one and comes back on your next visit.{' '}
            <button className="file-btn" onClick={() => setAeroOverride(null)}>
              Go back to {AERO_SHORT[aeroChoiceOf(prefs)]}
            </button>
          </p>
        )}
        <p className="prefs-hint">
          <strong>Classic Extended Barrowman</strong> is OpenRocket 24.12's Barrowman
          model with three later upstream OpenRocket corrections: bounded fin CP at
          low aspect ratio, including tube fins (#3196/#3262); the transonic fin
          normal-force slope (#3236); and body skin friction using the body diameter
          (#3237). These corrections stay on in every model. Classic switches off the
          optional additions below and stays the closest match for comparison with
          desktop OpenRocket, not an exact one. Results can differ slightly from
          desktop 24.12, most near Mach 1 and on low-aspect-ratio or tube fins. The
          low-aspect-ratio fallback keeps CP bounded and continuous; it does not
          establish measured accuracy. Other differences remain too: the app seeds
          wind turbulence from a fixed number, 42, so the same design always flies the
          same flight, while desktop OpenRocket draws a random seed for each simulation
          and does not save it, so the same design opened there again does not repeat
          its gusts. <strong>Rogers Modified Barrowman</strong> adds the
          body-in-presence-of-fins lift carryover (NACA&nbsp;1307) that classic Barrowman
          drops — a slightly more aft CP that tracks real flight data
          better, so it's the default. An aft CP RAISES the stability margin shown,
          so it is not the safer answer by itself; it is the closer one. <strong>The app's supersonic model</strong> extends the
          same kernel with corrected supersonic fin lift (2D Busemann level), the exact
          NACA&nbsp;1307 interference, Mach-dependent nose lift, per-shape wave drag with
          physical hypersonic decay, and Van&nbsp;Driest&nbsp;II friction — CP and drag
          then move with Mach the way wind tunnels measure (built from the open
          literature and validated against NASA ARCAS and Basic Finner data to
          Mach&nbsp;4.6). A model applies to the <strong>entire flight</strong>, subsonic
          portions included, so expect stability and apogee to shift when the model
          changes. <strong>Auto</strong> flies Rogers Kbf and re-flies the whole flight
          on the supersonic model only when it's projected past Mach&nbsp;0.9. Each
          saved run records which model flew it.
        </p>

        <h3 className="prefs-section">3D printing</h3>
        {/* Setting a printer is what lets the 🖨 STL button check a part
            against it and offer to split an oversized one. Leaving it unset is
            a first-class state: the export then behaves exactly as it did
            before splitting existed. */}
        <div className="field-grid">
          <div className="field">
            <label htmlFor={idFor('printer')}>Printer</label>
            <select
              id={idFor('printer')}
              value={printer
                ? (PRINTER_PRESETS.some((p) => p.id === printer.preset) ? printer.preset : CUSTOM_PRESET)
                : ''}
              onChange={(e) => {
                const id = e.target.value;
                if (id === '') setPrinter(undefined);
                else if (id === CUSTOM_PRESET) setPrinter({ ...(printer ?? CUSTOM_SEED), preset: CUSTOM_PRESET });
                else setPrinter(printerFromPreset(id, printer) ?? undefined);
              }}
            >
              <option value="">Not set — export parts whole</option>
              {PRINTER_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} — {p.mm[0]} × {p.mm[1]} × {p.mm[2]} mm
                </option>
              ))}
              <option value={CUSTOM_PRESET}>Custom…</option>
            </select>
          </div>
          {printer && (
            <>
              {axisField('x', 'Bed X')}
              {axisField('y', 'Bed Y')}
              {axisField('z', 'Maximum Z')}
              <div className="field">
                {/* Its aria-label read "Joint clearance" under these words:
                    two copies of one name, already drifted apart. */}
                <label htmlFor={idFor('printer-clearance')}>Joint clearance (per side) <UnitChip quantity="length" /></label>
                <NumField
                  id={idFor('printer-clearance')}
                  value={toUi(printer.clearance)}
                  step={niceStep(toUi(0.00005))}
                  // 0 is not "no clearance", it is two parts that cannot be
                  // assembled; prefs substitutes the 0.15 mm default for it,
                  // which is safe but silent. Refuse it at the keyboard.
                  min={toUi(0.00002)}
                  onCommit={(v) => {
                    if (v !== null) setPrinter({ ...printer, clearance: uiToSi('length', lengthSym, v) });
                  }}
                />
              </div>
            </>
          )}
        </div>
        <p className="prefs-hint">
          With a printer set, the <strong>🖨 STL</strong> button on a component measures the
          part against it and says so — and when a part is too tall, it offers to export it
          as numbered segments with a glued spigot instead of one unprintable file. It never
          splits silently: the piece count is in the button and in the file names.
          {' '}<strong>{(DEFAULT_PRINT_MARGIN * 1000).toFixed(0)} mm</strong> is kept clear at
          both edges of the bed in X and Y (room for a brim) and at the top of Z (gantry
          clearance) — the part stands on the bed, so nothing comes off the bottom of Z.
          {' '}<strong>Joint clearance</strong> is the gap per side between a spigot and its
          socket — 0.15&nbsp;mm suits FDM and 30-minute epoxy; drop it toward 0.05&nbsp;mm only
          if you glue with thin CA, which seizes in a wider gap. Print every segment of a part
          in the <strong>same material on the same printer</strong>: PLA shrinks about 0.3% and
          ASA/ABS 0.6–0.8%, which only cancels out when both halves shrink alike.
        </p>

        <p className="prefs-hint">
          Values are stored in SI internally — switching units never changes your design,
          only how numbers are shown and typed.
        </p>
      </div>
    </div>
  );
}
