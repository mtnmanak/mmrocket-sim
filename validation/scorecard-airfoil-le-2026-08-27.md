# Scorecard — the sharp-AIRFOIL leading-edge term moves into Kbf (v0.075)

**Date:** 2026-08-27
**Change:** `FinSetCalc.calculatePressureCD` — the sharp-airfoil branch is now gated on
`(supersonicAero || rogersKbf)` rather than `supersonicAero` alone.
**Ruling:** the owner's, 2026-08-27, after the "subsonic only" variant was measured and
rejected.

---

## The headline finding: the harness cannot see this change

| Model | Before | After |
|---|---|---|
| Classic (parity) | 10/175 | **10/175** |
| Rogers Kbf (default) | 17/175 | **17/175** |
| Supersonic | 71/175 | **71/175** |

Not "no regression" — **no signal at all**. All four finned fixtures
(`arcas-long`, `arcas-short`, `basic-finner`, `rma53d02`) name an `airfoilSection`, so with
`rogersKbf` on they short-circuit at the section-model gate above and never reach the branch
that changed. The remaining fixtures have no fins.

That is a gap in the harness, not evidence for or against the change. **A fixture with an
airfoil cross-section and NO named section is the missing coverage**, and it is cheap to add:
the geometry already exists, it just needs the section field deleted.

## Why not "subsonic only"

The first proposal was to gate the branch below Mach 0.9 and leave the transonic/supersonic
range on the classic term. Measured on a 4-fin sport geometry, that produces:

| Mach | fin pressure CD |
|---|---|
| 0.90 | 0.0006 |
| 0.91 | 1.2082 |

A **step of +1.21** at the transonic onset. The classic transonic branch is
`cd = 1 − 1.785·(M − 0.9)`, which starts at exactly 1.0 — it is only meaningful as the
continuation of the subsonic `(1 − M²)^−0.417` rise it follows. Remove the base and the top
floats. A discontinuity in CD at the most consequential Mach number of the flight is worse for
an adaptive-step RK4 than the error it removes, so the two halves are not separable.

After the change the same sweep is smooth: largest adjacent step over 0.01-Mach samples through
the transonic is **0.0426**, an ordinary transonic rise.

## Containment (artifact vs artifact, M0.1–3.0, step 0.1)

Four cross-sections × three models, total power-off CD:

| Cross-section | Classic | Kbf | Supersonic |
|---|---|---|---|
| airfoil, **no** named section | identical | **moved** | identical |
| airfoil + named section | identical | identical | identical |
| square (the `FinSet` default) | identical | identical | identical |
| rounded | identical | identical | identical |

One case moves. Desktop parity is untouched, the supersonic model is untouched, and a fin is
SQUARE unless someone changes it.

JVM↔TeaVM differential: **309 lines** clean (194 bit-identical, 115 within ULP tolerance).

## Magnitude on real files (total CD, Kbf)

| Design | M0.3 | M0.5 | M0.8 | M0.9 | M1.2 | M2.0 |
|---|---|---|---|---|---|---|
| `Mach2.trf.ork` | −0.4 % | −1.2 % | −4.6 % | −8.2 % | −6.3 % | −12.0 % |
| `LEM-IV.ork` | −0.6 % | −1.8 % | −6.8 % | −11.5 % | −8.8 % | −15.7 % |
| `CT-Concep98-External-Fincan.ork` | −0.3 % | −0.9 % | −3.5 % | −6.2 % | −4.4 % | −9.1 % |
| `LEM-M2B.ork` | — | — | — | — | — | — |

`LEM-M2B` is unchanged: it carries no airfoil-cross-section fins. Both `Mach2.trf.ork` and
`LEM-IV.ork` carry `<crosssection>airfoil</crosssection>` with **no** `<airfoilsection>`, which
is what every desktop-authored `.ork` looks like — `airfoilsection` is our own extension tag.

## Flight level

A Mach 1.9 three-fin probe on a J-class motor, Kbf:

| | Before | After | Δ |
|---|---|---|---|
| Apogee | 2226.6 m | 2701.5 m | **+21.3 %** |
| Max velocity | 578.0 m/s | 655.7 m/s | +13.4 % |
| Max Mach | 1.711 | 1.942 | +13.5 % |

The same probe with SQUARE fins: **1826.1 m on both kernels**, bit-identical.

## The unresolved part, stated rather than buried

This moves Kbf **away** from one anchor and **toward** the other, and they have disagreed since
Phase 2:

- **Buckeye apogee** — Kbf already predicted 20,154 ft against 18,006 ft GPS (+11.9 %). Less
  drag raises predicted apogee, so this makes that disagreement worse.
- **Buckeye GPS-derived Cd trace** — the same flight says Kbf reads Cd high by +22/+28/+42 %
  through the supersonic range. This moves squarely toward it.

Both cannot be satisfied by a drag change alone, which is itself informative: if the drag is
right and the apogee is still over-predicted, the remaining error is somewhere else in the
flight (mass, thrust curve, or the descent). Worth chasing separately.

**Standing rule observed:** no tolerance was widened, and no fixture was changed to make
anything pass. The scores are unchanged because the harness is blind here, and that is recorded
above rather than presented as a result.
