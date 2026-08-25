# The ×1.8 fin interference factor — 2026-08-25 (§6a step 2: remove it and see what happens)

The instruction was "remove the ×1.8 junction factor and see what happens." It was removed,
built and scored, along with three other settings of the same number and the one structural
alternative. **The measurement says do not remove it**, and this file is mostly the arithmetic
for why, including the parts that argue the other way.

**Nothing about the physics changed in this pass.** Both scorecards came out byte-identical to
the tree they started from — all 164 classic rows and all 164 supersonic rows. What changed in
the tree is a code comment whose stated provenance was wrong, this scorecard, a ledger entry,
and three new differential goldens. Artifact md5
`8456e660a9284f3fcfe2f93131f77188` → `bc0c742d0343d36a83e0a213f3159da7` — the md5 moved because
the golden harness grew, not because a number did. No anchor, tolerance or fixture was touched.

Runs: `node validation/score.mjs` and `--supersonic` on every variant, each from its own
rebuilt kernel (build times 3 s; every variant's md5 recorded below and re-checked after every
measurement so a concurrent rebuild could not mix two builds into one number).

---

## What the term is

`FinSetCalc.calculateFrictionCD` multiplies the fin set's skin-friction CD by **1.8** when the
`supersonicAero` flag is on — +80 % of fin friction, at every Mach.

### It is a port of RASAero's own component, not an ARCAS calibration

The code comment said the factor was anchored to the ARCAS fins-on/fins-off tunnel increment.
That is wrong, and the wrong provenance has been repeated downstream — `docs/testing/
response-2026-08-23c.md` §4, `docs/handoff-2026-08-24.md` §4, and both the Phase-5 and Phase-6
scorecards all call it "fin-junction" on that authority. Where the number actually comes from is
RASAero II's own printed drag breakdown:

| *RASAero II Users Manual* | Mach | Fin friction term | **Fin Interference** | ratio |
|---|---|---|---|---|
| p.90 (Subsonic Run Test) | 0.50 | Fin Frict&Press 0.050 | **0.042** | **0.840** |
| p.92 (Supersonic Run Test) | 2.00 | Fin Frict 0.037 (+ Fin Wave 0.067) | **0.031** | **0.838** |

Both rows' printed components sum to the printed CD (0.306 + 0.026 + 0.057 + 0.050 + 0.042 =
0.481 exactly; 0.189 + 0.059 + 0.163 + 0.037 + 0.067 + 0.031 + 0.084 = 0.630 against 0.631
printed, rounding).
So RASAero carries a fin-interference drag of **0.84 × fin friction, Mach-flat**, and our 0.8
reproduces it to 5 %. That is a real provenance and it is why the number is not arbitrary.

### The anchor the comment claimed is not a valid calibration target

The ARCAS fins-on/fins-off increment (NASA TN D-4013, CA,corr; values as digitised in
`docs/research/validation-anchors-2026-08-03.md`) is:

| Mach | Short fins-on | Short fins-off | increment |
|---|---|---|---|
| 0.60 | 0.295 | 0.222 | **0.073** |
| 0.70 | 0.300 | 0.222 | **0.078** |
| 0.80 | 0.309 | 0.229 | **0.080** |

Three problems with using it to calibrate an interference factor:

1. **It contains the fin-anchor brackets.** RASAero books those in a *separate* Protuberance
   column — manual p.92 note ("Protuberance CD is Total of Rail Guide, Launch Lug, Launch Shoe,
   … and Inclined Flat Plate Protuberances"), manual Figure 31 ("Example Inclined Flat Plate
   Protuberances, **fin brackets**"), and the RASAero ARCAS comparison deck slide 2 states
   plainly that the ARCAS fin anchors were converted to frontal area and entered as a rail
   guide. Our fixture models no protuberance at all.
2. **It contains fin LE bluntness** the kernel charges only when `finLeRadius` is given; the
   ARCAS fixture gives none.
3. **Taken literally it does not support 1.8 anyway.** Our bare fin friction on the ARCAS Short
   is 0.0351 / 0.0346 / 0.0342 at M0.60 / 0.70 / 0.80, so closing the 0.073 / 0.078 / 0.080
   increment with a friction multiplier would need **2.08 / 2.25 / 2.34×**.

The increment is an **upper bound** on fin + interference drag, not a target.

### It is not junction interference in the physical sense

A wing-body junction is a corner effect: its drag area scales with **t²** (Hoerner's
wing-root correlation, quoted from the standard reference — there is no copy in this repo to
cite line-and-verse — puts ΔC_D based on t² at roughly 17(t/c)² − 0.05 per junction, i.e. ≈0
below t/c ≈ 0.054). This term instead scales with **fin wetted area × Cf**. Turning what it
adds into an equivalent per-junction coefficient, on the three finned validation cells:

| cell | fin t/c | fins | bare fin friction CD (M0.60) | Aref (m²) | implied ΔC_D per junction, on t² |
|---|---|---|---|---|---|
| ARCAS Short/Long | 0.0437 | 4 | 0.03507 | 2.5652e-3 | **0.92** |
| Basic Finner | 0.0800 | 4 | 0.03840 | 7.0686e-4 | **0.47** |
| RM A53D02 | 0.0386 | 4 | 0.05340 | 3.1669e-5 | **0.52** |

A factor of two apart, and *not* tracking fin thickness — the thickest-finned cell gets the
smallest implied coefficient. That is the signature of a term that is not scaling on junction
geometry. **Verdict: it is a lumped fin-in-presence-of-body drag component with a real
pedigree, mis-named "junction interference" in our code, and it is not double-counting anything
this kernel books elsewhere** (the fin's own pressure/wave/base drag is `calculatePressureCD`;
nothing else charges fin interference; body friction is not reduced under the fin root).

A correctly-scaled junction term would be ≈0 for the 2–5 % thick sections rockets use — i.e.
implementing "real junction physics" and deleting the factor are the same change, with more
code. That is worth knowing before anyone proposes it.

---

## The option table

Every row is its own kernel build, scored on the unchanged 2026-08-25 anchors.
"RMS |Δ|/tol" is the root-mean-square of (delta ÷ tolerance) over all 164 gated rows — a
scale-free accuracy measure that, unlike the gate count, does not care whether a row sits just
inside or just outside its tolerance edge. "rows closer / worse" counts the 83 gated CD rows
that this term can move, against the shipped ×1.8.

| option | artifact md5 | gates | RMS \|Δ\|/tol | rows closer / worse | Buckeye apogee (meas. 18,006 ft) | LEM-IV apogee (meas. 11,755 ft) |
|---|---|---|---|---|---|---|
| **×1.0 — remove** | `2fc348b9…` | **71/164** | 2.595 | 18 / **65** | 20,905 ft (+16.1 %) | 12,765 ft (+8.6 %) |
| ×1.2 | `4bbee071…` | 73/164 | 2.548 | 20 / 63 | 20,567 ft (+14.2 %) | 12,606 ft (+7.2 %) |
| ×1.4 | `f0f5657e…` | **76/164** | 2.509 | 25 / 58 | 20,242 ft (+12.4 %) | 12,451 ft (+5.9 %) |
| **×1.8 — shipped** | `8456e660…` | 70/164 | **2.455** | — | **19,623 ft (+9.0 %)** | **12,155 ft (+3.4 %)** |
| ×1.8 in **both** models | `6f1c3f38…` | ss 70 · **classic 12** | ss 2.455 · **classic 4.970** | classic **80 closer / 3 worse** | classic 20,154 ft (+11.9 %) | classic 12,008 ft (+2.2 %) |
| (classic today, for scale) | — | 10/164 | 5.279 | — | 21,498 ft (+19.4 %) | 12,617 ft (+7.3 %) |

**The gate count and the accuracy aggregate disagree, and they disagree for a reason.**
Removing the factor nets **+1 gate** while moving 65 of 83 rows further from the data. The six
ARCAS supersonic gates it flips sit at +0.021…+0.028 against a ±0.020 tolerance with the term,
and the term is worth 0.014–0.023 CD there — so **every** reduction tested (1.4, 1.2, 1.0) flips
all six, and none of them buys anything the others do not. Meanwhile the rows that move the
wrong way each move by less than their own tolerance, so they cost no gates and are invisible in
the headline. ×1.4 wins the gate count (76) and loses the accuracy aggregate and both flights.
**Picking 1.4 would be fitting to the anchors**, the thing this harness's own README forbids and
the Phase-6 scorecard refused to do with `SS_TRANSONIC_K`.

## Per-series gate counts, every variant

| cell / series | ×1.0 | ×1.2 | ×1.4 | **×1.8** | classic off | classic + term |
|---|---|---|---|---|---|---|
| arcas-long `cd-supersonic` | **5/5** | 5/5 | 5/5 | 3/5 | 0/5 | 0/5 |
| arcas-long `cd-transonic` | 6/10 | 7/10 | 8/10 | **8/10** | 3/10 | **4/10** |
| arcas-short `cd-supersonic` | **5/6** | 5/6 | 5/6 | 1/6 | 0/6 | 0/6 |
| arcas-short `cd-transonic` | 4/10 | 5/10 | 5/10 | **6/10** | 3/10 | **4/10** |
| rma53d02 `cd0-freeflight` | 11/29 | 11/29 | **13/29** | 12/29 | 1/29 | 1/29 |
| basic-finner `cd0-freeflight` | 0/23 | 0/23 | 0/23 | 0/23 | 0/23 | 0/23 |
| arcas `cp-supersonic` (both) | 1/5 · 1/4 | unchanged | unchanged | 1/5 · 1/4 | 0/5 · 0/4 | unchanged |
| basic-finner `cna` / `cp` | 16/23 · 17/23 | unchanged | unchanged | 16/23 · 17/23 | 0/23 · 1/23 | unchanged |
| **hb2 (all three series)** | **0/9 · 5/9 · 0/8** | **unchanged** | **unchanged** | **0/9 · 5/9 · 0/8** | 0/9 · 2/9 · 0/8 | **unchanged** |
| **TOTAL** | 71/164 | 73/164 | 76/164 | **70/164** | 10/164 | 12/164 |

**HB-2 is the isolation control and it does not move — zero rows, byte-identical, in every
variant including the both-models one.** HB-2 is finless; if it had moved, the experiment would
have been leaking somewhere it should not.

Every CP and CNα row is byte-identical in every variant too: this is a drag term and nothing
here touches normal force.

## Per-row: the ARCAS gates that removal flips

| cell | Mach | tunnel | ×1.8 | ×1.4 | ×1.2 | ×1.0 | tol |
|---|---|---|---|---|---|---|---|
| arcas-long | 1.80 | 0.508 | **+0.0277 FAIL** | +0.0166 PASS | +0.0110 | +0.0055 | ±0.020 |
| arcas-long | 2.29 | 0.410 | **+0.0260 FAIL** | +0.0160 PASS | +0.0110 | +0.0061 | ±0.020 |
| arcas-long | 2.95 | 0.336 | +0.0158 PASS | +0.0072 | +0.0029 | −0.0014 | ±0.020 |
| arcas-long | 3.95 | 0.269 | +0.0012 PASS | −0.0056 | −0.0090 | −0.0124 | ±0.020 |
| arcas-long | 4.65 | 0.225 | +0.0015 PASS | −0.0041 | −0.0069 | −0.0097 | ±0.020 |
| arcas-short | 1.49 | 0.532 | **+0.0632 FAIL** | +0.0509 FAIL | +0.0448 FAIL | +0.0386 FAIL | ±0.020 |
| arcas-short | 1.80 | 0.470 | **+0.0256 FAIL** | +0.0140 PASS | +0.0082 | +0.0024 | ±0.020 |
| arcas-short | 2.29 | 0.376 | **+0.0239 FAIL** | +0.0135 PASS | +0.0083 | +0.0031 | ±0.020 |
| arcas-short | 2.95 | 0.300 | **+0.0207 FAIL** | +0.0118 PASS | +0.0073 | +0.0028 | ±0.020 |
| arcas-short | 3.95 | 0.223 | **+0.0227 FAIL** | +0.0156 PASS | +0.0120 | +0.0085 | ±0.020 |
| arcas-short | 4.65 | 0.198 | +0.0083 PASS | +0.0025 | −0.0005 | −0.0034 | ±0.020 |

Six gates, exactly as a prior session's arithmetic predicted. Note M1.49 on Short stays red at
every setting (+0.039 at ×1.0) — that row is the low-supersonic boat-tail level error the Phase-6
scorecard names, not this term.

## Per-row: what removal costs, including the rows that get worse

ARCAS **transonic/subsonic**, base-excluded (tunnel CA,corr, ±0.030):

All twenty rows, both configs, no selection:

| cell | Mach | tunnel | ×1.8 | ×1.4 | ×1.2 | ×1.0 |
|---|---|---|---|---|---|---|
| arcas-long | 0.60 | 0.348 | +0.0073 | −0.0061 | −0.0129 | −0.0196 |
| arcas-long | 0.70 | 0.348 | +0.0095 | −0.0038 | −0.0104 | −0.0171 |
| arcas-long | 0.80 | 0.353 | +0.0086 | −0.0045 | −0.0111 | −0.0176 |
| arcas-long | 0.90 | 0.385 | −0.0155 PASS | −0.0285 PASS | **−0.0350 FAIL** | **−0.0414 FAIL** |
| arcas-long | 0.95 | 0.470 | −0.0087 PASS | −0.0216 PASS | −0.0281 PASS | **−0.0345 FAIL** |
| arcas-long | 1.00 | 0.630 | −0.0025 | −0.0154 | −0.0218 | −0.0283 |
| arcas-long | 1.05 | 0.720 | +0.0035 | −0.0094 | −0.0158 | −0.0223 |
| arcas-long | 1.10 | 0.735 | +0.0025 | −0.0104 | −0.0168 | −0.0232 |
| arcas-long | 1.15 | 0.665 | +0.0780 fail | +0.0653 fail | +0.0589 fail | +0.0526 fail |
| arcas-long | 1.20 | 0.635 | +0.1055 fail | +0.0929 fail | +0.0866 fail | +0.0803 fail |
| arcas-short | 0.60 | 0.295 | +0.0117 | −0.0023 | −0.0093 | −0.0163 |
| arcas-short | 0.70 | 0.300 | +0.0095 | −0.0043 | −0.0112 | −0.0182 |
| arcas-short | 0.80 | 0.309 | +0.0052 | −0.0085 | −0.0153 | −0.0221 |
| arcas-short | 0.90 | 0.350 | −0.0273 PASS | **−0.0409 FAIL** | **−0.0476 FAIL** | **−0.0544 FAIL** |
| arcas-short | 0.95 | 0.460 | −0.0453 fail | −0.0588 fail | −0.0656 fail | −0.0723 fail |
| arcas-short | 1.00 | 0.683 | −0.1020 fail | −0.1155 fail | −0.1222 fail | −0.1289 fail |
| arcas-short | 1.05 | 0.685 | −0.0080 PASS | −0.0215 PASS | −0.0282 PASS | **−0.0349 FAIL** |
| arcas-short | 1.10 | 0.666 | +0.0251 | +0.0117 | +0.0050 | −0.0017 |
| arcas-short | 1.15 | 0.635 | +0.0621 fail | +0.0489 fail | +0.0422 fail | +0.0356 fail |
| arcas-short | 1.20 | 0.596 | +0.0991 fail | +0.0860 fail | +0.0794 fail | +0.0728 fail |

Lower-case `fail` marks rows that are red at *every* setting, so they never register as a gate
flip either way. Note that M1.15 and M1.20 do get **better** with every reduction (+0.1055 →
+0.0803 on Long) — that is the low-supersonic boat-tail overshoot the Phase-6 scorecard names,
and it is the one part of the ARCAS transonic picture that argues for removal. It is not enough
to change a verdict anywhere, and the same reduction takes M0.90/0.95/1.05 out of tolerance.

The two **finned free-flight** cells, which already run low, get worse across the board:

| cell | | ×1.8 | ×1.4 | ×1.2 | ×1.0 |
|---|---|---|---|---|---|
| basic-finner `cd0` (23 rows) | mean Δ | −0.0892 | −0.0984 | −0.1030 | **−0.1075** |
| | range | −0.143…−0.043 | | | −0.163…−0.054 |
| rma53d02 `cd0` (29 rows) | mean \|Δ\| | 0.0301 | 0.0341 | 0.0373 | **0.0405** |
| | M0.60 (runs HIGH) | +0.0939 | | | **+0.0512** |
| | M0.91 (runs HIGH) | +0.1397 | | | **+0.1022** |
| | M2.10 (runs LOW) | −0.0665 | | | **−0.0925** |
| | M10.0 (runs LOW) | −0.0176 | | | **−0.0221** |

rma53d02 is the one cell where removal genuinely helps in the band users fly: its +26 %/+38 %
subsonic excess falls to +14 %/+28 %. It is still red, and the same change pushes its whole
M1.9–10 range further low. Basic Finner has no upside at any setting — every one of its 23 rows
moves the wrong way, and it stays 0/23 throughout.

## The measurement that decides it: the ARCAS fins-on/fins-off increment

The ARCAS is the only fixture family in the anchor set with a **fins-off** tunnel run, so it is
the only place the fin increment can be checked directly instead of inferred from a total. Our model's
increment is measured the same way the tunnel's is — build the fixture, delete the fin set, take
the difference (verified to equal the fin component row to the last digit on both configs):

| | Mach | tunnel fins-off | **our body** | tunnel increment | **ours ×1.8** | **ours ×1.0** |
|---|---|---|---|---|---|---|
| ARCAS Short | 0.60 | 0.222 | 0.2436 (**+9.7 %**) | 0.073 | 0.0631 (**−14 %**) | 0.0351 (−52 %) |
| ARCAS Short | 0.80 | 0.229 | 0.2526 (**+10.3 %**) | 0.080 | 0.0616 (**−23 %**) | 0.0342 (−57 %) |
| ARCAS Long | 0.60 | 0.248 | 0.2948 (**+18.9 %**) | 0.100 | 0.0605 (**−39 %**) | 0.0336 (−66 %) |

Two things fall out, and they are the crux:

1. **Even at ×1.8 the fin increment is 14–39 % short of the measured one.** The term is not
   over-charging fins on the one cell that can measure it; it is under-charging them. The total
   looks +0.005…+0.012 high there only because our **body** runs +10…+19 % high subsonically —
   the fully-turbulent friction and `0.12 + 0.13 M²` base law diagnosed in the Phase-5 scorecard,
   both carved classic physics. Two large errors of opposite sign.
2. **TN D-4013's fins-off data stops at M1.2.** There is no fins-off measurement above M1.2
   anywhere in the anchor set. So the six ARCAS supersonic gates cannot be attributed to this
   term rather than to the body: removing it fixes those gates by taking drag off the one
   component the data shows is already under-predicted where the data exists.

(The tunnel increment is itself an upper bound — it includes the fin anchors, per the provenance
section. Both readings above therefore *understate* how short our fin model is.)

## The flights

`docs/User files/Mach2.trf.ork` (Buckeye's WM Mach 2 on a K480W) and `docs/User files/LEM-IV.ork`
on its **M1500G** configuration — the one atestani flew — run headless through the same build
path the app uses (importOrk → engineTree → motor from the database with file-header masses →
simulate, file's own launch conditions, Rogers Kbf on). The classic numbers reproduce the
session record exactly: Mach 2 Buster apogee 6552.5985 m and vmax 658.8677 m/s against the
handoff's 6552.5984 / 658.8677, and LEM-IV 12,617 ft against its recorded 12,616–12,621.

| model | Buckeye — 18,005.6 ft GPS | LEM-IV — 11,755 ft (3 altimeters, 0.37 % spread) |
|---|---|---|
| classic (the shipped default) | 21,498 ft **+19.4 %** | 12,617 ft **+7.3 %** |
| Supersonic ×1.0 (remove) | 20,905 ft +16.1 % | 12,765 ft **+8.6 %** |
| Supersonic ×1.2 | 20,567 ft +14.2 % | 12,606 ft +7.2 % |
| Supersonic ×1.4 | 20,242 ft +12.4 % | 12,451 ft +5.9 % |
| **Supersonic ×1.8 (shipped)** | **19,623 ft +9.0 %** | **12,155 ft +3.4 %** |
| classic + the term (not enabled) | 20,154 ft +11.9 % | 12,008 ft **+2.2 %** |

**Every model over-predicts every flight, and removing the term makes both over-predictions
worse** — Buckeye by 1,281 ft, LEM-IV by 609 ft. That is the plain answer to "does removing it
move predicted apogee toward or away from the measured flights": **away, on both.**

Two honesty notes on that table:

- **LEM-IV is the better datum.** Three independent altimeters agreeing to 0.37 %.
- **Buckeye's flight is not a clean anchor and should not carry weight on its own.** The same
  kit on the same motor has been measured twice more, both GPS-corroborated, at **22,285 and
  22,757 ft** (`docs/testing/response-2026-08-23c.md` §4). His 18,006 is 20 % below their mean.
  Against *those* two flights every model under-predicts and removal would look like an
  improvement. One flight cannot decide this; the direction agrees with LEM-IV, which is why it
  is reported at all.

### And the reason apogee agreement is not the same thing as being right

Buckeye's GPS-derived Cd against the same three models, on his own file:

| Mach | measured | classic | Supersonic ×1.8 | Supersonic ×1.0 |
|---|---|---|---|---|
| 0.30 | 0.397 | 0.4353 (+10 %) | 0.4825 (**+22 %**) | 0.4335 (+9 %) |
| 0.50 | 0.384 | 0.4487 (+17 %) | 0.4910 (**+28 %**) | 0.4427 (+15 %) |
| 0.80 | 0.361 | 0.4901 (+36 %) | 0.5116 (**+42 %**) | 0.4653 (+29 %) |
| 1.10 | 0.721 | 0.5051 (−30 %) | 0.6266 (**−13 %**) | 0.5860 (−19 %) |
| 1.20 | 0.717 | 0.4889 (−32 %) | 0.6028 (**−16 %**) | 0.5635 (−21 %) |
| 1.30 | 0.604 | 0.4727 (−22 %) | 0.5652 (**−6 %**) | 0.5272 (−13 %) |

**Removing the term moves subsonic Cd toward his measurement and transonic Cd away from it**,
and the apogee it buys back is dominated by the transonic band. So ×1.8 wins the apogee
comparison partly by compensating errors: it adds drag subsonically, where the flight trace says
we already have too much, to cover a transonic hole it does not touch. That is the handoff's
"a shape error answered with a flat offset", quantified. It argues for fixing the transonic
shape (§6a step 3, in progress) — it does not argue for deleting the only fin term that keeps
the totals honest in the meantime.

One more consequence of removal, worth naming because users would see it: on Buckeye's rocket
(airfoil fin sections), flag-on **without** the term predicts *less* subsonic drag than classic —
0.4335 vs 0.4353 at M0.30 (0.4 % below) and 0.4653 vs 0.4901 at M0.80 (**5.1 % below desktop
OpenRocket**) — because Phase 2 already removed the blunt-LE plateau from airfoil sections and
the ×1.8 is what puts a comparable amount back. "Switch to the supersonic model, get *less* drag
than the classic one" is a hard result to defend, and it is what ×1.0 ships.

## Decision

**Keep the factor at 1.8 in the supersonic model. Do not remove it, do not retune it.**

1. Removal is worse on both accuracy measures — 65 of 83 gated CD rows away from the data,
   aggregate RMS 2.455 → 2.595 — and on both tester flights. The +1 gate is tolerance-edge luck.
2. On the only fins-on/fins-off measurement in the anchor set, ×1.8 is still 14–39 % *short* of
   the measured fin increment; ×1.0 is 52–66 % short.
3. The six ARCAS supersonic gates removal flips are not evidence about this term: there is no
   fins-off data above M1.2 to attribute them with.
4. The magnitude reproduces RASAero II's own published Fin Interference component (0.84 vs our
   0.80). Departing from the reference implementation this feature set ports needs a reason
   better than a gate count that moved by one.
5. ×1.4 scores best on gates (76/164) and is not shipped, because it wins nothing else and has
   no source. Choosing it would be fitting to the anchors.

**Two things this pass does change**, neither of them a number:

- The code comment's provenance is corrected in place (`FinSetCalc.calculateFrictionCD`) — what
  the term is, what it is not, what removal costs, and the fact that it is *not* junction
  interference and should not be described as such.
- New goldens `ssjunction.0.3 / 0.6 / 0.85` pin flag-off **and** flag-on total CD and friction CD
  on the reference rocket at three subsonic Mach numbers. That is the regime the factor actually
  changes for most users and nothing pinned it — every existing `ssaerocd` sample sits at M1.2 or
  above. Square-section fins, so the Phase-2 AIRFOIL pressure change cannot contaminate the
  off→on ratio. Differential **296 → 299 lines, all 3 new lines bit-identical JVM ↔ TeaVM**. They
  print the user-visible size of the term as a side effect: at M0.30 the reference rocket's total
  CD goes **0.998023 → 1.077198 (+7.9 %)** on the flag alone, friction 0.426869 → 0.507707
  (+18.9 %).

## Still open, and it is the owner's call

§6a step 2 puts it as a dichotomy: the term is Mach-flat, so it either belongs in the **baseline
for everyone at all speeds**, or nowhere. This pass measured "nowhere" and it lost. It also
measured the other half, and **that is the option the data supports** — but it moves
desktop-OpenRocket parity, so it was measured and left disabled rather than shipped:

| classic model | today | with the term |
|---|---|---|
| gates | 10/164 | **12/164** |
| RMS \|Δ\|/tol (164 rows) | 5.279 | **4.970** |
| gated CD rows closer / worse | — | **80 / 3** |
| arcas-short `cd-transonic` | 3/10 | 4/10 |
| arcas-long `cd-transonic` | 3/10 | 4/10 |
| LEM-IV apogee | +7.3 % | **+2.2 %** |
| Buckeye apogee | +19.4 % | **+11.9 %** |

80 of the 83 gated CD rows move toward the data; the 3 that move away are rma53d02's subsonic
rows, where classic already reads high. Against that: it would change the numbers of every user
on the default model, and the classic model's entire claim is bit-identical parity with desktop
OpenRocket (`engine-java` difftest). **Not a change to make without Eric.**

The related structural item is also still open and is not in this pass's files: `auto` mode
(`packages/app/src/App.tsx`) applies the flag from t=0 retroactively because the rocket went
transonic later, which a Mach-flat interference term has no reason to care about.

## What is still wrong, unchanged by this pass

1. **Our body runs +10…+19 % high subsonically on the ARCAS** and +26 %/+38 % on rma53d02 —
   carved-classic fully-turbulent friction plus the `0.12 + 0.13 M²` base law, diagnosed in the
   Phase-5 scorecard, used by every rocket, still not this pass's to move. It is the band users
   fly, and it is half of why the fin term's calibration reads the way it does.
2. **Our fin increment runs 14–39 % low subsonically on the ARCAS** even with the term. The
   named candidates are fin LE bluntness (modelled only when `finLeRadius` is given) and
   protuberance drag for fin brackets/anchors (not modelled at all, and RASAero's own answer).
3. **arcas-short M1.49 (+0.063), M1.15/M1.20 (+0.062/+0.099)** — the low-supersonic boat-tail
   level error from the Phase-6 scorecard. These rows do move with this factor (M1.49 falls to
   +0.039 at ×1.0) but stay red at every setting, so no setting of it reaches them.
4. **Basic Finner stays 0/23** at every setting, −0.043…−0.143 low. Still the finned-body
   base-pressure backlog item.
5. **The supersonic CP aft bias** (7 red ARCAS CP gates across the two configs) is untouched —
   every CP and CNα row is byte-identical in every variant here, which is the proof that a drag
   term is all this is.

## Reproducing this

Each option is a one-token edit to `cd *= 1.8;` in
`engine-java/patches/info/openrocket/core/aerodynamics/barrowman/FinSetCalc.java`, then
`node engine-java/scripts/carve.mjs && node engine-java/scripts/build-engine.mjs` (≈3 s), then
`node validation/score.mjs [--supersonic]`. The "both models" option is the same edit with the
`if (supersonicAero)` guard deleted. Artifact md5 per option is in the option table; the tree
rebuilt to `8456e660a9284f3fcfe2f93131f77188` before and after the experiment, so every delta
here is the source change and not build drift. The flight numbers come from a headless driver
that replays the app's own import → build → simulate path; its classic results match the
recorded session values to the digit, which is what makes it usable as an instrument.
