# TN D-4013 fins-on: tested-Mach gates and report-derived budgets — 2026-11-15

Tier 0 row 91; owner ruling of 15 November 2026. This implements the two harness changes
identified in `scorecard-finson-reread-2026-10-11.md` §7 items 1–2. Row 98 made no kernel
change. Anchor values, fixture geometry and every computed model number stay unchanged.

| Model | Before | After | Passing fairing gates removed | Tested gates PASS → FAIL |
|---|---|---|---|---|
| classic | 11/191 | **8/178** | 0 | 3 |
| kbf | 38/191 | **30/178** | 3 | 5 |
| supersonic | 80/191 | **68/178** | 7 | 5 |
| hybrid | 80/191 | **69/178** | 6 | 5 |

The denominator falls **191 → 178**: four untested Short Machs, the same four in its
sharp-airfoil copy, and five Long Machs. Read scores with their denominators; percentages
across revisions are not a measure of model improvement. These are coefficient checks,
not flights. The Short copy continues to count the same tunnel run through a second kernel path.

## 1. Tested Machs and informational fairing

TN D-4013 p.4 states that both models ran M0.60/0.80/0.90/1.00/1.20, with M0.95 on Short
only. That statement is recorded in `scorecard-finsoff-figs-2026-08-25.md` §1.1 and the
fins-on re-read §7 item 1. The anchors exactly matched the disputed Mach lists.

As for `cd0-finsoff-fairing`, the reads between tested Machs now sit in a separate
`cd-transonic-fairing` series with `quantity: cd`, `base: excluded`, `gate: false`,
`source` explaining the fairing, and the original `[mach, value]` points. Its ±0.03 band
is retained only as the old informational curve-read band, not a measurement accuracy.
All ten values per cell remain visible. Short-nosection copies both Short series.

## 2. Per-point uncertainty budget

The rule is the **root-sum-square, rounded upward** rule written in
`scorecard-finsoff-figs-2026-08-25.md` §3.1 and `anchors.json`’s Short fins-off
`_provenance` tolerance paragraph. Using the unrounded base term:

```
RSS = sqrt(0.004² + (0.01 × 0.4225)² + 0.004² + (0.003 × slope)²)
tolerance = ceil(1000 × RSS) / 1000
```

The first, second and fourth terms come from the report p.4 accuracy table; A_b/S =
0.65² = 0.4225 from Fig 1(b). Digitization ±0.004 is the bound established by the four
reads in the fins-off scorecard §2.2, retained by the fins-on re-read §2.

The old derivation specifies local slope but no discrete stencil. Here it is the larger
absolute adjacent secant of the full existing ten-point read curve, including fairing
reads; endpoints use the sole secant. This conservative choice avoids cancellation at
a peak. Slopes are CD per Mach; coefficients, Mach and tolerances are dimensionless.
This is a reproducible finite-difference estimate from the anchors, not a new pixel read.

Permanent calculator: `digitize/d4013-finson-budget.mjs`, beside the readers so future
anchor revisions can reproduce the budgets. It prints every gated budget and rejects
any result above the old ±0.03 rather than silently capping it. None exceeds ±0.03.

| Cell (Short also copied to Short-nosection) | Mach | Local slope | RSS | Written tolerance |
|---|---|---|---|---|
| arcas-short | 0.6 | 0.1370 | 0.007072450 | ±0.008 |
| arcas-short | 0.8 | 0.9060 | 0.007565590 | ±0.008 |
| arcas-short | 0.9 | 2.9140 | 0.011237134 | ±0.012 |
| arcas-short | 0.95 | 2.9140 | 0.011237134 | ±0.012 |
| arcas-short | 1 | 2.3440 | 0.009964921 | ±0.010 |
| arcas-short | 1.2 | 0.7800 | 0.007438160 | ±0.008 |
| arcas-long | 0.6 | 0.0700 | 0.007063620 | ±0.008 |
| arcas-long | 0.8 | 0.8020 | 0.007459186 | ±0.008 |
| arcas-long | 0.9 | 2.8240 | 0.011028391 | ±0.012 |
| arcas-long | 1 | 2.6500 | 0.010632644 | ±0.011 |
| arcas-long | 1.2 | 0.8620 | 0.007519177 | ±0.008 |

The fins-off gates remain at their existing ±0.008, including the deliberately tighter
Short M1.00 gate described in the old derivation. No existing tolerance is widened.

## 3. Every changed scored row

Each row below had tolerance ±0.03 and gated before. **Budget** means it remains gated
with the per-point report budget; **Fairing** means it is now informational with the
same ±0.03 band. P = PASS, F = FAIL, i = ok (info), o = off (info). Verdicts read before → after.
Every listed row changes its tolerance or gating; unchanged verdicts are shown too.

### arcas-short

| Mach | Anchor | Reason; after tolerance | Classic | Kbf | Supersonic | Hybrid |
|---|---|---|---|---|---|---|
| 0.6 | 0.295 | Budget; ±0.0080 | P → F | P → F | P → F | P → F |
| 0.7 | 0.3087 | Fairing; ±0.0300 | F → o | P → i | P → i | P → i |
| 0.8 | 0.3295 | Budget; ±0.0080 | F → F | P → F | P → F | P → F |
| 0.9 | 0.4201 | Budget; ±0.0120 | F → F | F → F | F → F | F → F |
| 0.95 | 0.5658 | Budget; ±0.0120 | F → F | F → F | F → F | F → F |
| 1 | 0.683 | Budget; ±0.0100 | F → F | F → F | F → F | F → F |
| 1.05 | 0.685 | Fairing; ±0.0300 | F → o | F → o | P → i | F → o |
| 1.1 | 0.666 | Fairing; ±0.0300 | F → o | F → o | P → i | P → i |
| 1.15 | 0.635 | Fairing; ±0.0300 | F → o | F → o | F → o | F → o |
| 1.2 | 0.596 | Budget; ±0.0080 | F → F | F → F | F → F | F → F |

### arcas-short-nosection

| Mach | Anchor | Reason; after tolerance | Classic | Kbf | Supersonic | Hybrid |
|---|---|---|---|---|---|---|
| 0.6 | 0.295 | Budget; ±0.0080 | P → F | P → F | P → F | P → F |
| 0.7 | 0.3087 | Fairing; ±0.0300 | F → o | P → i | P → i | P → i |
| 0.8 | 0.3295 | Budget; ±0.0080 | F → F | P → F | P → F | P → F |
| 0.9 | 0.4201 | Budget; ±0.0120 | F → F | F → F | F → F | F → F |
| 0.95 | 0.5658 | Budget; ±0.0120 | F → F | F → F | F → F | F → F |
| 1 | 0.683 | Budget; ±0.0100 | F → F | F → F | F → F | F → F |
| 1.05 | 0.685 | Fairing; ±0.0300 | F → o | F → o | P → i | F → o |
| 1.1 | 0.666 | Fairing; ±0.0300 | F → o | F → o | F → o | P → i |
| 1.15 | 0.635 | Fairing; ±0.0300 | F → o | F → o | F → o | F → o |
| 1.2 | 0.596 | Budget; ±0.0080 | F → F | F → F | F → F | F → F |

### arcas-long

| Mach | Anchor | Reason; after tolerance | Classic | Kbf | Supersonic | Hybrid |
|---|---|---|---|---|---|---|
| 0.6 | 0.348 | Budget; ±0.0080 | P → F | P → F | P → F | P → F |
| 0.7 | 0.355 | Fairing; ±0.0300 | F → o | P → i | P → i | P → i |
| 0.8 | 0.3714 | Budget; ±0.0080 | F → F | P → P | P → P | P → P |
| 0.9 | 0.4516 | Budget; ±0.0120 | F → F | F → F | F → F | F → F |
| 0.95 | 0.5928 | Fairing; ±0.0300 | F → o | F → o | F → o | F → o |
| 1 | 0.7253 | Budget; ±0.0110 | F → F | F → F | F → F | F → F |
| 1.05 | 0.7279 | Fairing; ±0.0300 | F → o | F → o | P → i | F → o |
| 1.1 | 0.698 | Fairing; ±0.0300 | F → o | F → o | F → o | P → i |
| 1.15 | 0.665 | Fairing; ±0.0300 | F → o | F → o | F → o | F → o |
| 1.2 | 0.6219 | Budget; ±0.0080 | F → F | F → F | F → F | F → F |

The tested gates that change verdict all change **PASS → FAIL**; none becomes PASS:

- classic: arcas-short M0.6 (model 0.3221, delta +0.0271, tolerance ±0.0080); arcas-short-nosection M0.6 (model 0.3221, delta +0.0271, tolerance ±0.0080); arcas-long M0.6 (model 0.3718, delta +0.0238, tolerance ±0.0080).
- kbf: arcas-short M0.6 (model 0.3102, delta +0.0152, tolerance ±0.0080); arcas-short M0.8 (model 0.3171, delta -0.0124, tolerance ±0.0080); arcas-short-nosection M0.6 (model 0.3102, delta +0.0152, tolerance ±0.0080); arcas-short-nosection M0.8 (model 0.3171, delta -0.0124, tolerance ±0.0080); arcas-long M0.6 (model 0.3588, delta +0.0108, tolerance ±0.0080).
- supersonic: arcas-short M0.6 (model 0.3092, delta +0.0142, tolerance ±0.0080); arcas-short M0.8 (model 0.3166, delta -0.0129, tolerance ±0.0080); arcas-short-nosection M0.6 (model 0.3092, delta +0.0142, tolerance ±0.0080); arcas-short-nosection M0.8 (model 0.3166, delta -0.0129, tolerance ±0.0080); arcas-long M0.6 (model 0.3578, delta +0.0098, tolerance ±0.0080).
- hybrid: arcas-short M0.6 (model 0.3102, delta +0.0152, tolerance ±0.0080); arcas-short M0.8 (model 0.3171, delta -0.0124, tolerance ±0.0080); arcas-short-nosection M0.6 (model 0.3102, delta +0.0152, tolerance ±0.0080); arcas-short-nosection M0.8 (model 0.3171, delta -0.0124, tolerance ±0.0080); arcas-long M0.6 (model 0.3588, delta +0.0108, tolerance ±0.0080).

## 4. Containment and the LEDGER

Loaded kernel artifact md5: `d0699d79db49401cf09bb0c9aac53a27`, untouched. In each model all 490
scored rows have exactly the same Mach, anchor, model and delta columns as before
(matching fairing rows back to their original series). Exactly **30 rows per model**
change their tolerance or verdict: ten each on Short, Short-nosection and Long.
No other scored row changes any displayed column. There is no flown-number change,
so no tester-flight corpus run is needed for this harness-only edit.

The LEDGER ×1.8 entry is **already corrected**: lines 704–710 distinguish the historical
14–39 % range from the re-read Short 14–62 % and Long 39–68 % ranges, explicitly at
M0.60–0.90. It is left unchanged. A fresh Kbf sweep, subtracting each matching fins-off
fixture from the fins-on fixture and dividing by the corresponding current anchor
increment, confirms those rounded ranges (measurements below). Long’s measured increment
includes the anchor-fairing difference, so it is an upper bound on fins alone.

| Cell | Mach | Tunnel increment | Kbf increment | Shortfall |
|---|---|---|---|---|
| arcas-short | 0.6 | 0.0736 | 0.0631320 | 14.22 % |
| arcas-short | 0.8 | 0.0986 | 0.0615735 | 37.55 % |
| arcas-short | 0.9 | 0.1590 | 0.0609364 | 61.68 % |
| arcas-long | 0.6 | 0.0989 | 0.0605124 | 38.81 % |
| arcas-long | 0.8 | 0.1194 | 0.0590130 | 50.58 % |
| arcas-long | 0.9 | 0.1853 | 0.0583926 | 68.49 % |

## 5. Reproduce and regression proof

```
node validation/digitize/d4013-finson-budget.mjs
node validation/score.mjs
node validation/score.mjs --kbf
node validation/score.mjs --supersonic
node validation/score.mjs --hybrid
node --test validation/score.test.mjs
node scripts/build-user-guide.mjs
```

Runtime: Node v24.19.0 on Eric_AW_2026. All four scorer commands exit 0 before and
after; existing failed gates still give `--strict` exit 1 (asserted by the tests).
The regression pins tested Machs, every tolerance, the preserved fairing reads, the
Short copy, all four score totals, printed tolerance overrides and informational verdicts.
It failed on the original unsplit anchors (exit 1). Restoring only Short M0.60’s old
±0.03 tolerance also failed it (exit 1); the fixed bytes were restored and verified
by matching git hash-object `42d91a0e3223e2f7c3c4b4c7188cacda0eb27507`.

`node --test validation/score.test.mjs`: exit 0, 12 passed, 0 failed. The zero-warning
lint command `npm run lint -- --max-warnings 0` also exits 0. The guide generator
also exits 0 (13 sections). Its required restoration command,
`git checkout -- packages/app/src/data/userGuide.ts`, is blocked: Git cannot create
`C:/git/online_open_rocket/.git/worktrees/row91/index.lock` (Permission denied), exit 1.
It was not retried or worked around. The generated file therefore remains modified;
Claude must restore it before integrating the source edits, then regenerate it during
the integration build. This is not the full Node 22 integration gate.

