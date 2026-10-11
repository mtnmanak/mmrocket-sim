# Validation harness (RASAero #1 supersonic/hypersonic build)

Scores the JS engine against **measured** wind-tunnel and free-flight anchor
datasets. Provenance, tolerances, and every caveat live in
the project's research notes, which record each dataset, its stated accuracy
and every caveat behind the tolerances used here.

## Run it

```
npm run build -w @online-openrocket/engine   # harness imports packages/engine/dist
node validation/score.mjs                    # classic Extended Barrowman (flag off)
node validation/score.mjs --kbf              # Rogers Kbf — THE MODEL THE APP LAUNCHES WITH
node validation/score.mjs --supersonic       # the opt-in supersonic aero model
node validation/score.mjs --hybrid           # experimental Kbf/Supersonic blend
node validation/score.mjs --strict           # exit 1 unless every gate point passes
node --test validation/score.test.mjs        # R-100 fixture and scoring regression checks
```

## Scoreboard

**ANCHOR REVISION (2026-10-11, night; gates unchanged at 191): the TN D-4013 fins-on curves
re-read off the report scan.** The `cd-transonic-tunnel` values came from a 2026-08 read of the
curves as reproduced in Rogers' comparison deck, and they lay below the curve all through the drag
rise on both models (two Long points past the peak, M1.10 and M1.20, sat above it). Examples: Short M0.90 was 0.350 where the scan reads 0.4201; Long M1.00 was
0.63 where it reads 0.7253; the Long peak sat at M1.10 where the curve peaks at M1.02-1.05.
`digitize/read-d4013-ca.py` traces the δF = 0 curve on the NTRS scan, separating it from the dashed
δF = 2 curve where they cross. Read uncertainty is ±0.004. A point was replaced only where the read
differs by more than that and a second method agrees:
- the TRF reproduction of the same figure, read by the same code, agrees at all 20 points;
- the report's own α = 0 data (Fig 7(a)/9(a) C_A plus Fig 3/5 C_p,b × A_b/S) agrees at the tested
  Machs. On the Long model it runs 0.008-0.010 low at M0.60 too, where nothing is disputed, and it
  reproduces the rise.

Points replaced: Short 4 of 10 (M0.70-0.95), Long 8 of 10; the sharp-airfoil cell copies Short.
Tolerance, gate set and kernel are untouched. **Classic 13 → 11, Kbf 41 → 38, Supersonic 86 → 80,
Hybrid 82 → 80/191**, every flip in `cd-transonic-tunnel`. The fin increment this unblocks:
- On the bracket-free Short model the tunnel's fin set rises 1.34× from M0.60 to M0.80 and 2.16× to
  M0.90.
- The three non-classic models stay flat, so the default model's shortfall grows from −14 % (M0.60,
  about 1σ) to −38 % (M0.80) and −62 % (M0.90).
- No Mach the tunnel measured calls for less drag on a sharp-airfoil fin.

Every row, the flips, the increments and the airfoil-fin reading: `scorecard-finson-reread-2026-10-11.md`.

**Scores not recorded here until now (v0.179 kernel, LEDGER: board row 87 and the Supersonic per-fin
CNα top): Kbf 22 → 41, Supersonic 83 → 86, Hybrid 79 → 82; Classic 13.** The table below carries
them.

**INFORMATIONAL ADDITION (2026-10-11, later; gates unchanged at 191): the subsonic CP
anchor, board Tier 0 row 85.** `arcas-short` / `arcas-long` now carry the NASA TN D-4013
fins-on x_cp at M0.60/0.80/0.90 (the Machs the report tested), one `gate: false` series per
independent read of the report figure: Rogers' comparison deck, the project's 2026-08-03 read
(Short only), and a pixel read of the NTRS scan (`digitize/read-d4013-xcp.py`). Tolerance
±0.5 %L, carried from the report's stated C_N/C_m accuracy. The reads disagree by up to
1.8 %L on the Short model, so none gates. They are the harness's only subsonic CP
measurement, and at M0.60 **Rogers Kbf — the app default — sits 0.8–1.1 caliber aft of every
read on both models** (more margin shown than measured); Classic is within 0.3 caliber,
Supersonic 0.6–0.8. Every pre-existing scorecard line is byte-identical in all four models.
Full tables, the tolerance derivation and the proof: `scorecard-subsonic-cp-2026-10-11.md`.

**INFORMATIONAL ADDITION (2026-10-11, gates unchanged at 191): harness coverage —
a small-model cell, plain-body and boat-tailed-body cells, Finner below M1.05.**
Eighteen `gate: false` cells, 193 points, every pre-existing scorecard line
byte-identical in all four models. From NASA TR R-100's config sheets (free flight,
no sting, stated accuracy ΔC_D ±0.01 and ΔM ±0.01): `r100-23`, a 1.00 in body with
three fins of 12.4 × its cross-section in planform — the oversized-fin small-model
regime — measured M0.85–1.25; `r100-78/92/98-finned`, plain (no boat-tail) bodies
with the report's thin fins; and 13 `r100-*-increment` cells scoring each boattail's
measured drag change over the same-length cylinder through a new `cdDelta`
quantity. From Karbon's 2026 R&D report (Figure 23): the Basic Finner's tunnel Cx0,
the harness's only Finner drag below M1.05. **No model lands inside the stated
accuracy on any small-model or plain-body point**: on the small model every model
is high by 0.14–0.21 at M0.85; on the plain bodies by 0.07–0.16 subsonic, with the
kernel's base term plus body friction already above the measured total. They stay
informational because each R-100 curve was read by one reader (a second independent
read would let them gate) and the Finner figure is a reproduction whose source is
not chased. Aerobee 350 is blocked on geometry (Barrowman & Barrowman 1966, not on
disk). Everything, with per-model tables: `scorecard-coverage-2026-10-11.md`.

**Score change not recorded here until now (v0.165, commit 7b47fb3e, board Tier 0
row 75): Supersonic 78 → 83/191, Hybrid 74 → 79/191.** The Supersonic afterbody
factor now counts only the body behind the fin (ARCAS CP gates 2/9 → 7/9; Long M3.5
PASS → FAIL). Classic and Kbf were byte-identical. The table below carries it.

**INFORMATIONAL ADDITION (2026-10-07, gates unchanged at 191): NASA TR R-100
Figure 13(a).** Six helium-gun free-flight points at M1.2 (no sting) compare
afterbody pressure plus base drag, `cdAfterbody`, with friction and fins excluded.
Four conical afterbodies and two cylindrical afterbodies use the report's full
parabolic nose, with no cylindrical midbody. All six series are `gate: false`:
reported, never counted. Classic and Kbf are low on configs 82/83/101 and high on
100; Supersonic and Hybrid are high on all four conical cases. All four models
are within the supplied reading uncertainty on cylinder 92 and high on cylinder
98. These are six measurements at one Mach, not flight-validation results or a
default-model decision. Full provenance, geometry, per-model tables, exact commands
and byte-identical before/after proof: `scorecard-r100-fig13a-2026-10-07.md`.

**ANCHOR REVISION (2026-08-25, 166 → 175 gates): the fins-off cells re-sourced from
NASA TN D-4013 ITSELF.** The report was retrieved from NTRS and its Figures 11 and 12
digitized off the report's own page scans (2368×3104 / 2352×3072, ≈2.8× the linear
resolution of the forum reproductions). The two quoted single-point figure reads are
**superseded** by the whole measured curve, gated at **every Mach the report actually
tested** — 6 points on the Short, 5 on the Long — at a tolerance (**±0.008**, tighter than
the ±0.010 it replaces) now derived from the report's own stated accuracies (C_A ±0.004,
C_p,b ±0.01, M ±0.003) instead of a curve-read band. Verified four ways: an independent
read of a different image by the same code (rms 0.0010), the four-way spread at M0.60
(0.0036), an earlier independent read of the same figure's x_cp panel (~1 %L), and the
report's own prose about where its two fins-off curves cross (M0.975 — reproduced exactly).
**10 of the 11 gates fail in both models**, and they fail in *opposite* directions at
opposite ends of the Mach range: classic 11/175 (6.3 %) *at this revision* — a later pass
took it to the 10/175 in the scoreboard, see `scorecard-transition-2026-08-25.md` —
supersonic 71/175 (40.6 %), with
all five other cells byte-identical. The base-drag panel (C_A,b) was digitized too, its sign
convention established from the report and demonstrated against the report's own C_p,b
figures — and then deliberately **not** gated, because the tunnel base is sting-dominated
and reads as base *thrust* subsonically. Full accounting, including three facts the report
settles that this harness had been guessing at (the models WERE boundary-layer tripped; the
fin anchors stayed on for the SHORT fins-off run only; C_A,corr is base-corrected only for
these summary figures): `scorecard-finsoff-figs-2026-08-25.md`.

**ANCHOR REVISION (2026-08-25, 164 → 166 gates): the FINS-OFF gates.** Two new
cells, `arcas-short-finsoff` / `arcas-long-finsoff` — the same two ARCAS
fixtures with the fin set deleted and nothing else changed — gate the NASA
TN D-4013 **fins-off** (body only) tunnel CD at M0.60. Until this revision only
the fins-on *total* was gated, and on this cell a body error and a fin error of
opposite sign were cancelling inside a passing row: our body runs **+8.3 %
(Short) / +17.9 % (Long)** high while our fin increment runs **10–38 % low**,
and the fins-on total sat inside ±0.03 regardless. **Both new gates FAIL HIGH
in both models** (classic 10/164 → 10/166, supersonic 70/164 → 70/166; no
existing row moved a digit). The percentages fell because the anchors got
harder — again. Full accounting, including the fixture-pair consistency proof
and the measurement that our skin friction on added body length is ~2× the
tunnel's: `scorecard-finsoff-2026-08-25.md`. *Two numbers in that scorecard are
superseded by the revision above, which read the report directly: the body
excess at M0.60 is **+10.0 % / +18.3 %**, not +8.3 % / +17.9 %, and the
friction over-scaling on added length is **at most 1.85×**, not 2.05× — the
Short tunnel number carries fin anchors the Long one does not.*

**ANCHOR REVISION (2026-08-25, 135 → 164 gates):** the two ARCAS fixtures were
re-derived from Chuck Rogers' own CDX1 reconciled against the TN D-4013/D-4014
drawings (boat-tail rear dia **1.308 in** = Detail A's dimensioned cone base
R 0.654, the drawn 15° running over 1.757 in before a 0.053-in reflexed lip
flares to the 1.470 D the drawings also dimension — note 1.470 was *not* a
misreading, it is a real dimensioned diameter, and the defect was using it as
the transition aft radius, which forces a 12.3° cone against the drawn 15°;
an intermediate revision used 1.28 in, which applies 15° over the full 1.810 in
and double-counts the lip length, as Chuck's own decks do; fin thickness
0.123 = the mean of the drawn 0.150→0.096 spanwise
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
exists in the reference material (see the scorecard). *Superseded in part the
same day:* a finless but still **boat-tailed** dataset does exist and is now
gated — see the fins-off revision above. A finless **no-boat-tail** cell is
still absent.

**ANCHOR REVISION (2026-08-04 audit, 137 → 135 gates):** the ARCAS M1.19 rows
in `cd-supersonic-tunnel` (both configs) were removed — they were TN D-4013
CA,corr measurements (base-corrected ⇒ base-EXCLUDED accounting), but sat in a
base-INCLUDED series sourced to D-4014 (whose data starts at M1.5), and the
same measurement was already gated base-excluded as the transonic series' M1.2
point. The old convention had flattered the score by one spurious pass (kernel
base CD ≈ 0.09 at M1.19 vs the ±0.02 tolerance). Phase-1..4 scorecards below
are historical (scored against the 137-gate anchors); the current state under
revised anchors is `scorecard-audit-2026-08-04.md`.

**Read a percentage with its denominator or not at all.** The gate corpus has been revised five
times — 137 → 135 (the 2026-08-04 audit) → 164 (the ARCAS re-fixture plus 29 free-flight gates) →
166 (fins-off cells) → 175 (the fins-off curve from the report scans) → 191 (the sharp-airfoil
cell). Percentages across revisions are not comparable; per-scorecard gate FLIPS are. A denominator
pins the gate SET, not the anchor values — some anchor values moved inside a revision as well, so a
row's grade can change with neither the model nor the denominator moving. *(Hoisted here
2026-09-21: it was one sentence buried 25 lines below the table it governs.)*

| Model | Gate points | Scorecard |
|---|---|---|
| Classic Extended Barrowman | 7/135 historical | `baseline-classic-2026-08-04.md` (135-gate anchors) |
| + Phase 1 (supersonic CP/CNα) | 52/137 historical | `scorecard-phase1-2026-08-04.md` |
| + Phase 2 (drag fidelity) | 68/137 historical | `scorecard-phase2-2026-08-04.md` |
| + Phase 3 (fin airfoil sections) | 65/137 historical | `scorecard-phase3-2026-08-04.md` |
| + Phase 4 (hypersonic corrections) | 65/137 historical | `scorecard-phase4-2026-08-04.md` |
| Phase 4, 2026-08-04 anchors | 64/135 historical | `scorecard-audit-2026-08-04.md` |
| Supersonic, 2026-08-25 anchors, pre-Phase-5 | 52/164 (31.7%) | `scorecard-anchors-2026-08-25.md` |
| Classic, 2026-08-25 anchors (164 gates) | 10/164 (6.1%) | `scorecard-phase6-2026-08-25.md` |
| Supersonic, Phase 5 + Phase 6 (164 gates) | 70/164 (42.7%) | `scorecard-phase6-2026-08-25.md` |
| Classic, + fins-off gates (166) | 10/166 (6.0%) | `scorecard-finsoff-2026-08-25.md` |
| Supersonic, + fins-off gates (166) | 70/166 (42.2%) | `scorecard-finsoff-2026-08-25.md` |
| Classic, fins-off curve gated from TN D-4013 (175) | 10/175 (5.7%) | `scorecard-transition-2026-08-25.md` (11 → 10), gates from `scorecard-finsoff-figs-2026-08-25.md` |
| Rogers Kbf, same revision (175) | 17/175 (9.7%) | `scorecard-transition-2026-08-25.md` (15 → 17), unchanged by `scorecard-airfoil-le-2026-08-27.md` |
| Supersonic, same revision (175) | 71/175 (40.6%) | `scorecard-finsoff-figs-2026-08-25.md` |
| Classic, + the sharp-airfoil cell | 13/191 (6.8%) | `scorecard-nosection-2026-08-29.md` — the 3 gains are the parent cell's own passes double-counted (classic parity, by construction) |
| Rogers Kbf, same revision | 21/191 (11.0%) | `scorecard-nosection-2026-08-29.md` — subsonic tight, M0.95+ runs 16–27% LOW on the desktop-import fin path |
| Supersonic, + the sharp-airfoil cell | 77/191 (40.3%) | `scorecard-nosection-2026-08-29.md` |
| Classic, upstream aero fixes #3262/#3236/#3237 (191 gates) | 13/191 (6.8%) historical | `scorecard-aerofix-2026-10-08.md` — one gain (RMA53D02 M1.06) and one loss (ARCAS-Long M1.8); re-scored unchanged on the v0.177 kernel in `scorecard-coverage-2026-10-11.md` |
| Rogers Kbf, same kernel | 22/191 (11.5%) historical | `scorecard-aerofix-2026-10-08.md` — basic-finner CP M1.056 now passes; unchanged on the v0.177 kernel |
| Supersonic, upstream aero fixes (191 gates) | 78/191 (40.8%) historical | `scorecard-aerofix-2026-10-08.md` — RMA53D02 M1.53 now passes; Hybrid 73 → 74 the same way |
| Supersonic, + the afterbody-factor fix (v0.165, row 75) | 83/191 (43.5%) historical | commit 7b47fb3e (ARCAS CP 2/9 → 7/9, Long M3.5 PASS → FAIL); re-scored on the v0.177 kernel in `scorecard-coverage-2026-10-11.md` |
| Hybrid, same kernel | 79/191 (41.4%) historical | commit 7b47fb3e (74 → 79); re-scored on the v0.177 kernel |
| Rogers Kbf, v0.179 kernel (row 87: Fleeman nose wave drag) | 41/191 (21.5%) historical | LEDGER row-87 entry (22 → 41); superseded by the fins-on re-read below |
| Supersonic / Hybrid, v0.179 kernel (per-fin CNα top) | 86 / 82/191 historical | LEDGER entry (83 → 86, 79 → 82); superseded by the fins-on re-read below |
| **Current: classic, v0.179 kernel, fins-on curves re-read (191 gates)** | **11/191 (5.8%)** | `scorecard-finson-reread-2026-10-11.md` — Short M0.95 and Short-nosection M0.95 PASS → FAIL |
| **Current: Rogers Kbf — THE SHIPPED DEFAULT, same** | **38/191 (19.9%)** | same — M0.90 PASS → FAIL on Short, Short-nosection and Long |
| **Current: supersonic, same** | **80/191 (41.9%)** | same — M0.90 ×3 and Long M0.95/1.00/1.10 PASS → FAIL |
| **Current: hybrid, same** | **80/191 (41.9%)** | same — M0.90 ×3 PASS → FAIL, Long M1.10 FAIL → PASS |

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
  - `arcas-short-finsoff.json` / `arcas-long-finsoff.json` — the same two, fin
    set deleted and NOTHING else changed, against TN D-4013's fins-off (body
    only) run. The only cells that isolate body drag from fin drag; keep them
    byte-identical to their finned siblings or the difference stops being
    readable (the consistency identity is in each fixture's `_notes`). Gated
    across M0.60–1.20 from the report's own Figures 11/12 since 2026-08-25.
    **They are not equivalent articles:** the report left the un-faired fin
    anchors in place as slot plugs on the SHORT fins-off model and faired the
    LONG one flush with balsa, so the Short tunnel number carries protuberance
    drag no fixture models and the Long one is clean. Where the two disagree
    about our body error, the Long cell is the better-posed comparison
  - `basic-finner.json` — Army-Navy Basic Finner, cone + rectangular fins,
    free-flight data to M4.47
  - `hb2.json` — AGARD HB-2 blunt cone-cylinder-flare, finless body anchor to
    M10 (geometry approximated pending nose-bluntness support)
  - `rma53d02.json` — NACA RM A53D02 gun-launched free-flight model, ogive +
    hexagonal-blunt-base fins, measured data to M10 (the finned M3–10 cell and
    the only non-airfoil fin-section cell; interim figure-read anchors until
    the report number arrives)
  - `r100-{82,83,101,100,92,98}.json` — NASA TR R-100 Figure 13(a), full
    parabolic nose (`shapeParameter: 1`, l_N/d = 7.13) directly followed by a
    conical transition or cylindrical body tube. d = 0.0381 m; no fins or
    midbody. `cdAfterbody` subtracts the same nose-only fixture's pressure CD
    from the full fixture's pressure CD, adds its base CD, then applies
    `refAreaScale` (1 here). A cylindrical afterbody contributes base CD only.
    Identical model flags and Mach/altitude conditions apply to both sweeps.
    Re was approximately 8–12 million on length; sea-level ISA is acceptable
    for this pressure-plus-base quantity because friction is excluded.
    Uncertainties are the supplied two-reader half-difference plus reading
    resolution (±0.007 for config 82, ±0.005 for the other five), not fitted
    tolerances. The research report's equation (1) remains unresolved and is
    not used. These fixtures isolate the reported fin-excluded quantity;
    the real models were fin-stabilised.
  - `r100-{78,79,80,81,93,94,95,99,102,103}.json` (2026-10-11) — the rest of
    R-100's Figure 10 series as finless bodies (same nose; cylinder, or a curved
    afterbody as an exact parabolic transition). With the four conical
    Figure 13(a) bodies they are the two sides of the `cdDelta` increments:
    boattailed body minus the same-length cylinder (78, 92 or 98).
  - `r100-{78,92,98}-finned.json` (2026-10-11) — the plain bodies with the
    report's three type-A fins as drawn (1.8 in chords, 45° sweep, 0.05 in
    hexagonal section), scored on total C_D,T.
  - `r100-23.json` (2026-10-11) — the small-model cell: 1.00 in body, three
    type-A fins of 12.4 × its cross-section, 40° cone tip plus a power-0.5
    curved nose section read off the sheet's r/R plot, 2 in conical boattail.
- `anchors.json` — machine-readable anchor tables (units/conventions in its
  `_readme`; `gate: false` series are informational; a point may carry its own
  tolerance as a third element)
- `score.mjs` — builds each fixture, runs `dragSweep` (which emits CD
  power-off/on + CP + CNα per Mach), interpolates at anchor Machs, grades.
  `cdDelta` subtracts a `referenceFixture` swept under the same model
- `scorecard-finson-reread-2026-10-11.md` — **the newest scorecard**: the TN D-4013 fins-on
  `cd-transonic-tunnel` curves re-read off the NTRS scan and checked two other ways, 12 points replaced,
  every gate flip in all four models (11 · 38 · 80 · 80 of 191), the fin increment above M0.70 and what it
  says about airfoil fin drag.
- `digitize/read-d4013-ca.py` — the reader behind that revision: give it the NTRS PDF of TN D-4013 (and
  optionally the two TRF images of Figs 11/12) and it prints every fins-on, dashed and fins-off read,
  the independent route through Figs 7/9 and 3/5, and the keep/replace decision per point.
- `scorecard-subsonic-cp-2026-10-11.md` — the TN D-4013
  subsonic CP series (three reads Short, two Long, all informational), the ±0.5 %L
  tolerance derived from the report's stated accuracy, every existing line
  byte-identical, gate scores 13/191 · 22/191 · 83/191 · 79/191 on the v0.178 kernel.
- `digitize/read-d4013-xcp.py` — the pixel reader behind the `cp-subsonic-tunnel-scanread`
  series: give it the NTRS PDF of TN D-4013 (not committed) and it prints the reads.
- `scorecard-coverage-2026-10-11.md` — 18 informational
  cells (small model, plain body, boattail increments, Finner tunnel series), every
  existing line byte-identical, gate scores 13/191 · 22/191 · 83/191 · 79/191
  (Classic · Kbf · Supersonic · Hybrid) on the v0.177 kernel.
- `scorecard-aerofix-2026-10-08.md` — no anchor or tolerance
  changed, the kernel did (three upstream aero fixes, all four models). Gate scores
  13/191 · 22/191 · 78/191 · 74/191 (Classic · Kbf · Supersonic · Hybrid), with every
  verdict that changed listed.
- `scorecard-r100-fig13a-2026-10-07.md` — six new
  informational points and all four models measured, with every prior output
  byte unchanged. Gate scores remain 13/191 · 21/191 · 77/191 · 73/191
  (Classic · Kbf · Supersonic · Hybrid).
- `scorecard-nosection-2026-08-29.md` — the latest gate-set revision. It is where
  the **13/191 · 21/191 · 77/191** that held until the 2026-10-08 kernel change was set. Walk back through the entries below for how
  each earlier revision's denominator was reached. *(This line named the 27 August scorecard and
  its 10/17/71 until 2026-09-21 — two revisions of the gate set out of date, in the one place
  that tells a reader where to start.)*
- `scorecard-finsoff-figs-2026-08-25.md` — where the gate count reached 175: TN D-4013
  retrieved from NTRS, Figures 11/12 digitized off the report's own page scans,
  the fins-off gates expanded 2 → 11 at a tolerance derived from the report's
  accuracy table, the base panel's convention established and then ruled
  un-gateable, and the measured shape of the body-only error vs Mach.
  **It records classic at 11/175** — the 10/175 in the scoreboard came later.
- `scorecard-anchors-2026-08-25.md` — the 2026-08-25 anchor revision,
  before/after accounting, the measured compensating-error decompositions, and
  the falsifiable gate list the model fixes must move
- `baseline-classic-2026-08-04.md` — the classic Extended Barrowman scorecard
  under the historical 135-gate anchors (7/135)
- `scorecard-audit-2026-08-04.md` — the supersonic-model scorecard under the
  historical 135-gate anchors (64/135)
- `scorecard-phase1-2026-08-04.md` — the Phase-1 supersonic-model scorecard
- `scorecard-phase5-2026-08-25.md`, `scorecard-phase6-2026-08-25.md` — the Phase-5/6 passes
- `scorecard-finsoff-2026-08-25.md` — the first two TN D-4013 fins-off gates
  (`scorecard-finsoff-figs-2026-08-25.md`, which expanded them to 11, is listed above)
- `scorecard-junction-2026-08-25.md` — the ×1.8 fin-junction term moving into Kbf.
  **Scored on the older 164-gate anchors** — it carries no /175 figure, so it cannot be
  cited for any number in the scoreboard above
- `scorecard-transition-2026-08-25.md` — boundary-layer transition refuted three ways, and
  the parity boundary enforced (this is where classic went 11 → 10/175)
- `scorecard-airfoil-le-2026-08-27.md` — the sharp-AIRFOIL leading-edge term moving into Kbf
  (v0.075): why not subsonic-only (a +1.21 CD step at M0.90), the 4×3 containment matrix, and
  the finding that **the harness is blind to the change**
- `scorecard-nosection-2026-08-29.md` — the cell that ended that blindness: arcas-short with
  the section tags deleted (the desktop-import path), 175 → 191 gates, and the first
  measurement of the v0.075 branch against the tunnel (Kbf 16–27% low above M0.95)
- `scorecard-finsoff-reread-2026-08-29.md` — the ARCAS-Long fins-off anchor confirmed by an
  independent third read (+0.0001/+0.0027 vs the gated values); the +0.020 re-read hypothesis
  refuted, so the Long/Short body-drag split stands as real physics, not a data error

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
   ≈0.61 at M1.1). *Refined 2026-08-25, on the body alone with the fins
   removed, which is where this can be measured without a fin term to argue
   about:* the classic **body** rise starts **too late, not too early** — drag
   divergence (CD 10 % above its M0.60 value) at M1.00 against the tunnel's
   M0.86, and past M1.00 the tunnel body is flat to within 2 tolerances while
   classic peaks at M1.10 and falls away 34 % low by M1.20. The supersonic model
   gets the divergence Mach about right (M0.90) and then never stops climbing,
   ending 32 % high. Numbers: `scorecard-finsoff-figs-2026-08-25.md` §5.
4. **Subsonic CD runs high** on the tunnel fixtures. For ARCAS this is now
   Re-matched (the fixtures carry RASAero's `machAlt` table); Finner and HB-2
   still sweep at ISA sea level — see `anchors.json` `_readme`.

Keep gates honest: never widen a tolerance to make a phase pass — the
tolerances come from the datasets' own stated accuracies.

## Not yet in the harness

- ~~A finned fixture with an AIRFOIL cross-section and NO named `airfoilSection`.~~ —
  **CLOSED 2026-08-29**: `arcas-short-nosection` gates the desktop-import fin path against the
  same tunnel measurement as its parent (175 → 191 gates). See
  `scorecard-nosection-2026-08-29.md` for the first accuracy measurement of the v0.075 branch
  (the behavioural guard in `orkEngine.test.ts` still pins containment and continuity).

- MESOS / Aftershock II / GoFast end-to-end flight fixtures (need thrust-curve
  reconstruction + manual forum retrievals — see anchors doc §2/§6)
- Cajun (fin semispan not in our extract; retrievable from NASA TM X-1771)
- Power-on ΔCD series (Nike-Apache deck) — needs the fixture nozzle-exit data
- Reynolds matching for Finner and HB-2 (ARCAS and rma53d02 are machAlt-matched)
- A plain-body (finless, **no boat-tail**) cell — still absent. The 2026-08-25
  entry here said no measured finless dataset existed at all; that was wrong
  and is corrected: **TN D-4013 fins-off CA was pulled and gated the same day**
  (`scorecard-finsoff-2026-08-25.md`), but its body keeps the 15° boat tail, so
  it is not the plain-body cell. Remaining candidate: TM X-1771 Cajun.
  R-100 configs 92/98 now provide informational cylinder **base-only** points
  at M1.2, and since 2026-10-11 `r100-{78,92,98}-finned` give informational
  plain-body **total** drag over M0.80–1.25 — but with fins on, and single-read,
  so a finless plain-body gate is still absent.
- **Aerobee 350** (Karbon's Figure 24 CP comparison: Barrowman 9.931 m, wind
  tunnel 10.008 m) — needs the vehicle geometry and test Mach from Barrowman &
  Barrowman, *The Theoretical Prediction of the Center of Pressure*, NARAM-8 R&D
  (1966), which is not on disk.
- **Second, independent reads** of R-100 Figure 10, config 23 and Karbon's
  Figure 23 — the step that would let the 2026-10-11 cells gate.
- **Small models below M0.85**: `r100-23` covers the oversized-fin regime only
  from M0.85 up (its sheet has no lower data).
- **Fins-off data above M1.2** — TN D-4013's stops there, so no supersonic gate
  can be attributed to the fin term versus the body. This is the single missing
  measurement blocking the ×1.8 question (`scorecard-junction-2026-08-25.md`).
- ~~Upgrading the two fins-off anchors from figure reads to tabulated values~~ —
  **DONE 2026-08-25** (`scorecard-finsoff-figs-2026-08-25.md`): TN D-4013 was
  retrieved from NTRS and Figures 11/12 digitized off its own page scans, so the
  tolerance now comes from the report's stated accuracy (C_A ±0.004, C_p,b
  ±0.01, M ±0.003) and the gates cover every Mach the report tested. Fully
  tabulated values are still not published in the report — everything in it is
  plots — so a figure read remains the only route, but it is now a read of the
  primary source, verified four ways.
- ~~Re-reading the fins-ON transonic curves (`cd-transonic-tunnel`) the same
  way.~~ — **DONE 2026-10-11** (`scorecard-finson-reread-2026-10-11.md`): 12 points
  replaced (Short 4, Long 8), each confirmed by a second read. Still open from it: four of
  the ten gated fins-on Machs on the Short model and five on the Long are fairing points the
  report did not test (M0.70, 1.05, 1.10, 1.15 on both, plus M0.95 on the Long), which the fins-off cells carry as `gate: false`. The
  series' ±0.03 is not derived from the report's accuracy; a report-derived budget would be
  about ±0.008 subsonically. Both would change the gate set or a tolerance derivation, so
  they are left for their own decision.
- **The base-drag panel (C_A,b) of TN D-4013 Figs 11/12** — digitized, its sign
  convention established from the report and demonstrated against the report's
  own C_p,b figures, and deliberately NOT gated: the tunnel base is
  sting-dominated (1-in sting in a 1.46-in base, 19.2° flare 11.5 in aft) and
  reads as base *thrust* subsonically, which our kernel cannot and should not
  reproduce. Values are in the two cells' `_provenance`. Gating them would need
  a `cdBase` quantity in `score.mjs`; do not add one until there is a base
  measurement with no sting in it. R-100 Figure 13(a) now supplies sting-free
  cylinder base-only points through `cdAfterbody`, informational only; this
  does not change the TN D-4013 sting caveat or authorize its gating.
  The same caveat is now open against
  `cd-supersonic-tunnel`, which gates our base-INCLUDED CD against TN D-4014's
  *uncorrected* C_A — that report prints its chamber axial force separately
  (its Fig 4) and is retrievable the same way.
- rma53d02 anchor upgrade from figure reads to the report's tabulated values
  (waiting on the report number from Chuck Rogers)
