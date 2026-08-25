# Anchor revision scorecard — 2026-08-25 (§6a step 1: make the harness see the defects)

Engine: v0.067 (`8d3253d`), committed `orkengine.mjs`, no kernel change in this revision —
**every gate movement below is an anchor/fixture change, not a model change.** Runs:
`node validation/score.mjs` and `--supersonic`, before and after, both archived in the
session scratchpad and reproducible from this tree.

## What changed

1. **ARCAS re-fixtured from Chuck Rogers' own file** (`docs/User files/ARCAS-Long - 2.CDX1`,
   run through the app's real `importCdx1`), every conflict resolved against the TN
   D-4013/D-4014 drawings reproduced in "RASAero II Comparisons with ARCAS CP and CD Data":
   - **Boat-tail rear diameter 1.47 → 1.28 in.** The file wins. D-4013 Fig 1(b) dimensions
     the tail cone **15° × 0.80d**: 2.250 − 2·1.81·tan 15° = **1.280 in exactly** (the old
     1.47 also broke the drawn angle: atan(0.485/1.81) would need the cone to be 12.3°).
     D-4014 Detail A shows where 1.47 came from: the cone reaches R 0.654 (dia 1.308) and a
     small **reflexed base lip** flares to **1.470 D** — the old fixture had misread the lip
     diameter as the cone base. RASAero excluded the lip as buried in the boattail boundary
     layer (comparison doc slide 2), and the anchor dots were read through that comparison.
   - **Fin thickness 0.150 → 0.123 in.** The file wins. D-4014's fin section tapers
     **spanwise 0.150 (root) → 0.096 (tip)** — the drawn 1.47° taper angle is exactly
     2·atan(0.027/2.103) — and **0.123 is the exact mean**, the single-thickness convention
     RASAero uses. The old 0.150 was the root maximum and overstated the t² wave term ~49 %.
   - **Tip chord 2.09 → 2.165 in** (D-4014 dimensions it directly; 2.09 was D-4013's rounded
     ".93d"), sweep 1.214 → 1.215 in (= 2.103·tan 30°).
   - **True fin section**: `doublewedge`, LE chamfer 0.0377521 m (FX1 1.4863 in), TE chamfer
     0.0326695 m (derived: mean chord − FX1), sharp LE — replacing the `airfoil`
     placeholder, which produced no section-specific wave/base terms.
   - **Fins at their true station**: root LE 1.84 in ahead of the boattail (D-4014 stations
     37.30/49.85), TE overhanging it by 1.54 in — `bottom +0.0391161 m`, exactly what
     `importCdx1` produces. The old fixture had them flush, 1.54 in forward of truth.
   - Finish `polished` → `finishpolished` (the importer's mapping of RASAero "Smooth (Zero
     Roughness)"); **measured Δ CD = 0.0000 at every gate Mach** (tunnel Re is not
     roughness-limited), recorded for pipeline consistency only.
   - Anchor **values** untouched.
2. **New cell `rma53d02`** — NACA RM A53D02, gun-launched free-flight ballistic model to
   **Mach 10**, from `docs/User files/RMA53D02 - 2.CDX1` cross-checked against the model
   drawing in Rogers & Cooper 2011 Fig 2. This is the missing **finned M3–10** cell AND the
   missing **non-airfoil fin section** cell (hexagonal blunt base, 3/16 in LE chamfer, blunt
   TE). Two tiers, strictly separated:
   - `cd0-freeflight` (**29 gates**): the *measured* free-flight circles of Fig 2, digitized
     at 600 dpi with grid-calibrated axes and Hough circle detection, verified by overlay.
     relTol 0.08 = the dataset's own visible shot scatter (±7.6 % inside the M7.2 cluster)
     plus digitization. Interim until Rogers supplies the report number and its tabulated
     values — then the reads get replaced and the tolerance re-derived, per the standing rule.
   - `cd-rasaero-reference` (**gate:false, never counted**): RASAero II's published curve —
     another code's *prediction*, kept for cross-code comparison only.
3. **Plain-body cell (finless, no boat-tail): SKIPPED — no defensible measured dataset in
   the reference material.** Checked: the ARCAS comparison PDF (fins-on configs only; the
   D-4013 fins-off runs are not tabulated in any document we hold), Rogers & Cooper 2011
   (RM A53D02 finned; TR R-100 Config 98 is boat-tailed *and* RASAero flags its own
   prediction invalid there, rb/R < 0.5; Aerobee 150A finned), the MESOS report (full-rocket
   flight), Ironbark (no data tables), and the RASAero II Users Manual. HB-2 remains the
   finless anchor but is flared. Candidates if the source reports are ever pulled: the
   D-4013 fins-off CA series (finless but boat-tailed), NASA TM X-1771 Cajun. Nothing was
   invented to fill the slot.

## Scores

| Model | before | after |
|---|---|---|
| Classic Extended Barrowman | 7/135 (5.2 %) | **10/164 (6.1 %)** |
| Supersonic (flag on) | 64/135 (47.4 %) | **52/164 (31.7 %)** |

Per-series (supersonic model; unchanged series omitted — basic-finner and hb2 moved **zero**
gates, confirming the changes are isolated):

| series | before | after | flips |
|---|---|---|---|
| arcas-short `cd-supersonic-tunnel` | 5/6 | **1/6** | M1.8 +0.002→+0.038, M2.29 +0.005→+0.031, M2.95 +0.006→+0.025, M3.95 +0.011→+0.024 all → FAIL; M1.49 (already red) +0.033→**+0.083** |
| arcas-short `cd-transonic-tunnel` | 3/10 | **4/10** | M0.9 −0.041→+0.009 → PASS (honest gain: the true 15° boattail raises pre-transonic CD) |
| arcas-short `cp-supersonic-tunnel` | 5/5 | **1/5** | M1.5 +1.4→+4.9, M2 +0.2→+3.5, M2.5 −0.9→+2.2, M3 −0.6→+2.2 %L → FAIL |
| arcas-long `cd-supersonic-tunnel` | 5/5 | **2/5** | M1.8 +0.004→+0.041, M2.29 +0.007→+0.033, M2.95 +0.001→+0.020 → FAIL |
| arcas-long `cd-transonic-tunnel` | 4/10 | 4/10 | (rows move but no flips) |
| arcas-long `cp-supersonic-tunnel` | 4/4 | **1/4** | M2 +1.3→+3.8, M2.5 +0.0→+2.3, M3 +0.3→+2.3 %L → FAIL |
| rma53d02 `cd0-freeflight` (new) | — | **1/29** | only M1.06 passes |

Classic model: arcas-long transonic 1→3, arcas-short transonic 2→3, arcas-short
cd-supersonic 1→0, rma53d02 +1 ⇒ 7→10.

**These FAILs are the deliverable.** The harness could not see the §6a defects before; now
every one of them is a red row.

## The compensating errors, quantified

The response doc §7.1 predicted it; here it is measured (Long config, machAlt-Re-matched,
flag on — all numbers from this session's runs):

1. **Boat-tail overshoot vs too-fast decay.** With the true geometry the model lands
   **+0.041 at M1.8 (+8.1 %) decaying to +0.001 at M4.65 (+0.5 %)** — §7.1's exact numbers.
   Isolated by single-variable sweeps (old fixture as base): correcting **only** the
   boat-tail 1.47→1.28 adds **+0.060 CD at M1.8 shrinking to +0.019 at M4.65** (the
   overshooting strip-theory term, now on the true 15° cone); correcting **only** the fin
   geometry/section subtracts −0.023 → −0.008. The old fixture's understated boattail was
   cancelling the model's boattail overshoot at low supersonic Mach, and at M4.65 the
   *remaining* overshoot cancels the too-fast decay — which is why the old cell scored
   10/11 with deltas of +0.001…+0.011 while hiding both defects.
2. **The decay defect, uncompensated.** rma53d02 has no boat tail, so nothing masks it:
   **−29 % at M1.95, −33 % at M2.55, and monotonically down to −62 % at M10** against
   measured free-flight data (matching §7.2's file-level measurement: this fixture
   reproduces those runs, −20 %/−27 %/−58 % vs RASAero at M2/3/10).
3. **The M1.5 false peak is now a harness observable.** On the re-fixtured ARCAS Long the
   boat-tail component's CD **climbs through the whole transonic band to a maximum at
   exactly M1.500 (0.3768, up from 0.2556 at M1.05) and only then falls** — the linear
   M0.8→M1.5 blend in the patched `SymmetricComponentCalc`. The total-CD curve now has TWO
   transonic peaks, **M1.150 (0.6552) and M1.500 (0.6601) — and the false one is the global
   maximum**. It lands directly on the M1.49 anchor: +0.083, the worst supersonic-series
   miss on the board.
4. **CP was passing on a mis-placed fin.** Moving the fins to D-4014's dimensioned station
   (aft by 1.54 in) moves model CP **+2.7 %L aft at M2** (76.4→79.1 %L). The old 9/9 CP
   pass was fin-position error compensating the model's aft-CP bias; truthfully placed, the
   model sits **+2.2…+4.9 %L aft of the tunnel over M1.5–3** (still within +0.2…+1.9 %L at
   M4–4.63, info region). Aft-of-measured = margin-flattering, §7.3's caveat now quantified
   and gated red.
5. **New subsonic finding.** rma53d02's two subsonic gates fail HIGH: **+26 % at M0.60,
   +37 % at M0.91** (model 0.455/0.499 vs measured 0.360/0.364) — the model is already
   rising at M0.91 where the data is flat (drag divergence starts too early), the same
   direction Buckeye's flight trace showed subsonically (meas/model 0.86–0.91).

Not carried into the fixtures, measured/bounded: the 4 fin-root anchors (0.178 in² total;
RASAero models them as an equivalent rail guide) — a 2-railbutton proxy measured **+0.002…
+0.005 CD**, but the kernel railbutton's height isn't bridgeable so the proxy's frontal area
can't be made faithful; omitted, so kernel ARCAS CD reads LOW by ≈0.002–0.005 until the
protuberance component (§7.5e) exists. Nose tip radius 0.062 in and the base lip likewise
documented in the fixture notes.

## What the coming model fixes must move (the falsifiable list)

**§7.5(a) — boat-tail transonic blend + 2θ/β recalibration** (next kernel session):
- Acceptance (from §7.1): the ARCAS sweep has a **single** transonic peak, located M1.0–1.15,
  monotone decay above it; the boat-tail component row itself must be monotone after its peak.
- MUST flip: arcas-short `cd-supersonic` **M1.49** (+0.083); arcas `cd-supersonic`
  **M1.8/M2.29/M2.95** on both configs (+0.020…+0.041).
- MUST NOT break: arcas-long **M3.95 (+0.003) / M4.65 (+0.001)**. Warning from the
  decomposition: a pure −17 % boat-tail correction (exact Prandtl–Meyer) pushes these to
  roughly −0.017/−0.016 — inside ±0.02 but with no margin. If they go red, the decay fix
  (d) is being demanded, not a tolerance.
- SHOULD move toward green: arcas `cd-transonic` M1.0–1.2 (−0.055…−0.181) — closing them
  fully is §6a step 3 (the actual transonic rise), not (a) alone. Step 3 must also bring
  rma53d02 **M0.60/M0.91 DOWN** (+26/+37 %) and its M1.32–1.57 cluster UP (−12…−22 %):
  a later peak, and a higher one.
- Watchdog (must stay): basic-finner cd0 0/23, cna 16/23, cp 17/23; hb2 all series.
**§7.5(d) — hypersonic decay recalibration, finned, M>2.5** (after a+b; zero user flights up
there):
- MUST move: rma53d02 `cd0-freeflight` M2.91–M10 — **17 gates, all red, −25 %…−62 %**,
  monotonically worsening with Mach. The `cd-rasaero-reference` series shows where another
  code lands on the same body (info only, never a gate).
- MUST NOT break: hb2 `ca0-aedc` M8–10, which currently errs the OTHER way (+0.14 HIGH,
  finless flare body) — the recalibration is shape-dependent or it is wrong.
**Newly exposed, needs its own decision (not covered by §7.5a–e):** the supersonic CP aft
bias, +2.2…+4.9 %L over M1.5–3 on both ARCAS configs (8 red CP gates). Aft-of-measured
flatters stability margins. Nothing in the planned drag work touches CP.
**Blocked on data:** rma53d02 tolerances/values upgrade when Chuck supplies the report
number (Eric has asked); the fixture `_provenance` note says exactly what to replace.
