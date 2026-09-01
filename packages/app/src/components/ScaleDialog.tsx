import { useEffect, useMemo, useState } from 'react';
import type { RocketTree } from '@online-openrocket/engine';
import { NumField } from './NumField.js';
import { useDialog } from './useDialog.js';
import { usePrefs } from '../prefs/PrefsContext.js';
import { siToUi, uiToSi } from '../prefs/units.js';
import { loadPresets, type Preset } from '../services/presets.js';
import { classLabel } from '../services/motorDb.js';
import {
  maxBodyDiameter, previewMounts, rocketLength, scaleRocket, type ScaleResult,
} from '../tree/scaleRocket.js';

/**
 * Scale the whole rocket — the upscale/downscale workflow Eric queued in
 * issues-2026-08-31a and released in c ("I read the research doc - overall, I
 * say 'go' - build it").
 *
 * Two ways in, because those are the two ways builders actually think about it
 * (his ruling, and the Apogee article's own workflow):
 *
 *  - a FACTOR, for "make it half size";
 *  - a TARGET BODY DIAMETER, for the real workflow — "I have 4 inch tube, what
 *    does this 2.6 inch plan become?" The catalogue dropdown fills that in
 *    from a tube you can actually buy, which is where a scale project starts:
 *    "find the nose cone first… factor = new tube OD ÷ original tube OD".
 *
 * The two fields are linked, exactly like desktop OpenRocket's "Scale from X
 * to Y" pair. Desktop then applies the change silently; this dialog says what
 * it is about to do to the motor mounts first, because a scaled mount usually
 * is not a motor you can buy.
 */
export function ScaleDialog({ tree, assignedMotorDiameters, onApply, onSaveBackup, onClose }: {
  tree: RocketTree;
  /** Motor diameter (m) per mount id, for the "does it still fit" check. */
  assignedMotorDiameters: Record<string, number>;
  onApply: (result: ScaleResult) => void;
  onSaveBackup: () => void;
  onClose: () => void;
}) {
  const dialogRef = useDialog(onClose);
  const { prefs } = usePrefs();
  const lenSym = prefs.units.length;

  const baseD = maxBodyDiameter(tree);
  const baseL = rocketLength(tree);

  const [factor, setFactor] = useState(2);
  const [snapMounts, setSnapMounts] = useState(false);
  const [tubes, setTubes] = useState<Preset[] | null>(null);
  /**
   * The chosen catalogue ROW, as an index into `tubeRows`, held so the <select>
   * is genuinely controlled. Pinning it to value="" instead reset the widget to
   * the placeholder after every change, which a mouse user never notices and a
   * keyboard user cannot get past: ArrowDown moves from the placeholder to the
   * first option, the value resets, and the next ArrowDown does the same again.
   *
   * A ROW, not a diameter, since v0.091: the list used to collapse every tube
   * within 0.1 mm to one entry, so picking a size applied the FIRST row's
   * diameter rather than the one you chose.
   */
  const [tubeRow, setTubeRow] = useState('');
  const [busy, setBusy] = useState(false);

  /**
   * Set the factor from anywhere that is NOT the catalogue, clearing the
   * catalogue selection with it — otherwise the select goes on naming a tube
   * whose OD contradicts the factor now in the box.
   *
   * One function because the pair was copied into two handlers and the third
   * entry point (the 0.5× / 2× buttons) was written without it, which is the
   * bug this replaces. A fourth entry point gets it for free.
   */
  const setFactorOffCatalogue = (f: number) => { setFactor(f); setTubeRow(''); };

  useEffect(() => {
    loadPresets()
      .then((all) => setTubes(all.filter((p) => p.kind === 'BodyTube'
        && typeof p['outsideDiameter'] === 'number')))
      .catch(() => setTubes([]));
  }, []);

  /**
   * Every catalogue tube, grouped by outside diameter — one <optgroup> per
   * 0.1 mm bucket, one <option> per real part inside it.
   *
   * It used to show ONE row per bucket with "(+N more)" after it, and the
   * owner reported the consequence: a specific tube could be unreachable. That
   * was not a corner case. Measured on the shipped data: 1,309 body tubes fall
   * into 215 buckets, so 1,094 rows were unselectable, one bucket holds 87 of
   * them, and his own example — Composite Warehouse "4 Inch Airframe" — sat
   * 13th of 13 behind a label reading "Always Ready Rocketry BT_3.90_48".
   * (The old comment here said the raw set held "246 values for 215 real
   * sizes", which is off by a factor of five and is what made the collapse
   * look harmless.)
   *
   * The bucketing itself is KEPT, as the grouping: it is what stops 53.98 mm
   * and 54.00 mm reading as two unrelated sizes, and it preserves the ordered
   * ladder of buyable diameters that made the list usable in the first place.
   * What changes is that the group is now openable instead of being a count.
   */
  const tubeRows = useMemo(
    () => [...(tubes ?? [])].sort((a, b) => (a['outsideDiameter'] as number) - (b['outsideDiameter'] as number)
      || String(a.manufacturer).localeCompare(String(b.manufacturer))
      || String(a.partNo).localeCompare(String(b.partNo))),
    [tubes],
  );

  const tubeGroups = useMemo(() => {
    const out: Array<{ key: number; od: number; rows: Array<{ i: number; p: Preset }> }> = [];
    tubeRows.forEach((p, i) => {
      const od = p['outsideDiameter'] as number;
      const key = Math.round(od * 10000);
      const last = out[out.length - 1];
      if (last && last.key === key) last.rows.push({ i, p });
      else out.push({ key, od, rows: [{ i, p }] });
    });
    return out;
  }, [tubeRows]);

  const targetD = baseD * factor;
  const mounts = useMemo(
    () => previewMounts(tree, factor, assignedMotorDiameters, snapMounts),
    [tree, factor, assignedMotorDiameters, snapMounts],
  );
  const snappable = mounts.filter((m) => m.snappable);
  const lostMotors = mounts.filter((m) => !m.motorStillFits);

  const fmt = (si: number, places = 1) => siToUi('length', lenSym, si).toFixed(places);

  const apply = () => {
    if (busy) return;
    setBusy(true);
    onApply(scaleRocket(tree, factor, { snapMounts, assignedMotorDiameters }));
    onClose();
  };

  const usable = Number.isFinite(factor) && factor > 0 && factor !== 1 && baseD > 0;

  return (
    <div className="prefs-overlay" role="presentation" onClick={onClose}>
      <div
        className="prefs-dialog panel"
        role="dialog"
        aria-modal="true"
        aria-label="Scale rocket"
        ref={dialogRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <h2 style={{ flex: 1 }}>Scale rocket</h2>
          <button className="file-btn" onClick={onClose} aria-label="Close scale dialog">✕ Close</button>
        </div>

        {baseD <= 0 ? (
          <p className="comp-stats">
            This design has no body tube, nose cone or transition to measure, so there is
            nothing to scale from. Add an airframe first.
          </p>
        ) : (
          <>
            <p className="comp-stats" style={{ marginTop: 0 }}>
              Every length, diameter, wall, fin and position is multiplied by one factor.
              It lands as a single step, so Ctrl+Z puts the design back.
            </p>

            <div className="field">
              {/* The htmlFor is live again: NumField now takes an `id` and puts it
                  on the real <input>. Before, it pointed at nothing (the wrapper
                  div is not labelable) so clicking this label did nothing, while
                  the <select>'s label below worked — and simply deleting the
                  dangling attribute would have left that behaviour unchanged.

                  NO ariaLabel on these two fields, deliberately. An aria-label
                  BEATS an associated <label> in the accessible-name
                  computation, so "Scale factor" would replace the visible
                  "Scale by" — WCAG 2.5.3 label-in-name, and a voice-control
                  user saying "click Scale by" matches nothing. Elsewhere in
                  the app (LaunchPanel, PropertyPanel) ariaLabel is right,
                  because those labels are NOT associated and the aria-label is
                  the only name there is; the rule is that once a label is
                  wired, it is the name. */}
              <label htmlFor="scale-factor">Scale by</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <NumField
                  id="scale-factor"
                  value={factor}
                  onCommit={(v) => { if (v !== null && v > 0) setFactorOffCatalogue(v); }}
                  min={0.01}
                  max={100}
                  step={0.05}
                />
                <span className="comp-stats" style={{ whiteSpace: 'nowrap' }}>
                  × &nbsp;({(factor * 100).toFixed(1)} %)
                </span>
                {[0.5, 2].map((f) => (
                  <button
                    key={f}
                    type="button"
                    className="file-btn"
                    onClick={() => setFactorOffCatalogue(f)}
                  >
                    {f}×
                  </button>
                ))}
              </div>
            </div>

            <div className="field">
              <label htmlFor="scale-target">New body diameter ({lenSym})</label>
              <NumField
                id="scale-target"
                value={Number(siToUi('length', lenSym, targetD).toFixed(4))}
                onCommit={(v) => {
                  if (v === null || !(v > 0)) return;
                  const si = uiToSi('length', lenSym, v);
                  if (si > 0 && baseD > 0) setFactorOffCatalogue(si / baseD);
                }}
                min={0.0001}
                step={1}
              />
              <span className="comp-stats">
                The widest body diameter is {fmt(baseD)} {lenSym} today. Type what you are
                building it in and the factor follows — that is how a scale project actually
                starts: find the tube, then let everything else follow it.
              </span>
            </div>

            <div className="field">
              <label htmlFor="scale-tube">…or pick a tube from the catalogue</label>
              <select
                id="scale-tube"
                value={tubeRow}
                disabled={!tubes}
                onChange={(e) => {
                  setTubeRow(e.target.value);
                  const row = tubeRows[Number(e.target.value)];
                  // The chosen row's OWN diameter, not its group's. Applying
                  // the group's first row moved the factor by up to 0.3 %
                  // against the part actually named on screen.
                  const od = row ? (row['outsideDiameter'] as number) : 0;
                  if (od > 0 && baseD > 0) setFactor(od / baseD);
                }}
              >
                <option value="">
                  {tubes === null
                    ? 'Loading the catalogue…'
                    : `${tubeRows.length} tubes in ${tubeGroups.length} sizes — choose one`}
                </option>
                {tubeGroups.map((g) => (
                  // Three decimals in inches: at two, 0.254 mm of resolution
                  // makes distinct sizes print the same number.
                  <optgroup key={g.key} label={`${fmt(g.od, lenSym === 'in' ? 3 : 2)} ${lenSym}`}>
                    {g.rows.map(({ i, p }) => (
                      <option key={i} value={i}>
                        {p.manufacturer} {p.partNo}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>

            <p className="comp-stats">
              <strong>{fmt(baseL, 0)} × {fmt(baseD)} {lenSym}</strong>
              {' becomes '}
              <strong>{fmt(baseL * factor, 0)} × {fmt(targetD)} {lenSym}</strong>
              {'. Solid parts keep their material, so their mass goes as the cube — about '}
              {(factor ** 3).toFixed(2)}×. A parachute does not: its canopy is fabric of a fixed
              thickness, so it scales with its area, which is right for a real build and means
              the design is no longer exactly similar. Descent rate goes as roughly the square
              root of the factor — about {Math.sqrt(factor).toFixed(2)}× — so size the canopy for
              the new mass rather than trusting the scaled one.
            </p>

            {mounts.length > 0 && (
              <div className="field">
                <label>Motor mounts</label>
                <ul className="comp-stats" style={{ margin: 0, paddingLeft: 18 }}>
                  {mounts.map((m) => (
                    <li key={m.id}>
                      {m.name}: {m.boreMm.toFixed(1)} →{' '}
                      <strong>{m.finalBoreMm.toFixed(1)} mm</strong>
                      {/* One discriminant, computed in previewMounts — see
                          MountPreview.verdict. Re-deriving it here from
                          onStandardClass/snappable/isAirframe is what let this
                          list and the post-apply note disagree about an
                          off-class airframe mount with the snap unticked. */}
                      {m.verdict === 'on-class'
                        ? <> — a standard {classLabel(m.nearestMm)} mm.</>
                        : m.verdict === 'snapped'
                          ? <> — snapped {m.nearestMm > m.scaledBoreMm ? 'up' : 'down'} from{' '}
                            {m.scaledBoreMm.toFixed(1)} mm to the
                            standard {classLabel(m.nearestMm)} mm.</>
                          : m.verdict === 'airframe-left'
                            ? <> — not a motor size you can buy (nearest is{' '}
                              {classLabel(m.nearestMm)} mm), and this mount <em>is</em> the
                              airframe, so it is left for you to resize.</>
                            : <> — not a motor size you can buy; nearest is{' '}
                              {classLabel(m.nearestMm)} mm.</>}
                      {!m.motorStillFits && m.motorMm !== null && (
                        <> <strong>The {m.motorMm.toFixed(0)} mm motor loaded in it will no longer
                          fit.</strong>
                          {m.verdict === 'snapped' && m.motorFitsUnsnapped && (
                            <> Snapping is what loses it — the scaled{' '}
                              {m.scaledBoreMm.toFixed(1)} mm bore still takes it.</>
                          )}</>
                      )}
                    </li>
                  ))}
                </ul>
                {snappable.length > 0 && (
                  <label style={{ display: 'flex', gap: 6, alignItems: 'flex-start', marginTop: 6 }}>
                    <input
                      type="checkbox"
                      checked={snapMounts}
                      onChange={(e) => setSnapMounts(e.target.checked)}
                    />
                    <span className="comp-stats">
                      Snap each mount to the nearest standard motor size, keeping its wall
                      thickness. Leave this off to get the true geometric scale and choose the
                      mount yourself — the nearest size is not always the right one.
                    </span>
                  </label>
                )}
              </div>
            )}

            <p className="comp-stats">
              The <strong>Measured mass &amp; CG</strong> box is cleared, because it describes a
              rocket that will no longer exist. That is the one thing Ctrl+Z cannot put back —
              undo covers the design tree — so write those two numbers down first if you want
              them.
            </p>

            <p className="comp-stats">
              <strong>Kept at their own size:</strong> camera shrouds (the camera does not scale)
              and rail buttons (they come in fixed sizes — micro, mini, 1010, 1515, unistrut), and
              a launch lug&rsquo;s bore, which is the launch rod&rsquo;s. They move to their new
              stations. <strong>Never scaled:</strong> angles, fin and instance counts, densities,
              drag coefficients, finish, motor choice, deployment settings, launch conditions.
            </p>

            <p className="comp-stats">
              What no simulator can scale: Reynolds number, the ratio of inertia to aerodynamic
              moment, and surface finish. The flight is recomputed for the new size rather than
              assumed — which is the point of doing it here rather than on a photocopier — but a
              big downscale can fly worse than the arithmetic suggests.
            </p>

            {lostMotors.length > 0 && (
              <p className="file-note file-note-warn">
                A loaded motor will not fit the scaled mount. The design still scales; pick a new
                motor on Motors &amp; Launch afterwards.
              </p>
            )}

            <div className="modal-actions">
              <button className="file-btn" onClick={onSaveBackup}>
                Save a .ork backup first
              </button>
              <button
                className="file-btn file-btn-primary"
                onClick={apply}
                disabled={!usable}
              >
                Scale to {(factor * 100).toFixed(1)} %
              </button>
              <button className="file-btn" onClick={onClose}>Cancel</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
