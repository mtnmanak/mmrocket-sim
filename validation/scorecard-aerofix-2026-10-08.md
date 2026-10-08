# Scorecard: upstream aerodynamic fixes, all four models (2026-10-08)

The anchor set is unchanged: 191 gates, and no tolerance was touched. The kernel
changed (branch `wt/aerofix`, Eric's decision 70, applied in every model). Three
upstream OpenRocket fixes went in:

- **#3196 / PR #3262 (with #3235 superseded):** a bounded fin and tube-fin CP along the
  MAC. Below AR*beta 0.84 it sits at the quarter chord, a Hermite bridge runs from 0.84
  to 1, and the source formula applies from 1 up. In the transonic band the CP comes from
  exact endpoint data, replacing the rounded fifth-order polynomial. Tube fins no longer
  sit at the tube's leading edge between M0.5 and M2.
- **#3236:** the transonic fin CNa interpolation takes the lower-endpoint slope from
  `CNA_SUBSONIC` rather than from `mach`.
- **#3237:** the body skin-friction fineness ratio is taken on the diameter, so body
  friction is multiplied by (1+R/L)/(1+R/2L).

## Gate counts

Main's committed `orkengine.mjs` (md5 270fc0d6...) and the branch artifact (md5
d9bb4cdc...) were each swapped into `packages/engine/vendor/` and scored with
`node validation/score.mjs [--kbf|--supersonic|--hybrid]`. The dist is unchanged.

| model | before | after |
|---|---|---|
| Classic | 13/191 (6.8%) | 13/191 (6.8%) |
| Rogers Kbf (the shipped default) | 21/191 (11.0%) | **22/191 (11.5%)** |
| Supersonic | 77/191 (40.3%) | **78/191 (40.8%)** |
| Hybrid | 73/191 (38.2%) | **74/191 (38.7%)** |

## Every verdict that changed

| model | row | before | after |
|---|---|---|---|
| Classic | arcas-long / cd-supersonic-tunnel M1.8 | PASS (+0.0196) | FAIL (+0.0217) |
| Classic | rma53d02 / cd0-freeflight M1.06 | FAIL (-0.0442) | PASS (-0.0411) |
| Kbf | basic-finner / cp-freeflight M1.056 | FAIL (1.54) | PASS (1.4675) |
| Supersonic | rma53d02 / cd0-freeflight M1.53 | FAIL (-0.0401) | PASS (-0.0374) |
| Hybrid | rma53d02 / cd0-freeflight M1.53 | FAIL (-0.0401) | PASS (-0.0374) |
| all four | hb2 / ca0-vti-transonic M1.1 (informational, never counted) | off (-0.0538) | ok (-0.0494) |

Classic's count is unchanged because one gain cancels one loss. The ARCAS-Long M1.8
loss is #3237: body friction rises, and that row was already high.

Of the 191 gated rows, this many moved closer to or further from their anchor:

| model | closer | further | unchanged |
|---|---|---|---|
| Classic | 54 | 80 | 57 |
| Kbf | 96 | 36 | 59 |
| Supersonic | 56 | 78 | 57 |
| Hybrid | 63 | 71 | 57 |

On the rows that moved, most of the movement is #3237's added body friction. That
pushes CD up everywhere: rows that were low get closer and rows that were high get
further away. Kbf gains most because its gated rows run low at M0.95 and above.

`node --test validation/score.test.mjs` passes 5/5 on the new artifact. The R-100
Fig. 13(a) cdAfterbody rows exclude friction by construction.
