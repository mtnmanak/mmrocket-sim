# Scorecard note — LEM-IV input sweep: can bad data explain the residual? — 2026-08-29

**Change: none.** No anchor value, tolerance, fixture or kernel byte moved. This note records a
measurement that **retires the "we need a weighed liftoff mass" question** and bounds what is
left of the LEM-IV disagreement.

## Why it was run

`docs/testing/response-2026-08-29a.md` §6 measured LEM-IV on the v0.076 kernel and left the
residual pointing at *data*: as-flown liftoff mass, and whether that M1500G reload matched its
published RASP curve. The owner's answer (`issues-2026-08-29b.md` §3) is that the data mostly
does not exist — RSO weights are "close enough", not weighed to the gram, and *"this data may
not be widely recorded."*

So the question was inverted: instead of asking for the numbers, **ask how wrong they would
have to be.** Two observables, two candidate input errors, no new field data needed.

| Observable | As flown | Sim, default model (Rogers Kbf) |
|---|---|---|
| Apogee | 11,755 ft | 12,544 ft (**+6.7 %**) |
| Peak acceleration | 598–685 ft/s² | 526 ft/s² (**−12 % to −23 %**) |

The rocket as modelled: airframe **5.460 kg** (12.04 lb), loaded **10.356 kg** (22.83 lb),
length 2.280 m, ref. diameter 102.1 mm, 2.85 cal. Motor: M1500G from the local `rasp.eng`,
4.896 kg loaded / 2.631 kg propellant, **5,217 N·s** over 3.6 s.

## Method

The 2026-08-29 re-fly recipe, re-run inside vitest rather than a hand-bundled driver (happy-dom
supplies `DOMParser`, the app's own module graph supplies `importOrk`, `parseEng`,
`samplesToMotorSpec` and `engineTree`). Driver committed at
`packages/app/src/services/lemivSweep.test.ts` — env-gated, and it skips itself when the
local-only design file is absent, so CI never sees it. `LEMIV=1 npx vitest run
src/services/lemivSweep.test.ts` from `packages/app`.

Configuration `91154772-…f3` (the M1500G one, not the file's default), launch conditions from
the file's own `<simulation>` block (1.524 m rod, 0° from vertical, 2.2352 m/s wind, 3.048 m
site, lat 26.380273, dt 0.05). Baseline reproduces the response doc to the foot: **12,544 ft**.

Two one-parameter families, each physically motivated:

- **Burn rate at constant total impulse** — `times × s`, `thrusts ÷ s`. This is the ordinary
  reload variation: the same propellant, burning hotter and shorter (or cooler and longer) than
  the published curve. Impulse is conserved exactly, so it is a pure *shape* hypothesis.
- **Structural mass** — every structural mass in the tree × f, motor untouched. This is the
  "close enough" pad weight.

## Result 1 — burn rate explains the acceleration completely, and the apogee not at all

| Burn | Apogee | vs measured | Peak a | in the 598–685 band? |
|---|---|---|---|---|
| ×1.00 (published) | 12,544 ft | +6.7 % | 526 ft/s² | no, low |
| ×0.90 | 12,503 ft | +6.4 % | 592 ft/s² | just below |
| **×0.85** | **12,483 ft** | **+6.2 %** | **630 ft/s²** | **yes, mid-band** |
| ×0.80 | 12,461 ft | +6.0 % | 674 ft/s² | yes, high |
| ×0.70 | 12,417 ft | +5.6 % | 781 ft/s² | no, high |
| ×0.60 | 12,372 ft | +5.3 % | 926 ft/s² | no |
| ×0.50 | 12,325 ft | +4.9 % | 1,131 ft/s² | no |

A burn **10–20 % shorter than published** puts peak acceleration exactly in the measured band —
an unremarkable reload variation — and moves apogee by **0.7 % of the 6.7 % gap.**

## Result 2 — mass moves the two observables in opposite directions

| Structure | Apogee | vs measured | Peak a |
|---|---|---|---|
| ×0.90 | 12,740 ft | +8.4 % | 556 ft/s² |
| ×0.95 | 12,644 ft | +7.6 % | 541 ft/s² |
| ×1.00 | 12,544 ft | +6.7 % | 526 ft/s² |
| ×1.05 | 12,439 ft | +5.8 % | 512 ft/s² |
| ×1.10 | 12,332 ft | +4.9 % | 499 ft/s² |
| ×1.20 | 12,127 ft | +3.2 % | 475 ft/s² |

Every kilogram that helps the apogee hurts the acceleration. There is no mass at which both
agree.

## Result 3 — solved: how heavy would the airframe have to be?

Bisected for the structural factor that lands the measured apogee exactly, then priced in
acceleration:

| Case | As modelled | Structure needed | Peak a there |
|---|---|---|---|
| Published curve, Kbf | 12,544 ft / 526 ft/s² | **×1.404** | 431 ft/s² |
| Burn ×0.85, Kbf | 12,483 ft / 630 ft/s² | **×1.359** | 528 ft/s² |
| Published curve, Supersonic | 12,155 ft / 526 ft/s² | ×1.348 | 442 ft/s² |
| Burn ×0.85, Supersonic | 12,036 ft / 630 ft/s² | ×1.271 | 550 ft/s² |

In the best case — the burn correction already applied and the Supersonic model — the airframe
would have to weigh **6.94 kg instead of 5.46 kg**, i.e. **+1.48 kg (+3.3 lb) on a 12.0 lb
airframe, +14 % on a 22.8 lb liftoff weight.** On the default model it is **+2.0 kg (+4.3 lb),
+19 % liftoff.** And taking that mass costs the acceleration agreement the burn correction had
just bought.

## Ruling

1. **The as-flown-mass question is closed, and closed negatively.** A pad weight "close enough"
   for an RSO is off by ounces, not by three to five pounds on a twenty-three pound rocket. The
   weight cannot be the explanation, so not having it is no longer a blocker. Do not re-ask for
   it; do not gate anything on it.
2. **The peak-acceleration deficit is explained without new data** — a burn 10–20 % shorter than
   the published RASP curve, at the same impulse, lands it mid-band. That is a motor-data
   hypothesis, not a physics defect, and it is the *only* one of the two that data uncertainty
   can carry.
3. **What is left is a real modelling residual, now bounded:** with the acceleration observable
   satisfied, apogee is still **+6.2 % on Rogers Kbf and +2.4 % on Supersonic**. Neither mass
   nor thrust-curve shape reaches it. The next hypotheses have to come from drag, the descent /
   deployment model, or the atmosphere — not from the flight card.
4. **Direction of travel, noted but NOT counted:** Supersonic sits 3.8 points closer on this
   anchor once the burn correction is applied. LEM-IV is an existing anchor, not a new paired
   flight — **the aero-default tally stays at 2 of the 5 it needs.**

## Honest limits of this measurement

- The burn-rate family is one hypothesis about how a real reload differs from its published
  curve; a real deviation is not a uniform time scaling. It is the right family for "hotter and
  shorter", and the wrong one for a curve that is off only at ignition or only at tail-off.
- Both families were swept independently. A joint (mass, burn) solve was run only at the
  bisection points in Result 3; the qualitative conclusion does not depend on it, since the two
  gradients have opposite signs on the acceleration.
- Structural scaling multiplies every mass in the tree, including the two overridden stage
  masses, so it scales the pinned figures rather than the parts underneath them. That is the
  right model for "the whole airframe is heavier than the file says".
- The apogee comparison uses the sim's `maxAltitude`. Nothing here re-examines how the 11,755 ft
  was recorded.
