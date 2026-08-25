# Validation harness (RASAero #1 supersonic/hypersonic build)

Scores the JS engine against **measured** wind-tunnel and free-flight anchor
datasets. Provenance, tolerances, and every caveat live in
the project's research notes, which record each dataset, its stated accuracy
and every caveat behind the tolerances used here.

## Run it

```
npm run build -w @online-openrocket/engine   # harness imports packages/engine/dist
node validation/score.mjs                    # classic Extended Barrowman (flag off)
node validation/score.mjs --supersonic       # the opt-in supersonic aero model
node validation/score.mjs --strict           # exit 1 unless every gate point passes
```

## Scoreboard

**ANCHOR REVISION (2026-08-25, 135 → 164 gates):** the two ARCAS fixtures were
re-derived from Chuck Rogers' own CDX1 reconciled against the TN D-4013/D-4014
drawings (boat-tail rear dia 1.28 in per the drawn 15° cone — 1.47 was the base
LIP misread; fin thickness 0.123 = the mean of the drawn 0.150→0.096 spanwise
taper; tip chord 2.165; true double-wedge section; fins at their true station),
and a new 29-gate cell **rma53d02** (NACA RM A53D02 free-flight, finned, blunt-base
hex section, M0.6–10) was added — plus a gate:false RASAero-prediction reference
series that is never counted. Anchor values for the old cells are unchanged; the
score moved because fixture compensating errors were removed: **supersonic
64/135 → 52/164, classic 7/135 → 10/164**. The full accounting — which gates
flipped, the measured decompositions, and the falsifiable list the model fixes
must move — is `scorecard-anchors-2026-08-25.md`; the model fixes that answered
that list are `scorecard-phase5-2026-08-25.md` and `scorecard-phase6-2026-08-25.md`
(supersonic 52 → 70/164 against these same anchors). A plain-body (finless,
no-boat-tail) cell was evaluated and **skipped**: no defensible measured dataset
exists in the reference material (see the scorecard).

**ANCHOR REVISION (2026-08-04 audit, 137 → 135 gates):** the ARCAS M1.19 rows
in `cd-supersonic-tunnel` (both configs) were removed — they were TN D-4013
CA,corr measurements (base-corrected ⇒ base-EXCLUDED accounting), but sat in a
base-INCLUDED series sourced to D-4014 (whose data starts at M1.5), and the
same measurement was already gated base-excluded as the transonic series' M1.2
point. The old convention had flattered the score by one spurious pass (kernel
base CD ≈ 0.09 at M1.19 vs the ±0.02 tolerance). Phase-1..4 scorecards below
are historical (scored against the 137-gate anchors); the current state under
revised anchors is `scorecard-audit-2026-08-04.md`.

| Model | Gate points | Scorecard |
|---|---|---|
| Classic Extended Barrowman | 7/135 historical | `baseline-classic-2026-08-04.md` (135-gate anchors) |
| + Phase 1 (supersonic CP/CNα) | 52/137 historical | `scorecard-phase1-2026-08-04.md` |
| + Phase 2 (drag fidelity) | 68/137 historical | `scorecard-phase2-2026-08-04.md` |
| + Phase 3 (fin airfoil sections) | 65/137 historical | `scorecard-phase3-2026-08-04.md` |
| + Phase 4 (hypersonic corrections) | 65/137 historical | `scorecard-phase4-2026-08-04.md` |
| Phase 4, 2026-08-04 anchors | 64/135 historical | `scorecard-audit-2026-08-04.md` |
| Supersonic, 2026-08-25 anchors, pre-Phase-5 | 52/164 (31.7%) | `scorecard-anchors-2026-08-25.md` |
| **Current: classic, 2026-08-25 anchors** | **10/164 (6.1%)** | `scorecard-phase6-2026-08-25.md` |
| **Current: supersonic, Phase 5 + Phase 6** | **70/164 (42.7%)** | `scorecard-phase6-2026-08-25.md` |

**Read the two 2026-08-25 numbers together or not at all.** The supersonic percentage
*fell* from the 2026-08-04 line (47.4% → 42.7%) while the model got materially better,
because the anchors got harder in the same session: the ARCAS cells were re-fixtured
from the RASAero co-author's own file (correcting boat-tail base diameter, fin thickness
and — the big one — a fin station that had been 1.54 in forward of the drawing, which had
been flattering the CP series), and 29 new free-flight gates were added at M0.6–10.
Against the *new* anchors the model work moved 52 → 70. Percentages across anchor
revisions are not comparable; per-scorecard gate flips are.

Phase 4 (Van Driest II friction above M4; cone wave-drag coefficient fading
2.1 → Cp_max(M) over M4–8) moved no gates but cut HB-2's high-Mach CA0 excess
~45% (+0.25 → +0.14 at M8–10) with ARCAS M4.65 tightening to −0.003. HB-2's
remaining gaps are deliberate non-goals for a hobby-rocket code, documented in
LEDGER: spherical-cap nose bluntness and flare-effectiveness decay.

Phase 3's score DECREASE is deliberate honesty: Finner's fixture switched from
the biconvex placeholder to its true `singlewedge` section, and the correct
(smaller) wedge thickness term unmasked a systematic Finner Cx0 deficit
(−0.04…−0.13) that the placeholder had been accidentally covering. Suspected
free-flight base-drag environment (base pressure behind a finned body runs
below the clean-cylinder Hoerner law); flagged for the refinement phase. All
ARCAS and CP series unchanged.

Phase 2 (same flag): sharp-airfoil fins lose the spurious blunt-LE drag plateau
and get thin-airfoil wave drag; boattails get supersonic wave drag; nose wave
drag decays past its table end; base drag gets the vacuum-limit cap; fin-body
junction interference (+80% of fin friction, from the D-4013 fins-on/off
increment); fixtures polished + tunnel-Re-matched (`machAlt`). ARCAS-Short
supersonic CD 6/7 (M1.49 misses by +0.033), Long 5/6, subsonic green.
(An earlier claim of 7/7 counted the since-removed M1.19 row.) Remaining red, documented: the
transonic peak band M0.95–1.2 (tunnel shows fin transonic drag ≈4× subsonic;
RASAero underpredicts these same anchors by 0.10–0.22), Finner Cx0 (wedge
blunt-TE fin base drag → feature #4 airfoils), HB-2 (flare/bluntness →
hypersonic phase).

Phase 1 (opt-in `supersonicAero` flag — corrected supersonic fin normal force,
NACA-1307 interference, Mach-dependent nose CNα; see LEDGER.md) turns the CP
series green: ARCAS supersonic CP 9/9 gated on both configs (matching the
tunnel where RASAero itself diverges above M3.5), Finner CP 17/23 and CNα
16/23 (remaining fails: the transonic band M1.05–1.4, whose measured lift
overshoot is Phase-2 physics, plus marginals inside free-flight shot scatter).
Still red by design: every CD series (drag is Phase 2), HB-2 CNα (the flare
body needs Phase-2+/hypersonic treatment).

Scoring conditions: Basic Finner scores at α = 2° (its free-flight fits ride
at finite yaw — see the `_aoaNote` in anchors.json); everything else at α = 0.

After any engine rebuild, regenerate and eyeball the scorecard:

```
node validation/score.mjs > validation/scorecard.md
```

## Files

- `fixtures/*.json` — RocketTree fixtures for the tunnel models (each file's
  `_notes` records its modeling approximations):
  - `arcas-short.json` / `arcas-long.json` — NASA TN D-4013/D-4014 sounding
    rocket, ogive + swept double-wedge fins + 15° boat-tail, data to M4.63
    (re-fixtured 2026-08-25 from Rogers' own CDX1 + the report drawings)
  - `basic-finner.json` — Army-Navy Basic Finner, cone + rectangular fins,
    free-flight data to M4.47
  - `hb2.json` — AGARD HB-2 blunt cone-cylinder-flare, finless body anchor to
    M10 (geometry approximated pending nose-bluntness support)
  - `rma53d02.json` — NACA RM A53D02 gun-launched free-flight model, ogive +
    hexagonal-blunt-base fins, measured data to M10 (the finned M3–10 cell and
    the only non-airfoil fin-section cell; interim figure-read anchors until
    the report number arrives)
- `anchors.json` — machine-readable anchor tables (units/conventions in its
  `_readme`; `gate: false` series are informational)
- `score.mjs` — builds each fixture, runs `dragSweep` (which emits CD
  power-off/on + CP + CNα per Mach), interpolates at anchor Machs, grades
- `scorecard-anchors-2026-08-25.md` — the CURRENT scorecard: the 2026-08-25
  anchor revision, before/after accounting, the measured compensating-error
  decompositions, and the falsifiable gate list the model fixes must move
- `baseline-classic-2026-08-04.md` — the classic Extended Barrowman scorecard
  under the historical 135-gate anchors (7/135)
- `scorecard-audit-2026-08-04.md` — the supersonic-model scorecard under the
  historical 135-gate anchors (64/135)
- `scorecard-phase1-2026-08-04.md` — the Phase-1 supersonic-model scorecard

## Baseline reading (why almost everything fails, and why that's fine)

The harness exists to turn red rows green, phase by phase. The classic kernel:

1. **CP travel is wildly overpredicted, not just frozen.** Body CP never reads
   Mach (frozen at its M1 value near the nose) while fin CNα falls off with
   the Busemann 4/β trend — so the *combined* CP races forward far faster than
   any tunnel shows (ARCAS: model 27 %L vs measured 57 %L at M4.63). Phase 1
   (supersonic body CNα/CP) attacks this from both ends.
2. **Supersonic CD is high by ~2×** at M3–4.6 (wave-drag extrapolation + the
   0.25/M base model + no per-shape fin thickness treatment).
3. **The transonic rise starts too early and peaks too low** vs the ARCAS
   tunnel (kernel rises from M0.8; tunnel peaks ≈0.685 at M1.05, kernel
   ≈0.61 at M1.1).
4. **Subsonic CD runs high** on the tunnel fixtures. For ARCAS this is now
   Re-matched (the fixtures carry RASAero's `machAlt` table); Finner and HB-2
   still sweep at ISA sea level — see `anchors.json` `_readme`.

Keep gates honest: never widen a tolerance to make a phase pass — the
tolerances come from the datasets' own stated accuracies.

## Not yet in the harness

- MESOS / Aftershock II / GoFast end-to-end flight fixtures (need thrust-curve
  reconstruction + manual forum retrievals — see anchors doc §2/§6)
- Cajun (fin semispan not in our extract; retrievable from NASA TM X-1771)
- Power-on ΔCD series (Nike-Apache deck) — needs the fixture nozzle-exit data
- Reynolds matching for Finner and HB-2 (ARCAS and rma53d02 are machAlt-matched)
- A plain-body (finless, no boat-tail) cell — evaluated 2026-08-25 and SKIPPED:
  no measured dataset for one exists in the reference material (details in
  `scorecard-anchors-2026-08-25.md`). Candidates if the source reports are
  pulled: TN D-4013 fins-off CA (finless but boat-tailed), TM X-1771 Cajun.
- rma53d02 anchor upgrade from figure reads to the report's tabulated values
  (waiting on the report number from Chuck Rogers)
