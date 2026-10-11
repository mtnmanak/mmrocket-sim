# Harness coverage: a small-model cell, plain-body and boat-tailed-body cells, Finner subsonic — 2026-10-11

Eighteen new **informational** cells (`gate: false`: reported, never counted) and 193 new
points. **No existing anchor, tolerance, gate or scored row changed**: in all four models the
first 586 lines of the scorecard (everything above *Summary*) are byte-identical before and
after, and the gate scores stay **Classic 13/191 · Kbf 22/191 · Supersonic 83/191 · Hybrid
79/191** (kernel of v0.177). No kernel or app file changed, so no number a user sees moves.
These are comparisons against measured drag, not flown simulations and not a ruling on the
default model.

Board row: *Karbon's Finner/Aerobee anchors · a small-model fixture · the two Cd0 cells ·
re-score the harness* (open-items §3, *Harness coverage*).

## What was added

| Cell(s) | Fixture | Quantity | Source | What it covers |
|---|---|---|---|---|
| `r100-23` | `r100-23.json` | `cd` total | NASA TR R-100 config 23 sheet (PDF p40) | **The small-model cell**: a 1.00 in body (BT-20 size) with three fins whose exposed planform is 12.4 × the body cross-section (goblin-29.CDX1, the design the register raised: 10.5 ×). M0.85–1.25. |
| `r100-78-finned`, `r100-92-finned`, `r100-98-finned` | same names | `cd` total | R-100 configs 78/92/98 sheets (Figure 10 series) | **The plain-body cell**: parabolic nose straight into a cylinder (no boat-tail), l_A/d 1.78 / 3.50 / 5.00, with the report's three thin type-A fins as drawn. M0.80–1.25. |
| `r100-{79–83, 93–95, 99–103}-increment` | 9 new finless bodies + the 4 Figure 13(a) boattails | new `cdDelta` | R-100 Figure 10 series | **The boat-tailed-body cell**: each boattailed body's measured C_D,T minus the same-length cylinder's. The identical nose and fins cancel in the measurement, so the kernel difference is formed between two finless bodies. 13 configurations, curved and conical, r_b/R 0 / 0.438 / 0.700. M0.80–1.25. |
| `basic-finner-fig23` | `basic-finner.json` (unchanged) at α = 0 | `cd` (Cx0) | Karbon, vNARCON 2026 R&D report, Figure 23, "DRDC WT" | The only Finner drag data below M1.05 in the harness (the gated DREV free-flight table starts at M1.056). M0.60–4.11. |

`score.mjs` gained two small things, both covered by `score.test.mjs`: the `cdDelta` quantity
(`referenceFixture` names the body to subtract; it is swept under the same model and
conditions through one shared `buildModel` helper, so a reference can never be scored under a
different model), and an optional per-point tolerance (a third element, `[mach, value, tol]`)
for datasets whose stated accuracy varies point to point.

### Why every new series is informational

- **R-100 cells:** the report states its own accuracy, ΔC_D = ±0.01 and ΔM = ±0.01 (p6,
  from repeat flights of identical models), and the per-point tolerance is built from exactly
  that: the quadrature sum of ±0.01, the reading resolution, and ±0.01 Mach times the local
  slope of the measured curve (so a point on the drag rise gets the wider band the stated Mach
  error implies). The source would support gating. They stay informational because each curve
  was **read once, by one reader** (`docs/research/Boat-tails/fig10-digitised/manual-read1.json`
  for Figure 10, 2026-10-08; config 23 read this sitting), and the house standard for a gate
  read is two independent reads (the Figure 13(a) points were two-reader). A second
  independent read is the one step between these and gates.
- **Finner Figure 23:** a reproduction of a reproduction. Karbon cites Bhagwandin & Sahu
  (ARL 2013, DTIC ADA592550); the DRDC wind-tunnel report behind the legend is not chased, and
  the source states no accuracy. Tolerance ±0.010 is the figure read's own check (below);
  ±0.015 on three markers hidden behind other symbols.

## How the values were read

- **Figure 10 (configs 78–103):** unchanged from the 2026-10-08 manual read (±0.003; ±0.01 on
  the steep M0.975–1.00 points). Increments are config minus cylinder at the same nominal Mach,
  where both curves exist. They reproduce `docs/research/Boat-tails/fig10-digitised/compare.md`
  point for point, as they should (same reads, same bodies).
- **Config 23:** the 300-dpi page render, gridlines located per row and column (the scan is
  skewed 0.26°, corrected locally), the C_D,T curve traced column by column with continuity
  tracking, then checked by eye on a 2× enlargement. Resolution ±0.003; from M1.18 the curve
  lies on the 0.50 gridline. The sheet has no data below M0.85.
- **Karbon Figure 23:** the PDF's embedded 1259 × 747 raster, axes from its gridlines; markers by
  template match and by connected-component centroid (agreeing within 0.003 in Cx0), three
  occluded markers by eye on a 4× ruled enlargement. **Check:** the same procedure on the
  figure's free-flight series gives (1.052, 0.867), (2.371, 0.482), (3.731, 0.305) against the
  DREV Table VIII values already gated, (1.056, 0.868), (2.364, 0.478), (3.745, 0.309) — within
  0.005; about 0.01 elsewhere, where the figure appears to plot a mean of several shots.

## Geometry decisions (full detail in each fixture's `_notes`)

- **Fins (all finned R-100 cells):** the report's fin type A as drawn — three fins, 1.8 in root
  and tip chord, 45° sweep, 0.05 in symmetric hexagonal section with 0.6 in chamfers. The span
  dimension is measured from the body axis (its extension line is the centreline), so the
  exposed span is 1.75 in on the 1.5 in bodies and 1.80 in on config 23's 1.00 in body. The
  tabulated S_F/A_max is wetted area (both faces); the fixtures reproduce it to 10.7 vs 11.0 and
  24.75 vs 24.6.
- **Config 78's fin** starts 0.295 in ahead of the nose/body joint (radius there 0.9992 R); a
  trapezoidal fin set cannot mount on a nose cone, so it hangs off the cylinder with a negative
  offset.
- **Config 23's nose** is a 40° (included) cone tip to half radius, then a curved section, read
  off the sheet's r/R plot: modelled as a conical nose cone plus an **unclipped power-0.5
  transition**, which reproduces the plotted profile within 0.02 r/R at six stations. Its fins
  mount on the cylinder and overhang the boattail, the ARCAS convention.
- **Reynolds number:** sea-level ISA reproduces the sheets' own N_Re (about 7 × 10^6 at M0.8),
  so no Mach-altitude tables. The Finner cell's tunnel Re is not given (sea level, as the gated
  Finner cell).

## Results

All models, all new cells: **no model lands inside the stated accuracy on any plain-body or
small-model point.** Gates are unchanged; these are new measurements of where the models sit.

### Per cell: points inside their tolerance, and mean (model − anchor)

| Cell | points | Classic | Kbf | Supersonic | Hybrid |
|---|---|---|---|---|---|
| `basic-finner-fig23` | 18 | 0 · +0.154 | 1 · −0.103 | 1 · −0.100 | 1 · −0.101 |
| `r100-23` | 12 | 0 · +0.178 | 0 · +0.102 | 0 · +0.175 | 0 · +0.154 |
| `r100-78-finned` | 11 | 0 · +0.103 | 0 · +0.073 | 0 · +0.079 | 0 · +0.077 |
| `r100-92-finned` | 11 | 0 · +0.103 | 0 · +0.072 | 0 · +0.079 | 0 · +0.077 |
| `r100-98-finned` | 10 | 0 · +0.113 | 0 · +0.081 | 0 · +0.088 | 0 · +0.086 |
| `r100-79-increment` | 9 | 1 · −0.060 | 1 · −0.060 | 2 · +0.139 | 1 · +0.079 |
| `r100-80-increment` | 9 | 0 · −0.118 | 0 · −0.118 | 2 · +0.058 | 0 · +0.014 |
| `r100-81-increment` | 11 | 1 · −0.036 | 1 · −0.036 | 3 · +0.028 | 3 · +0.014 |
| `r100-82-increment` | 10 | 0 · −0.102 | 0 · −0.102 | 1 · +0.083 | 1 · +0.044 |
| `r100-83-increment` | 11 | 0 · −0.028 | 0 · −0.028 | 2 · +0.036 | 2 · +0.022 |
| `r100-93-increment` | 11 | 0 · −0.023 | 0 · −0.023 | 3 · +0.011 | 3 · +0.004 |
| `r100-94-increment` | 11 | 0 · −0.066 | 0 · −0.066 | 1 · +0.030 | 0 · +0.010 |
| `r100-95-increment` | 11 | 0 · −0.128 | 0 · −0.128 | 0 · +0.064 | 0 · +0.023 |
| `r100-99-increment` | 10 | 5 · −0.023 | 5 · −0.023 | 2 · +0.001 | 2 · −0.005 |
| `r100-100-increment` | 10 | 1 · −0.033 | 1 · −0.033 | 2 · −0.009 | 2 · −0.015 |
| `r100-101-increment` | 9 | 0 · −0.056 | 0 · −0.056 | 1 · +0.018 | 1 · −0.000 |
| `r100-102-increment` | 10 | 0 · −0.056 | 0 · −0.056 | 1 · +0.010 | 1 · −0.006 |
| `r100-103-increment` | 9 | 0 · −0.088 | 0 · −0.088 | 1 · +0.062 | 1 · +0.025 |

### The small-model cell, `r100-23` (C_D,T, three fins of 12.4 × the body cross-section on a 1.00 in body)

| Mach | measured | tol | Classic | Kbf | Supersonic | Hybrid |
|---|---|---|---|---|---|---|
| 0.85 | 0.303 | ±0.010 | 0.509 (+0.206) | 0.446 (+0.143) | 0.446 (+0.143) | 0.446 (+0.143) |
| 0.9 | 0.309 | ±0.011 | 0.570 (+0.261) | 0.456 (+0.147) | 0.456 (+0.147) | 0.456 (+0.147) |
| 0.95 | 0.316 | ±0.011 | 0.571 (+0.255) | 0.479 (+0.163) | 0.512 (+0.196) | 0.489 (+0.173) |
| 0.97 | 0.334 | ±0.024 | 0.576 (+0.242) | 0.492 (+0.158) | 0.552 (+0.218) | 0.516 (+0.182) |
| 0.98 | 0.364 | ±0.032 | 0.578 (+0.214) | 0.499 (+0.135) | 0.573 (+0.209) | 0.531 (+0.167) |
| 0.99 | 0.395 | ±0.027 | 0.581 (+0.185) | 0.506 (+0.111) | 0.593 (+0.198) | 0.547 (+0.152) |
| 1 | 0.413 | ±0.016 | 0.583 (+0.170) | 0.512 (+0.100) | 0.613 (+0.200) | 0.563 (+0.150) |
| 1.05 | 0.454 | ±0.012 | 0.597 (+0.143) | 0.528 (+0.074) | 0.662 (+0.208) | 0.620 (+0.166) |
| 1.1 | 0.474 | ±0.011 | 0.603 (+0.129) | 0.537 (+0.063) | 0.657 (+0.183) | 0.639 (+0.165) |
| 1.15 | 0.491 | ±0.011 | 0.608 (+0.117) | 0.544 (+0.053) | 0.645 (+0.154) | 0.641 (+0.150) |
| 1.2 | 0.499 | ±0.010 | 0.609 (+0.110) | 0.548 (+0.049) | 0.635 (+0.136) | 0.635 (+0.136) |
| 1.25 | 0.5 | ±0.010 | 0.604 (+0.104) | 0.534 (+0.034) | 0.613 (+0.113) | 0.613 (+0.113) |

### A plain-body cell, `r100-92-finned` (C_D,T; 78 and 98 behave the same way)

| Mach | measured | tol | Classic | Kbf | Supersonic | Hybrid |
|---|---|---|---|---|---|---|
| 0.8 | 0.278 | ±0.010 | 0.373 (+0.095) | 0.360 (+0.082) | 0.360 (+0.082) | 0.360 (+0.082) |
| 0.85 | 0.274 | ±0.010 | 0.395 (+0.121) | 0.367 (+0.093) | 0.367 (+0.093) | 0.367 (+0.093) |
| 0.9 | 0.27 | ±0.011 | 0.425 (+0.155) | 0.376 (+0.106) | 0.376 (+0.106) | 0.376 (+0.106) |
| 0.95 | 0.287 | ±0.011 | 0.429 (+0.142) | 0.389 (+0.102) | 0.394 (+0.106) | 0.390 (+0.103) |
| 0.975 | 0.302 | ±0.017 | 0.433 (+0.131) | 0.398 (+0.096) | 0.408 (+0.106) | 0.402 (+0.100) |
| 1 | 0.336 | ±0.017 | 0.441 (+0.105) | 0.411 (+0.075) | 0.426 (+0.090) | 0.418 (+0.083) |
| 1.05 | 0.366 | ±0.011 | 0.448 (+0.082) | 0.418 (+0.052) | 0.439 (+0.072) | 0.432 (+0.066) |
| 1.1 | 0.366 | ±0.010 | 0.445 (+0.079) | 0.416 (+0.050) | 0.431 (+0.065) | 0.429 (+0.063) |
| 1.15 | 0.361 | ±0.011 | 0.437 (+0.076) | 0.409 (+0.048) | 0.416 (+0.055) | 0.415 (+0.054) |
| 1.2 | 0.352 | ±0.011 | 0.430 (+0.078) | 0.403 (+0.051) | 0.403 (+0.051) | 0.403 (+0.051) |
| 1.25 | 0.348 | ±0.010 | 0.420 (+0.072) | 0.390 (+0.042) | 0.390 (+0.042) | 0.390 (+0.042) |

### Basic Finner, Karbon Figure 23 "DRDC WT" (Cx0, α = 0)

| Mach | measured | tol | Classic | Kbf | Supersonic | Hybrid |
|---|---|---|---|---|---|---|
| 0.6 | 0.461 | ±0.010 | 0.432 (−0.029) | 0.447 (−0.014) | 0.447 (−0.014) | 0.447 (−0.014) |
| 0.69 | 0.478 | ±0.010 | 0.488 (+0.010) | 0.466 (−0.012) | 0.466 (−0.012) | 0.466 (−0.012) |
| 0.8 | 0.5 | ±0.010 | 0.608 (+0.108) | 0.503 (+0.003) ok | 0.503 (+0.003) ok | 0.503 (+0.003) ok |
| 0.93 | 0.675 | ±0.015 | 0.860 (+0.185) | 0.601 (−0.074) | 0.602 (−0.073) | 0.601 (−0.074) |
| 0.94 | 0.696 | ±0.010 | 0.862 (+0.166) | 0.613 (−0.083) | 0.616 (−0.080) | 0.614 (−0.082) |
| 1.05 | 0.996 | ±0.015 | 0.944 (−0.052) | 0.746 (−0.250) | 0.776 (−0.220) | 0.767 (−0.229) |
| 1.076 | 1.013 | ±0.010 | 0.956 (−0.057) | 0.754 (−0.259) | 0.779 (−0.234) | 0.774 (−0.239) |
| 1.24 | 0.845 | ±0.010 | 0.900 (+0.055) | 0.671 (−0.174) | 0.671 (−0.174) | 0.671 (−0.174) |
| 1.27 | 0.829 | ±0.010 | 0.885 (+0.056) | 0.646 (−0.183) | 0.646 (−0.183) | 0.646 (−0.183) |
| 1.3 | 0.811 | ±0.010 | 0.874 (+0.063) | 0.627 (−0.184) | 0.627 (−0.184) | 0.627 (−0.184) |
| 1.35 | 0.75 | ±0.015 | 0.863 (+0.113) | 0.602 (−0.148) | 0.602 (−0.148) | 0.602 (−0.148) |
| 1.378 | 0.733 | ±0.010 | 0.857 (+0.124) | 0.590 (−0.143) | 0.590 (−0.143) | 0.590 (−0.143) |
| 1.75 | 0.562 | ±0.010 | 0.808 (+0.246) | 0.478 (−0.084) | 0.478 (−0.084) | 0.478 (−0.084) |
| 2 | 0.482 | ±0.010 | 0.786 (+0.304) | 0.429 (−0.053) | 0.429 (−0.053) | 0.429 (−0.053) |
| 2.49 | 0.384 | ±0.010 | 0.752 (+0.368) | 0.362 (−0.022) | 0.362 (−0.022) | 0.362 (−0.022) |
| 3.07 | 0.354 | ±0.010 | 0.722 (+0.368) | 0.308 (−0.046) | 0.308 (−0.046) | 0.308 (−0.046) |
| 3.6 | 0.332 | ±0.010 | 0.702 (+0.370) | 0.273 (−0.059) | 0.273 (−0.059) | 0.273 (−0.059) |
| 4.11 | 0.317 | ±0.010 | 0.686 (+0.369) | 0.248 (−0.069) | 0.244 (−0.073) | 0.244 (−0.073) |

### Boattail increments, all 13 configurations pooled: mean (model − measured) · RMS · points inside tolerance

| Model | M 0.80–0.95 | M 0.975–1.05 | M 1.10–1.25 |
|---|---|---|---|
| Classic | −0.055 · 0.066 · 2/48 | −0.075 · 0.088 · 2/39 | −0.058 · 0.071 · 4/44 |
| Kbf | −0.055 · 0.066 · 2/48 | −0.075 · 0.088 · 2/39 | −0.058 · 0.071 · 4/44 |
| Supersonic | −0.043 · 0.053 · 8/48 | +0.058 · 0.092 · 13/39 | +0.114 · 0.135 · 0/44 |
| Hybrid | −0.051 · 0.061 · 3/48 | −0.001 · 0.055 · 14/39 | +0.103 · 0.123 · 0/44 |

## What the new cells say

**1. The small-model cell (`r100-23`) — all four models over-predict this article's drag.**
At M0.85: Classic +0.206 (+68 %), Kbf, Supersonic and Hybrid +0.143 (+47 %). At M1.20: Classic
+0.110, Kbf +0.049, Supersonic and Hybrid +0.136. The measured rise from M0.85 to M1.20 is
+0.196; Classic and Kbf rise +0.100 and +0.102, Supersonic and Hybrid +0.189. Kernel breakdown
at M0.8 (sea level): Classic friction 0.230, pressure 0.134, base 0.106; Kbf friction 0.290,
pressure 0.043, base 0.106. The sheet's own computed friction drag (body plus fins, all
turbulent) is 0.252 at M0.8, which leaves about 0.05 of the measured 0.303 for pressure plus
base — against a kernel base term of 0.11 on its own. Classic's subsonic jump is visible
between M0.85 and M0.90: +0.061 in the model, +0.006 measured. The direction is the one the
register expected (more drag than measured means a lower predicted apogee, the safe side); the
register's M0.3 end of the question stays unanchored, because the sheet starts at M0.85.

**2. The plain-body cells (`r100-78/92/98-finned`) — all models high by 0.07–0.16 subsonic.**
Config 92 at M0.8: measured 0.278; Kbf 0.360 = friction 0.156 + base 0.203. The kernel's base
term plus its body friction (0.099) already exceeds the measured total, fins included. This is
the subsonic base-drag question (decision 73, measured and held on `wt/basedrag`; body drag C2
parked since 2026-09-04) seen on a second, independent article; this sitting changes no model.
The measured drag rise from M0.95 to M1.05 is +0.079 (92), +0.095 (78), +0.103 (98); Kbf gives
+0.029, +0.030, +0.029, Supersonic +0.045 on 92, Classic +0.019. Caution: configs 92 and 98
measure 0.278 and 0.280 at M0.8 although 98 carries 1.5 d more cylinder (the kernel adds about
0.015 of friction for it) — configuration-to-configuration scatter of about 0.01–0.015,
consistent with the report's stated ±0.01.

**3. The boat-tailed-body cells (13 increments)** reproduce the 2026-10-08 research comparison:
Classic and Kbf overstate the boattail's subsonic saving by about 0.055 and stay low by about
0.06 above M1.05; Supersonic and Hybrid overstate the boattail's drag above M1.05 by 0.10–0.11.
Hybrid is closest through the rise (mean −0.001, 14 of 39 points inside). Curved and conical
pairs with the same end radii get identical kernel pressure and base drag (a model limitation
recorded in `docs/research/Boat-tails/fig10-app/README.md`).

**4. Basic Finner, tunnel series (`basic-finner-fig23`).** Subsonic, Kbf, Supersonic and Hybrid
sit within 0.003–0.014 of the tunnel at M0.60–0.80 (M0.80 inside ±0.010); Classic is −0.029 at
M0.60 and +0.108 at M0.80. Through M0.93–1.38 the three non-classic models are 0.07–0.26 low;
from M1.75 up they are 0.02–0.08 low, and Classic 0.25–0.37 high, matching what the gated
free-flight series already shows. **Caution:** the tunnel's peak (1.013 at M1.076) is 0.145
above the gated free-flight value at M1.056 (0.868). At the peak the two measurements disagree
by more than the models' error against the free-flight one, so the transonic tunnel points are
not evidence on their own.

## Not done, and why

- **Aerobee 350 — BLOCKED on geometry.** Karbon's Figure 24 gives CP from the nose tip
  (Barrowman 9.931 m, wind tunnel 10.008 m, his CFD 10.113 m, RockSim 10.121 m) but no vehicle
  geometry, no vehicle length and no test Mach; the drawing shows only the aft end with no scale.
  The geometry is in his reference [3], Barrowman & Barrowman, *The Theoretical Prediction of
  the Center of Pressure*, NARAM-8 R&D (1966), which is not in the repo or `docs/`. Retrieve it,
  then the fixture is a CP cell (`cpOverL` cannot be used without a length; a new absolute-CP
  quantity would be needed, or the length from the 1966 report).
- **The Finner figure's DRDC source** (behind Bhagwandin & Sahu's Figure) is not chased; that
  is what a gate would need.
- **A finless plain body** is still absent: every R-100 article carries fins, and NASA TM X-1771
  (Cajun) is not on disk (and is a finned article too).
- **`arcas-long` `cd-rasaero-parity` re-read from RASAero's export** (same register section):
  no RASAero aero-plot export for ARCAS-Long was found in `docs/`; the register does not name
  the file.
- **Second, independent reads** of Figure 10, config 23 and Figure 23 — the step that would let
  the R-100 cells gate.

## Commands and proof

```
npm run build -w @online-openrocket/engine
node validation/score.mjs [--kbf | --supersonic | --hybrid]
node --test validation/score.test.mjs      # 6 tests, all pass
```

Byte-identity: each model's scorecard was captured before the change; after it, the first 586
lines (every pre-existing cell, through the last row before *Summary*) compare identical with
`cmp` in all four models, and the summary line is unchanged. New tests: the coverage cells are
all `gate: false`, every increment fixture is finless, the finned fixtures carry the drawn
type-A fins, and for three increment cells at M0.90 and M1.20 in every model the printed model
value equals a direct kernel difference and the printed tolerance is the point's own. Mutations
(each reverted): flipping the `cdDelta` sign, ignoring per-point tolerances, and sweeping the
reference as the cell's own body each fail 4 of the 6 tests.
