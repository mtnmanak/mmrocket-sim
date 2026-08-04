# Validation harness (RASAero #1 supersonic/hypersonic build)

Scores the JS engine against **measured** wind-tunnel and free-flight anchor
datasets. Provenance, tolerances, and every caveat live in
`docs/research/validation-anchors-2026-08-03.md`; the target physics lives in
`docs/research/rasaero-supersonic-spec-2026-08-03.md`.

## Run it

```
npm run build -w @online-openrocket/engine   # harness imports packages/engine/dist
node validation/score.mjs                    # classic Extended Barrowman (flag off)
node validation/score.mjs --supersonic       # the opt-in supersonic aero model
node validation/score.mjs --strict           # exit 1 unless every gate point passes
```

## Scoreboard

| Model | Gate points | Scorecard |
|---|---|---|
| Classic Extended Barrowman | **8/137 (5.8%)** | `baseline-classic-2026-08-04.md` |
| + Phase 1 (supersonic CP/CNα) | **52/137 (38.0%)** | `scorecard-phase1-2026-08-04.md` |
| + Phase 2 (drag fidelity) | **68/137 (49.6%)** | `scorecard-phase2-2026-08-04.md` |

Phase 2 (same flag): sharp-airfoil fins lose the spurious blunt-LE drag plateau
and get thin-airfoil wave drag; boattails get supersonic wave drag; nose wave
drag decays past its table end; base drag gets the vacuum-limit cap; fin-body
junction interference (+80% of fin friction, from the D-4013 fins-on/off
increment); fixtures polished + tunnel-Re-matched (`machAlt`). ARCAS-Short
supersonic CD 7/7, Long 5/6, subsonic green. Remaining red, documented: the
transonic peak band M0.95–1.2 (tunnel shows fin transonic drag ≈4× subsonic;
RASAero underpredicts these same anchors by 0.10–0.22), Finner Cx0 (wedge
blunt-TE fin base drag → feature #4 airfoils), HB-2 (flare/bluntness →
hypersonic phase).

Phase 1 (opt-in `supersonicAero` flag — corrected supersonic fin normal force,
NACA-1307 interference, Mach-dependent nose CNα; see LEDGER.md) turns the CP
series green: ARCAS supersonic CP 9/9 gated on both configs (matching the
tunnel where RASAero itself diverges above M3.5), Finner CP 17/23 and CNα
16/23 (remaining fails: the transonic band M1.05–1.4, whose measured lift
overshoot is Phase-2 physics, plus marginals inside free-flight shot scatter).
Still red by design: every CD series (drag is Phase 2), HB-2 CNα (the flare
body needs Phase-2+/hypersonic treatment).

Scoring conditions: Basic Finner scores at α = 2° (its free-flight fits ride
at finite yaw — see the `_aoaNote` in anchors.json); everything else at α = 0.

After any engine rebuild, regenerate and eyeball the scorecard:

```
node validation/score.mjs > validation/scorecard.md
```

## Files

- `fixtures/*.json` — RocketTree fixtures for the tunnel models (each file's
  `_notes` records its modeling approximations):
  - `arcas-short.json` / `arcas-long.json` — NASA TN D-4013/D-4014 sounding
    rocket, ogive + swept fins, data to M4.63
  - `basic-finner.json` — Army-Navy Basic Finner, cone + rectangular fins,
    free-flight data to M4.47
  - `hb2.json` — AGARD HB-2 blunt cone-cylinder-flare, finless body anchor to
    M10 (geometry approximated pending nose-bluntness support)
- `anchors.json` — machine-readable anchor tables (units/conventions in its
  `_readme`; `gate: false` series are informational)
- `score.mjs` — builds each fixture, runs `dragSweep` (which emits CD
  power-off/on + CP + CNα per Mach), interpolates at anchor Machs, grades
- `baseline-classic-2026-08-04.md` — the classic Extended Barrowman scorecard
  (flag off, regenerated whenever the harness changes): **8/137 gate points**
- `scorecard-phase1-2026-08-04.md` — the Phase-1 supersonic-model scorecard

## Baseline reading (why almost everything fails, and why that's fine)

The harness exists to turn red rows green, phase by phase. The classic kernel:

1. **CP travel is wildly overpredicted, not just frozen.** Body CP never reads
   Mach (frozen at its M1 value near the nose) while fin CNα falls off with
   the Busemann 4/β trend — so the *combined* CP races forward far faster than
   any tunnel shows (ARCAS: model 27 %L vs measured 57 %L at M4.63). Phase 1
   (supersonic body CNα/CP) attacks this from both ends.
2. **Supersonic CD is high by ~2×** at M3–4.6 (wave-drag extrapolation + the
   0.25/M base model + no per-shape fin thickness treatment).
3. **The transonic rise starts too early and peaks too low** vs the ARCAS
   tunnel (kernel rises from M0.8; tunnel peaks ≈0.685 at M1.05, kernel
   ≈0.61 at M1.1).
4. **Subsonic CD runs high** on the tunnel fixtures; part of this is the
   harness's known Re mismatch (kernel sweeps at ISA sea level, tunnels ran
   fixed Re/ft — see `anchors.json` `_readme`). Re-matching is a planned
   harness upgrade before drag-phase tuning is judged subsonic.

Keep gates honest: never widen a tolerance to make a phase pass — the
tolerances come from the datasets' own stated accuracies.

## Not yet in the harness

- MESOS / Aftershock II / GoFast end-to-end flight fixtures (need thrust-curve
  reconstruction + manual forum retrievals — see anchors doc §2/§6)
- Cajun (fin semispan not in our extract; retrievable from NASA TM X-1771)
- Power-on ΔCD series (Nike-Apache deck) — needs the fixture nozzle-exit data
- Reynolds matching (tunnel Re vs sea-level sweep)
