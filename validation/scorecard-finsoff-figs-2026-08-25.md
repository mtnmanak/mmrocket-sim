# NASA TN D-4013 Figures 11 and 12, digitized and gated — 2026-08-25

The instruction was to digitize the two ARCAS fins-off figures and turn them into gates.
While doing it the **source report itself was retrieved** (NTRS, 64 pp., scanned), which
turned a plan to read two forum JPEGs more carefully into something better: the anchors
are now read off the report's own page scans, the tolerance comes from the report's own
stated accuracies instead of a curve-read band, and four questions this harness has been
carrying as "unresolved" are answered in the report's own words.

| | before | after |
|---|---|---|
| gates | 166 | **175** |
| fins-off gated points | 2 (one Mach, one per cell) | **11** (every Mach the report tested) |
| fins-off tolerance | ±0.010, from a curve-read band | **±0.008, from the report's accuracy table** |
| classic Extended Barrowman | 10/166 (6.0 %) | **11/175 (6.3 %)** |
| supersonic aero (flag on) | 70/166 (42.2 %) | **71/175 (40.6 %)** |
| artifact md5 | `bc0c742d…` | `bc0c742d…` (untouched — no kernel change in this pass) |

**Every one of the five non-fins-off cells is byte-identical in both models** — `arcas-short`,
`arcas-long`, `rma53d02`, `basic-finner`, `hb2` diff clean against the pre-task scorecards.
The only text that moved is the two fins-off cells and the summary line. No fixture geometry
changed; no kernel code was touched.

**10 of the 11 new gates fail, in both models, and they fail in opposite directions at
opposite ends of the Mach range.** That is the point of this pass: the two M0.60 points we
had could only measure a *level*. The curve measures a *shape*, and the shape is where the
model is actually broken.

---

## 1. The source, and why it changed mid-task

The two gates added earlier today were figure reads quoted by C. E. Rogers on TRF 197207 #9
(Short 0.225, Long 0.250 at M0.60), never independently confirmed, with a tolerance derived
from a curve-read band. `README.md` listed the upgrade path as *"read TN D-4013 directly, or
retrieve the two 'No Fins' `.CDX1` files"*.

**TN D-4013 was retrieved directly**, from NTRS:
`https://ntrs.nasa.gov/api/citations/19670020050/downloads/19670020050.pdf` — Ferris,
*Static Stability Investigation of a Single-Stage Sounding Rocket at Mach Numbers From 0.60
to 1.20*, NASA TN D-4013, July 1967, L-5132. It is a 64-page scan with no text layer; its
page images extract at 2368×3104 (Figure 11, report p.60) and 2352×3072 (Figure 12, p.61),
about **2.8× the linear resolution** of the forum reproductions and bilevel rather than
JPEG-blurred.

Both figures were digitized from those page images. The forum images
(`docs/User files/TRF RASAero Files/1778709826323.png` = Fig 11,
`…/1778710171376.png` = Fig 12) were digitized too, independently, and are used as the
cross-check in §2.3.

### 1.1 What the report settles that we had been guessing at

| open question | the report's answer | where |
|---|---|---|
| Were the models boundary-layer tripped? | **Yes.** *"In order to obtain turbulent flow over the model, a 0.25-cm-wide (0.10-in.) strip of No. 120 carborundum grains was affixed around the model 3.17 cm (1.25 in.) aft of the nose and 1.27 cm (0.5 in.) aft of the leading edge of each fin."* | p.4 |
| Did the fin anchors stay on for the fins-off runs? | **On the SHORT model yes, un-faired; on the LONG model no.** *"The fin anchors (fig. 1(b)) were used to plug the slots in the boattailed afterbody when the short model was investigated without fins, whereas the slots were plugged with balsa and faired flush with the model skin when the long model was investigated without fins."* | p.3 |
| Is C_A,corr really base-excluded? | **Yes, and only for these summary figures.** *"Axial-force data were not corrected to free-stream conditions at the model base, except for the summary data at a roll angle of 0° and an angle of attack of 0°."* | p.4 |
| What is the data's stated accuracy? | C_A **±0.004**, C_p,b ±0.01, C_N ±0.03, α ±0.1°, M ±0.003 | p.4 |
| Which Mach numbers were actually run? | *"Both models were investigated at Mach numbers of 0.60, 0.80, 0.90, 1.00, and 1.20. The short model was also investigated at a Mach number of 0.95."* | p.4 |

The trip answer closes `scorecard-finsoff-2026-08-25.md` §5 item 3 outright: **the models were
tripped, so the fully-turbulent friction our kernel is stuck with is the correct modelling
choice for this cell, and none of the excess below can be blamed on the missing partial-laminar
branch.** That removes the one escape route the +8–18 % body finding had.

The fin-anchor answer is worse news than the placeholder it replaces, and it is *asymmetric*:
the Short fins-off article carries four un-faired protuberances that no fixture models, and the
Long one is clean. Direction: the Short tunnel number is inflated, so **our Short excess is
understated** and the Long cell is the better-posed comparison of the two. The report itself
charges the anchors with the Short curve rising above the Long one at M0.975–1.20 (p.6).

---

## 2. The digitization

Script: `…/scratchpad/{digitize,cal,cal2,extract,gridpresence,read_cacorr,read_cab}.py`
(scratchpad path in this session's environment block). `cal2.py` drives the report scans,
`cal.py` the forum images; everything downstream is shared, so the two sources are read by
the *same* code and differ only in their input pixels.

### 2.1 Method

1. **Mach axis** — least squares over the 17 printed vertical gridlines (M0.50…M1.30, 0.05
   apart, identified as full-height dark columns). Fit residual **0.00015 Mach** (Fig 11),
   **0.00010** (Fig 12). The 0.05 spacing is not assumed: the figure's printed tick labels
   ".6", ".7" … "1.3" were located as glyph groups and their centroids land on **every second
   gridline** to within 3 px, which is what fixes the leftmost line as M0.50 and the spacing as
   0.05 rather than 0.10.
2. **De-skew** — Fig 11's scan is rotated **0.557°**. Measured on its C_A,corr zero axis, a
   heavy line clean across the whole panel with no curve within 0.22 in C_A of it: on the
   report page image it falls **11.2 px** left-to-right over 1000 usable columns with a
   **0.53 px** linear-fit residual (on the forum image, 5.4 px and 0.22 px). Every column is
   shifted before anything else is measured. Skipping this step biases the two ends of a curve
   by ±0.004, half the tolerance being derived. Fig 12's rotation is 0.128°, 2.5 px across the
   panel, and matters much less.
   *Evidence the de-skew is real and not a fudge:* it improves the independent coefficient-axis
   fit residual on Fig 11 from 0.00045 to **0.00019** in C_A, and the x_cp panel fit from
   0.061 to **0.014 %L**.
3. **Coefficient axis** — least squares over the 17 printed C_A,corr gridlines (0.80…0.00).
   Residual **0.00019** (Fig 11) / **0.00024** (Fig 12) in C_A, i.e. ≈0.3 px at 14.5 / 13.5 px
   per 0.01. The C_A,b panel is fitted separately over its own five printed lines
   (+0.10…−0.10); its scale comes out **0.9995** and **1.0014** times the C_A,corr panel's —
   an independent confirmation that both fits are right.
4. **Curve separation** — a value envelope that brackets the fins-off curve away from the two
   fins-on curves, plus a printed-gridline mask. The mask is applied **only where the grid is
   actually drawn**, and where that is was *measured*, not assumed: per column, the fraction of
   the 17 gridline rows carrying ink. It shows Fig 11 draws its coefficient grid over
   **M ≤ 0.65 only** and Fig 12 over **M ≥ 1.10 only** — which is why a single fixed rule fails
   on this pair, and why Fig 12's fins-off curve (which sits on the undrawn 0.25 line for
   M0.60–0.85) is readable at all. A forward monotonicity constraint of one line width keeps
   the selector off Fig 12's 0.25 line once the curve has climbed past it.

### 2.2 The verification the instruction demanded

> *"VERIFY by re-reading known points — the M0.60 fins-off values must come back at
> 0.225/0.250 (Rogers' own read) and our earlier independent read 0.222/0.248."*

| M0.60 fins-off | ARCAS Short | ARCAS Long |
|---|---|---|
| **this read, report page scan** (now the anchor) | **0.2214** | **0.2491** |
| this read, forum image, same code | 0.2216 | 0.2495 |
| this project, 2026-08-03 | 0.222 | 0.248 |
| C. E. Rogers, TRF 197207 #9 | 0.225 | 0.250 |
| **total spread across four reads** | **0.0036** | **0.0020** |

It lands on both. Nothing about the calibration needed fixing.

### 2.3 Three more verifications, because one is not enough

**(a) A completely independent image, read by the same code.** The forum reproductions are a
different scan at 1/2.8 the linear resolution with JPEG artefacts. Over 14 Mach numbers on
both configs the two sources agree to **rms 0.0010, max 0.0032**:

| | mean (report − forum) | rms | max abs |
|---|---|---|---|
| Short | +0.0004 | 0.0010 | 0.0018 |
| Long | −0.0006 | 0.0011 | 0.0032 |

**(b) A different panel of the same figure, against a different reader.** The same pipeline
pointed at Fig 11's x_cp panel reproduces the earlier independent digitization recorded in
`docs/research/validation-anchors-2026-08-03.md` §1.4 to about 1 %L at all ten Machs
(e.g. M0.60 74.3 vs 74.5, M0.90 71.0–72.0 vs 71.0, M1.10 87.1 vs 87.0).

**(c) The report's own prose about its own curves.** p.5–6: *"A comparison of the fins-off
configurations for the long and short models indicates that the long model has higher C_A,corr
coefficients than the short model at Mach numbers from 0.60 to 0.975. At Mach numbers from
0.975 to 1.20, the short model has higher C_A,corr values."* In the digitized curves Long > Short
at every Mach up to 0.95 and Short > Long from M1.00 on, and **the crossover falls at M0.975**
— the exact Mach the report names. A digitization that got the calibration wrong could not
reproduce a crossover point it was never told about.

### 2.4 How the fins-off curve was told apart from the fins-on ones

The legend is solid = δ_F 0°, dashed = δ_F 2°, dash-dot = fins off. **Line style was not used as
the discriminator** — at this scan quality the dash-dot and dashed strokes are not separable
where the curves run within a line width of each other, and in the C_A,b panel all three do.

* **C_A,corr panel:** the fins-off curve is the lowest of the three at every Mach (0.221→0.430
  against 0.30→0.69 and 0.325→0.72 on Fig 11), so it is picked geometrically, by a value
  envelope, with the printed gridlines excluded as in §2.1(4). Style was used only as a
  consistency check: at M0.62 on Fig 11 the three strokes read long-dash/gap/dot/gap/long-dash
  (dash-dot, the top curve), uniform 6–8 px dashes (the middle), and continuous ink (the
  bottom) — the legend order.
* **C_A,b panel:** the three curves **cross** near M0.85, so "lowest" is not a valid rule
  across the whole range. Identity is fixed *quantitatively* instead, against the report's own
  base-pressure figures — see §4.

---

## 3. The new gates

Values are the report-scan read. **Only the Mach numbers the report actually tested are
gated**; the curve between them is the draftsman's fairing through those points, not a
measurement, so it is carried as `gate: false` in a `cd0-finsoff-fairing` series — visible in
every scorecard, never counted. That is why the Short cell gates 6 points and the Long 5 (the
Long model was not run at M0.95).

### 3.1 Tolerance ±0.008 — derived, and tighter than what it replaces

Root-sum-square of four terms, three of which are the report's own numbers:

| term | value | source |
|---|---|---|
| balance accuracy, C_A | ±0.004 | report p.4 accuracy table |
| the base correction, C_p,b ±0.01 × A_b/S = 0.4225 | ±0.0042 | report p.4; A_b/S from Fig 1(b), tail-cone base 0.65 d |
| digitization | ±0.004 | bounded by the 0.0036 max spread across the four independent reads in §2.2 |
| Mach ±0.003 × local curve slope | ≤±0.0012 | report p.4; slopes from the digitized curve, flat and plateau bands |
| **RSS** | **0.0072 → ±0.008** | rounded **up** |

**This is a tightening, not a widening: ±0.010 → ±0.008.** The anchor values also move against
us at both M0.60 points (0.225 → 0.2214, 0.250 → 0.2491), so the superseding numbers are the
*less* flattering ones in both cells. Nothing here was chosen because it passes.

One gated point, Short M1.00, sits on a steep local gradient where the same budget would
justify ±0.011. **It is deliberately left at ±0.008** — tightening is always allowed, and it
changes no verdict there (the model misses by −0.151 / +0.052).

The one thing that is *not* in the tolerance is the Short model's fin anchors. That is a
one-sided physical bias in the tunnel article, not a measurement uncertainty, and widening a
tolerance to absorb a bias is exactly what this harness forbids. It is recorded as a bias, and
its sign is stated wherever a Short number is used.

### 3.2 Result — classic Extended Barrowman

| cell | M | tunnel | model | delta | tol | result |
|---|---|---|---|---|---|---|
| arcas-short-finsoff | 0.60 | 0.2214 | 0.2446 | **+0.0232** | ±0.008 | **FAIL** |
| arcas-short-finsoff | 0.80 | 0.2309 | 0.2531 | **+0.0222** | ±0.008 | **FAIL** |
| arcas-short-finsoff | 0.90 | 0.2611 | 0.2591 | −0.0020 | ±0.008 | PASS |
| arcas-short-finsoff | 0.95 | 0.2930 | 0.2628 | **−0.0302** | ±0.008 | **FAIL** |
| arcas-short-finsoff | 1.00 | 0.4174 | 0.2669 | **−0.1505** | ±0.008 | **FAIL** |
| arcas-short-finsoff | 1.20 | 0.4297 | 0.2843 | **−0.1454** | ±0.008 | **FAIL** |
| arcas-long-finsoff | 0.60 | 0.2491 | 0.2958 | **+0.0467** | ±0.008 | **FAIL** |
| arcas-long-finsoff | 0.80 | 0.2520 | 0.3030 | **+0.0510** | ±0.008 | **FAIL** |
| arcas-long-finsoff | 0.90 | 0.2663 | 0.3085 | **+0.0422** | ±0.008 | **FAIL** |
| arcas-long-finsoff | 1.00 | 0.3665 | 0.3160 | **−0.0505** | ±0.008 | **FAIL** |
| arcas-long-finsoff | 1.20 | 0.4219 | 0.3322 | **−0.0897** | ±0.008 | **FAIL** |

**1/11.** The single pass is a sign change in flight, not agreement: the Short row crosses zero
at M0.90 on its way from +0.023 to −0.150.

### 3.3 Result — supersonic aero model (flag on)

| cell | M | tunnel | model | delta | tol | result |
|---|---|---|---|---|---|---|
| arcas-short-finsoff | 0.60 | 0.2214 | 0.2436 | **+0.0222** | ±0.008 | **FAIL** |
| arcas-short-finsoff | 0.80 | 0.2309 | 0.2526 | **+0.0217** | ±0.008 | **FAIL** |
| arcas-short-finsoff | 0.90 | 0.2611 | 0.2617 | +0.0006 | ±0.008 | PASS |
| arcas-short-finsoff | 0.95 | 0.2930 | 0.3361 | **+0.0431** | ±0.008 | **FAIL** |
| arcas-short-finsoff | 1.00 | 0.4174 | 0.4693 | **+0.0519** | ±0.008 | **FAIL** |
| arcas-short-finsoff | 1.20 | 0.4297 | 0.5687 | **+0.1390** | ±0.008 | **FAIL** |
| arcas-long-finsoff | 0.60 | 0.2491 | 0.2948 | **+0.0457** | ±0.008 | **FAIL** |
| arcas-long-finsoff | 0.80 | 0.2520 | 0.3026 | **+0.0506** | ±0.008 | **FAIL** |
| arcas-long-finsoff | 0.90 | 0.2663 | 0.3111 | **+0.0448** | ±0.008 | **FAIL** |
| arcas-long-finsoff | 1.00 | 0.3665 | 0.5184 | **+0.1519** | ±0.008 | **FAIL** |
| arcas-long-finsoff | 1.20 | 0.4219 | 0.6166 | **+0.1947** | ±0.008 | **FAIL** |

**1/11**, the same row, for the same reason.

---

## 4. The base-drag panel: convention established, and then NOT gated

The instruction was explicit — establish the relationship, demonstrate it on a known point, and
only then decide.

### 4.1 The convention, from the report

Symbols, report p.2: `C_A,b` = **base axial-force coefficient, Base axial force / qS**;
`C_p,b` = **base-pressure coefficient, (p_b − p)/q**; `C_A,corr` = **axial force corrected for
base axial force**. Axial force is positive aft, so

```
C_A,b  =  −C_p,b × (A_b / S)          C_A,corr  =  C_A − C_A,b
```

which is **the same sign convention our kernel uses for `powerOff.base`**: a positive C_A,b is
base drag. The panel plots C_A,b *negative* over M0.60–1.00 not because of a sign flip but
because the measured base pressure is **above** free stream there.

### 4.2 Demonstrated on known points, not assumed

Figures 3 (Short) and 5 (Long) plot C_p,b against α for fins-on and fins-off. At α ≈ 0,
`−C_p,b × 0.4225` reproduces both branches of the Fig 11/12 base panel:

| | C_p,b read (Fig 3/5) | ⇒ C_A,b predicted | C_A,b read (Fig 11/12) | Δ |
|---|---|---|---|---|
| Short, M0.60, fins off | +0.065 | −0.0275 | −0.0293 | 0.0018 |
| Short, M0.60, fins on δ_F 0 | +0.090 | −0.0380 | −0.0418 | 0.0038 |
| Short, M0.91, fins off | +0.072 | −0.0304 | −0.0300 | 0.0004 |
| Short, M0.91, fins on | +0.032 | −0.0135 | −0.0128 | 0.0007 |
| Long, M0.60, fins off | +0.050 | −0.0211 | −0.0235 | 0.0024 |
| Long, M0.60, fins on δ_F 0 | +0.091 | −0.0384 | −0.0394 | 0.0010 |

All six inside the C_p,b read error (±0.01 in C_p,b is ±0.0042 in C_A,b). This also does the
job line style could not: it is what identifies which branch of the crossing pair is the
fins-off one at each end of the Mach range.

### 4.3 Why it is not gated

**Because C_p,b is positive.** At α = 0 the tunnel base pressure is *above* free-stream static
over M0.60–0.90, so the measured base axial force is a **thrust** of 0.02–0.04 in CD. Our
kernel's base CD is structurally ≥ 0 and always will be; every row would fail by construction
and none of the failures would mean anything about the model.

The report reaches the same conclusion about its own data (p.5): *"The base axial-force
coefficients were generally negative at Mach numbers less than 1.00 and were positive at a Mach
number of 1.20. This trend is characteristic of boattailed afterbodies and is also associated
with sting diameter and flare angle."* The hardware behind that: a **2.54-cm (1-in.) sting**
through a base the report dimensions at 0.65 d ≈ 1.46 in full-scale — **58 % of the base area is
sting** — extending 29.21 cm aft to a 19.2° half-angle flare (p.4). This is not a free base.

Two consequences worth carrying forward:

1. **It validates the base-EXCLUDED convention of the fins-off and transonic gates.** Comparing
   base-included totals against this run would put an 0.085-CD sting artefact into every row
   (our +0.056 base drag at M0.60 against the tunnel's −0.029).
2. **It puts a question mark on the base-INCLUDED `cd-supersonic-tunnel` series**, which gates
   our total CD against TN D-4014's *uncorrected* C_A — a different tunnel, but also a sting.
   D-4014 prints its chamber axial force separately (its Fig 4), and that report is retrievable
   the same way this one was. Flagged, not touched.

**So the series is recorded but not gated.** The read values are in the two cells'
`_provenance` rather than as a series, because `score.mjs` has no `cdBase` quantity and adding
one is outside this pass's file manifest — and should not be added until there is a base
measurement with no sting in it. For the record (read accuracy ≈ ±0.005):

| M | 0.60 | 0.65 | 0.70 | 0.75 | 0.90 | 0.95 | 1.00 | 1.05 | 1.10 | 1.15 | 1.20 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Short C_A,b | −0.029 | −0.033 | −0.036 | −0.041 | −0.033 | −0.018 | −0.021 | — | −0.015 | +0.023 | +0.026 |
| Long C_A,b | −0.024 | −0.024 | −0.026 | −0.031 | −0.039 | −0.037 | −0.022 | −0.028 | −0.031 | −0.036 | −0.042 |

The Long curve stays negative at M1.20 and the Short goes positive — which is again the report's
own observation (p.5), and which it again attributes to the Short model's fin anchors.

### 4.4 The x_cp panel has no fins-off curve to gate

Checked blob by blob across both panels and both scans: **never more than two curves at any
Mach.** The legend lists "Fins off" for the figure as a whole, but the x_cp panel draws only
δ_F = 0 and δ_F = 2. A finless ARCAS body's CP sits around 40–50 %L, off the bottom of a panel
that spans 70–90 %L. Nothing was gated and nothing was invented.

---

## 5. What the shape of the body-only error says. This is the part that matters.

Base-excluded body drag, fins removed, tunnel-Re-matched, both cells, both models:

| M | tunnel Short | classic | supersonic | tunnel Long | classic | supersonic |
|---|---|---|---|---|---|---|
| 0.60 | 0.2214 | 0.2446 **+10.5 %** | 0.2436 +10.0 % | 0.2491 | 0.2958 **+18.7 %** | 0.2948 +18.3 % |
| 0.70 | 0.2231 | 0.2482 +11.2 % | 0.2472 +10.8 % | 0.2489 | 0.2987 +20.0 % | 0.2978 +19.6 % |
| 0.80 | 0.2309 | 0.2531 +9.6 % | 0.2526 +9.4 % | 0.2520 | 0.3030 +20.2 % | 0.3026 +20.1 % |
| 0.85 | 0.2408 | 0.2560 +6.3 % | 0.2564 +6.5 % | 0.2576 | 0.3056 +18.6 % | 0.3061 +18.8 % |
| 0.90 | 0.2611 | 0.2591 −0.8 % | 0.2617 +0.2 % | 0.2663 | 0.3085 +15.8 % | 0.3111 +16.8 % |
| 0.95 | 0.2930 | 0.2628 **−10.3 %** | 0.3361 **+14.7 %** | 0.2967 | 0.3120 +5.2 % | 0.3853 **+29.8 %** |
| 1.00 | 0.4174 | 0.2669 **−36.1 %** | 0.4693 **+12.4 %** | 0.3665 | 0.3160 **−13.8 %** | 0.5184 **+41.4 %** |
| 1.05 | 0.4313 | 0.3196 −25.9 % | 0.5472 +26.9 % | 0.3938 | 0.3686 −6.4 % | 0.5963 +51.4 % |
| 1.10 | 0.4315 | 0.3320 −23.1 % | 0.5576 +29.2 % | 0.4077 | 0.3809 −6.6 % | 0.6065 +48.8 % |
| 1.15 | 0.4307 | 0.3147 −26.9 % | 0.5644 +31.0 % | 0.4158 | 0.3630 −12.7 % | 0.6128 +47.4 % |
| 1.20 | 0.4297 | 0.2843 **−33.8 %** | 0.5687 **+32.3 %** | 0.4219 | 0.3322 **−21.3 %** | 0.6166 **+46.2 %** |

Rows at M0.65/0.75/0.85/0.95(Long)/0.975/1.05/1.10/1.15 are the fairing reads (`gate: false`);
they are included here because the shape is the finding.

### 5.1 Three separate defects, now separated

**(1) A subsonic level error that grows with body length.** +10 % on the Short, **+19 %** on the
Long, essentially flat across M0.60–0.85 and identical in both aero models — it is carved
classic physics, not the flag. The Short number is a *lower bound*: its tunnel value includes
the un-faired fin anchors we do not model.

**(2) The drag-divergence Mach is far too late in classic and about right in the supersonic
model.** Taking M at which the body's CD exceeds its M0.60 value by 10 %:

| | tunnel | classic | supersonic |
|---|---|---|---|
| ARCAS Short | **M 0.86** | M 1.00 | M 0.90 |
| ARCAS Long | **M 0.91** | M 1.01 | M 0.91 |

Classic starts its body drag rise **0.10–0.14 Mach too late**. That is the single cleanest
statement of the "transonic rise starts too early/too late" item in `README.md`'s baseline
reading, measured on a body with no fins on it to argue about.

**(3) Past M1.00 the tunnel body is FLAT and neither model is.** The measured fins-off Short
body reads 0.4174 / 0.4313 / 0.4315 / 0.4307 / 0.4297 at M1.00/1.05/1.10/1.15/1.20 — flat to
within 0.014, i.e. **within 2 tolerances across the whole low-supersonic range**. Against that:

* **classic peaks at M1.10 and then falls**, ending 34 % low at M1.20;
* **the supersonic model never stops climbing** — 0.4693 → 0.5687 over the same span, ending
  32 % high, and its error is still growing at the last gated point.

The supersonic model's body wave-drag terms keep accumulating where the tunnel says body wave
drag has already plateaued. That is a specific, falsifiable target for the transition work, and
it is a *shape* defect, not a level one: at M1.00 the supersonic body is only +12 % high; by
M1.20 it is +32 %. On the Long cell the same defect is worse (+41 % → +46 %).

### 5.2 The length-scaling (skin friction) measurement, corrected

The two fins-off configs differ by 12.55 in of cylinder and nothing else, so their difference is
a measured friction increment — the only one in the anchor set. With the better reads:

| M | tunnel Long − Short | ours (100 % friction) | ratio |
|---|---|---|---|
| 0.60 | 0.0277 | 0.0512 | **1.85×** |
| 0.65 | 0.0273 | 0.0509 | 1.86× |
| 0.70 | 0.0258 | 0.0505 | 1.96× |
| 0.75 | 0.0235 | 0.0502 | 2.14× |
| 0.80 | 0.0211 | 0.0499 | 2.37× |

**Two corrections to the earlier scorecard's headline "2.05×".**

1. At M0.60 the ratio is **1.85×**, not 2.05×, on the report-scan reads.
2. **It is an upper bound, and the bound tightens.** The tunnel's Short number carries the fin
   anchors and the Long one does not, so the *clean* length increment is `0.0277 + anchors`,
   and the true ratio is **≤ 1.85×**. The apparent rise with Mach (1.85 → 2.37) is the anchor
   drag growing transonically, not our friction getting worse — by M0.90 the tunnel's apparent
   increment has collapsed to 0.0052 and the "ratio" to a meaningless 9.5×.

The direction of the earlier finding survives — our friction on added body length is
substantially over-scaled — but its magnitude was overstated, and the honest statement is now
"**at most 1.85× at M0.60**, and the bound is not tight, because the fin-anchor drag that
inflates the Short number has not been quantified". Our increment is **100.0 % friction** at
every Mach in the table (pressure contributes 0.0000), so nothing else can be blamed for it.

### 5.3 What this does to the fin-increment story

The fin increment is `fins-on total − fins-off total`, and the fins-on side comes from the
`cd-transonic-tunnel` series, which **this pass has reason to doubt above M0.70** — see §6. At
M0.60, where the direct read and the existing anchor agree to 0.005, the picture is unchanged
from `scorecard-finsoff-2026-08-25.md`: measured increment 0.074 (Short) / 0.099 (Long) against
our 0.063 / 0.061 with the ×1.8 factor in place. The fin set is still short, the body is still
long, and the fins-on total still passes. Above M0.70 the arithmetic is **blocked** until the
fins-on curves are re-read the way the fins-off ones just were.

---

## 6. A finding this pass did NOT act on, and should be handed on

Reading Fig 11 and Fig 12 also reads the two **fins-on** curves, and they do not match the
`cd-transonic-tunnel` anchors in the middle of the range. Direct read of the δ_F = 0 solid
curve against the gated anchor:

| M | 0.60 | 0.70 | 0.80 | 0.90 | 0.95 | 1.00 | 1.05 | 1.10 | 1.15 | 1.20 |
|---|---|---|---|---|---|---|---|---|---|---|
| Short anchor | 0.295 | 0.300 | 0.309 | 0.350 | 0.460 | 0.683 | 0.685 | 0.666 | 0.635 | 0.596 |
| Short, read here | ≈0.300 | 0.309 | 0.331 | **0.423** | **0.568** | 0.686 | 0.688 | 0.668 | 0.635 | 0.600 |
| Long anchor | 0.348 | 0.348 | 0.353 | 0.385 | 0.470 | 0.630 | 0.720 | 0.735 | 0.665 | 0.635 |
| Long, read here | 0.347 | 0.354 | 0.371 | **0.453** | **0.570** | — | — | — | — | — |

The two ends agree — **≤0.006 at M0.60–0.70 and ≤0.006 at M1.00–1.20 on the Short** — and the
middle does not, by up to **+0.11**. That pattern is not a calibration error (a calibration
error would move the ends too, and the fins-off curve on the same panels, read by the same
code, matches four independent reads). Both scans give the same answer, both configs show the
same shape, and the M0.90 read is corroborated by the base panel: the fins-on and fins-off
C_A,b branches at M0.91 sit exactly where Fig 3's C_p,b says they should.

**It is not fixed here**, for two reasons: it is outside this task's stated purpose, and it
would move eight gated rows in cells this pass otherwise leaves byte-identical. It deserves its
own pass with the same treatment the fins-off curves just got — including a careful
solid-versus-dashed identification through the M0.85–0.95 band, which this pass's quick check
did not do to the standard it applied to the fins-off curve. Recorded here so it is not lost.

---

## 7. What changed in the tree

| file | change |
|---|---|
| `validation/anchors.json` | both fins-off cells re-sourced: gated series expanded 1 → 6 (Short) and 1 → 5 (Long) points at ±0.008, new `cd0-finsoff-fairing` and `cd0-finsoff-priorreads` info series, `_provenance` rewritten with the report's own words, the tolerance derivation, the fin-anchor and trip findings, and the whole base-panel analysis; `_readme` gains the 166 → 175 revision note |
| `validation/fixtures/arcas-short-finsoff.json` | `_notes` only: fin anchors resolved (they stayed on, un-faired), boundary layer confirmed tripped, base-diameter conflict recorded, anchor source upgraded |
| `validation/fixtures/arcas-long-finsoff.json` | `_notes` only: same, plus that this is the *clean* article of the pair |
| `validation/README.md` | scoreboard, file list, and the "not yet in the harness" entries the report has now answered |
| `validation/scorecard-finsoff-figs-2026-08-25.md` | this file |

**No kernel change, no fixture geometry change.** `packages/engine/vendor/orkengine.mjs` md5
`bc0c742d0343d36a83e0a213f3159da7`, untouched. Classic parity with desktop OpenRocket is not
involved in this pass at all: the only classic rows that moved are the two fins-off cells, and
they moved because the *anchors* moved, not the model.

## 8. What got worse

**The supersonic percentage, on paper.** 70/166 (42.2 %) → 71/175 (40.6 %). It gained a gate
and lost 1.6 points because nine harder gates were added. Classic went 10/166 (6.0 %) →
11/175 (6.3 %). This is the fourth anchor revision in this harness where the percentage falls
while the measurement gets better, and it is why `README.md` says percentages across anchor
revisions are not comparable.

Nothing regressed. There is no model change in this pass to regress anything.

## 9. What this leaves open

1. **The fins-on transonic anchors (§6).** The single most consequential loose end: eight gated
   rows may be wrong by up to 0.11.
2. **The supersonic body model has no plateau** (§5.1). Gated, measured, and the error is still
   growing at the last data point.
3. **Classic's body drag rise starts 0.10–0.14 Mach late** (§5.1), and this cannot be blamed on
   fins or on laminar flow — the models were tripped.
4. **The subsonic body level, +10 % / +19 %, is unexplained by anything this pass could rule
   out.** Trip: confirmed. Re: matched. Fin anchors: they push the Short number the *other* way.
   The friction over-scaling (§5.2, ≤1.85× on added length) accounts for the Short→Long
   difference but not for the Short's own +10 %.
5. **`cd-supersonic-tunnel`'s base-included convention** (§4.3 item 2) — TN D-4014 is
   retrievable the same way TN D-4013 was, and its Fig 4 prints the chamber axial force.
6. **The fixture's boat-tail base diameter.** TN D-4013 Fig 1(b) dimensions the tail-cone base
   at **0.65 d = 1.463 in** where the fixtures use 1.308 in. If 0.65 d is right, our base area is
   0.80× the tunnel's. Recorded in both fixtures' `_notes`; not acted on, because it would move
   every ARCAS row and it does not touch these base-excluded gates.
7. **Still absent: a finless, NO-boat-tail cell**, and **any fins-off data above M1.20**.

## 10. Reproducing this

```
node validation/score.mjs               # classic    -> 11/175
node validation/score.mjs --supersonic  # supersonic -> 71/175
```

The digitization is scripted end to end: `cal2.py` (report page scans) and `cal.py` (forum
images) build the calibration, `extract.py` + `gridpresence.py` find the curve blobs,
`read_cacorr.py` and `read_cab.py` emit the tables in §2 and §4, and `finsoff_sweep.mjs`
produces the model side of §5 from `packages/engine/dist`. The report itself is at
`https://ntrs.nasa.gov/api/citations/19670020050/downloads/19670020050.pdf`; Figure 11 is its
page 60 (PDF page 62) and Figure 12 page 61 (PDF page 63), and their page images extract at
2368×3104 and 2352×3072 with `PyMuPDF`.
