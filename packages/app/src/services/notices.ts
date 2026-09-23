import type { RocketTree } from '@online-openrocket/engine';
import type { Notice, NoticeSeverity } from '../components/NoticeBar.js';
import type { MountMotor } from '../model/design.js';
import { nozzleOversize, nozzleOversizeText } from './nozzleCheck.js';
import { fmtStepS } from './orkFile.js';
import { runCapNote } from './simStore.js';

/**
 * EVERYTHING TRANSIENT THE USER SHOULD SEE, in one channel with a severity —
 * the list the notice bar draws.
 *
 * Extracted from App.tsx's `notices` memo in the 2026-09-22 audit (row 501,
 * extraction #5 of 8 September). Nine branches of user-facing copy, each with
 * its own reasoned rule for whether it offers a ×, and the only coverage they
 * had was regexes over App's source text (nozzleWiring.test.ts,
 * noticeBarPhoneLift.test.ts), which stay green on the wrong severity or a
 * dropped branch as long as the text still matches. notices.test.ts asserts
 * them by what the list says.
 *
 * Motor trouble is a WARNING, never a build error: a malformed published
 * thrust curve is a fault in someone else's file and must not take the design
 * down with it (issues-2026-08-23a.md).
 */

/** A note the app holds in state and shows until it is dismissed or replaced. */
export interface HeldNote {
  text: string;
  severity: NoticeSeverity;
}

/** What the list is made from — App's state, read as it stands. */
export interface NoticeInput {
  /** The build's error, else the last flight's (App's `buildError`). */
  error: string | null;
  /** `error` is the BUILD's — a standing fact about the design, not a flight's. */
  buildFailed: boolean;
  /** Motors the kernel refused on this build. */
  motorFailures: readonly { mountId: string; text: string }[];
  tree: RocketTree;
  /** App's `assigned`: motors on mounts that still exist in the tree. */
  assigned: readonly (readonly [string, MountMotor])[];
  /** The design was parsed by an earlier build's importer (restored from autosave). */
  restoredByOlderBuild: boolean;
  /** The restore raised a pre-v0.071 session's inherited time step to the default. */
  timeStepMigrated: boolean;
  /** The step that migration replaced, when the panel could take it back; else null. */
  timeStepMigratedFrom: number | null;
  /** Where a pad mass entered in v0.116/v0.117 went (services/padMassReconcile.ts). */
  padMassNote: HeldNote | null;
  /** The file/transient note ("Loaded …", "Share link copied", an export failure). */
  fileNote: HeldNote | null;
  /** Saved runs the 500-run cap removed, and new ones that never fit. */
  runsCapped: { evicted: number; unsaved: number };
  /** A length in the user's unit ("31.8 mm") — the one part that needs prefs. */
  lengthText: (m: number) => string;
}

/** What each dismissible notice's × does. */
export interface NoticeDismissers {
  simError(): void;
  staleSession(): void;
  timeStep(): void;
  padMassNote(): void;
  fileNote(): void;
  runsCapped(): void;
}

/**
 * What the published thrust curves of the motors loaded needed, one entry per
 * motor per kind, keyed by mount so loading another motor does not make them
 * new to the bar.
 *
 * REPAIRS: thrustcurve.org carries manufacturer files with coincident time
 * points; the app mends them rather than refuse the motor, and says so here
 * so a silent fix never changes someone's numbers without telling them.
 *
 * AND ONE THING THAT IS NOT A REPAIR (the guide pass of audit 2026-09-22).
 * Since v0.116 thrustcurve.ts appends its impulse note — the curve flown
 * integrates more than 5 % off the motor's certified total — to the same
 * `curveRepairs` list, and this printed every entry inside "<motor>: its
 * published thrust curve needed repair before it could be flown (…). This is
 * a fault in the motor file": a complete sentence in another's brackets,
 * announcing a repair nothing made. The note already names the motor and says
 * what it means for apogee, so it is shown as written. Told apart by shape,
 * because stored sessions hold both kinds in that one list: repairSamples'
 * entries are lower-case fragments ("dropped 2 duplicate data points"), the
 * note is a sentence of its own. notices.test.ts holds both producers to that.
 */
export function curveNotes(assigned: NoticeInput['assigned']): { id: string; text: string }[] {
  const out: { id: string; text: string }[] = [];
  for (const [mountId, mm] of assigned) {
    const entries = (mm.spec as { curveRepairs?: string[] }).curveRepairs ?? [];
    const repairs = entries.filter((e) => !isOwnSentence(e));
    if (repairs.length) {
      out.push({
        id: `curve-repair:${mountId}`,
        text: `${mm.spec.designation}: its published thrust curve needed repair `
          + `before it could be flown (${repairs.join('; ')}). This is a fault in the `
          + 'motor file, not in your design.',
      });
    }
    for (const note of entries.filter(isOwnSentence)) {
      out.push({ id: `curve-impulse:${mountId}`, text: note });
    }
  }
  return out;
}

/** A note written as a sentence of its own, not a repair fragment to bracket. */
const isOwnSentence = (entry: string): boolean => /^[A-Z]/.test(entry);

export function designNotices(input: NoticeInput, dismiss: NoticeDismissers): Notice[] {
  const out: Notice[] = [];
  if (input.error) {
    // Dismissible ONLY when it came from a flight. A BUILD error is a
    // standing fact about the design on screen — it comes straight back on
    // the next render, so a × would be a button that does nothing. A
    // simulation failure is a one-off event, and there is no reason a user
    // who has read it should have to keep looking at it.
    out.push({
      id: 'build-error',
      severity: 'error',
      text: input.error,
      ...(!input.buildFailed ? { onDismiss: dismiss.simError } : {}),
    });
  }
  for (const f of input.motorFailures) {
    out.push({ id: `motor-failed:${f.mountId}`, severity: 'warn', text: f.text });
  }
  for (const { id, text } of curveNotes(input.assigned)) {
    out.push({ id, severity: 'warn', text });
  }
  if (input.restoredByOlderBuild) {
    out.push({
      // `info`, not `warn`, and deliberately: NoticeBar opens the bar for any
      // non-info notice, and this one fires for EVERY returning user after
      // EVERY release (sessionPredatesThisBuild is appVersion !== APP_VERSION,
      // and this app releases near daily). A self-opening bar on a phone is
      // how it came to cover the tab bar. The message is advisory — nothing
      // is wrong, there is a better version of the file to re-open — which is
      // exactly the bar's own stated rule for what stays quiet.
      id: 'stale-session',
      severity: 'info',
      text: 'This design was restored from autosave and was read in by an earlier build of'
        + ' the app, so file-reading fixes made since then have not been applied to it.'
        + ' Re-open the original file to pick them up.',
      onDismiss: dismiss.staleSession,
    });
  }
  // One-time, on the first load after upgrading: the restored session carried
  // a time step finer than the default, inherited from some file opened long
  // ago and invisible until this build. Say so rather than letting the number
  // in the new field differ from what the user was silently flying.
  if (input.timeStepMigrated) {
    out.push({
      id: 'timestep-migrated',
      severity: 'info',
      // The closing sentence names the replaced value when the session
      // carried it — the migration overwrites it in place, so this notice is
      // the last thing that can — and promises nothing when it did not:
      // "if you want it back" with no number and 0.05 in every field was a
      // promise the migrated tester could not act on.
      text: 'Your saved session was flying a finer simulation time step than the default,'
        + ' inherited from a design file — it is now set to 0.05 s, which is several times'
        + ' faster and, in our testing, no less accurate.'
        + (input.timeStepMigratedFrom !== null
          ? ` To get the old step back, type ${fmtStepS(input.timeStepMigratedFrom)} into the`
            + ' Time step field in the Launch panel.'
          : ' The Time step field in the Launch panel takes a finer step, if you have a'
            + ' reason to pay for one.'),
      onDismiss: dismiss.timeStep,
    });
  }
  // Where a pad mass entered in v0.116/v0.117 went (moved under its motor,
  // or dropped with the value and the motor named) — its own entry, so it
  // cannot overwrite an import note and an import note cannot overwrite it.
  if (input.padMassNote) {
    out.push({
      id: 'pad-mass-moved',
      severity: input.padMassNote.severity,
      text: input.padMassNote.text,
      onDismiss: dismiss.padMassNote,
    });
  }
  // A nozzle exit diameter wider than the motors in its stage (2026-09-08).
  // NOT dismissible, for the reason a build error is not: it is a standing
  // fact about the design on screen, so a × would be a button that does
  // nothing — it comes straight back on the next render. One entry per
  // stage, keyed by the stage id, so a second bad stage cannot hide behind
  // the first. The check and the sentence are in services/nozzleCheck.ts;
  // only the unit formatting comes from the caller, because that is the one
  // part that needs prefs.
  for (const w of nozzleOversize(input.tree, input.assigned)) {
    out.push({
      id: `nozzle-oversize:${w.stageId}`,
      severity: 'warn',
      text: nozzleOversizeText(w, input.lengthText),
    });
  }
  if (input.fileNote) {
    out.push({
      id: 'file-note',
      severity: input.fileNote.severity,
      text: input.fileNote.text,
      onDismiss: dismiss.fileNote,
    });
  }
  // Saved runs the cap removed — its own entry, so it neither overwrites an
  // import note nor is overwritten by one. A warning: those runs are gone.
  if (input.runsCapped.evicted > 0 || input.runsCapped.unsaved > 0) {
    out.push({
      id: 'runs-evicted',
      severity: 'warn',
      text: `${runCapNote(input.runsCapped.evicted, input.runsCapped.unsaved)} Download the run table`
        + ' (Results) to keep a copy of the rest before more go.',
      onDismiss: dismiss.runsCapped,
    });
  }
  return out;
}
