import { NumField } from './NumField.js';
import { useDialog } from './useDialog.js';
import { UnitChip } from './UnitChip.js';
import { usePrefs } from '../prefs/PrefsContext.js';
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
  const { prefs, setPrefs } = usePrefs();

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
      <label>{label} <UnitChip quantity="length" /></label>
      <NumField
        value={printer ? toUi(printer[axis]) : undefined}
        step={niceStep(toUi(0.001))}
        ariaLabel={label}
        onCommit={(v) => { if (v !== null && v > 0) setAxis(axis, uiToSi('length', lengthSym, v)); }}
      />
    </div>
  );

  const dialogRef = useDialog(onClose);

  return (
    <div className="prefs-overlay" role="presentation" onClick={onClose}>
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
          <div className="field">
            <label>First-run tour</label>
            <select
              value={prefs.tourOff ? 'off' : 'on'}
              onChange={(e) => setPrefs({ ...prefs, tourOff: e.target.value === 'off' })}
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

        <h3 className="prefs-section">Aerodynamics</h3>
        {/* ONE pulldown, four explicit choices (2026-08-05c #9 — the separate
            Kbf checkbox next to a "Classic" option read as two things both
            called classic). The select derives from and writes BOTH stored
            prefs (aeroModel + rogersKbf) — no migration needed. */}
        <div className="field">
          <label>Aerodynamics model</label>
          <select
            value={(prefs.aeroModel ?? 'classic') === 'classic'
              ? ((prefs.rogersKbf ?? true) ? 'kbf' : 'eb')
              : (prefs.aeroModel ?? 'classic')}
            onChange={(e) => {
              const v = e.target.value;
              setPrefs({
                ...prefs,
                aeroModel: v === 'eb' || v === 'kbf' ? 'classic' : (v as 'supersonic' | 'auto'),
                // Kbf rides along under Auto too (it's the better subsonic model).
                rogersKbf: v !== 'eb',
              });
            }}
          >
            <option value="eb">OpenRocket — Extended Barrowman (exact desktop parity)</option>
            <option value="kbf">Rogers Modified Barrowman (Kbf) — the default</option>
            <option value="auto">Auto — Rogers Kbf, switching to our supersonic model past Mach 0.9</option>
            <option value="supersonic">Supersonic — our extended model at all speeds (validated to Mach 4.6)</option>
          </select>
        </div>
        <p className="prefs-hint">
          <strong>OpenRocket — Extended Barrowman</strong> is the desktop program's exact
          physics, bit-for-bit. <strong>Rogers Modified Barrowman</strong> adds the
          body-in-presence-of-fins lift carryover (NACA&nbsp;1307) that classic Barrowman
          drops — a slightly more aft, more conservative CP that tracks real flight data
          better, so it's the default. <strong>Our supersonic model</strong> extends the
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
            <label>Printer</label>
            <select
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
                <label>Joint clearance (per side) <UnitChip quantity="length" /></label>
                <NumField
                  value={toUi(printer.clearance)}
                  step={niceStep(toUi(0.00005))}
                  ariaLabel="Joint clearance"
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
          each end of every axis (brim and first layer at the bed, gantry clearance up top).
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
