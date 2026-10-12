import { runStoppedEarly, type SimRun } from './simReport.js';
import { classesFittingMount, filterMotors, manufacturersForMount, sortMotors, type MotorDbEntry } from './motorDb.js';
import { mixedComboCount } from './batchSweep.js';
import { DEFAULT_TIME_STEP_S, timeStepCostFactor } from './launchConditions.js';

// Pure sweep rules stay independent of the dialog (audit 2026-10-11, S3a-7).
export interface Criteria {
  /** SI m/s; null = don't filter. */
  minRodExit: number | null;
  minThrustToWeight: number | null;
  /** SI meters AGL. */
  minApogee: number | null;
  maxApogee: number | null;
  autoDelay: boolean;
  includeOOP: boolean;
  manufacturers: string[];
  classes: number[];
}

/**
 * Which acceptance criteria this flight fails (empty = accepted).
 *
 * Called in RENDER, against the criteria on screen — not once when the flight
 * lands. The verdict used to be frozen at run time while the criteria fields
 * above the table stayed live, so tightening the apogee window after a sweep
 * left rows marked ✓ that the window now excluded: the table contradicted the
 * criteria it was displayed under (audit 2026-09-22).
 */
export function gradeBatchRun(run: SimRun, criteria: Criteria): string[] {
  const failed: string[] = [];
  // An aborted flight can never be "accepted": the kernel stopped it early,
  // so its apogee is whatever height the rocket had reached when it gave up.
  // Before this, a tumbling design's 140 m truncated flight could sail past
  // an apogee criterion and be graded ✓ in green. The same predicate as the
  // Saved simulations Safe column (runStoppedEarly), so the two cannot differ.
  if (runStoppedEarly(run)) {
    failed.push('flight stopped early');
  }
  if (criteria.minRodExit !== null
      && (run.rodExitVelocity === null || run.rodExitVelocity < criteria.minRodExit)) {
    failed.push('rod-exit velocity');
  }
  if (criteria.minThrustToWeight !== null
      && (run.thrustToWeightAtRod === null || run.thrustToWeightAtRod < criteria.minThrustToWeight)) {
    failed.push('thrust:weight');
  }
  if (criteria.minApogee !== null && run.maxAltitude < criteria.minApogee) failed.push('apogee too low');
  if (criteria.maxApogee !== null && run.maxAltitude > criteria.maxApogee) failed.push('apogee too high');
  return failed;
}

/**
 * How many rows the table draws. A mixed-cluster sweep can fly tens of
 * thousands of combinations, and drawing every row after every flight built a
 * DOM of ~200k nodes on a 25k-row sweep (audit 2026-09-22). The table shows
 * the best of them in the sweep's own order — accepted first, then by apogee —
 * and says how many it is not showing; the CSV and XLSX still carry every
 * flown row. See batchTableRows for the rows that could not be flown.
 */
export const BATCH_TABLE_ROWS = 400;

/**
 * The rows the table draws, from the sorted list (flown rows first, then the
 * ones that could not be flown): the best BATCH_TABLE_ROWS flown rows, then
 * the rows that could not be flown, with an allowance of their own.
 *
 * Their own, because they sort last: a plain top-400 slice of a sweep with
 * more than 400 flown rows dropped every one of them, and neither export
 * carries them either — only a flown row has a run to export — so which
 * motors failed, and why, was shown nowhere at all while the summary line
 * still counted them (review of the row-512 cap, 2026-09-22). Capped all the
 * same: a combination sweep turns each candidate that cannot be flown into a
 * failed combination with every other candidate.
 */
export function batchTableRows<T extends { run?: unknown }>(
  sorted: readonly T[],
): { shown: T[]; flown: number; failed: number } {
  const flown = sorted.filter((r) => r.run);
  const failed = sorted.filter((r) => !r.run);
  return {
    shown: [...flown.slice(0, BATCH_TABLE_ROWS), ...failed.slice(0, BATCH_TABLE_ROWS)],
    flown: flown.length,
    failed: failed.length,
  };
}

/** What the table says about the rows it leaves out, or null when it draws them all. */
export function batchCapNote({ flown, failed }: { flown: number; failed: number }): string | null {
  const said: string[] = [];
  if (flown > BATCH_TABLE_ROWS) {
    said.push(`Showing the top ${group(BATCH_TABLE_ROWS)} of ${group(flown)} flown rows — the CSV and `
      + 'XLSX carry every one.');
  }
  if (failed > BATCH_TABLE_ROWS) {
    said.push(`Listing the first ${group(BATCH_TABLE_ROWS)} of ${group(failed)} rows that could not be `
      + 'flown, which neither export carries.');
  }
  return said.length > 0 ? said.join(' ') : null;
}

/**
 * Why batch simulation is unavailable, in words, or null when it is available.
 *
 * Reported 2026-09-01b: *"'batch simulate motors' appears to be broken, when I
 * click the button, nothing happens."* It was not broken — the button was
 * DISABLED, and a disabled button gives no feedback when you click it. There
 * are three separate reasons it can be off and the tooltip named only one, so
 * the other two showed the button's ENABLED description and then did nothing
 * at all.
 *
 * Returning the reason as text means the caller can put it ON SCREEN rather
 * than hiding it in a `title` nobody hovers.
 */
export function batchUnavailableReason(
  { built, hasMount, isStaged }: { built: boolean; hasMount: boolean; isStaged: boolean },
): string | null {
  if (!built) return 'the design cannot be built, so there is nothing to fly';
  if (!hasMount) return 'this rocket has no motor mount';
  // The owner's own ruling (2026-07-03): no batch across staged rockets,
  // because the combinations explode. Batch on a CLUSTER is wanted and works.
  if (isStaged) return 'the motor combinations explode on a staged rocket';
  return null;
}

/**
 * What to say when a batch run ends.
 *
 * Reported 2026-09-01b, after a 226-motor run: *"how does the user know the
 * batch is complete? Once the sims are done, there is no indication to the user
 * that all the simulations have been completed and they can now download the
 * file."* He was right — the progress bar and its "simulating 173/226" line
 * simply vanished and the Stop button turned back into Simulate. A disappearing
 * progress bar is not an announcement.
 *
 * `total` is what this run flew (fewer than `planned` when it was stopped);
 * `candidates` and `planned` are the sweep it started — its candidate count and
 * the flights the button named. It counts in the button's noun
 * (batchButtonLabel): motors while every flight is one candidate, FLIGHTS once
 * a combination mode makes the two differ. It said "motors" whatever the sweep
 * was, so 20 candidates with "mixed 2+2" finished as "simulated 210 motors"
 * beside a meta line that said 20 (audit 2026-09-30).
 */
export function batchSummary(
  { total, candidates, planned, stopped, accepted, errors, downloadable }: {
    total: number; candidates: number; planned: number;
    stopped: boolean; accepted: number; errors: number; downloadable: boolean;
  },
): string {
  const head = stopped ? 'Stopped early' : 'Finished';
  const noun = planned === candidates ? 'motor' : 'flight';
  const flown = `${group(total)} ${noun}${total === 1 ? '' : 's'}`;
  const errs = errors > 0 ? `, ${group(errors)} could not be flown` : '';
  const tail = downloadable ? '. Download the results as CSV or XLSX above.' : '.';
  return `${head} — simulated ${flown}; ${group(accepted)} met your criteria${errs}${tail}`;
}

/** Thousands separators, pinned to en-US so these labels are deterministic. */
const group = (n: number) => n.toLocaleString('en-US');

/**
 * WHAT ONE BATCH FLIGHT COSTS, in seconds at the 0.05 s default step — measured,
 * so the Simulate button can say how long a sweep will take (board Tier 1 row 7:
 * a combination sweep's count was fixed in v0.105, but nothing said how long
 * one would run, and nothing stopped one). Two prices, because the delay
 * solver's probe flights are most of the cost: `optimalDelay` for a flight that
 * searches for its optimum delay, `fixedDelay` for one flown at a set delay.
 * Which flights search is COUNTED (batchSweep's batchSolverFlights), not read
 * off the checkbox: unticking "optimal delay per motor" still leaves every
 * flight of motors sold plugged only searching on a design whose recovery waits
 * for the charge — 64 of the 420 in-production candidates on a 38 mm mount,
 * 158 of 600 on 54 mm — and those were priced at a fixed delay until the
 * review of 2026-10-01.
 *
 * Measured 2026-10-01 through runBatchSweep itself — catalogue curves, nozzle
 * table, the delay solver and the Mach probe, everything a sweep does — on the
 * shipped kernel under Node 24 on the project laptop:
 *
 *   searching: 1.80-1.88 s a flight on every aero model, for 29 in-production
 *   motors spanning a 38 mm mount in a 50 mm airframe (apogees to 3.2 km);
 *   2.0 s for 36 flights of a 24 mm 4-ring cluster with "mixed 2+2"
 *   fixed: 0.47 s (Rogers) to 0.60 s (Auto), for the same 29
 *
 * These price an ESTIMATE, and the design moves them more than anything else
 * (re-measured in review, same day): 24 mm motors in a 42 mm airframe searched
 * at 0.94 s a flight, so the button read about twice the real time; four
 * plugged-only 38 mm motors flown at their optimum in a 50 mm airframe (J1026,
 * I426, H248, G8) took 3.8 s a flight on average, about twice the searching
 * price, so a sweep heavy in them runs longer than it says. The aero model
 * moved the figure by under 0.1 s; a faster or slower machine moves all of it.
 * Hence "about" on the button.
 */
export const BATCH_FLIGHT_S = { optimalDelay: 2, fixedDelay: 0.6 } as const;

/** A sweep as the estimate reads it: its flights, how many of them search for their delay, and the step. */
export interface BatchPace {
  flights: number;
  /** batchSweep's batchSolverFlights for this sweep — all of them with "optimal delay per motor" ticked. */
  solverFlights: number;
  timeStepS?: number | null;
}

/**
 * Above this many flights the button says how long the sweep will take beside
 * how many flights it is. 100 flights is about three minutes at the default
 * pace (BATCH_FLIGHT_S): a shorter sweep is over while the user watches, and a
 * longer one — the owner's 226-motor sweep is about eight minutes — is worth
 * knowing the length of before it starts.
 */
export const BATCH_ESTIMATE_ABOVE_FLIGHTS = 100;

/** Above 5,000 flights, preserve the existing second ask on the Simulate button. */
export const BATCH_CONFIRM_ABOVE_FLIGHTS = 5000;
/** Above 20,000 flights, require the separate Run anyway action. */
export const BATCH_RUN_ANYWAY_ABOVE_FLIGHTS = 20_000;

/** A confirmation belongs only to the permitted sweep whose inputs were shown. */
export function batchConfirmationArmed(confirmed: object | null, sweep: object, flights: number, refusal: string | null): boolean {
  return confirmed === sweep && refusal === null && flights > BATCH_CONFIRM_ABOVE_FLIGHTS;
}

/**
 * Memory ceiling, separate from the time confirmation. The dialog retains all
 * rows for export even though it draws only BATCH_TABLE_ROWS of each kind.
 * Row-55 measurement (2026-10-04, Node 24): 40,000 independent copies of a
 * six-ring mixed 4+2 result held 257 MiB, 264 MiB including sorting/filtering.
 * 50,000 leaves room above the owner's 37,820-flight sweep while bounding
 * retention (roughly 330 MiB for that fixture, not a universal heap bound).
 * Unbounded combinations can reach millions of rows and several GiB.
 * Saved history still has its separate 500-run cap in simStore.
 */
export const BATCH_MAX_FLIGHTS = 50_000;

/**
 * The motors a sweep of this mount flies, highest impulse first; how many the
 * mount's max motor length left out (EXCLUDED, not just flagged: in a batch
 * there's no point flying motors that don't fit); and the maker chips that
 * applied. One function for the list on screen and for the refusal's question
 * of what unticking "include OOP" would leave (batchRefusal), so the two cannot
 * filter differently.
 *
 * The maker chips that APPLY are the stored selection intersected with the
 * makers this mount offers as chips — the rule the diameter classes always
 * followed, and the motor browser's. The criteria persist across sessions and
 * mounts, so Loki chosen on a 54 mm mount (it makes nothing under 38 mm), or an
 * out-of-production-only maker once "include OOP" was unticked, went on
 * filtering with no chip on screen: "0 candidate motors", Simulate disabled,
 * nothing to say why (audit 2026-09-30). The stored list is left as it is, so
 * the choice comes back on a mount that offers it.
 */
export function batchCandidates(
  criteria: Pick<Criteria, 'manufacturers' | 'classes' | 'includeOOP'>,
  mount: { diameterMm: number; maxMotorLengthM: number | null },
  motors: MotorDbEntry[],
): { candidates: MotorDbEntry[]; tooLongCount: number; appliedMakers: string[] } {
  const offered = new Set(manufacturersForMount(mount.diameterMm, criteria.includeOOP, motors).map((m) => m.abbrev));
  const appliedMakers = criteria.manufacturers.filter((m) => offered.has(m));
  const fittingClasses = classesFittingMount(mount.diameterMm, motors);
  const filtered = filterMotors({
    manufacturers: new Set(appliedMakers),
    classes: new Set(criteria.classes.filter((c) => fittingClasses.includes(c))),
    boreMm: mount.diameterMm,
    includeOOP: criteria.includeOOP,
    text: '',
  }, motors);
  const room = mount.maxMotorLengthM;
  const fitting = room === null ? filtered : filtered.filter((m) => m.length / 1000 <= room);
  return {
    candidates: sortMotors(fitting, 'totImpulseNs', -1),
    tooLongCount: filtered.length - fitting.length,
    appliedMakers,
  };
}

/**
 * How many flights a sweep of `n` candidates flies with these combination
 * splits ticked (each split's group count): every candidate alone, plus each
 * split's mixed combinations — the total runBatchSweep counts its progress to.
 */
export function batchFlightCount(n: number, groups: readonly number[]): number {
  return n + groups.reduce((sum, g) => sum + mixedComboCount(n, g), 0);
}

/** The most candidates whose sweep stays within BATCH_MAX_FLIGHTS with these splits still ticked. */
export function batchMaxCandidates(groups: readonly number[]): number {
  let n = 0;
  while (batchFlightCount(n + 1, groups) <= BATCH_MAX_FLIGHTS) n++;
  return n;
}

/**
 * Roughly how long a sweep takes, in seconds: its searching flights at the
 * searching price (BATCH_FLIGHT_S) and the rest at the fixed one, times the
 * time-step caution's own factor when the step is finer than the default,
 * since a fine step's cost is per flight. A coarser step keeps the measured
 * pace: the factor was fitted on finer steps only, and an estimate should not
 * shrink on a guess.
 */
export function batchSweepSeconds({ flights, solverFlights, timeStepS }: BatchPace): number {
  const perSweep = solverFlights * BATCH_FLIGHT_S.optimalDelay + (flights - solverFlights) * BATCH_FLIGHT_S.fixedDelay;
  const step = timeStepS != null && timeStepS < DEFAULT_TIME_STEP_S ? timeStepCostFactor(timeStepS) : 1;
  return perSweep * step;
}

/**
 * A duration as an estimate can honestly claim it: minutes under the hour,
 * quarter hours under ten, whole hours under two days, then days.
 */
export function batchDurationText(seconds: number): string {
  if (seconds < 60) return 'under a minute';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} min`;
  if (seconds < 10 * 3600) {
    const quarters = Math.round(seconds / 900);
    const h = Math.floor(quarters / 4);
    const m = (quarters % 4) * 15;
    return m > 0 ? `about ${h} h ${m} min` : `about ${h} h`;
  }
  if (seconds < 48 * 3600) return `about ${Math.round(seconds / 3600)} h`;
  return `about ${Math.round(seconds / 86400)} days`;
}

/** What the button says after the count: how long the sweep takes, or null for one too short to need it. */
export function batchEstimate(pace: BatchPace): string | null {
  return pace.flights > BATCH_ESTIMATE_ABOVE_FLIGHTS ? batchDurationText(batchSweepSeconds(pace)) : null;
}

/**
 * Why a sweep past BATCH_MAX_FLIGHTS will not start, and the ways to bring it
 * under — only the ways that do, each checked by counting the flights it would
 * leave (review of the cap, 2026-10-01). It used to offer unticking "include
 * OOP" whenever out-of-production motors were in, and either combination box
 * when both were ticked: a 29 mm 4-ring with "mixed 2+2" is 314 candidates and
 * 49,455 flights with them in, and still 232 and 27,028 without, and unticking
 * "mixed 3+3" alone leaves the 4+2 / 2+2+2 split, the one that explodes. Named:
 * each box whose unticking is enough by itself (else every box together), the
 * candidate count that fits with the boxes still ticked, and unticking include
 * OOP when that alone gets there. The time it quotes for the cap is at this
 * sweep's own mix of searching and fixed flights. Null when the sweep fits.
 */
export function batchRefusal({ candidates, withoutOOP, modes, solverFlights, timeStepS }: {
  /** How many candidates the filters leave. */
  candidates: number;
  /** How many unticking "include OOP" would leave (batchCandidates); null while it is unticked. */
  withoutOOP: number | null;
  /** The ticked combination modes: the words on each box, and its split's group count. */
  modes: readonly { name: string; groups: number }[];
  /** How many of this sweep's flights search for their delay (BatchPace). */
  solverFlights: number;
  timeStepS?: number | null;
}): string | null {
  const groupsOf = (ms: readonly { groups: number }[]) => ms.map((m) => m.groups);
  const fits = (n: number, ms: readonly { groups: number }[]) => batchFlightCount(n, groupsOf(ms)) <= BATCH_MAX_FLIGHTS;
  const flights = batchFlightCount(candidates, groupsOf(modes));
  if (flights <= BATCH_MAX_FLIGHTS) return null;
  const atCap = batchDurationText(batchSweepSeconds({
    flights: BATCH_MAX_FLIGHTS, solverFlights: BATCH_MAX_FLIGHTS * (solverFlights / flights), timeStepS,
  }));
  const alone = modes.filter((m) => fits(candidates, modes.filter((o) => o !== m)));
  const untick = alone.length > 0 ? `Untick ${alone.map((m) => m.name).join(' or ')}`
    : modes.length > 1 && fits(candidates, [])
      ? `Untick ${modes.length === 2 ? 'both ' : ''}${modes.map((m) => m.name).join(' and ')}`
      : null;
  const oop = withoutOOP !== null && fits(withoutOOP, modes) ? ', or by unticking include OOP' : '';
  const narrow = `bring the candidates down to ${group(batchMaxCandidates(groupsOf(modes)))} or fewer with the `
    + `maker and diameter chips${oop}`;
  const how = untick ? `${untick}, or ${narrow}` : narrow[0]!.toUpperCase() + narrow.slice(1);
  return `${group(flights)} flights is more than one batch will fly: the most is ${group(BATCH_MAX_FLIGHTS)}, `
    + `${atCap} at the measured pace. The app keeps every result in memory for export. ${how}.`;
}

/**
 * The primary button's label.
 *
 * It used to read `Simulate ${candidates.length} motors` — the SINGLE-motor
 * candidate count — while the sweep actually flew `totalFlights`. With a
 * combination mode ticked those two differ by up to four orders of magnitude,
 * so the button contradicted the meta line beside it, and the button is what
 * gets clicked. It counts FLIGHTS, and says so, as soon as the two differ: a
 * mixed-cluster combination is not a motor. Past BATCH_ESTIMATE_ABOVE_FLIGHTS
 * it says how long they will take as well (batchEstimate).
 */
export function batchButtonLabel(
  { candidates, totalFlights, confirming, estimate = null }:
  { candidates: number; totalFlights: number; confirming: boolean; estimate?: string | null },
): string {
  const time = estimate ? ` · ${estimate}` : '';
  if (confirming) return `Yes — fly ${group(totalFlights)} flights${time}`;
  if (totalFlights === candidates) {
    return `Simulate ${group(candidates)} ${candidates === 1 ? 'motor' : 'motors'}${time}`;
  }
  return `Simulate ${group(totalFlights)} flights${time}`;
}

/** The second-ask copy for a sweep past {@link BATCH_CONFIRM_ABOVE_FLIGHTS}. */
export function batchConfirmWarning(totalFlights: number, estimate: string | null): string {
  if (totalFlights <= BATCH_RUN_ANYWAY_ABOVE_FLIGHTS) {
    return `${group(totalFlights)} flights is a very long run${estimate ? ` — ${estimate}` : ''}. The page `
      + 'cannot respond while a flight runs, and Stop only takes effect between them. Press the button '
      + 'again to start, or untick a combination mode to shrink it.';
  }
  return `${group(totalFlights)} flights is a very long run${estimate ? ` — ${estimate}` : ''}. The app `
    + 'cannot respond while a flight runs, and Stop only takes effect between them. Choose Run anyway '
    + 'to start, or Cancel to narrow the makers, diameters or combination modes.';
}

/**
 * What the screen-reader live region says while a sweep runs, or null when
 * nothing new should be announced.
 *
 * Deliberately COARSE. A polite live region on the visible counter would speak
 * the whole "226 candidate motors · … — simulating 5/226: AeroTech H128" line
 * once per flight; on sub-second flights the queue never drains and the user
 * hears a backlog minutes behind the run. This announces the start and then
 * each 10 % of the sweep — the end already has its own role="status" message,
 * and role="progressbar" on the bar itself carries the value in between.
 */
export function batchProgressAnnouncement(done: number, total: number): string | null {
  if (total <= 0) return null;
  if (done <= 0) return `Simulating ${group(total)} flights.`;
  const step = Math.max(1, Math.ceil(total / 10));
  if (done % step !== 0) return null;
  return `${Math.round((done / total) * 100)} percent — ${group(done)} of ${group(total)} flights.`;
}

