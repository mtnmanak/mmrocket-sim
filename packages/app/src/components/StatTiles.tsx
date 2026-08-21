import { useRef, useState } from 'react';
import type { StaticInfo } from '@online-openrocket/engine';
import { usePrefs } from '../prefs/PrefsContext.js';
import { fmtSi, type Quantity } from '../prefs/units.js';
import { stabilityState, type SimRun } from '../services/simReport.js';
import { UnitChip } from './UnitChip.js';

/** Shared tiered styling: under-stable = red, over-stable = yellow caution. */
export function stabilityGlyphClass(cal: number | null | undefined): { glyph: string; cls: string } {
  const st = stabilityState(cal);
  return st === 'under' ? { glyph: '⚠', cls: 'stability-bad' }
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

export function DesignStats({ info, motorLabel }: { info: StaticInfo; motorLabel?: string }) {
  const { prefs } = usePrefs();
  const len = prefs.units.length;
  const mass = prefs.units.mass;
  const { glyph, cls } = stabilityGlyphClass(info.stabilityCalibers);
  const stabilityPct = info.length > 0
    ? ((info.cp - info.cg) / info.length) * 100
    : 0;
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
        <Tile label="CP" value={fmtSi('length', len, info.cp, 3)} quantity="length" />
        <Tile
          label="Stability"
          value={`${glyph} ${info.stabilityCalibers.toFixed(2)}`}
          unit="cal"
          className={cls}
        />
        <Tile
          label="Stability"
          value={stabilityPct.toFixed(1)}
          unit="%"
          className={cls}
        />
      </div>
    </>
  );
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
  return { x: 12, y: 12, folded: false };
}

export function StatsChip({ info }: { info: StaticInfo }) {
  const { prefs } = usePrefs();
  const len = prefs.units.length;
  const { glyph, cls } = stabilityGlyphClass(info.stabilityCalibers);
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
            <span className={`stats-chip-value ${cls}`}>{glyph} {info.stabilityCalibers.toFixed(2)} cal</span>
          </div>
        )
        : (
          <>
            {row('Length', `${fmtSi('length', len, info.length, 3)} ${len}`)}
            {row('Mass loaded', `${fmtSi('mass', prefs.units.mass, info.mass)} ${prefs.units.mass}`)}
            {row('CG', `${fmtSi('length', len, info.cg, 3)} ${len}`)}
            {row('CP', `${fmtSi('length', len, info.cp, 3)} ${len}`)}
            {row('Stability', `${glyph} ${info.stabilityCalibers.toFixed(2)} cal`, cls)}
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
  render: (run: SimRun, u: { dist: string; vel: string; acc: string; mass: string }) =>
    { value: string; quantity?: Quantity; unit?: string };
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
    render: (r) => ({ value: r.launchStaticMarginCal === null ? '—' : r.launchStaticMarginCal.toFixed(2), unit: 'cal' }),
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
        <button className="file-btn" style={{ alignSelf: 'flex-start' }}
          title="Choose which metrics show here"
          onClick={() => setPicking(!picking)}>⚙</button>
      </div>
      {picking && (
        <div className="panel" style={{ marginTop: 6, padding: '8px 12px' }}>
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
