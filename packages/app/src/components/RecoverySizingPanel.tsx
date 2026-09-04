import { useEffect, useMemo, useState } from 'react';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { usePrefs } from '../prefs/PrefsContext.js';
import { fmtSi, siToUi } from '../prefs/units.js';
import { loadPresets, type Preset } from '../services/presets.js';
import type { RecoveryMass } from '../services/recoveryMass.js';
import {
  recoverySizing, type BandAdvice, type Candidate, type RecoverySizing,
} from '../services/recoverySizing.js';
import type { LaunchConditions } from './LaunchPanel.js';
import { UnitChip } from './UnitChip.js';

/**
 * "Recovery sizing" — the design page's answer to "so what chute do I buy?".
 *
 * It sits in the RIGHT column under the component properties. It shipped in
 * v0.104 beside the tree, next to the recovery weight it is computed from,
 * which read well but pushed the measured-mass box off the bottom of that
 * column; the owner moved it the same day.
 *
 * It says BOTH halves, in his order: the SIZE first, because that is the
 * answer for someone sewing their own canopy or shopping outside this
 * catalogue, and then real catalogue parts with the rate each would actually
 * give THIS rocket. Neither alone is an answer — a diameter with no Cd beside
 * it is meaningless, and a list of parts with no size line strands anyone who
 * does not buy from the five manufacturers we happen to carry.
 *
 * The arithmetic, the bands and every judgement call live in
 * services/recoverySizing.ts; this file is presentation only.
 */
export function RecoverySizingPanel({ recovery, tree, launch, deviceMass }: {
  /** The recovery weight, straight from App — never recomputed here. */
  recovery: RecoveryMass;
  tree: RocketTree;
  launch: LaunchConditions;
  /** Kernel mass of a component (kg), or null. See the substitution note in the service. */
  deviceMass: (node: ComponentNode) => number | null;
}) {
  const { prefs } = usePrefs();
  const lenSym = prefs.units.length;
  const velSym = prefs.units.velocity;
  const massSym = prefs.units.mass;
  const distSym = prefs.units.distance;

  /**
   * The parts catalogue is ~1.3 MB and lazily imported. It is fetched ONLY
   * once a motor is loaded — which is the same gate the recommendation itself
   * has, so a user who never picks a motor never pays for it, and one who does
   * was about to open the preset picker anyway.
   */
  const [presets, setPresets] = useState<Preset[] | null>(null);
  const wanted = recovery.state === 'ok';
  useEffect(() => {
    if (!wanted || presets !== null) return;
    let live = true;
    void loadPresets().then((p) => { if (live) setPresets(p); }).catch(() => { /* size line still works */ });
    return () => { live = false; };
  }, [wanted, presets]);

  const sizing: RecoverySizing = useMemo(
    () => recoverySizing({ recovery, tree, deviceMass, presets: presets ?? [], launch }),
    [recovery, tree, deviceMass, presets, launch],
  );

  if (sizing.state === 'no-motor') {
    return (
      <Shell summary="needs a motor">
        <p className="recovery-sizing-hint">
          Load a motor. A canopy is sized on the <strong>recovery weight</strong> — the dry
          rocket plus the spent motor casing — so it cannot be chosen until the motor is.
        </p>
      </Shell>
    );
  }
  if (sizing.state === 'unavailable') {
    return (
      <Shell summary="no recommendation">
        <p className="recovery-sizing-hint">
          No recommendation: {sizing.reason}.
        </p>
      </Shell>
    );
  }

  /**
   * The size line is an approximation and is rounded like one — a whole inch,
   * a whole millimetre, a tenth of a metre. `fmtSi`'s default ladder keeps one
   * more digit than that ("64.7 in"), which reads as a measurement rather than
   * as the target it is.
   */
  const roughLength = (si: number): string => {
    const v = siToUi('length', lenSym, si);
    const a = Math.abs(v);
    return v.toFixed(a >= 10 ? 0 : a >= 1 ? 1 : 2);
  };
  const rate = (si: number): string => fmtSi('velocity', velSym, si, 1);

  const pctFaster = Math.round((sizing.siteRateFactor - 1) * 100);

  // What the header says when the panel is shut. The two size lines are the
  // conclusion; everything the panel expands to is the working behind them.
  const summary = `main ~${roughLength(sizing.main.diameter)} ${lenSym}`
    + ` · drogue ~${roughLength(sizing.drogue.diameter)} ${lenSym}`;

  return (
    <Shell summary={summary}>
      <p className="recovery-sizing-lede">
        Sized for <strong>{fmtSi('mass', massSym, sizing.massKg)} {massSym}</strong> coming down
        {sizing.elevationM > 0 && (
          <>
            {' '}at <strong>{fmtSi('distance', distSym, sizing.elevationM, 0)} {distSym}</strong>
            {/* The ELEVATION is always named — every rate on this panel was
                computed at its density. The "% faster" clause is not: ISA
                density falls ~1.16 % per 100 m, so siteRateFactor only reaches
                1.005 at ~86 m, and every field below that printed "lands it 0%
                faster than sea level" — a sentence that contradicts itself on
                the one panel whose job is to be trusted. The same guard drops
                the clause when a cold, high-pressure site makes the factor less
                than 1, where it would have read "-1% faster". */}
            {pctFaster >= 1 && <>, where the thinner air lands it {pctFaster}% faster than sea level</>}
          </>
        )}.
      </p>

      {[sizing.main, sizing.drogue].map((advice) => (
        <BandSection
          key={advice.role}
          advice={advice}
          catalogueReady={presets !== null}
          boreM={sizing.boreM}
          roughLength={roughLength}
          rate={rate}
          lenSym={lenSym}
          velSym={velSym}
          massSym={massSym}
        />
      ))}
    </Shell>
  );
}

/**
 * The panel is long — the size line, two bands and up to five catalogue rows
 * each — and it sits under the component properties, which are long too. So it
 * collapses, and the COLLAPSED header still carries the answer:
 * "main ~65 in · drogue ~24 in". A disclosure that hides its own conclusion
 * would just be a second click on the way to the same place.
 *
 * Open on a fresh browser, because a tester who never opens it never learns the
 * panel exists; the choice then persists, because someone who shut it meant it.
 * localStorage can throw outright (blocked site data), so every access is
 * guarded and the default survives.
 */
const OPEN_KEY = 'online-openrocket.recovery-sizing-open';

function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) !== '0';
  } catch {
    return true;
  }
}

function Shell({ summary, children }: { summary: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(readOpen);
  const toggle = (): void => {
    setOpen((v) => {
      try {
        localStorage.setItem(OPEN_KEY, v ? '0' : '1');
      } catch {
        // Preference lost, panel still works. Not worth a message.
      }
      return !v;
    });
  };
  return (
    <div className={open ? 'panel recovery-sizing' : 'panel panel-dormant recovery-sizing'}>
      <div className="panel-head">
        <h2 style={{ flex: 1 }}>Recovery sizing</h2>
        {!open && <span className="recovery-sizing-summary">{summary}</span>}
        <button className="file-btn" aria-expanded={open} onClick={toggle}
          title={open ? 'Collapse the recovery sizing panel' : 'Show the full recommendation'}>
          {open ? 'Hide' : 'Show'}
        </button>
      </div>
      {open && children}
    </div>
  );
}

function BandSection({
  advice, catalogueReady, boreM, roughLength, rate, lenSym, velSym, massSym,
}: {
  advice: BandAdvice;
  catalogueReady: boolean;
  boreM: number | null;
  roughLength: (si: number) => string;
  rate: (si: number) => string;
  lenSym: string;
  velSym: string;
  massSym: string;
}) {
  const title = advice.role === 'main' ? 'Main' : 'Drogue';
  const cdSaid = advice.cdSource === 'this device'
    ? `the Cd of the ${advice.role} in this design`
    : advice.cdSource === 'the design’s other chute'
      ? 'the Cd of the other chute in this design — this slot is empty'
      : 'the simulator’s default for a canopy that states no Cd';
  const anyFlagged = advice.candidates.some((c) => c.flagged);
  const anyUnverified = advice.candidates.some((c) => c.fit === 'unverified');
  // WHICH Cd CONVENTION THE SIZE LINE QUOTED. `advice.cd` is vent-corrected —
  // the rated figure scaled by 1 − (d/D)² — so the diameter beside it is
  // reproducible from it by hand. Without saying so, a reader who checks the
  // sum against the Cd printed on their chute's own field gets a different
  // number and has no way to tell which one the panel meant.
  const vented = advice.ventFactor < 1;
  const cdNum = (v: number) => v.toFixed(2).replace(/\.?0+$/, '');

  return (
    <section className="recovery-band">
      <h3>
        {title}
        <span className="recovery-band-range">
          {rate(advice.band.min)}–{rate(advice.band.max)} <UnitChip quantity="velocity" />
        </span>
      </h3>

      {/* THE SIZE, first and in the largest type on the panel. It is the half
          of the answer that survives leaving this catalogue behind, and the Cd
          travels with it because a diameter alone is not an answer. */}
      <p className="recovery-size-line">
        about <strong>{roughLength(advice.diameter)} {lenSym}</strong>
        {' '}at <strong>Cd {cdNum(advice.cd)}</strong>
      </p>
      <p className="recovery-size-note" title={`Cd ${advice.cd}: ${cdSaid}.`}>
        for {rate(advice.band.target)} {velSym} — {cdSaid}
        {vented && <>, its rated Cd {cdNum(advice.cdNominal)} scaled for its spill hole</>}.
      </p>

      {advice.candidates.length > 0 ? (
        // A LIST, not a table. This panel lives in the design page's 290 px
        // left column; five columns of numbers with their own unit chips do
        // not fit in it, and the name — the thing a reader carries to a shop —
        // is the one field that must never be truncated. So each canopy gets
        // two lines: what it is and what it does, then the details.
        <ul className="recovery-parts">
          {advice.candidates.map((c) => (
            <PartRow key={`${c.manufacturer}|${c.partNo}`} c={c}
              lenSym={lenSym} velSym={velSym} massSym={massSym} />
          ))}
        </ul>
      ) : (
        <p className="recovery-sizing-hint">
          {!catalogueReady
            ? 'Looking through the parts catalogue…'
            : advice.inBand === 0
              ? `No canopy in the catalogue lands this rocket inside the ${title.toLowerCase()} band.`
              // The count itself is in the footer below — one place, so the two
              // sentences cannot end up disagreeing about the same number.
              : 'Nothing in the catalogue that hits this band will pack into the airframe.'}
        </p>
      )}

      <p className="recovery-band-foot">
        {advice.excludedForFit > 0 && boreM !== null && (
          <>
            {advice.excludedForFit} of {advice.inBand} canopies that hit this band pack wider
            than this airframe’s {fmtSi('length', lenSym, boreM, 1)} {lenSym} bore and are
            not listed.{' '}
          </>
        )}
        {advice.mergedVariants > 0 && (
          <>
            {advice.mergedVariants} more {advice.mergedVariants === 1 ? 'is' : 'are'} the same
            canopy in another fabric weight, folded into the line above.{' '}
          </>
        )}
        {anyUnverified && (
          <>
            <span className="recovery-mark">‡</span> publishes no packed size — check it fits
            your bay before you buy.{' '}
          </>
        )}
        {anyFlagged && (
          <>
            {/* The app contradicting itself is the defect this wording exists to
                avoid: the owner's drogue band reaches 75 ft/s, the launch report
                complains above 70, and both facts belong on the same line. */}
            <span className="recovery-mark recovery-mark-warn">†</span> is faster than the
            accepted {rate(advice.band.warnAbove!)} {velSym} drogue band — the launch report
            will say so.
          </>
        )}
      </p>
    </section>
  );
}

function PartRow({ c, lenSym, velSym, massSym }: {
  c: Candidate;
  lenSym: string;
  velSym: string;
  massSym: string;
}) {
  const { prefs } = usePrefs();
  const len = (si: number) => fmtSi('length', lenSym, si, 1);
  // A FIXED decimal here, unlike the size line: `fmtSi` strips trailing zeros,
  // which puts "58" under "59.3" and breaks the alignment of the one figure a
  // reader scans down the list.
  const fixedRate = siToUi('velocity', prefs.units.velocity, c.rate).toFixed(1);
  return (
    <li className={`recovery-part${c.flagged ? ' recovery-part-warn' : ''}`}>
      <div className="recovery-part-head">
        <span className="recovery-part-name" title={c.description}>
          <span className="recovery-part-mfr">{c.manufacturer}</span>
          {' '}{c.partNo}
          {c.variants > 1 && (
            <span className="recovery-part-variants"
              title={`${c.variants} catalogue rows are this same canopy in different fabric weights`}>
              {' '}+{c.variants - 1}
            </span>
          )}
        </span>
        {/* The rate is why this canopy is on the list, so it is the one figure
            on the same line as the name and the one set in the panel's ink. */}
        <span className="recovery-part-rate">
          {fixedRate} {velSym}
          {c.flagged && (
            <span className="recovery-mark recovery-mark-warn"
              aria-label="above the accepted drogue band">†</span>
          )}
        </span>
      </div>
      <div className="recovery-part-meta">
        {len(c.diameter)} {lenSym}
        {c.mass !== null && <> · {fmtSi('mass', massSym, c.mass)} {massSym}</>}
        {' · '}
        {c.packedDiameter !== null && c.packedLength !== null
          ? <>packs {len(c.packedDiameter)} × {len(c.packedLength)} {lenSym}</>
          : (
            <>
              packed size unpublished
              <span className="recovery-mark" aria-label="packed size unpublished">‡</span>
            </>
          )}
      </div>
    </li>
  );
}
