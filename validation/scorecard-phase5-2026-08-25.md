# Phase 5 scorecard — 2026-08-25 (§6a step 3a: boat-tail shape, ogive nose wave drag, LE-sonic fin sweep)

Engine: kernel rebuild on top of v0.067 (`8d3253d`) — three shape-selective changes to the
opt-in **Supersonic** aero model, ledgered as *RASAero feature #1 Phase 5* in
`engine-java/patches/LEDGER.md`. Scored against the 2026-08-25 anchors
(`scorecard-anchors-2026-08-25.md`), which were written *before* any of this and are
unchanged: **no anchor, tolerance or fixture was touched in this pass.** Runs:
`node validation/score.mjs` and `--supersonic`, before and after.

> **This is a partial fix and the table below says where it stops.** Two of the three
> defects moved a long way; the third — the transonic *peak location* — moved only
> partly, and one cell got no better at all subsonically. All of that is quantified here
> rather than left for a reader to find.

## Headline

| Model | before | after |
|---|---|---|
| Classic Extended Barrowman (flag off) | 10/164 (6.1 %) | **10/164 — all 164 rows byte-identical** |
| Supersonic (flag on) | 52/164 (31.7 %) | **69/164 (42.1 %)** |

**17 gates flipped green; none flipped red.** The 87 CP/CNα rows are byte-identical too —
this pass touches drag only.

## What changed in the kernel

1. **Boat-tail wave drag rebuilt** (`SymmetricComponentCalc`). Phase 2 blended linearly
   from the subsonic estimate at M0.8 to the linearized `2θ/β` value at M1.5, putting the
   boat-tail's maximum at exactly M1.500. Phase 5: classic estimate to M0.90 → smoothstep
   to M1.05 → plateau to M1.20 → **exact Prandtl–Meyer** expansion Cp above (θ clamped at
   20°, where a boat tail separates).
2. **Fleeman ogive nose wave drag** (`SymmetricComponentCalc`). The classic OGIVE branch
   builds its whole supersonic curve from the surface slope over the aft 1 % of the shape,
   which is zero by construction for a tangent ogive — so the nose wave term had collapsed.
   Flag on, nose ogives with shape parameter ≥ 0.35 only.
3. **LE-sonic fade of the fin sweep relief** (`FinSetCalc.sweepWaveFactor`). cos²Γ relief on
   fin thickness wave drag is only valid while the leading edge is subsonic-normal.

Sources, formulae and the determinism argument for the new bisection are in the LEDGER
entry. The differential test went 271 → **286 lines** (three new golden scenarios covering
the new code paths); all 15 new lines are bit-identical JVM ↔ TeaVM.

## Per-series movement (supersonic model)

| cell / series | before | after | gates that flipped (delta before → after) |
|---|---|---|---|
| arcas-long `cd-transonic-tunnel` | 4/10 | **8/10** | M0.95 −0.0368→−0.0098 · M1.0 −0.1694→−0.0245 · M1.05 −0.1812→−0.0261 · M1.1 −0.1582→−0.0196 |
| arcas-long `cd-supersonic-tunnel` | 2/5 | **3/5** | M2.95 +0.0202→+0.0175 |
| arcas-short `cd-transonic-tunnel` | 4/10 | **5/10** | M1.1 −0.1355→+0.0031 |
| arcas-short `cd-supersonic-tunnel` | 1/6 | 1/6 | none — every row improved, none crossed (M1.49 +0.0831→+0.0704, M1.8 +0.0385→+0.0305, M2.29 +0.0312→+0.0269, M2.95 +0.0251→+0.0224, M3.95 +0.0241→+0.0234) |
| rma53d02 `cd0-freeflight` | 1/29 | **12/29** | M1.32 · M1.44 · M1.46 · M1.57 · M4.04 · M4.56 · M4.57 · M4.64 · M4.73 · M5.45 · M5.49 |
| arcas `cp-supersonic-tunnel` (both) | 2/9 | 2/9 | **byte-identical** — nothing here touches normal force |
| basic-finner (cd0 / cnα / cp) | 0/23 · 16/23 · 17/23 | unchanged | **all 69 rows byte-identical** |
| hb2 (cnα / xcp / ca0) | 0/9 · 5/9 · 0/8 | unchanged | **all 26 gated rows byte-identical** (and its informational transonic series too) |

The last two lines are the load-bearing ones: Basic Finner's fins are unswept
(sweepWaveFactor ≡ 1 by construction) and both it and HB-2 have **conical** noses, so
neither the Fleeman branch nor the sweep fade can reach them, and HB-2 has no boat tail.
The shape-selectivity claim is measured, not asserted — which matters because HB-2 runs
**+0.13…+0.26 HIGH** at M2–10, so any global drag increase is falsified on sight.

## Defect 1 — the M1.5 false peak. Verified by sweeping the curve, not by reading the code

The falsifiable acceptance test was: *the ARCAS sweep has a single transonic peak, and the
boat-tail component row is monotone after its peak.* ARCAS Long, flag on, Re-matched,
0.025 Mach grid:

| | before | after |
|---|---|---|
| boat-tail row local maxima | **M1.500 = 0.3768** | **M1.050 = 0.4376** (only one) |
| boat-tail row above its peak | rises to M1.500 | monotone decreasing to M10 — 0.4340 (M1.10), 0.4278 (M1.20), 0.2939 (M1.500), 0.1926 (M2), 0.0527 (M5) |
| total-CD local maxima | **two: M1.150 = 0.6552 and M1.500 = 0.6601** | **one: M1.200 = 0.8221** |
| total above M1.2 | rises again from M1.325 | no rise anywhere above the peak |

**The false peak is gone and the boat-tail row passes cleanly.** The exact-vs-linearized
recalibration is in there too: for the ARCAS 15° turn, exact PM / `2θ/β` measures 0.66 at
M1.2, 0.73 at M1.8, 0.50 at M4.65 — so the term dropped in level as well as changing shape
(−0.064 CD at M1.8, −0.039 at M4.65).

**Where it stops: the total peak sits at M1.200, not M1.05–1.10.** That half of the
acceptance test is *not* met, and the reason is measured. Between M1.05 and M1.20 the
tunnel total falls 0.085 while our model rises 0.061, because two *other* transonic bridges
in this patch set still top out at the end of their ramps: the fin thickness-wave blend
(linear M0.9 → 1.2) adds +0.042 across that interval and the nose bridge (M1.0 → 1.3) adds
+0.026. Consequence: M1.15 and M1.2 now overshoot the tunnel by **+0.0712 / +0.1197**
(they were −0.0801 / −0.0547 low). That is a smaller, opposite-signed error, and closing it
is the §6a **step 3** transonic-rise item — a real fin/nose transonic model, not a knob.

Residual decomposition at M1.2 (ARCAS Long, base-excluded; model 0.7547 vs tunnel 0.635):
friction 0.2766, boat-tail wave 0.3538, fin wave 0.0673, nose wave 0.0570.

## Defect 2 — supersonic/hypersonic decay on finned bodies

NACA RM A53D02, free-flight measured anchors, relTol 8 %:

| Mach | before | after | anchor tol |
|---|---|---|---|
| 0.60 | +26.4 % | **+26.1 %** (unchanged) | ±8 % |
| 0.91 | +37.1 % | **+38.4 %** (slightly worse) | ±8 % |
| 1.95 | −28.8 % | **−15.2 %** | ±8 % |
| 2.10 | −29.5 % | **−15.6 %** | ±8 % |
| 2.55 | −33.0 % | **−18.6 %** | ±8 % |
| 3.30 | −32.4 % | **−12.6 %** | ±8 % |
| 4.04 | −25.3 % | **+0.3 % PASS** | ±8 % |
| 4.73 | −29.3 % | **−1.2 % PASS** | ±8 % |
| 5.45 | −29.0 % | **+5.3 % PASS** | ±8 % |
| 7.20 | −54.4 % | **−21.4 %** | ±8 % |
| 10.0 | −61.8 % | **−16.1 %** | ±8 % |

Eric's Mach-5 scope ruling makes M2–5 the primary band. Against these free-flight anchors
its twelve gates ran **−25.3 %…−33.0 %** before and run **−18.6 %…+1.1 %** now, with 7 of
the 9 gates in M4–5.5 green (the two reds are M4.00 at −8.8 % and M5.32 at +9.6 %, both
just outside ±8 %). Above M5 the nine gates ran −25 %…−62 % and now run between +9.6 % and
−24.7 %; **every single row's absolute error fell** — nothing regressed anywhere on this
cell above M1.06. (For cross-reference with the thread: the earlier "−20 % at M2 / −58 % at M10"
figures were measured against *RASAero's prediction*, which itself sits below these
free-flight points transonically; the percentages here are against the measured data.)

Attribution, measured on nose-only and fin-only isolation runs:

- **Nose wave drag was the dominant hole, not the Phase-4 fade.** Measured nose pressure CD
  on the RM A53D02 nose, flag on, before: 0.00123 (M1.0), **0.00036 (M2)**, 0.00006 (M10) —
  i.e. essentially zero, because `sinphi` is 0.00123 for a tangent ogive. After: 0.0180
  (M1.0), 0.0605 (M2), 0.0475 (M10). At M2.1 that single term is **the whole closure**
  (+0.0589 of the +0.0588 the gate moved) — the fin term is zero there by design.
- **Fin wave drag was crushed 10× by cos²Γ.** These fins have tanΓ_LE = 3 exactly ⇒
  cos²Γ = 0.100. Isolated fin-set wave drag at M5: **0.00053 → 0.00536**; at M10
  0.00026 → 0.00264. The LE goes sonic at M3.16, so this term does nothing below M2.85 —
  which is correct (the relief is genuinely valid there) and is why M2–3 closed less than
  M4–5.
- Side effect worth knowing: the fade puts a small local maximum in the *fin* row at M3.20
  (0.0675 vs 0.0666 at M3.0) as the LE crosses sonic. It is real physics (the LE-sonic drag
  rise), it is 0.3 % of the total, and the total curve stays monotone through it.

## What is still wrong (the honest list)

1. **rma53d02 subsonic, +26 % / +38 % at M0.60 / M0.91 — untouched, and now diagnosed.**
   Decomposition at M0.60 (model 0.4539 vs measured 0.360): friction 0.2503 (55 %), body
   base drag 0.1668 (37 %), fin blunt-base 0.0368 (8 %). Two carved-classic terms account
   for it:
   - *Fully-turbulent friction.* Re = 8.8×10⁵ over this 63.5 mm model — just past the
     kernel's turbulent switch. The kernel's own alternative branch
     (`Rocket.isPerfectFinish`, partial-laminar: `Cf = 1/(1.5 ln Re − 5.6)² − 1700/Re`)
     gives Cf 0.00255 instead of 0.00433. Substituting it lands total CD at **0.3511 vs the
     measured 0.360 (−2.5 %, inside the gate)** at M0.60 and cuts M0.91 from +38 % to
     +23 %. The Cf model was verified against the kernel first: predicted
     friction(M0.9)/friction(M0.6) = 0.88012, measured 0.88011.
   - *The base-drag law.* `0.12 + 0.13 M²` rises 37 % from M0.6 to M0.91 across a band
     where the measured CD is flat (0.360 → 0.364).
   Neither is this change's to move: both are classic carved physics that every rocket
   uses, and `isPerfectFinish` is not even reachable through the engine bridge today.
   Recorded for step 3 — and note it is the band where users actually fly.
2. **ARCAS still reads high supersonically**: +0.070 at M1.49, +0.0175…+0.0326 at M1.8–2.95
   (both configs), +0.002/+0.002 at M3.95/M4.65 on Long but +0.023/+0.009 on Short. The
   prime suspect is named and measured: the **Mach-flat ×1.8 fin-junction friction factor**,
   worth **+0.0222 (M1.8), +0.0172 (M2.95), +0.0112 (M4.65)** on ARCAS Long — measured as
   4/9 of the fin friction, itself isolated as the fin row minus the fin pressure row.
   Subtracting those measured amounts from the current deltas would put six more ARCAS
   supersonic gates inside tolerance (arithmetic on measured numbers — *not* run, because
   the factor is not this change's to remove). It would also push rma53d02 and Basic Finner
   (both already LOW) further down: on rma53d02 the same factor is worth +0.0269 at M2.
   It stays bundled; it is Eric's §6a step-2 decision, not a knob to turn here.
3. **Basic Finner cd0 stays 0/23** and rma53d02 stays low through M2–3. Both are finned
   free-flight cells running LOW while HB-2 (finless) runs HIGH — the same pattern the
   Phase-3 ledger flagged: base pressure behind a *finned* body sits below the
   clean-cylinder law. Still the McCoy/BRL base-pressure backlog item; deliberately not
   attempted, because raising base drag globally is falsified by HB-2 on sight.
4. **The supersonic CP aft bias (8 red gates, +2.2…+4.9 %L over M1.5–3) is untouched** and
   still needs its own decision. Nothing in this drag work moves CP, and the rows are
   byte-identical proof of that.

## Calibration discipline

The design has exactly one declared knob, `CAL_BRIDGE_SLOPE_CAP` (the sonic drag-rise slope
cap on the new nose bridge), and it was **measured across its whole declared range rather
than fitted**: at 1.5 / 2.0 / 3.0 the score is 69/164 in all three cases, every per-series
count identical, and the largest single gate-row movement is 0.0093 CD (ARCAS Long M1.1).
It is a weak knob; 2.0 is simply the middle of the range. No tolerance was widened, no
anchor moved, no fixture edited.

## Informational (not gates)

- Flag-**off** drag is byte-identical on all four fixtures at all 164 rows, and the classic
  golden lines are unchanged — desktop-OpenRocket parity is intact.
- Subsonic effect on an ordinary (no boat tail, ogive nose) rocket, flag on: the new nose
  bridge's subsonic tail adds ≤ 0.0007 CD below M0.8 and 0.004 at M0.9 — under 1 % of a
  typical Cd ≈ 0.5, as required. Boat-tailed rockets get slightly *less* drag at M0.8–0.9
  (the flag-on onset moved M0.8 → M0.90).
- Supersonically it is not a small change, and users of the opt-in model should know: on the
  ARCAS nose, isolated, nose pressure CD at M1.5 goes **0.0005 → 0.0539**, and that 4-inch
  rocket's flag-on total CD at M1.5 is now 0.497. Restoring a real ogive nose wave term adds
  roughly 0.05 CD (base-area referenced) to every ogive-nosed design above M1.3 in the
  Supersonic model. Classic (the default) is unaffected.
- `validation/README.md`'s scoreboard table still shows the pre-Phase-5 numbers; updating it
  (and a `version.json` bump) belongs with the release, not with this measurement pass.
