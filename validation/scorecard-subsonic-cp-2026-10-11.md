# TN D-4013 subsonic CP added as informational anchors — 2026-10-11

Board Tier 0 row 85 (*Kbf ships half the Rogers method*). Gate set unchanged at 191; every
pre-existing scorecard line byte-identical in all four models. Gate scores on the v0.178
kernel: **Classic 13/191 · Rogers Kbf 22/191 · Supersonic 83/191 · Hybrid 79/191** — the same as
before this change.

## 1. What was added

`arcas-short` and `arcas-long` each carry new `gate: false` `cpPctL` series: the TN D-4013
fins-on (δ_F = 0) centre of pressure, −2° ≤ α ≤ 2°, roll 0°, Re 3.0 × 10⁶/ft (the fixtures'
`machAlt` tables already match it), at **M0.60, 0.80 and 0.90** — the Machs the report
actually tested below M0.95 (p.4: *"0.60, 0.80, 0.90, 1.00, and 1.20"*, Short also 0.95). The
figures' M0.70 and M0.85 values are fairings between test points and are not carried.

One series per independent read of the same figure, because the reads disagree by more than the
data's own accuracy:

| Model | Mach | deck read | 2026-08-03 eyeball read | 2026-10-11 scan read |
|---|---|---|---|---|
| Short (Fig 11) | 0.60 | 75.7 | 74.5 | 74.60 |
| | 0.80 | 72.6 | 71.5 | 70.82 |
| | 0.90 | 70.4 | 71.0 | 71.52 |
| Long (Fig 12) | 0.60 | 76.6 | — | 76.65 |
| | 0.80 | 75.8 | — | 75.52 |
| | 0.90 | 76.2 | — | 76.12 |

- **deck read** (`cp-subsonic-tunnel-deckread`): the wind-tunnel markers C. E. Rogers plotted on
  slides 11/12 of *RASAero II Comparisons with ARCAS CP and CD Data*, read in
  `docs/research/validation-anchors-2026-08-03.md` §1.4 (markers ±0.15 %L).
- **eyeball read** (`cp-subsonic-tunnel-agentread`, Short only): the project's own read of
  Fig 11 in the same §1.4. The 2026-08-25 pixel pipeline matched it to about 1 %L
  (`scorecard-finsoff-figs-2026-08-25.md` §2.3(b)); nobody had read Fig 12's x_cp panel.
- **scan read** (`cp-subsonic-tunnel-scanread`): a pixel read of the NTRS page scans
  (PDF pp. 62/63) against each panel's own printed gridlines —
  `validation/digitize/read-d4013-xcp.py`, which prints these numbers from the report PDF.
  Gridline fit rms 0.23 px (Fig 11) / 0.16 px (Fig 12), i.e. 0.02 / 0.01 %L; the read is
  the lower (solid, δ_F = 0) stroke — the dashed δ_F = 2 curve lies above it and is
  interrupted, which is how the two were told apart column by column.

On the Short model the deck read is the outlier: 1.1–1.2 %L aft of both report reads at M0.60 and
1.8 %L aft of the scan read at M0.80. On the Long model the deck and scan reads agree to 0.3 %L.

## 2. Tolerance: ±0.5 %L, from the report's stated accuracy

The report states no x_cp accuracy. It states C_N ±0.03 and C_m ±0.05 (p.4), with moments
about 70 %L and C_m on S·d (p.2), so x_cp = 70 − (100/f)·C_m/C_N with f = 18.2 (Short) or 23.8
(Long). Taking both slopes across the stated −2°…+2° window with the stated error at each end,
at the measured C_Nα at M0.60 (≈0.23/deg Short, Fig 7(b); ≈0.215/deg Long, Fig 9(b)), combined root-sum-square
(a linear sum would give 0.63–0.67 %L):
**0.47 %L on both models**, used as ±0.5. It is tighter than the read-to-read spread on the
Short model, which is why every read is kept and none gates.

## 3. Result (model CP, %L; α = 0, tunnel Re)

| Model | Short M0.60 / 0.80 / 0.90 | Long M0.60 / 0.80 / 0.90 |
|---|---|---|
| Classic Extended Barrowman | 76.09 / 76.94 / 77.49 | 76.66 / 77.48 / 78.00 |
| Rogers Kbf — the app default | 80.26 / 80.91 / 81.33 | 81.08 / 81.71 / 82.11 |
| Supersonic | 78.77 / 79.54 / 80.04 | 79.45 / 80.19 / 80.66 |
| Hybrid | 80.26 / 80.91 / 81.15 | 81.08 / 81.71 / 81.90 |

At M0.60, against the scan read (deck read in brackets), in calibers (Short 1 cal = 5.49 %L,
Long 4.20 %L):

| Model | Short | Long |
|---|---|---|
| Classic | +0.27 (+0.07) | +0.00 (+0.01) |
| Rogers Kbf | **+1.03 (+0.83)** | **+1.05 (+1.07)** |
| Supersonic | +0.76 (+0.56) | +0.67 (+0.68) |

Positive is aft of the tunnel: the model shows **more static margin than the tunnel measured**.
Every model is outside ±0.5 %L at M0.80–0.90 on the Short model, where the tunnel CP drifts
4 %L forward between M0.60 and M0.85 and no subsonic Barrowman-class model moves at all;
the Long model shows none of that drift.

For the CP the app displays (M0.3, not a tunnel Mach): Classic 75.52 / 76.07 %L, Kbf
79.82 / 80.63 %L (Short / Long).

## 4. Proof nothing else moved

Each model was scored before and after (`node validation/score.mjs [--kbf|--supersonic|--hybrid]`,
engine built from this tree). `diff before after` shows **0 lines removed or changed and
50 lines added** in each of the four models — the five new tables, nothing else — and the gate
line is unchanged. `validation/score.test.mjs` pins the new series (informational, tested Machs
only, ±0.5, every read kept) and, per model, that each new row is the kernel's own CP at that
Mach under the cell's `machAlt`.

## 5. What it bears on

Board row 85: the shipped Rogers Kbf builds the fin-carryover half of the Rogers method and
not the body-tube cylinder term, which would move CP forward. The formula for that term is not
published (row 85's research, `open-items.md`); these cells are the measurement any future
version of it would be scored against. Read with Karbon's CFD (42 mm, L/d ≈ 11, M0.3), which
puts truth aft of Kbf instead — a different regime; do not merge the two.

## 6. Reproduce

```
npm run build -w @online-openrocket/engine
node validation/score.mjs --kbf          # and '', --supersonic, --hybrid
node --test validation/score.test.mjs
python validation/digitize/read-d4013-xcp.py <NTRS 19670020050.pdf>
```
