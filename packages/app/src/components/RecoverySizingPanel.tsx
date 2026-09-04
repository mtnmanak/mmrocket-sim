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
 * "Recovery sizing" — the design page's answer to "so what chute do I buy?",
 * sitting beside the recovery weight it is computed from (the owner's ruling,
 * 2026-09-04).
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
      <Shell>
        <p className="recovery-sizing-hint">
          Load a motor. A canopy is sized on the <strong>recovery weight</strong> — the dry
          rocket plus the spent motor casing — so it cannot be chosen until the motor is.
        </p>
      </Shell>
    );
  }
  if (sizing.state === 'unavailable') {
    return (
      <Shell>
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

  return (
    <Shell>
      <p className="recovery-sizing-lede">
        Sized for <strong>{fmtSi('mass', massSym, sizing.massKg)} {massSym}</strong> coming down
        {sizing.elevationM > 0 && (
          <>
            {' '}at <strong>{fmtSi('distance', distSym, sizing.elevationM, 0)} {distSym}</strong>,
            where the thinner air lands it {pctFaster}% faster than sea level
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

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="panel recovery-sizing">
      <h2>Recovery sizing</h2>
      {children}
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
        {' '}at <strong>Cd {advice.cd.toFixed(2).replace(/\.?0+$/, '')}</strong>
      </p>
      <p className="recovery-size-note" title={`Cd ${advice.cd}: ${cdSaid}.`}>
        for {rate(advice.band.target)} {velSym} — {cdSaid}.
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
