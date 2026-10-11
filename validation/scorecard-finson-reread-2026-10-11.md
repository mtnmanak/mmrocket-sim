# TN D-4013 fins-on curves, re-read off the report scan — 2026-10-11

Board Tier 2: *"The gated M0.8/0.9 fins-on anchors read 0.309/0.350 where the scan reads 0.331/0.423; the fin
increment above M0.70 is blocked until they are re-read."* This pass re-reads every fins-on point the harness
uses, checks each a second way, and replaces the ones that were wrong. It changes anchor values only: no kernel,
fixture, tolerance or gate-set change.

| | before (v0.179 kernel) | after (same kernel) |
|---|---|---|
| gates | 191 | 191 |
| `cd-transonic-tunnel` points replaced | — | Short 4 of 10 (M0.70/0.80/0.90/0.95), Long 8 of 10 (all but M0.60/1.15); `arcas-short-nosection` copies Short |
| Classic | 13/191 | **11/191** |
| Rogers Kbf (the app default) | 41/191 | **38/191** |
| Supersonic | 86/191 | **80/191** |
| Hybrid | 82/191 | **80/191** |
| artifact md5 | `85016ffe…` | `85016ffe…` (untouched) |

Every score fell, because the gates got harder where the old values were wrong; read the denominators, not the
percentages (README). Every changed scorecard line is a `cd-transonic-tunnel` row of `arcas-short`,
`arcas-short-nosection` or `arcas-long`, or one of those three series' source strings, or the summary line
(section 4). No other row moved a digit in any model.

---

## 1. Where the old values came from, and why they were doubted

The fins-on series were read in August 2026 off the TN D-4013 curves *as reproduced in Rogers' RASAero comparison
deck* (research notes `validation-anchors-2026-08-03.md` §1.3, "WT δF=0 solid"). When the report itself was
retrieved on 2026-08-25 to read the fins-off curves, the same pass glanced at the fins-on curves and found them
higher in the middle of the range: Short 0.331 / 0.423 at M0.80 / 0.90 against the gated 0.309 / 0.350
(`scorecard-finsoff-figs-2026-08-25.md` §6). That pass left them alone and said they needed their own read, with
care over which stroke is the solid δF = 0 curve where it crosses the dashed δF = 2 one.

## 2. The read

Script: `validation/digitize/read-d4013-ca.py` (give it the NTRS PDF; the two TRF images are optional). Its
docstring is the method in full. In short:

**Method 1, the summary curve (Fig 11, PDF page 62; Fig 12, page 63).** Mach from the 17 printed vertical
gridlines (fit rms 0.00018 / 0.00012 Mach). C_A,corr from the panel's printed horizontal gridlines and the full-width
zero axis. These lines are **not parallel** on the scan: on Fig 11 their slope runs from about −3 px per 1000 px at
the top of the panel to −10 at the zero axis. So the fit gives each line its own offset and lets the slope vary
linearly with height (fit rms 0.33 / 0.22 px, about 0.0002 in C_A). The single-slope de-skew the fins-off pass
used is also computed, and the difference goes into the uncertainty.

The curves are **traced** column by column. The solid curve is followed as an unbroken stroke: each column's run
must touch the last. Where two runs touch (the strokes merge at a crossing), the trace tries the one nearest the
prediction first. If that path then breaks away from any gridline, it was the dashed stroke, and the trace backs
up and takes the other run. That is what keeps it on δF = 0 through the crossings: Fig 11 near M0.95, Fig 12 near
M0.93 and at the peak. The traces were overlaid on both scans and checked by eye.

**The same code on a different scan.** The TRF reproductions of Figs 11 and 12 (834×1125 and 884×1125 px, JPEG,
lower resolution) are a separate scan of the same figures.

**Method 2, through two other figures.** C_A,corr = C_A − C_A,b, where C_A,b = −C_p,b × A_b/S and A_b/S = 0.4225.
- C_A at α = 0 comes from Fig 7(a) (Short) and Fig 9(a) (Long). These are the report's measured points, not its
  summary curve.
- C_p,b at α = 0 comes from Fig 3 (Short) and Fig 5 (Long).
- The conversion is the one `scorecard-finsoff-figs-2026-08-25.md` §4.2 showed reproduces the Fig 11/12 C_A,b panel
  to ≤ 0.004. That 0.004 is in method 2's uncertainty, with the spread of the three roll-angle symbols at α = 0.
- It exists only at the Mach numbers the report tested.

### Calibration: the same reads reproduce the fins-off anchors

The fins-off curve sits on the same panels. Method 1 reads it at the gated Machs within **0.0022** of the
2026-08-25 anchors everywhere except Short M1.00, where the read is +0.0038 on the steepest part of the curve.
Method 2, from Figs 7/9 and 3/5, reproduces the fins-off anchors within **0.006** at the ten Machs where its
fins-off symbol can be isolated. At Long M0.80 the fins-off and fins-on symbols overlap.

### Read uncertainty

Every point is given **±0.004**: the digitization term of the fins-off tolerance budget (the four-read spread at
M0.60). The script's own computed term is smaller everywhere (≤ 0.0036). The two scans agree to rms 0.0014 and max
0.0041 (Long M0.95, on the steep rise).

## 3. Every point, against every read on file

Short (Fig 11). The deck's δF = 2 column shows the deck read was low through the rise on **both** curves. So it was
not a mix-up of the solid and dashed curves.

| M | gated until now (deck δF=0) | 08-25 quick read | **scan** | TRF image | Figs 7(a)+3 | deck δF=2 | scan δF=2 | verdict |
|---|---|---|---|---|---|---|---|---|
| 0.60 | 0.295 | ≈0.300 | 0.2983 | 0.2993 | 0.2956 ±0.008 | 0.325 | 0.3237 | keep (Δ +0.0033 < 0.004) |
| 0.70 | 0.300 | 0.309 | **0.3087** | 0.3086 | — | 0.331 | 0.3326 | **replace** |
| 0.80 | 0.309 | 0.331 | **0.3295** | 0.3294 | 0.3251 ±0.008 | 0.337 | 0.3550 | **replace** |
| 0.90 | 0.350 | 0.423 | **0.4201** | 0.4204 | 0.4191 ±0.009 | 0.40 | 0.4457 | **replace** |
| 0.95 | 0.46 | 0.568 | **0.5658** | 0.5673 | 0.5585 ±0.006 | 0.55 | 0.5956 | **replace** |
| 1.00 | 0.683 | 0.686 | 0.6865 | 0.6846 | 0.6888 ±0.007 | 0.710 | 0.7132 | keep |
| 1.05 | 0.685 | 0.688 | 0.6861 | 0.6857 | — | 0.710 | 0.7097 | keep |
| 1.10 | 0.666 | 0.668 | 0.6662 | 0.6663 | — | 0.688 | 0.6856 | keep |
| 1.15 | 0.635 | 0.635 | 0.6325 | 0.6322 | — | 0.652 | 0.6516 | keep |
| 1.20 | 0.596 | 0.600 | 0.5929 | 0.5926 | 0.5976 ±0.008 | 0.616 | 0.6138 | keep |

Long (Fig 12):

| M | gated until now | 08-25 quick read | **scan** | TRF image | Figs 9(a)+5 | scan δF=2 | verdict |
|---|---|---|---|---|---|---|---|
| 0.60 | 0.348 | 0.347 | 0.3476 | 0.3486 | 0.3389 ±0.006 | 0.3568 | keep |
| 0.70 | 0.348 | 0.354 | **0.3550** | 0.3568 | — | 0.3650 | **replace** |
| 0.80 | 0.353 | 0.371 | **0.3714** | 0.3732 | 0.3635 ±0.005 | 0.3829 | **replace** |
| 0.90 | 0.385 | 0.453 | **0.4516** | 0.4540 | 0.4418 ±0.005 | 0.4628 | **replace** |
| 0.95 | 0.47 | 0.570 | **0.5928** | 0.5969 | — | 0.6128 | **replace** |
| 1.00 | 0.63 | — | **0.7253** | 0.7239 | 0.7232 ±0.009 | 0.7420 | **replace** |
| 1.05 | 0.72 | — | **0.7279** | 0.7282 | — | 0.7387 | **replace** |
| 1.10 | 0.735 | — | **0.6980** | 0.6982 | — | 0.7109 | **replace** |
| 1.15 | 0.665 | — | 0.6620 | 0.6620 | — | 0.6753 | keep |
| 1.20 | 0.635 | — | **0.6219** | 0.6226 | 0.6161 ±0.016 | 0.6363 | **replace** |

The rule applied (the script prints it): **replace** where the scan read differs from the gated value by more than
its ±0.004 *and* a second method agrees within the RSS of the two uncertainties.
- The TRF read agrees at all 20 points.
- Method 2 agrees at every Short point.
- **On the Long model, method 2 sits 0.008–0.010 below every summary read at M0.60, 0.80 and 0.90.** That
  includes M0.60, where the gated value, the deck read, the quick read and both scan reads agree within 0.001.
  So the offset belongs to method 2 on this model: most likely Fig 9(a)'s α = 0 point lies in the small dip the
  α-sweeps show there. It is not a sign that the summary curve is wrong. Measured from its own M0.60 value,
  method 2 gives the rise to M0.80 / 0.90 as +0.025 / +0.103. The scan gives +0.024 / +0.104, and the superseded
  values +0.005 / +0.037.

The superseded values lie **below the curve all through the drag rise, on both models** (ten points, by up to
0.1228 at Long M0.95), and meet it again at the ends, except that two Long points past the peak sat above it
(M1.10 by 0.037, M1.20 by 0.013). On the Long model the superseded peak sat at M1.10 (0.735); the curve peaks at M1.02–1.05 (0.728). The
values kept differ from the scan read by ≤ 0.0035, inside its uncertainty. Short M0.60 stays at 0.295: the scan
reads 0.2983 (+0.0033), with the curve's start lying on the printed 0.30 gridline.

Not touched: the tolerance (±0.03; see section 7), the gate set, and the gated points (four in each Short cell, five on the Long) that are
fairing points rather than tested Machs (section 7).

## 4. Gates that flip

Every flip is in `cd-transonic-tunnel`; no other row in any series changed in any model.

| Model | Score | PASS → FAIL | FAIL → PASS |
|---|---|---|---|
| Classic | 13 → **11** | Short M0.95, Short-nosection M0.95 | — |
| Kbf | 41 → **38** | Short M0.90, Short-nosection M0.90, Long M0.90 | — |
| Supersonic | 86 → **80** | Short M0.90, Short-nosection M0.90, Long M0.90 / 0.95 / 1.00 / 1.10 | — |
| Hybrid | 82 → **80** | Short M0.90, Short-nosection M0.90, Long M0.90 | Long M1.10 |

Proof of containment: the four scorecards were generated on the same artifact (md5 `85016ffe…`) before and after
the anchor edit and compared row by row. In every model, exactly 16 scored rows changed: Short 4, Short-nosection
4, Long 8, all in `cd-transonic-tunnel`. No row was added or removed. The only other changed lines are those three
series' source strings and the summary line.

## 5. What the re-read unblocks: the fin increment above M0.70

Fin increment = fins-on C_A,corr − fins-off C_A,corr at the same Mach, both base-excluded, both from TN D-4013.
- **Uncertainty ±0.010**: the RSS over both terms of the balance (±0.004), the base correction (±0.0042) and the
  digitization (±0.004).
- **Short: no anchor bias.** The fin anchors stayed in the slots, unfaired, on the Short fins-off run, so its
  increment is fins only (`scorecard-finsoff-figs-2026-08-25.md` §1.1).
- **Long: an upper bound.** The Long fins-off article was faired flush, so its increment includes the anchors.

Model increments are the same difference taken in each model, from the same scorecards.

**Short (named double-wedge section):**

| M | tunnel, before | **tunnel now** | Classic | Kbf | Supersonic | Hybrid |
|---|---|---|---|---|---|---|
| 0.60 | 0.0736 | **0.0736** | 0.0750 (+2 %) | 0.0631 (−14 %) | 0.0631 (−14 %) | 0.0631 (−14 %) |
| 0.80 | 0.0781 | **0.0986** | 0.1379 (+40 %) | 0.0616 (−38 %) | 0.0616 (−38 %) | 0.0616 (−38 %) |
| 0.90 | 0.0889 | **0.1590** | 0.2290 (+44 %) | 0.0610 (−62 %) | 0.0610 (−62 %) | 0.0610 (−62 %) |
| 0.95 | 0.1670 | **0.2728** | 0.2114 (−23 %) | 0.0692 (−75 %) | 0.0786 (−71 %) | 0.0722 (−74 %) |
| 1.00 | 0.2656 | 0.2656 | 0.1939 (−27 %) | 0.0775 (−71 %) | 0.1117 (−58 %) | 0.0945 (−64 %) |
| 1.20 | 0.1663 | 0.1663 | 0.2119 (+27 %) | 0.1097 (−34 %) | 0.1263 (−24 %) | 0.1263 (−24 %) |

The Short-nosection cell (the desktop-import fin path) reads the same as Short through M0.90 in every model. Above
that, Kbf / Supersonic / Hybrid give 0.085 (−69 %) at M0.95, 0.129 (−52 %) at M1.00 and 0.149 (−11 %) at M1.20.

**Long (upper bound: includes the faired-over anchors):**

| M | tunnel, before | **tunnel now** | Classic | Kbf | Supersonic | Hybrid |
|---|---|---|---|---|---|---|
| 0.60 | 0.0989 | **0.0989** | 0.0735 (−26 %) | 0.0605 (−39 %) | 0.0605 (−39 %) | 0.0605 (−39 %) |
| 0.80 | 0.1010 | **0.1194** | 0.1364 (+14 %) | 0.0590 (−51 %) | 0.0590 (−51 %) | 0.0590 (−51 %) |
| 0.90 | 0.1187 | **0.1853** | 0.2275 (+23 %) | 0.0584 (−68 %) | 0.0584 (−68 %) | 0.0584 (−68 %) |
| 1.00 | 0.2635 | **0.3588** | 0.1926 (−46 %) | 0.0749 (−79 %) | 0.1092 (−70 %) | 0.0920 (−74 %) |
| 1.20 | 0.2131 | **0.2000** | 0.2106 (+5 %) | 0.1072 (−46 %) | 0.1239 (−38 %) | 0.1239 (−38 %) |

**Method 2 gives the same increments without using the summary figure at all.** Fins-on minus fins-off, both from
Figs 7/9 and 3/5:

| | Short M0.60 | Short M0.80 | Short M0.90 | Long M0.60 | Long M0.90 |
|---|---|---|---|---|---|
| method 2 | 0.075 | 0.094 | 0.153 | 0.094 | 0.181 |
| scan | 0.074 | 0.099 | 0.159 | 0.099 | 0.185 |

What it says:
1. **The tunnel fin set has a drag rise that starts below M0.80.** On the bracket-free Short model the increment
   is 1.34× its M0.60 value at M0.80, 2.16× at M0.90 and 3.71× at M0.95. The old anchors had it flat to M0.90
   (1.06× at M0.80).
2. **In the three non-classic models the sharp-airfoil fin increment is flat, or falls slightly, from M0.60 to
   M0.90** (Kbf 0.0631 → 0.0610). Their fin pressure drag for an AIRFOIL section is about zero subsonically, and
   the thin-airfoil wave drag is blended in only from M0.9 (LEDGER, Phase 2). So the shortfall grows with Mach on
   the Short model: −14 % at M0.60 (0.0105, about 1σ of the ±0.010), −38 % at M0.80 (0.037, about 3.7σ), and
   −62 % at M0.90 (0.098). The old anchors had it at −21 % and −31 %.
3. **Classic's increment rises from M0.70, as the tunnel's does, but too steeply.** It charges the sharp section a
   blunt-leading-edge pressure term with a (1 − M²)^−0.417 form: +40 % at M0.80, +44 % at M0.90. It then falls
   short from M0.95 (−23 %). Desktop parity keeps it, whatever the tunnel says.
4. Above M1.00 nothing changed on the Short model. On the Long model the deficits deepen at M1.00 (Kbf −72 → −79 %)
   and ease slightly at M1.20.

## 6. The airfoil-fin drag question (register item 8; measurement only, no kernel change)

The question was whether the non-classic models charge airfoil fins too much drag (Buckeye's CFD at M0.30: +41 %)
or too little (the tunnel). With the curves re-read:

- **At M0.60, the only Mach where the old and new anchors agree, the tunnel puts the default model's double-wedge
  fin increment at −14 % ± 14 %.** That is not high, and at 1σ not clearly low. The re-read does not change this
  point.
- **From M0.70 up, the tunnel's fin increment is larger than any non-classic model's, by 3.7σ at M0.80.** The
  tunnel never calls for less fin drag on a sharp section at any Mach it measured.
- **Buckeye's CFD airfoil is a rounded-leading-edge, sharp-trailing-edge NACA-type section** (Fable,
  `fable-aero-fin`), not the ARCAS double wedge. At M0.30 the two references are measuring different sections at
  different Mach numbers. So they need not contradict each other, and neither licenses a cut to the double-wedge
  fin drag.
- **The candidate measured in batch 4** cut the ×1.8 to 1.2759 on airfoil fins (a219c5cf on `exp/b4-aero-fin`,
  about −29 % on the airfoil fin increment). Applied to these increments, it would take the Short shortfall at
  M0.80 from −38 % to about −56 %. **The re-read strengthens the do-not-ship verdict.**
- **What the data now points at instead** is a transonic drag rise for sharp-airfoil fin sections starting near
  M0.7, which none of the non-classic models has. It is a modelling decision for the owner (a new item, not
  built). Its evidence is one tunnel article with one section family, measured at M0.60/0.80/0.90/0.95. Any term
  sized to these four points would be a fit; a published source for the section's drag-divergence behaviour is
  needed first.
- **For rounded and square sections nothing here applies.** Every finned tunnel fixture is a sharp section.

## 7. Found and not fixed

1. **Four of the ten gated fins-on Machs on the Short model, and five on the Long, are not tested Machs.**
   - TN D-4013 ran M0.60/0.80/0.90/1.00/1.20, plus 0.95 on the Short model only (p.4).
   - Gated untested points: M0.70, 1.05, 1.10, 1.15 on both models, and M0.95 on the Long.
   - Those values are the draftsman's fairing. The fins-off cells already carry such points as `gate: false`
     (`cd0-finsoff-fairing`).
   - Moving them would change the denominator (191) and is a separate decision. This pass re-read and replaced
     them under the same rule, because the harness gates them today.
2. **The ±0.03 tolerance is not derived from the report's stated accuracy.** It came with the RASAero comparison
   reads. The report-derived budget used for the fins-off cells (C_A ±0.004, C_p,b ±0.01 × 0.4225, digitization
   ±0.004, Mach ±0.003 × slope) would give about ±0.008 subsonically and more on the rise. Tightening is allowed,
   but this pass leaves the derivation alone, as instructed.
3. **The LEDGER's ×1.8 entry still says "1.8× leaves our fin increment 14–39 % short"** below M1.2. On the
   re-read anchors that range is 14–62 % (Short) and 39–68 % (Long). The LEDGER is the kernel's record, so this
   is left for the next kernel entry to carry.
4. **The README scoreboard table stopped at 13/22/83/79.** The v0.179 kernel's 13/41/86/82 (LEDGER: board row 87
   and the Supersonic per-fin CNα top) was never written into it. Corrected in this pass.

## 8. Reproduce

```
npm run build -w @online-openrocket/engine
node validation/score.mjs [--kbf | --supersonic | --hybrid]       # 11 · 38 · 80 · 80 of 191
python validation/digitize/read-d4013-ca.py <19670020050.pdf> [<TRF Fig 11 png> <TRF Fig 12 png>]
node --test validation/score.test.mjs                             # pins the re-read values and the copy
```

The report is at `https://ntrs.nasa.gov/api/citations/19670020050/downloads/19670020050.pdf` (md5 of the file
read here: `c33fe91cc88cee52e4380b26aaa99f3d`). The TRF images are `1778709826323.png` (Fig 11) and
`1778710171376.png` (Fig 12) from TRF thread 197207.
