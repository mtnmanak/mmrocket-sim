# Validation harness (RASAero #1 supersonic/hypersonic build)

Scores the JS engine against **measured** wind-tunnel and free-flight anchor
datasets. Provenance, tolerances, and every caveat live in
`docs/research/validation-anchors-2026-08-03.md`; the target physics lives in
`docs/research/rasaero-supersonic-spec-2026-08-03.md`.

## Run it

```
npm run build -w @online-openrocket/engine   # harness imports packages/engine/dist
node validation/score.mjs                    # markdown scorecard to stdout
node validation/score.mjs --strict           # exit 1 unless every gate point passes
```

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
- `baseline-classic-2026-08-04.md` — the frozen scorecard of the CLASSIC
  Extended Barrowman kernel before any supersonic work: **8/137 gate points**

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
