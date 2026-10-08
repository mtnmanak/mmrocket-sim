# NASA TR R-100 Figure 13(a): informational afterbody anchors — 2026-10-07

Six new **informational** points (`gate: false`, reported and never counted),
all at Mach 1.2. No existing anchor, tolerance, gate, or scored row changed.
These results compare model coefficients with figure-read measurements; they
are not flown simulations or a ruling on the app's default aerodynamics.

## Source and geometry

William E. Stoney Jr., *Collection of zero-lift drag data on bodies of revolution
from free-flight investigations*, NASA TR R-100 (1961), Figure 13(a), PDF page 21
([NTRS record](https://ntrs.nasa.gov/citations/19630004995)). The six readings and
uncertainties below were supplied by the assignment: mean of independent Claude
and Gemini reads of a 300-dpi render, uncertainty = half their difference plus
reading resolution. This implementation did not re-digitize the figure. They
supersede the preliminary approximate reads for these points in the read-only
research context, `docs/research/Boat-tails/REPORT-2026-10-07.md` (main checkout).
Provenance is also carried in `anchors.json` and each fixture's `_notes`.

Helium-gun free flight, no sting; Reynolds number approximately 8–12 × 10^6 on
model length. C_D,A includes **afterbody pressure plus base drag**, excludes
friction and fins, and references maximum body cross-section. Sea-level ISA is
acceptable for this quantity because no friction coefficient enters the score.
This does not establish Reynolds independence of the real separated flow.

| Config | Afterbody | l_A/d | r_b/R | Tabulated A_b/A_max | Tabulated theta_b (deg) | C_D,A | Reading uncertainty |
|---|---|---|---|---|---|---|---|
| 82 | conical | 1.78 | 0.438 | 0.19 | 9.0 | 0.142 | ±0.007 |
| 83 | conical | 1.78 | 0.700 | 0.49 | 4.87 | 0.114 | ±0.005 |
| 101 | conical | 5.00 | 0.438 | 0.19 | 3.2 | 0.059 | ±0.005 |
| 100 | conical | 5.00 | 0.700 | 0.49 | 1.7 | 0.083 | ±0.005 |
| 92 | cylindrical (base only) | 3.50 | 1.000 | 1.00 | 0 | 0.205 | ±0.005 |
| 98 | cylindrical (base only) | 5.00 | 1.000 | 1.00 | 0 | 0.190 | ±0.005 |

All fixtures have diameter d = 1.50 in = 0.0381 m, maximum radius 0.01905 m,
and nose l_N/d = 7.13 (length 0.271653 m). The afterbody immediately follows
the nose: **no cylindrical midbody**. The real models had three fins, 1.8-in
root and 45-degree sweep; the fixtures omit them because this quantity excludes
fin drag. Configs 92/98 use a body tube for their cylindrical afterbody; the
other four use a conical transition. Length and radius ratios define geometry;
the rounded tabulated area ratios and angles are retained as provenance, not
used to impose inconsistent extra constraints. Polished finish and 1-mm walls
are fixture assumptions, not experimental measurements.

The full parabolic nose is `shape: "parabolic", shapeParameter: 1`.
`packages/app/src/tree/shapeProfile.ts` and OpenRocket's
`Transition.Shape.PARABOLIC` both use
`r/R = (2u - p*u^2)/(2 - p)`, u = x/l_N. Thus p = 1 gives exactly
`r/R = 2u - u^2`. `ComponentFactory.java` maps `parabolic` to that enum and
passes `shapeParameter` to `setShapeParameter` for both noses and transitions.

**Equation (1) is not used.** The research report leaves its interpretation
open: using the cone half-angle gives about 0.070 versus roughly 0.14 on its
short, r_b/R ≈ 0.44 check. Whether the angle definition or identification of
the plotted curves explains that discrepancy remains unresolved. No equation
fit or tolerance adjustment was substituted for the supplied figure readings.

## Scoring

`cdAfterbody = (fixture pressure CD - nose-only pressure CD + fixture base CD)
* refAreaScale`. The reference fixture retains the identical nose and removes
the afterbody transition, leaving the nose ending at full diameter. Both sweeps
use the same model flags, Mach grid (0.05 to 1.2 in steps of 0.025), zero angle
of attack, and sea-level conditions. Values are interpolated at the series Mach
using the existing scorer convention. No total-CD or friction-CD subtraction is
used. For the two cylindrical afterbodies, C_D,A is simply fixture base CD times
the scale. Both areas are the maximum-diameter cross-section, so
`refAreaScale = 1`. The scorer deliberately accepts only the supported two-part,
finless nose/afterbody topology for this quantity.

The tables reproduce the scorer's four-decimal output. Error is model minus
anchor, in dimensionless C_D,A units. `ok (info)` means within the supplied
reading uncertainty; `off (info)` means outside it. Neither counts as a gate.

## Classic Extended Barrowman

| Config | Anchor C_D,A | Kernel C_D,A | Error | Uncertainty | Result |
|---|---|---|---|---|---|
| 82 | 0.142 | 0.0400 | -0.1020 | ±0.0070 | off (info) |
| 83 | 0.114 | 0.1021 | -0.0119 | ±0.0050 | off (info) |
| 101 | 0.059 | 0.0400 | -0.0190 | ±0.0050 | off (info) |
| 100 | 0.083 | 0.1021 | +0.0191 | ±0.0050 | off (info) |
| 92 | 0.205 | 0.2083 | +0.0033 | ±0.0050 | ok (info) |
| 98 | 0.19 | 0.2083 | +0.0183 | ±0.0050 | off (info) |

## Rogers Kbf

| Config | Anchor C_D,A | Kernel C_D,A | Error | Uncertainty | Result |
|---|---|---|---|---|---|
| 82 | 0.142 | 0.0400 | -0.1020 | ±0.0070 | off (info) |
| 83 | 0.114 | 0.1021 | -0.0119 | ±0.0050 | off (info) |
| 101 | 0.059 | 0.0400 | -0.0190 | ±0.0050 | off (info) |
| 100 | 0.083 | 0.1021 | +0.0191 | ±0.0050 | off (info) |
| 92 | 0.205 | 0.2083 | +0.0033 | ±0.0050 | ok (info) |
| 98 | 0.19 | 0.2083 | +0.0183 | ±0.0050 | off (info) |

## Supersonic

| Config | Anchor C_D,A | Kernel C_D,A | Error | Uncertainty | Result |
|---|---|---|---|---|---|
| 82 | 0.142 | 0.3281 | +0.1861 | ±0.0070 | off (info) |
| 83 | 0.114 | 0.2108 | +0.0968 | ±0.0050 | off (info) |
| 101 | 0.059 | 0.1607 | +0.1017 | ±0.0050 | off (info) |
| 100 | 0.083 | 0.1450 | +0.0620 | ±0.0050 | off (info) |
| 92 | 0.205 | 0.2083 | +0.0033 | ±0.0050 | ok (info) |
| 98 | 0.19 | 0.2083 | +0.0183 | ±0.0050 | off (info) |

## Hybrid (experimental)

| Config | Anchor C_D,A | Kernel C_D,A | Error | Uncertainty | Result |
|---|---|---|---|---|---|
| 82 | 0.142 | 0.3281 | +0.1861 | ±0.0070 | off (info) |
| 83 | 0.114 | 0.2108 | +0.0968 | ±0.0050 | off (info) |
| 101 | 0.059 | 0.1607 | +0.1017 | ±0.0050 | off (info) |
| 100 | 0.083 | 0.1450 | +0.0620 | ±0.0050 | off (info) |
| 92 | 0.205 | 0.2083 | +0.0033 | ±0.0050 | ok (info) |
| 98 | 0.19 | 0.2083 | +0.0183 | ±0.0050 | off (info) |

Classic and Kbf coincide on these six points. Supersonic and Hybrid coincide
at M1.2, the upper end of the hybrid blend. All four conical cases are outside
the supplied uncertainty in every model. Cylinder 92 is within uncertainty in
every model; cylinder 98 is high in every model. These six informational
comparisons do not change the 191-point gate set.

## Exact commands and before/after proof

Runtime: Node v24.19.0, Windows x64, committed kernel artifact; no kernel rebuild.
`npm.cmd run build -w @online-openrocket/engine` exited **0** before the baseline
runs and compiled only the TypeScript engine wrapper.

All commands below ran before and after the addition; each strict exit **1**
comes from existing failing gates, not the new informational series. No run is
claimed to pass all gates.

| Command | Before exit | After exit | Gate points before = after | Existing output byte-identical |
|---|---|---|---|---|
| `node validation/score.mjs --strict` | 1 | 1 | 13/191 | yes |
| `node validation/score.mjs --kbf --strict` | 1 | 1 | 21/191 | yes |
| `node validation/score.mjs --supersonic --strict` | 1 | 1 | 77/191 | yes |
| `node validation/score.mjs --hybrid --strict` | 1 | 1 | 73/191 | yes |

For each model, the comparison removed only the newly appended `## r100-...`
sections (up to `## Summary`) from the after stdout, then compared the complete
remaining UTF-8 output to the before stdout. The header, all old informational
and gated series, every existing row and the summary are byte-identical. All
pre-existing anchor specifications also compare equal to `HEAD:validation/anchors.json`;
existing fixture files are unchanged. Matching SHA-256 hashes for before stdout
and after stdout with only the new sections removed:

| Model | Matching SHA-256 |
|---|---|
| Classic Extended Barrowman | `fb95588d778d63c8179c783f1f1cdd1d9617beb0d6381ebf2d6fe61aba1e8283` |
| Rogers Kbf | `19dc155d3d5acbbac6a6ddef8e9a1cb8f1662ac5c5a9885808ebc0461c02faa7` |
| Supersonic | `e686b3f65b06d04f16124fb3cde93134b335aaeb2594001d864ed2c2ed247868` |
| Hybrid (experimental) | `c36b8e428c33e127ff35149e93f2b8a977062d7aacdc5d568eb4e89637c2e783` |

`node --test validation/score.test.mjs` exited **0**, 5/5 tests passed: geometry,
reference diameter and length, all supplied readings and non-gating status, plus
four model-specific comparisons against independent direct single-Mach kernel
evaluations. The numerical assertion allows half the scorer's last printed
digit plus floating-point roundoff; no exact kernel result is hard-coded.
The test was first run without the addition (exit **1**, all five fail for
missing config 82). Reversing the nose-pressure subtraction to addition made
all four model checks fail (exit **1**, one geometry test passes); restoring
the subtraction returned 5/5 passing (exit **0**).

Raw before/after stdout, exit metadata, comparison hashes and mutation evidence
are retained in the task-local `.claude/r100-evidence/` directory. These are
local verification artifacts, not another published scorecard or work queue.
The full app/engine test suite, app typecheck, Java differential tests and
CI/deploy gates were not run for this validation-only change; integration
verification remains with the orchestrator.
