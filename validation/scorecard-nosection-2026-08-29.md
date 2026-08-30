# Scorecard — the sharp-airfoil (no named section) cell — 2026-08-29

**Change:** anchors + fixtures only — `validation/fixtures/arcas-short-nosection.json` and the
`arcas-short-nosection` cell in `anchors.json`. **No kernel change**: the engine artifact is
untouched (`packages/engine/vendor/orkengine.mjs` md5 `f4dfe1d7a6fa39b68a3c88fd1fa6e00b`,
unchanged from v0.075/76). **No tolerance was widened and no fixture was changed to pass** —
the anchor values and tolerances are copied verbatim from `arcas-short`, whose own scorecards
derived them from the datasets' stated accuracies.

**What it closes:** the gap `scorecard-airfoil-le-2026-08-27.md` recorded and the owner ordered
closed (issues-2026-08-29a: "what do we need to do to close this gap" → this). All four finned
fixtures name an `airfoilSection`, so they short-circuit at the named-section branch
(`FinSetCalc.java:1034`) and the harness scored 10/17/71 identically before and after v0.075
moved the default model's Mach-2 CD by 9–16 %. This cell is the same ARCAS Short geometry with
the three section extension tags deleted — `crossSection: "airfoil"` and nothing more, which is
exactly what a desktop-authored `.ork` looks like — so it takes the v0.075 sharp-airfoil branch
(`FinSetCalc.java:1074`), the most-flown fin path in the app.

## Headline

| Model | Before (175 gates) | After (191 gates) | New-cell gates passed (of 16) |
|---|---|---|---|
| Classic | 10/175 (5.7 %) | 13/191 (6.8 %) | 3 — M0.60, M0.95, M1.80 |
| **Rogers Kbf (default)** | 17/175 (9.7 %) | 21/191 (11.0 %) | 4 — M0.60–0.90 (all subsonic) |
| Supersonic | 71/175 (40.6 %) | 77/191 (40.3 %) | 6 — M0.60–0.90, M1.05, M4.65 |

Percentages across anchor revisions are not comparable (standing rule); the per-cell rows below
are the comparable quantity.

## Integrity proofs (all three run on this revision)

- **Every pre-existing row is byte-identical** in all three models — the diff between the
  before/after score outputs, with the new cell and the Summary line stripped, is empty for
  classic, Kbf and supersonic. Adding the cell moved nothing else.
- **The clone's classic rows are byte-identical to the parent's classic rows** — classic never
  reaches either flag-gated section branch, so this is the construction proof that the two
  fixtures differ only by the section tags. (It is also why classic "gains" 3 gates: they are
  the parent's own passing rows counted on the second cell — the double-gating tension,
  recorded below.)
- **Kbf and Supersonic rows differ from the parent's**, as they must: the branch under test
  fires only for them.

## What the cell measures — the numbers

**Rogers Kbf, the shipped default, on the desktop-import path:**

- **Subsonic is tight**: M0.60–0.90 all pass at +0.013/+0.011/+0.006/−0.030 — the v0.075
  removal of the blunt-LE plateau lands this path on the tunnel to ~1–4 % below M0.9, and
  identical (to 4 decimals) to the named-doublewedge parent there.
- **Everything from M0.95 up runs LOW**, and by a lot: −0.113 (M0.95), −0.288 (M1.00, the
  transonic-peak miss), −0.213/−0.176/−0.164/−0.163 through M1.20, then −0.144 (M1.49, −27 %),
  −0.129 (M1.80, −27 %), −0.088 (M2.29, −23 %), −0.062 (M2.95, −21 %), −0.035 (M3.95, −16 %),
  −0.036 (M4.65, −18 %).
- **Against the named-section parent**: the no-section path reads slightly HIGHER (closer to
  the tunnel) everywhere above M0.9 — e.g. 0.3878 vs 0.3643 at M1.49 — so the v0.075 branch is
  consistent with, not wilder than, the named-section physics. The deficit is the same shape in
  both: the fin-drag deficit and transonic-peak items the open-items register carries (§3.3,
  §3.4, §3.7, §3.8), now measured on the path most users actually fly.

**Supersonic model:** 6/16 — subsonic all pass, and supersonically it sits slightly HIGH
(+0.077 at M1.49 shrinking to +0.012 at M4.65, that last one passing) — the mirror image of
Kbf's low bias, consistent with the register's picture of the two models bracketing the tunnel.

**Classic:** the familiar parity baseline — high supersonically (+0.17 at M4.65), the blunt-LE
plateau it charges this sharp fin being the exact thing v0.075 removed from Kbf.

## The double-gating tension, stated honestly

This cell gates the same TN D-4013/D-4014 tunnel measurement a second time (denominator
175 → 191). Mitigations: the two cells exercise **different kernel code paths** (named-section
`sectionPressureCD` vs the v0.075 sharp-airfoil branch), a regression in either is now visible
where before one whole path was dark; and scoreboard comparisons are made in gate flips within
a revision, never percentages across revisions. The alternative — leaving the most-flown fin
path with no anchor — is what this cell exists to end.

## Bookkeeping

- Fixture lockstep rule recorded in both fixtures' `_notes`: any geometry change to
  `arcas-short.json` must be mirrored in `arcas-short-nosection.json`; they differ only by the
  three deleted keys, the name and the notes.
- CP series deliberately not duplicated (section fields feed pressure CD only — duplicating CP
  would gate identical numbers twice); `cd-rasaero-parity` omitted (RASAero predicted the
  true-section article).
- Baseline/after outputs captured in the session scratchpad; `_readme` revision entry added to
  `anchors.json` (175 → 191).
