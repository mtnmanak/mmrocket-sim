/**
 * App version + changelog — the single source of truth for what the user
 * sees. Beta scheme (owner's rule): 0.NNN, incrementing NNN by 1 for every
 * released (pushed) build, until the first production release resets to
 * 1.0.0. The npm package versions stay independent (they're internal
 * workspace plumbing; npm requires strict semver).
 *
 * Release checklist: bump APP_VERSION, prepend a CHANGELOG entry, commit,
 * push.
 */

export const APP_VERSION = '0.004';

export interface ChangelogEntry {
  version: string;
  /** ISO date of the release. */
  date: string;
  title: string;
  items: string[];
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: '0.004',
    date: '2026-07-03',
    title: 'Preset database completeness — the desktop\'s own component files',
    items: [
      'The desktop app bundles its own component database beyond the public GitHub one — Fruity Chutes Enhanced (42 chutes, was 10 here), Spherachutes (46), Rocketman (107), FlisKits (160), Front Range, b2 Rocketry, Quest, and ~440 more legacy parts. All merged in: the preset database grows from 3,936 to 4,700 parts.',
      'Investigated the "215 mph descent" report: the descent-rate math is correct — that number is the OPENING velocity of the main when the drogue stage is a 36"×1" streamer, which genuinely cannot brake an 800 g rocket (kernel-verified: the same 15" chute deployed at apogee descends at 26 mph). The per-device recovery table from v0.003 shows exactly this.',
    ],
  },
  {
    version: '0.003',
    date: '2026-07-03',
    title: 'Dual-deployment aware recovery reporting',
    items: [
      'The launch report now lists EVERY recovery deployment by device name (drogue, main, …) with its own deploy time, altitude, opening velocity, descent rate, and verdict — safety warnings name the device that caused them.',
      'Descent-rate safety uses the accepted dual-deploy numbers: descent under a drogue up to 70 ft/s is fine, landing target is 20 ft/s or lower. A main opening under a healthy drogue no longer trips a false "high velocity at deployment" warning.',
      'New "Landing descent rate" line and verdict in the report; CSV gains Deployments, Drogue descent rate, Landing rate columns.',
      'Engine: flight events now carry their source component name (differential-tested with a dual-deploy golden scenario).',
    ],
  },
  {
    version: '0.002',
    date: '2026-07-03',
    title: 'Delay handling the way flyers actually do it + nose cone OD/ID sync',
    items: [
      'Ejection delay is editable right on the Motor panel — type any value without reloading the motor (typing overrides auto). The manufacturer\'s prescribed delays are shown for reference.',
      'Motor browser delay picker adds "Custom (drilled)…" — enter any delay, not just the prescribed list.',
      'Auto (optimal) delay now recommends the nearest WHOLE second to the simulated optimum (e.g. optimal 12.7 s → 13 s), matching how delays get drilled in the real world — it no longer snaps to the manufacturer\'s prescribed values. Batch simulation uses the same rule.',
      'Nose cone base now syncs like a body tube: base outer diameter, base inner diameter, and wall thickness — editing any one updates the others.',
    ],
  },
  {
    version: '0.001',
    date: '2026-07-03',
    title: 'First versioned beta — full response to the 3 July test pass',
    items: [
      'Fin tabs (through-the-wall) on trapezoidal, freeform and elliptical fin sets: depth/length/offset, "Fit tab to motor tube", 2D rendering, centering-ring snap, desktop-compatible .ork round-trip; tab volume counts toward fin mass and CG.',
      'Numeric input rebuilt: type negatives freely, clearing never resets to 0, letters and invalid values turn the field red and are not committed, display capped at 3 decimals (full precision stored).',
      'Session autosave & restore: the whole working state survives closing the tab or a crash.',
      '"New" asks for confirmation and offers to save the .ork first.',
      'Launch report: ~30 flight-day attributes including times to rod departure/burnout/apogee, rod-exit velocity and thrust:weight, launch mass/CG/CP/static margin, altitude & velocity at deployment, optimal delay (ballistic-probe) and recommended delay, safety verdicts, weathercocking, execution time.',
      'Saved simulations: every run persists, compare in a table, download all as CSV (33 columns).',
      'Batch simulate: fly every motor that fits the mount with per-motor optimal delay, acceptance criteria (min rod-exit speed, min thrust:weight, apogee window), progress + cancel, CSV.',
      '"Auto (optimal)" ejection-delay option in the motor browser.',
      'EX motor import from RASP (.eng) and RockSim (.rse) files — imported motors live under manufacturer "EX" and simulate like any other.',
      'Component editing: wall thickness ⇄ inner diameter dual input, finish "→ all", per-component mass/CG/position readout, two add buttons, new components inherit diameter/material/finish from the previous one, duplicate (⧉), override boxes show the calculated value until overridden, color quick-presets, motor-mount tubes auto-name.',
      '2D view: wheel zoom, drag-to-pan, reset view; nose/transition shoulders drawn sliding into their tubes.',
      'Rocket names: imported designs falling back to the desktop\'s generic "Rocket" take the filename; saves already use the rocket name.',
      '487 RockSim catalog parts merged into the preset database (now 3,936 parts).',
      'Engine: simulations are now strictly deterministic run-to-run (fixed an upstream OpenRocket force-summation ordering bug); differential JVM↔JS parity re-verified.',
    ],
  },
];

/** Milestones that predate version numbering (shown at the bottom of the changelog). */
export const PRE_VERSIONING_NOTE = `Before versioning (June–July 2026): Phase 0 engine spikes and the TeaVM
decision; Phase 1 MVP (real OpenRocket kernel in the browser, motor search,
.ork files); Phase 2 (component-tree editor, 3D view, launch conditions, plot
series, full-tree .ork); fin cross-sections + freeform fin editor; desktop-
mirrored units & preferences with click-to-change units; motor selection
rewrite with the bundled thrustcurve.org database; materials, 3,449-part
preset database, snap positioning and display colors.`;
