# Phase 6 scorecard — 2026-08-25 (§6a step 3: the transonic defect class, finished as far as it goes)

Engine: kernel rebuild on top of the Phase-5 tree. **One** kernel change, ledgered as
*RASAero feature #1 Phase 6* in `engine-java/patches/LEDGER.md`. Scored against the
2026-08-25 anchors, unchanged: **no anchor, tolerance or fixture was touched in this pass.**
The 66/164 flag-on baseline was re-measured from the tree at the start of this pass rather
than copied from `scorecard-phase5-2026-08-25.md`, which recorded 69/164. The difference is not
a regression and is not a model change: the two ARCAS fixtures on disk now carry boat-tail rear
diameter **1.308 in** (`aftRadius` 0.0166116 m) where the anchor-revision scorecard describes
1.28 in, and their mtimes (11:15/11:16) postdate the Phase-5 scorecard (11:12). A shallower
boat tail makes less wave drag, which costs three transonic gates. Every before/after number
below is measured against the same fixtures.
Runs: `node validation/score.mjs` and `--supersonic`, before and after.
Artifact md5 `5f947867e1bde5c65d45a241bad6bc4f` → `8456e660a9284f3fcfe2f93131f77188`.

> **Read the acceptance section before the headline.** Half of this pass's falsifiable
> acceptance test is met and half is **not**, and the half that is not met turns out to be
> unreachable from the two terms this pass was scoped to — that is a measured result with
> the arithmetic printed below, not an excuse. One of the two changes the task called for
> was **not made**, because measuring it first showed the premise was wrong.

## Headline

| Model | before | after |
|---|---|---|
| Classic Extended Barrowman (flag off) | 10/164 (6.1 %) | **10/164 — all 164 rows byte-identical** |
| Supersonic (flag on) | 66/164 (40.2 %) | **70/164 (42.7 %)** |

**4 gates flipped green, none flipped red.** 18 of 226 scorecard rows moved at all; the other
208 are byte-identical, including every CP and CNα row and every gated row above M1.20.

## What changed in the kernel

**One thing: the fin thickness-wave transonic bridge**
(`FinSetCalc.thicknessWave` / `betaEffThickness`, both flag-on call sites — the feature-#4
`sectionPressureCD` path and the plain `AIRFOIL` cross-section path).

Phases 2/3 blended **linearly** from zero at M0.9 up to the branch value at M1.2 and only then
followed `factor·τ²/β`. But that branch *decreases* with Mach — for the ARCAS fin it is 2.07×
larger at M1.05 than at M1.20 — so the ramp put the term's maximum at exactly M1.200, the top
of its own bridge, while the physics it bridged onto was already falling. Phase 6 replaces it
with the construction the Phase-5 boat tail uses:

```
  M <= 0.90      zero (profile drag stays in the friction form factor)
  0.90 -> 1.05   smoothstep rise to the transonic peak
  M >= 1.05      factor*tau^2/beta_eff  — monotone decreasing in M
```

with `beta_eff = max(sqrt(M²−1), sqrt(K)·[(γ+1)M²τ]^(1/3))`, K = 1.

- **The band edges are RASAero's own regime boundaries**, not fitted: *RASAero II Users
  Manual* p.90 prints Subsonic **M0.01–0.90**, Transonic **M0.91–1.04**, Supersonic-Hypersonic
  **M1.05–25**. Phase 5 chose the same 0.90/1.05 pair for the boat tail.
- **The peak height is set by the transonic-similarity floor, not by the band edge.**
  K = (M²−1)/[(γ+1)M²τ]^(2/3) is the transonic similarity parameter; linearized (Ackeret)
  thin-section theory is valid for K ≳ 1 (Liepmann & Roshko, *Elements of Gasdynamics* ch. 12;
  Ashley & Landahl, *Aerodynamics of Wings and Bodies* ch. 12). Freezing β at the K = 1
  crossover freezes the branch at its last trustworthy value instead of letting the 1/β
  singularity run away as M → 1⁺. The frozen value works out to
  `factor·τ²/[(γ+1)τ]^(1/3) ∝ τ^(5/3)` — the classic transonic-similarity scaling of peak
  section wave drag comes *out* of the floor rather than being asserted.
- For the ARCAS fin (τ = 0.0437) the floor stops binding at **M ≈ 1.13**, so **every value at
  and above M1.20 is bit-identical to Phase 5**. That is why nothing supersonic moved.
- Flag-gated on both paths. The `sectionPressureCD` path is *input*-gated (feature #4), so an
  ungated change there would move CLASSIC numbers for any design naming an airfoil section —
  the same boundary, and the same open Eric decision, as the Phase-5 sweep fade.

**Not changed: the nose wave bridge.** See "The nose" below — it was measured first and the
premise did not survive the measurement.

New goldens `ssphase6.finwave.*` and `ssphase6.airfoilwave.*` (5 samples each, at M0.85 /
0.95 / 1.05 / 1.10 / 1.30, unswept fins so `sweepWaveFactor ≡ 1` and the samples isolate the
thickness term) cover both call sites and the one new numeric operation in the kernel, the
cube root in the similarity floor. Differential **286 → 296 lines, all 10 new lines
bit-identical JVM ↔ TeaVM**, and every Phase-5 line unchanged.

## Acceptance test — verified by sweeping and printing the curve

The falsifiable acceptance was: *on both ARCAS fixtures the total CD curve has a single
maximum in M1.00–1.15 and decays monotonically above it, and the M1.15/M1.20 overshoot comes
down without pushing M0.95–1.10 back below tolerance.*

| | arcas-long before | arcas-long after | arcas-short before | arcas-short after |
|---|---|---|---|---|
| total CD (base-incl) local maxima | M1.200 = 0.8109 | **M1.125 = 0.8184** | M1.200 = 0.7655 | **M1.125 = 0.7723** |
| number of local maxima | one | **one** | one | **one** |
| above the maximum | monotone decreasing to M5 | **monotone decreasing to M5** | monotone decreasing | **monotone decreasing** |
| fin-set row local maxima | M1.200 = 0.1239 | **M1.125 = 0.1334** | M1.200 = 0.1264 | **M1.125 = 0.1359** |
| nose row local maxima | M1.275 = 0.0914 | M1.275 = 0.0914 | M1.275 = 0.0928 | M1.275 = 0.0928 |
| boat-tail row local maxima | M1.050 = 0.4268 | M1.050 = 0.4268 | M1.050 = 0.4271 | M1.050 = 0.4271 |

(0.025 Mach grid, flag on, machAlt Re-matched, `dragSweep` M0.05–5.)

**Peak location and monotonicity: MET.** The peak moved M1.200 → M1.125 on both configs and
the fin row's own maximum moved with it. Same result on the other two finned cells:
basic-finner's transonic peak M1.100 → **M1.075** (monotone decreasing from there to M5.0) and
rma53d02's M1.075 → **M1.050** (monotone decreasing to M10.5). HB-2 (finless) is unchanged at
M1.200 — byte-identical. (rma53d02's *global* maximum is at the M0.05 end of the sweep grid, a
low-Reynolds friction artifact of sweeping a 63.5 mm model down to M0.05; it is unrelated and
un-gated, and it is there before and after.)

**M1.15 / M1.20 overshoot: NOT MET, and it went the other way at M1.15.**
M1.15 went +0.0571 → **+0.0780** (long) and +0.0412 → **+0.0621** (short). M1.20 is
**byte-identical**: +0.1055 / +0.0991, unchanged to the last digit even though the fin bridge
was rebuilt from scratch. The arithmetic for why is in "Why M1.20 cannot move from here".

**M0.95–1.10 not pushed below tolerance: MET, and they improved.** Every row in that band
moved *toward* the tunnel on both configs; three flipped to PASS on Long and one on Short, and
none flipped the other way.

### The printed curve, ARCAS Long (base-included total CD, flag on, Re-matched)

| Mach | before | after | | Mach | before | after |
|---|---|---|---|---|---|---|
| 0.80 | 0.4303 | 0.4303 | | 1.25 | 0.7738 | 0.7738 |
| 0.85 | 0.4371 | 0.4371 | | 1.30 | 0.7395 | 0.7395 |
| 0.90 | 0.4457 | 0.4457 | | 1.35 | 0.7080 | 0.7080 |
| 0.95 | 0.5321 | **0.5415** | | 1.40 | 0.6802 | 0.6802 |
| 1.00 | 0.6778 | **0.7120** | | 1.50 | 0.6336 | 0.6336 |
| 1.05 | 0.7602 | **0.8040** | | 1.60 | 0.5955 | 0.5955 |
| 1.10 | 0.7781 | **0.8143** | | 1.80 | 0.5357 | 0.5357 |
| 1.15 | 0.7956 | **0.8165** | | 2.00 | 0.4900 | 0.4900 |
| 1.20 | 0.8109 | 0.8109 | | 4.65 | 0.2265 | 0.2265 |

### The term that moved, isolated (ARCAS Long, nose-only / no-fins isolation runs)

Fin-set **pressure** CD alone, before → after:

| Mach | 0.90 | 0.95 | 1.00 | 1.05 | 1.10 | 1.15 | 1.20 | 1.25 | 1.50 | 1.80 |
|---|---|---|---|---|---|---|---|---|---|---|
| before | 0.0000 | 0.0084 | 0.0169 | 0.0254 | 0.0369 | 0.0521 | 0.0673 | 0.0597 | 0.0401 | 0.0299 |
| after | 0.0000 | 0.0179 | 0.0511 | 0.0692 | 0.0732 | 0.0730 | 0.0673 | 0.0597 | 0.0401 | 0.0299 |

The unswept thickness term itself peaks at M1.05 and decays from there; the row peaks at
M1.125 because Phase-5's LE-sonic sweep fade is still climbing across M1.04–1.21 for these
30°-swept fins (Mn = M·cos Γ crosses 0.90 at M1.039 and 1.05 at M1.212). That is Phase-5
physics doing what it was written to do; the combined shape is a broad plateau M1.05–1.15
rather than a spike. Worth knowing rather than hiding.

## Per-series movement (supersonic model)

| cell / series | before | after | rows that moved |
|---|---|---|---|
| arcas-long `cd-transonic-tunnel` | 5/10 | **8/10** | M0.95, M1.0, M1.05, M1.1, M1.15 |
| arcas-short `cd-transonic-tunnel` | 5/10 | **6/10** | M0.95, M1.0, M1.05, M1.1, M1.15 |
| arcas `cd-supersonic-tunnel` (both) | 1/6 · 3/5 | 1/6 · 3/5 | **none — byte-identical, all 11 rows** |
| arcas `cp-supersonic-tunnel` (both) | 1/5 · 1/4 | 1/5 · 1/4 | **none — byte-identical** |
| rma53d02 `cd0-freeflight` | 12/29 | 12/29 | M1.06 only (+0.0070 → +0.0105, still PASS) |
| basic-finner `cd0-freeflight` | 0/23 | 0/23 | M1.056, M1.058, M1.116 (all three closer) |
| basic-finner `cna` / `cp` | 16/23 · 17/23 | unchanged | **byte-identical** |
| hb2 (all five series) | 0/9 · 5/9 · 0/8 | unchanged | **byte-identical — zero rows moved** |

### Every gate that moved

| cell | Mach | tunnel | before | after | result |
|---|---|---|---|---|---|
| arcas-long | 0.95 | 0.470 | −0.0181 | **−0.0087** | pass → pass |
| arcas-long | 1.00 | 0.630 | −0.0367 | **−0.0025** | FAIL → **PASS** |
| arcas-long | 1.05 | 0.720 | −0.0403 | **+0.0035** | FAIL → **PASS** |
| arcas-long | 1.10 | 0.735 | −0.0337 | **+0.0025** | FAIL → **PASS** |
| arcas-long | 1.15 | 0.665 | +0.0571 | **+0.0780** | fail → fail (**worse**) |
| arcas-short | 0.95 | 0.460 | −0.0548 | **−0.0453** | fail → fail |
| arcas-short | 1.00 | 0.683 | −0.1362 | **−0.1020** | fail → fail |
| arcas-short | 1.05 | 0.685 | −0.0518 | **−0.0080** | FAIL → **PASS** |
| arcas-short | 1.10 | 0.666 | −0.0111 | **+0.0251** | pass → pass (thinner margin) |
| arcas-short | 1.15 | 0.635 | +0.0412 | **+0.0621** | fail → fail (**worse**) |
| rma53d02 | 1.06 | 0.538 | +0.0070 | **+0.0105** | pass → pass |
| basic-finner | 1.056 | 0.868 | −0.1222 | **−0.0933** | fail → fail |
| basic-finner | 1.058 | 0.868 | −0.1215 | **−0.0930** | fail → fail |
| basic-finner | 1.116 | 0.854 | −0.1052 | **−0.0881** | fail → fail |

Four informational rows also moved (`cd-rasaero-parity` M1.05 and M1.15 on arcas-short, M1.15 on
arcas-long, and rma53d02's `cd-rasaero-reference` M1.0). They are never counted, and they moved
us **further from RASAero's own prediction** at M1.15 (+0.1676 → +0.1885 on Long) while moving
us toward the tunnel below M1.10. RASAero under-predicts these same tunnel rows by 0.10–0.22 —
that gap is noted in `README.md` and is not resolved by anything here. 18 rows moved in total;
the other 208 are byte-identical.

## Why M1.20 cannot move from here — the arithmetic, not an opinion

At M1.20 all three wave terms already sit exactly **on** their supersonic branches, and every
one of those branches is monotone decreasing there. A "rise → peak → decay onto the branch"
construction is therefore pinned at the branch value at M1.20 no matter how its transonic
section is shaped. Measured proof: the M1.20 row is byte-identical before and after a complete
rebuild of the fin bridge.

The M1.20 budget, measured on ARCAS Long (base-excluded, flag on, Re-matched):

| term | CD at M1.20 |
|---|---|
| friction (incl. the Mach-flat ×1.8 fin-junction factor, worth **+0.0252** here) | 0.2766 |
| boat-tail wave (exact Prandtl–Meyer, Phase 5) | 0.3396 |
| nose wave (Fleeman bridge, Phase 5) | 0.0570 |
| fin thickness wave (linear theory, unchanged by this pass) | 0.0673 |
| **model total** | **0.7405** |
| **tunnel** | **0.635** |

To land the M1.20 anchor with friction and the boat tail as they stand, nose + fin wave would
have to total **0.019** instead of 0.124 — an 85 % cut — at a Mach where the nose term alone is
0.039 by the kernel's own measured von Kármán table (see below) and the fin term is textbook
linearized double-wedge theory. Removing the ×1.8 junction factor entirely (Eric's §6a step-2
decision, not this pass's) would take M1.20 from +0.1055 to **+0.080** — still red.

So the M1.15/M1.20 residual is a **level** error concentrated in the boat-tail term, not a
transonic-shape error. The boat tail is 46 % of base-excluded CD at M1.20 and the same
accounting says it is right to within ~3 % at M1.8 and ~2 % at M2.95. Nothing in this pass's
remit could move it, and the one obvious candidate change was measured and rejected (below).

## The nose — the premise was measured, and it did not hold

The task called for the nose bridge to get the same rise/peak-at-1.05/decay treatment. It did
not get it, because measuring first showed the nose is **not** the defect.

The kernel's own measured TR R-100 tables (`SymmetricComponentCalc` lines 447–461) are the only
measured nose wave-drag data in the tree. Put through the kernel's own fineness extrapolation
(line 603–607) at the ARCAS nose's fineness ratio 4.711, normalised to each curve's M1.3 value:

| Mach | von Kármán f=3 | LV-Haack f=3 | parabolic f=3 | von Kármán extrapolated to f=4.71 | Phase-5 Fleeman bridge |
|---|---|---|---|---|---|
| 0.95 | 0.114 | 0.093 | 0.000 | 0.068 | 0.138 |
| 1.00 | 0.307 | 0.224 | 0.353 | 0.234 | 0.300 |
| 1.05 | 0.625 | 0.617 | 0.793 | 0.569 | 0.517 |
| 1.10 | 0.795 | 0.785 | 0.940 | 0.765 | 0.702 |
| 1.15 | 0.858 | 0.860 | 0.983 | 0.837 | 0.847 |
| 1.20 | 0.920 | 0.935 | 1.026 | 0.909 | 0.950 |
| 1.30 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 |

**Every streamlined-nose curve in that table also rises through M1.05 → M1.20.** Measured rise
across that interval: bridge **+0.0260 CD**, von Kármán measured-and-extrapolated **+0.0146 CD**.
The bridge rises about 0.011 CD too much over the interval and sits 0.005 CD low at M1.05 —
real, but an order of magnitude smaller than the +0.026 the Phase-5 scorecard attributed to it,
and in a shape whose *direction* the data agrees with. The bridge's literal "maximum at the top
of its ramp" is worth **0.0001 CD** (0.0601 at M1.275 against 0.0600 at M1.3).

The measured alternative was built and scored rather than argued about. **Variant A** — Fleeman
trusted from M1.05 with a 0.90→1.05 smoothstep, i.e. the literal treatment the task asked for:

| | score | arcas-long transonic | arcas-short transonic | long M1.15 | long M1.20 |
|---|---|---|---|---|---|
| shipped | **70/164** | **8/10** | **6/10** | +0.0780 | +0.1055 |
| Variant A | 64/164 | 6/10 | 3/10 | +0.0939 | +0.1127 |

Variant A loses six gates and makes **both** of the rows the acceptance test names *worse*. The
reason is visible in the table above: Fleeman is a supersonic correlation and over-predicts near
M1 — against the measured von Kármán f=3 table it reads 0.155 at M1.05 where the data says 0.055.
Not shipped. The nose bridge is unchanged and byte-identical.

## The boat tail — the other candidate, also measured and rejected

The Phase-5 boat tail holds a **plateau** at the exact-Prandtl–Meyer value at M1.20 across
M1.05–1.20. The obvious "purer" version is to trust exact PM from M1.05 and drop the plateau.
**Variant B**, built and scored:

| | score | arcas-long M1.05 | M1.10 | M1.15 | M1.20 | arcas supersonic gates |
|---|---|---|---|---|---|---|
| shipped | **70/164** | **+0.0035** | **+0.0025** | +0.0780 | +0.1055 | 1/6 · 3/5 |
| Variant B | 67/164 | +0.1207 | +0.0723 | +0.1096 | +0.1055 | 1/6 · 3/5 (unchanged) |

Exact PM over-predicts the boat tail by **+0.12 CD at M1.05** on this geometry. Phase-5's
plateau is doing real work as a transonic limiter and is better than the "purer" alternative.
Not shipped. Note the supersonic gates do not move in either variant — everything here is
confined below M1.20.

## Calibration discipline

The design has exactly one number that could be called a knob, `SS_TRANSONIC_K`, and it was
**measured across its range rather than fitted**:

| K | score | long M0.95 | M1.00 | M1.05 | M1.10 | M1.15 | M1.20 |
|---|---|---|---|---|---|---|---|
| 0.7 | 69/164 | 0.4648 | 0.6375 | 0.7370 | 0.7445 | 0.7430 | 0.7405 |
| **1.0 (shipped)** | **70/164** | 0.4613 | 0.6275 | 0.7235 | 0.7375 | 0.7430 | 0.7405 |
| 1.5 | 70/164 | 0.4580 | 0.6182 | 0.7108 | 0.7241 | 0.7354 | 0.7405 |
| 2.0 | 70/164 | 0.4561 | 0.6126 | 0.7032 | 0.7161 | 0.7267 | 0.7325 |

Largest single-row movement across the whole range: **0.0338 CD** (Long M1.05). This is a
stronger knob than Phase 5's `CAL_BRIDGE_SLOPE_CAP` and the honest reading is that the score is
flat at 70/164 over K = 1.0–2.0 and drops to 69 at 0.7. **K = 1.0 is shipped because it is the
textbook validity criterion itself, not because it scored best** — and it is worth recording
that K = 2.0 would have shaved 0.008–0.016 off the two rows the acceptance test wanted reduced.
Picking 2.0 for that reason would have been fitting to the anchors, and this file would not have
been able to say so. No tolerance was widened, no anchor moved, no fixture edited.

## What is still wrong (the honest list)

1. **The M1.15/M1.20 overshoot is the headline miss and it is a boat-tail level problem.**
   +0.078/+0.106 (Long) and +0.062/+0.099 (Short) after this pass, with M1.15 *worse* than
   before. The decomposition above names the term. Fixing it means revisiting the exact-PM
   boat-tail level in the low supersonic band (M1.2–1.6, where the same accounting puts the
   model ~40 % over at M1.20 and ~17 % over at M1.49 while it is right to a few percent at
   M1.8+) — real afterbody physics (pressure recovery along the boat tail toward the base,
   Eggers-class second-order shock expansion), not a knob. It is the next item, and it is
   bigger than this one.
2. **arcas-short M0.95 (−0.045) and M1.00 (−0.102) still fail low**, and the two configs'
   anchors disagree with each other there by more than their own declared accuracy: Long − Short
   is +0.053/+0.048/+0.044/+0.035 at M0.6–0.9, collapses to +0.010 at M0.95, then **inverts to
   −0.053 at M1.00** before returning to +0.035…+0.069 at M1.05–1.2. Our model's Long − Short is
   a steady +0.046 at every Mach (it is a body-tube friction difference and cannot do anything
   else). Both series are read off TN D-4013 CA,corr with a declared ±0.03 in the peak region.
   **This is flagged as a question for the data, not as grounds to move anything** — anchors and
   fixtures are read-only. It is worth one line to Chuck Rogers: are the two configs' M0.95–1.05
   dots from the same run set?
3. **Basic Finner cd0 stays 0/23** — its three transonic rows closed by ~0.02–0.03 but the cell
   runs −0.09…−0.14 low across the board, and rma53d02 stays low through M1.9–3.3, while HB-2
   (finless) runs HIGH. Same pattern the Phase-3 ledger flagged: base pressure behind a *finned*
   body sits below the clean-cylinder law. Still the McCoy/BRL base-pressure backlog item, still
   deliberately not attempted, because raising base drag globally is falsified by HB-2 on sight.
4. **rma53d02 subsonic (+26 % at M0.60, +38 % at M0.91) is untouched** — carved-classic
   fully-turbulent friction plus the `0.12 + 0.13 M²` base law, both diagnosed in the Phase-5
   scorecard, both used by every rocket, neither this pass's to move. This is the band where
   users actually fly.
5. **The supersonic CP aft bias (8 red gates, +2.2…+4.9 %L over M1.5–3) is untouched** and still
   needs its own decision. The CP rows being byte-identical is the proof that nothing here
   touched normal force.
6. **The Mach-flat ×1.8 fin-junction friction factor stays bundled behind the supersonic flag.**
   Measured worth on ARCAS Long: **+0.0252 at M1.20**, +0.0222 at M1.8. Removing it would flip
   several ARCAS supersonic gates and push Basic Finner and rma53d02 (both already low) further
   down. Still Eric's §6a step-2 decision, not a knob to turn here.

## Informational (not gates)

- **Flag-off drag is byte-identical on all four fixtures at all 164 rows** — desktop-OpenRocket
  parity intact. Verified by diffing the whole classic scorecard, not by inspection.
- **Nothing at or above M1.20 moved on any cell**, and HB-2 (finless) did not move at all. The
  change reaches exactly the fins, exactly in M0.90–1.13(ish, τ-dependent), and nowhere else.
- **Effect on an ordinary hobby rocket** (4 in airframe, tangent ogive, four 3.2 mm sharp
  airfoil fins, 51° LE sweep, no boat tail, flag on): fin thickness-wave CD at M1.05 goes
  **0.0039 → 0.0157**, i.e. about **+0.012 CD on a total near 0.70 (+1.7 %)**, tapering to zero
  by M1.20 and zero below M0.90. Thinner fins move less — the peak scales as τ^(5/3). In classic
  (the default model) nothing changes at all.
- `validation/README.md`'s scoreboard table still shows the pre-Phase-5 numbers; updating it
  (and a `version.json` bump) belongs with the release, not with this measurement pass.
- Reproducibility: the engine build is byte-reproducible and was used as the control. Rebuilding
  the *unchanged* tree at the start reproduced the existing artifact md5 exactly
  (`5f947867…`), confirming the 66/164 baseline belonged to the sources in the tree; the shipped
  code then rebuilt to the same md5 twice at each stage (`de24c78a…` before the goldens,
  `25d5e42b…` after them, `8456e660…` final). Every delta above is the source change, not build
  drift. Worth knowing for the next session: TeaVM's output depends on **declaration order**, so
  moving two methods within a file changed the artifact md5 while every one of the 226 scorecard
  rows and all 296 differential lines stayed byte-identical — an md5 change alone does not mean a
  numeric change, and vice versa.
