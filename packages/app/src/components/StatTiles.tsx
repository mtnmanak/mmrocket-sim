import { useLayoutEffect, useRef, useState } from 'react';
import type { StaticInfo } from '@online-openrocket/engine';
import { usePrefs } from '../prefs/PrefsContext.js';
import { RULER_LEFT, RULER_TOP } from './TreeSchematic.js';
import { ROLL_COL } from './RollControl.js';
import { fmtSi, type Quantity } from '../prefs/units.js';
import {
  formatRunStability, formatStability, hasAerodynamicForce, shownCp, shownStability,
  stabilityPercent, stabilityState,
  type SimRun, type StabilityUnit,
} from '../services/simReport.js';
import { UnitChip } from './UnitChip.js';

/** Shared tiered styling: under-stable = red, over-stable = yellow caution. */
export function stabilityGlyphClass(cal: number | null | undefined): { glyph: string; cls: string } {
  const st = stabilityState(cal);
  // `null` means "not known", and it used to fall through to the ✓ — so an
  // absent or non-finite margin painted the same green tick as a good one.
  // Unknown gets its own neutral glyph.
  return st === null ? { glyph: '–', cls: 'stability-unknown' }
    : st === 'under' ? { glyph: '⚠', cls: 'stability-bad' }
    : st === 'over' ? { glyph: '△', cls: 'stability-warn' }
    : { glyph: '✓', cls: 'stability-good' };
}

function Tile({ label, value, unit, quantity, className }: {
  label: string;
  value: string;
  unit?: string;
  /** When set, the unit is a click-to-change chip for this quantity group. */
  quantity?: Quantity;
  className?: string;
}) {
  return (
    <div className="stat-tile">
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${className ?? ''}`}>
        {value}
        {quantity
          ? <span className="stat-unit"><UnitChip quantity={quantity} /></span>
          : unit && <span className="stat-unit">{unit}</span>}
      </div>
    </div>
  );
}

/**
 * Reference Mach for the design-tab drag coefficient. Subsonic and well clear
 * of the transonic rise, so the number is stable while you edit — it is a
 * shape figure to compare designs and to watch while trimming a Cd override,
 * not a prediction for a particular flight.
 */
export const CD_REFERENCE_MACH = 0.3;

export function DesignStats({ info, motorLabel, cd }: {
  info: StaticInfo;
  motorLabel?: string;
  /**
   * Power-off total Cd at CD_REFERENCE_MACH, or null while it is unavailable.
   * Added 2026-08-23: the owner pointed out that with no Cd anywhere on the
   * Design tab, setting a Cd override changed nothing the user could see —
   * the whole override feature had no feedback loop.
   */
  cd?: number | null;
}) {
  const { prefs } = usePrefs();
  const len = prefs.units.length;
  const mass = prefs.units.mass;
  // No aerodynamic normal force -> the CP and the margin are artefacts, not
  // answers (see hasAerodynamicForce). Report them as unavailable rather than
  // printing a number the design does not support.
  const aero = hasAerodynamicForce(info);
  const { glyph, cls } = stabilityGlyphClass(aero ? shownStability(info) : null);
  const pct = aero ? stabilityPercent(info) : null;
  // Only worth showing when the clocking actually changes the answer: three or
  // more fins measure identically swept or not.
  const planeDiffers = info.cpWorst !== undefined
    && Math.abs(info.cpWorst - info.cp) > 1e-9;
  return (
    <>
      <div className="stat-row">
        <Tile label="Length" value={fmtSi('length', len, info.length, 3)} quantity="length" />
        <Tile label="Max diameter" value={fmtSi('length', len, info.refDiameter, 3)} quantity="length" />
        <Tile label="Mass (empty)" value={fmtSi('mass', mass, info.massEmpty)} quantity="mass" />
        <Tile label="Mass (loaded)" value={fmtSi('mass', mass, info.mass)} quantity="mass" />
        {motorLabel && <Tile label="Motor" value={motorLabel} />}
      </div>
      <div className="stat-row">
        <Tile label="CG (empty)" value={fmtSi('length', len, info.cgEmpty, 3)} quantity="length" />
        <Tile label="CG (loaded)" value={fmtSi('length', len, info.cg, 3)} quantity="length" />
        <Tile
          label="CP"
          value={aero ? fmtSi('length', len, shownCp(info), 3) : '—'}
          quantity={aero ? 'length' : undefined}
        />
        <Tile
          label="Stability"
          value={aero ? `${glyph} ${shownStability(info).toFixed(2)}` : '— no lift yet'}
          unit={aero ? 'cal' : undefined}
          className={cls}
        />
        {/* The All-stats drawer is the "everything" view, so it shows BOTH
            forms regardless of the stability-unit preference — but the two
            tiles must not both read "Stability". */}
        <Tile
          label="Stability (of length)"
          value={pct === null ? '—' : pct.toFixed(1)}
          unit="%"
          className={cls}
        />
        {/* The single-plane figure, kept because the swept one deliberately
            cannot see it. CP and Stability above are the most-forward CP over
            a full roll sweep, which is clocking-independent — right for a
            safety readout, and exactly why rotating a camera shroud no longer
            moves them. This tile is where that still shows: mount a shroud on
            the side and THIS number moves while the headline holds at the
            worst case. Hidden when the two agree, which is every symmetric
            design, so it does not add a tile to rockets it tells nothing
            about. */}
        {aero && planeDiffers && (
          <Tile
            label="CP in this plane"
            value={fmtSi('length', len, info.cp, 3)}
            quantity="length"
          />
        )}
        <Tile
          label={`Cd (M${CD_REFERENCE_MACH})`}
          value={cd === null || cd === undefined ? '—' : cd.toFixed(3)}
        />
      </div>
      {/*
        Moments of inertia (v0.088). Loaded, about the CG, in kg·m² — rendered
        raw rather than through a UnitChip, because there is no `inertia`
        quantity group and adding one would put a persisted unit preference on
        the screen for a quantity almost nobody switches.

        These are here because they were the quantity NOTHING displayed. A
        covering mass override scaled the mass and left the inertia summing the
        children's geometric masses, and the defect survived two years precisely
        because no screen, no export except the flight-data XLSX, and not even
        desktop OpenRocket's design tab shows the number. Publishing it is what
        makes the fix checkable by the person whose rocket it is.

        Roll is the axis a canted fin set spins the rocket about; pitch is the
        one that governs weathercocking, which is why a wrong value shows up as
        downwind drift long before it shows up in apogee.
      */}
      <div className="stat-row">
        <Tile label="Roll inertia (loaded)"
          value={fmtInertia(info.rotationalInertia)} unit="kg·m²" />
        <Tile label="Pitch inertia (loaded)"
          value={fmtInertia(info.longitudinalInertia)} unit="kg·m²" />
      </div>
    </>
  );
}

/**
 * Inertia spans orders of magnitude across the designs this app sees — a BT-5
 * micro is ~1e-7 kg·m² on roll while a 6-inch two-stage is ~1e-1 on pitch — so
 * a fixed number of decimal places prints either "0.000" or a wall of digits.
 * Four significant figures, and exponent notation once a fixed-point rendering
 * would round to nothing.
 */
function fmtInertia(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (v === 0) return '0';
  return Math.abs(v) < 1e-4 ? v.toExponential(3) : v.toPrecision(4);
}

/**
 * Floating stats chip on the design canvas (S1, batch 08-21c): the five
 * numbers the owner checks constantly, overlaid on canvas sky so the stat grid
 * can live in a drawer. Read-only by design — units follow preferences but
 * the chip offers no unit chips (that's the drawer's job).
 */
/** Where the chip sits and whether it's folded to the one-line pill —
 *  remembered so it stays where the user put it (batch 08-21e). */
const CHIP_KEY = 'online-openrocket.chip.v1';

function loadChipState(): { x: number; y: number; folded: boolean } {
  try {
    const raw = localStorage.getItem(CHIP_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<{ x: number; y: number; folded: boolean }>;
      if (typeof p.x === 'number' && typeof p.y === 'number') {
        return { x: p.x, y: p.y, folded: p.folded === true };
      }
    }
  } catch { /* fall through */ }
  // Clear of the 2D view's ruler gutters and roll column — the chip is the
  // one thing on the canvas that starts in the top-left corner, which is
  // exactly where the rulers now meet. (v0.076 moved the 3D view's buttons
  // out from under this chip for the same reason.) A position the user has
  // dragged to is stored and wins; this is only where it starts.
  return { x: ROLL_COL + RULER_LEFT + 8, y: RULER_TOP + 8, folded: false };
}

export function StatsChip({ info }: { info: StaticInfo }) {
  const { prefs } = usePrefs();
  const len = prefs.units.length;
  const aero = hasAerodynamicForce(info);
  const { glyph, cls } = stabilityGlyphClass(aero ? shownStability(info) : null);
  const [chip, setChip] = useState(loadChipState);
  const ref = useRef<HTMLDivElement | null>(null);
  // Drag bookkeeping: pointer-to-chip offset at grab, and whether the pointer
  // actually traveled (a still click on the pill toggles the fold instead).
  const dragFrom = useRef<{ dx: number; dy: number; moved: boolean } | null>(null);

  const persist = (next: { x: number; y: number; folded: boolean }) => {
    setChip(next);
    try { localStorage.setItem(CHIP_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  };

  /** Keep the chip inside its canvas (the position: relative rocket stage). */
  const clamp = (x: number, y: number) => {
    const el = ref.current;
    const host = el?.offsetParent as HTMLElement | null;
    if (!el || !host) return { x, y };
    return {
      x: Math.min(Math.max(0, x), Math.max(0, host.clientWidth - el.offsetWidth)),
      y: Math.min(Math.max(0, y), Math.max(0, host.clientHeight - el.offsetHeight)),
    };
  };

  // Re-clamp on mount and whenever the canvas resizes. clamp() only ever ran
  // DURING a drag, so a position saved on a wide window restored unchanged on a
  // narrow one — outside the overflow:hidden stage, invisible, with no reset
  // control to get it back. Clamping the rendered position without rewriting
  // storage means the chip reappears here now and still returns to where the
  // user put it once the window is wide again.
  useLayoutEffect(() => {
    const host = ref.current?.offsetParent as HTMLElement | null;
    if (!host) return;
    const reclamp = () => setChip((c) => {
      const { x, y } = clamp(c.x, c.y);
      return x === c.x && y === c.y ? c : { ...c, x, y };
    });
    reclamp();
    const ro = new ResizeObserver(reclamp);
    ro.observe(host);
    window.addEventListener('resize', reclamp);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', reclamp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- clamp reads refs
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    const el = ref.current;
    if (!el) return;
    e.preventDefault();
    const start = { dx: e.clientX - chip.x, dy: e.clientY - chip.y, moved: false };
    dragFrom.current = start;
    const onMove = (ev: PointerEvent) => {
      if (!dragFrom.current) return;
      const { x, y } = clamp(ev.clientX - start.dx, ev.clientY - start.dy);
      if (Math.abs(x - chip.x) + Math.abs(y - chip.y) > 3) dragFrom.current.moved = true;
      setChip((c) => ({ ...c, x, y }));
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      const from = dragFrom.current;
      dragFrom.current = null;
      const { x, y } = clamp(ev.clientX - start.dx, ev.clientY - start.dy);
      // A still click on the folded pill unfolds it — cheaper than aiming at
      // the tiny fold button on a phone.
      if (from && !from.moved && chip.folded) persist({ x, y, folded: false });
      else persist({ ...chip, x, y });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const row = (label: string, value: string, cls2?: string) => (
    <div className="stats-chip-row">
      <span className="stats-chip-label">{label}</span>
      <span className={`stats-chip-value ${cls2 ?? ''}`}>{value}</span>
    </div>
  );

  return (
    <div
      ref={ref}
      className={`stats-chip${chip.folded ? ' stats-chip-folded' : ''}`}
      style={{ left: chip.x, top: chip.y }}
      onPointerDown={onPointerDown}
      title="Drag to move this readout anywhere on the canvas"
    >
      <button
        className="stats-chip-fold"
        aria-label={chip.folded ? 'Expand the stats readout' : 'Collapse the stats readout to one line'}
        title={chip.folded ? 'Expand' : 'Collapse to one line'}
        onClick={() => persist({ ...chip, folded: !chip.folded })}
      >
        {chip.folded ? '▸' : '▾'}
      </button>
      {chip.folded
        ? (
          <div className="stats-chip-row">
            <span className={`stats-chip-value ${cls}`}>
              {glyph} {aero ? formatStability(info, prefs.stabilityUnit) : 'no lift'}
            </span>
          </div>
        )
        : (
          <>
            {row('Length', `${fmtSi('length', len, info.length, 3)} ${len}`)}
            {row('Mass loaded', `${fmtSi('mass', prefs.units.mass, info.mass)} ${prefs.units.mass}`)}
            {row('CG', `${fmtSi('length', len, info.cg, 3)} ${len}`)}
            {row('CP', `${fmtSi('length', len, shownCp(info), 3)} ${len}`)}
            {row('Stability', `${glyph} ${aero ? formatStability(info, prefs.stabilityUnit) : 'no lift yet'}`, cls)}
          </>
        )}
    </div>
  );
}

// ---- Customizable results tiles (issue 2026-08-05b #3) ----

interface TileSpec {
  id: string;
  label: string;
  /** null value → tile renders an em-dash. */
  render: (
    run: SimRun,
    u: { dist: string; vel: string; acc: string; mass: string; stability?: StabilityUnit },
  ) => { value: string; quantity?: Quantity; unit?: string };
}

/** Every metric the highlighted tiles can show, in display order. */
export const RESULT_TILE_METRICS: TileSpec[] = [
  { id: 'apogee', label: 'Apogee', render: (r, u) => ({ value: fmtSi('distance', u.dist, r.maxAltitude), quantity: 'distance' }) },
  { id: 'maxVelocity', label: 'Max velocity', render: (r, u) => ({ value: fmtSi('velocity', u.vel, r.maxVelocity), quantity: 'velocity' }) },
  { id: 'maxMach', label: 'Max Mach', render: (r) => ({ value: r.maxMach.toFixed(2) }) },
  { id: 'maxAccel', label: 'Max accel', render: (r, u) => ({ value: fmtSi('acceleration', u.acc, r.maxAcceleration), quantity: 'acceleration' }) },
  { id: 'apogeeAt', label: 'Apogee at', render: (r) => ({ value: r.timeToApogee.toFixed(1), unit: 's' }) },
  {
    id: 'landingRate', label: 'Landing rate',
    // The old tile said "Descent hits" and quietly showed ground-hit velocity.
    render: (r, u) => ({
      value: fmtSi('velocity', u.vel, r.landingRate ?? r.groundHitVelocity), quantity: 'velocity',
    }),
  },
  {
    id: 'drogueRate', label: 'Drogue descent',
    render: (r, u) => {
      const d = (r.deployments ?? []).find((x) => !x.isLanding)?.descentRate;
      return { value: d == null ? '—' : fmtSi('velocity', u.vel, d), quantity: 'velocity' };
    },
  },
  { id: 'flightTime', label: 'Flight time', render: (r) => ({ value: r.totalFlightTime.toFixed(0), unit: 's' }) },
  {
    id: 'padWeight', label: 'Pad weight',
    render: (r, u) => ({ value: r.launchMass === null ? '—' : fmtSi('mass', u.mass, r.launchMass), quantity: 'mass' }),
  },
  {
    id: 'recoveryWeight', label: 'Recovery weight',
    render: (r, u) => ({ value: r.burnoutMass == null ? '—' : fmtSi('mass', u.mass, r.burnoutMass), quantity: 'mass' }),
  },
  {
    id: 'thrustToWeight', label: 'Thrust : weight',
    render: (r) => ({ value: r.thrustToWeightAtRod === null ? '—' : `${r.thrustToWeightAtRod.toFixed(1)} : 1` }),
  },
  {
    id: 'guideVelocity', label: 'Guide departure',
    render: (r, u) => ({ value: r.rodExitVelocity === null ? '—' : fmtSi('velocity', u.vel, r.rodExitVelocity), quantity: 'velocity' }),
  },
  {
    id: 'staticMargin', label: 'Static margin',
    render: (r, u) =>
      formatRunStability(r.launchStaticMarginCal, r.launchStaticMarginPct, u.stability),
  },
  {
    id: 'optimalDelay', label: 'Optimal delay',
    render: (r) => ({ value: r.optimumDelayS === null ? '—' : r.optimumDelayS.toFixed(1), unit: 's' }),
  },
];

/** The classic six (with "Descent hits" renamed to Landing rate). */
const DEFAULT_TILES = ['apogee', 'maxVelocity', 'maxAccel', 'apogeeAt', 'landingRate', 'flightTime'];

export function FlightStats({ run }: { run: SimRun }) {
  const { prefs, setPrefs } = usePrefs();
  const [picking, setPicking] = useState(false);
  const u = {
    dist: prefs.units.distance, vel: prefs.units.velocity,
    acc: prefs.units.acceleration, mass: prefs.units.mass,
    stability: prefs.stabilityUnit,
  };
  const chosen = prefs.resultTiles ?? DEFAULT_TILES;
  const shown = RESULT_TILE_METRICS.filter((m) => chosen.includes(m.id));
  const toggle = (id: string) => {
    const next = chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id];
    // Persist in catalog order; never drop to zero tiles.
    const ordered = RESULT_TILE_METRICS.map((m) => m.id).filter((x) => next.includes(x));
    setPrefs({ ...prefs, resultTiles: ordered.length ? ordered : DEFAULT_TILES });
  };
  return (
    <>
      <div className="stat-row" style={{ position: 'relative' }}>
        {shown.map((m) => {
          const v = m.render(run, u);
          return <Tile key={m.id} label={m.label} value={v.value} quantity={v.quantity} unit={v.unit} />;
        })}
        {/* A bare ⚙ at 12 px, top-aligned against a row of tall stat tiles, was
            "almost unnoticeable" (the owner, 2026-08-23). It carries its name now,
            sits on the tiles' centre line, and announces its state. The
            aria-label CONTAINS the visible words (WCAG 2.5.3, label in name),
            so "click choose metrics" reaches it by voice. */}
        <button
          className="file-btn stat-pick-btn"
          aria-label="Choose metrics shown here"
          aria-expanded={picking}
          aria-controls="stat-pick-panel"
          title="Choose which metrics show here"
          onClick={() => setPicking(!picking)}
        >
          ⚙ Choose metrics
        </button>
      </div>
      {picking && (
        <div id="stat-pick-panel" className="panel" style={{ marginTop: 6, padding: '8px 12px' }}>
          <p className="comp-stats" style={{ margin: '0 0 6px' }}>
            Highlighted metrics — your picks are remembered. Everything is
            always available under “Show all details”.
          </p>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {RESULT_TILE_METRICS.map((m) => (
              <label key={m.id} className="motor-inline-label" style={{ whiteSpace: 'nowrap', cursor: 'pointer' }}>
                <input type="checkbox" style={{ width: 'auto' }}
                  checked={chosen.includes(m.id)} onChange={() => toggle(m.id)} />
                {m.label}
              </label>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
