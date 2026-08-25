# Gating the fins-off tunnel data, and the Mach shape of the fin interference factor — 2026-08-25

Two instructions, in order. **(1)** Turn the TN D-4013 **fins-off** ARCAS data into real
gates, because until today only the fins-on *total* was gated and a body error and a fin
error of opposite sign were cancelling inside it. **(2)** Then make the ×1.8 fin
interference factor Mach-dependent, deriving the fade from RASAero's own printed Fin
Interference component at M0.50 and M2.00 rather than from what scores best — *"If the
manual's two points do not support a fade, DO NOT invent one — report that the data says
the factor should stay flat, and stop."*

**Step 1 was done and both new gates fail HIGH, exactly as predicted.** **Step 2 stopped
at the stop condition:** the manual's two points do not support a fade, they support a
flat factor to 0.26 %. No kernel physics changed in this pass, and the artifact is
byte-identical: md5 `bc0c742d0343d36a83e0a213f3159da7` before and after, reproduced
through a forced full TeaVM regeneration (`--rerun-tasks`, generated tree deleted).

| | before | after |
|---|---|---|
| gates | 164 | **166** |
| classic Extended Barrowman | 10/164 (6.1 %) | **10/166 (6.0 %)** |
| supersonic aero (flag on) | 70/164 (42.7 %) | **70/166 (42.2 %)** |
| artifact md5 | `bc0c742d…` | `bc0c742d…` (unchanged) |

Every one of the 164 pre-existing rows is **byte-identical** in both models — the diff
between the pre-task and post-task scorecards is the two new cells and the two summary
lines, nothing else. Classic parity with desktop OpenRocket is untouched; `difftest.mjs`
passes 299 lines (187 bit-identical, 112 within ULP tolerance) and `npm test -w
@online-openrocket/engine` passes 45/45.

---

## 1. The new gates

### 1.1 The measurement

NASA TN D-4013 wind-tunnel-tested the ARCAS **with the fins removed** ("No Fins (Body
Only)" — the report's Fins Off data), on the same model, in the same facility, reported
as the same quantity as our existing fins-on anchors: *Axial Force Coefficient corrected
for the Base Pressure Coefficient* at α = 0 and roll 0, which at α = 0 is C_D. **Base
excluded**, byte-for-byte the convention of the `cd-transonic-tunnel` series.

`validation/README.md` recorded under "Not yet in the harness" that no plain-body dataset
existed in our reference material, naming *"TN D-4013 fins-off CA"* as the candidate if
the source report were pulled. It has now been pulled — by the person who holds it.

| | ARCAS-Short, M0.60 | ARCAS-Long, M0.60 |
|---|---|---|
| **TN D-4013 fins off — C. E. Rogers' read** (TRF 197207 #9) | **0.225** | **0.250** |
| TN D-4013 fins off — this project's own 2026-08-03 read | 0.222 | 0.248 |
| inter-reader spread | 0.003 | 0.002 |

### 1.2 Provenance and tolerance, stated honestly

This is **a figure read, not a tabulated value; two points; one Mach.** Its reader is
Chuck Rogers, the RASAero co-author, who holds the report and posted the read publicly.
Nobody on this project has read the report itself. That is recorded verbatim in the cell's
`_provenance`, alongside the upgrade path (read the report, re-derive the tolerance from
its own stated accuracy) — the same standing caveat `rma53d02` carries.

**Tolerance ±0.010, derived from the reading uncertainty — and it is TIGHTER than the
sibling series, not looser.** The instruction was to derive it from the reading
uncertainty rather than from what would pass, and the two available inputs agree:

1. This project's own digitization of the same TN D-4013 transonic panels states its
   accuracy directly: *"dots ±0.003, curves ±0.01, ±0.02 in the M0.9–1.05 rise"*
   (`docs/research/validation-anchors-2026-08-03.md` §1.3). The fins-off value is a
   **curve** read in the **flat M0.6–0.8 band** ⇒ ±0.01.
2. That digitization independently read this very point, on a different occasion, and
   landed 0.003 / 0.002 away. Two readers agreeing that closely corroborates the ±0.01
   rather than merely asserting it. Quadrature of the two gives 0.0104, so ±0.010 stands.

The research note suggested gating "at the sibling series' ±0.03". **That was not
followed, because ±0.03 is not this row's reading accuracy.** The fins-on series carries
one tolerance across its whole Mach span *including* the M0.95–1.05 transonic rise, where
the same source says ±0.02–0.03. Borrowing a peak-region number for a flat-region read
would be widening a tolerance, which this harness forbids. It also happens to matter:
at ±0.03 the Short row would have **passed** at +0.019 and the finding below would have
been half-hidden.

**The anchor uses Rogers' value, which is the choice that flatters our model.** Our own
read (0.222 / 0.248) would put us 0.003 and 0.002 *further* out. No conclusion here
depends on picking the friendlier number. Our read is carried as an explicit
`gate: false` `cd0-finsoff-independent-read` series so the cross-check is visible in
every future scorecard instead of living only in prose; it is never counted, because
gating it would count one tunnel run twice.

**Caveats carried in the fixture and anchor notes, not buried here:**

- **The body keeps its 15° boat tail.** "Fins off" means the fins came off *this* model.
  So this is **not** the plain-body (finless, no-boat-tail) cell the README still lists as
  missing — that one is still missing, and the README now says so precisely.
- **The fin-root anchor brackets.** The ARCAS tunnel model carried four (0.178 in² total
  frontal) which no fixture models. Whether they stayed on for the fins-off run is not
  stated in anything we hold. If they did, the tunnel number includes them and our model
  reads low by roughly a further 0.010 — which **enlarges** the finding below rather than
  shrinking it. The sign is safe either way.

### 1.3 The fixture-pair consistency check — done before trusting any conclusion

The instruction was to verify our fins-off body CD equals the fins-on total minus our fin
component **exactly** before drawing conclusions. It does, to floating-point round-off:

| | worst \|(fins-on total − fins-off total) − fin-set component row\| | worst base-CD difference |
|---|---|---|
| arcas-short, classic | 1.041e-16 | **0** |
| arcas-long, classic | 9.714e-17 | **0** |
| arcas-short, supersonic | 1.665e-16 | **0** |
| arcas-long, supersonic | 1.110e-16 | **0** |

Checked over the **full 199-point Mach grid**, not the anchor Machs only, in both models
and both configs. Base CD is identical to the last digit fins-on and fins-off (base area
unchanged), and the kernel does not reduce body wetted area under the fin root — so the
pair differs by the fin set and by nothing else, which is what makes the difference
readable as "our fin drag".

### 1.4 The result: **the body fails HIGH, and it fails high by a lot**

| cell | model | anchor | our model | delta | tol | result |
|---|---|---|---|---|---|---|
| arcas-short-finsoff M0.60 | classic | 0.225 | 0.2446 | **+0.0196 (+8.7 %)** | ±0.010 | **FAIL** |
| arcas-short-finsoff M0.60 | supersonic | 0.225 | 0.2436 | **+0.0186 (+8.3 %)** | ±0.010 | **FAIL** |
| arcas-long-finsoff M0.60 | classic | 0.250 | 0.2958 | **+0.0458 (+18.3 %)** | ±0.010 | **FAIL** |
| arcas-long-finsoff M0.60 | supersonic | 0.250 | 0.2948 | **+0.0448 (+17.9 %)** | ±0.010 | **FAIL** |

Info rows (our own read, never gated), supersonic model: Short M0.60 +0.0216, M0.70
+0.0252, M0.80 +0.0236; Long M0.60 +0.0468. **All four gated rows and all four info rows
fail in the same direction in both models.** Saying it plainly: **our body drag is 8–18 %
too high subsonically, this is now gated, and both the classic and the supersonic model
fail it.** It is not a flag-on defect — it is carved classic physics that every rocket in
the app uses, and the supersonic flag moves it by 0.001.

### 1.5 The compensating-error pair, now visible

This is what the gates were for. At M0.60, base-excluded, supersonic model:

| | ARCAS-Short | ARCAS-Long |
|---|---|---|
| tunnel body (fins off) | 0.225 | 0.250 |
| **our body** | **0.2436 (+8.3 %)** | **0.2948 (+17.9 %)** |
| tunnel fin increment (fins-on − fins-off) | 0.070 | 0.098 |
| **our fin increment, ×1.8 in place** | **0.0631 (−10 %)** | **0.0605 (−38 %)** |
| our fin increment, ×1.0 | 0.0351 (−50 %) | 0.0336 (−66 %) |
| tunnel fins-on total | 0.295 | 0.348 |
| our fins-on total | 0.3067 (+0.012) **PASS** ±0.030 | 0.3553 (+0.007) **PASS** ±0.030 |

**Both fins-on rows pass comfortably while both components are wrong**, one high and one
low, because only the sum was gated. That is exactly the failure mode the 2026-08-25
anchor revision was written to expose, and the harness was blind to it until today.

At M0.60 the fin set's entire contribution is friction — measured fin pressure CD is
**exactly 0.000000** for this sharp double-wedge section subsonically, in both models
(consistency run, all Machs ≤ 0.9). So the ×1.8 acts on 100 % of the fin contribution
here and the "×1.8 in place" row is exact, not an estimate.

### 1.6 A new finding the pair makes possible: our skin friction scales ~2× with length

The two fins-off configs differ by **12.55 in of cylinder and nothing else**. That makes
the difference between them a *measured skin-friction increment*, and it is the only
such measurement in the anchor set:

| | Short → Long, M0.60, base-excluded |
|---|---|
| tunnel (Rogers' reads) | 0.250 − 0.225 = **0.0250** |
| tunnel (our own reads) | 0.248 − 0.222 = **0.0260** |
| **our model** (identical in both models) | 0.2948 − 0.2436 = **0.0512**, of which **100.0 % is friction** |
| ratio | **2.05×** measured (1.97× against our own reads) |

**Our friction on the added length is roughly twice the tunnel's**, and it is pure
friction — pressure contributes 0.000000 to the difference. This is a far sharper
diagnosis than "the body runs high": it points directly at the fully-turbulent-only
defect (`docs/research/trf-aero-research-2026-08-25.md` §6 — OpenRocket's partial-laminar
branch is unreachable through the kernel bridge, so every rocket is scored fully
turbulent) and it explains why the error **grows with body length**, which is why Long is
+17.9 % where Short is +8.3 %. Whether the D-4013 models were boundary-layer tripped is
still unresolved and would change how much of this is ours; §6 of the research note flags
that as worth settling from the report.

---

## 2. Step 2 — the Mach shape. **The data says flat. Stopping, as instructed.**

### 2.1 What was proposed

`docs/research/trf-aero-research-2026-08-25.md` §1.3 recommends making the factor
Mach-dependent — full strength subsonically, *"fading through the transonic bridge to
~1.0 by M1.5–2"* — on the reasoning that *"the junction/horseshoe-vortex interference it
models is a subsonic boundary-layer phenomenon; there is no physical reason for it to
keep its full subsonic value at M1.8."*

### 2.2 What the two real anchor points say — read from the manual, not from the citation

The only Mach-resolved measurement of this quantity anywhere is RASAero's own printed
**Fin Interference** component. Both rows were re-extracted from
`RASAero II Users Manual.pdf` directly (and cross-checked against `Rogers_Cooper_2011.pdf`,
which prints the identical run):

**p.90, Subsonic Run Test, M0.50** —
`0.50 0.00 0.481 0.459 0.306 0.026 0.057 0.050 0.042 0.000 0.000 39146410`
⇒ Body Frict 0.306, Body Press 0.026, Body Base 0.057, **Fin Frict&Press 0.050**,
**Fin Interference 0.042**, Fin Base 0.000, Protuberance 0.000.

**p.92, Supersonic Run Test, M2.00** —
`2.00 0.00 0.631 0.572 0.189 0.059 0.163 0.037 0.067 0.031 0.000 0.084 0.000 156585600`
⇒ Body Frict 0.189, Nose Cone Wave 0.059, Body Base 0.163, **Fin Frict 0.037**,
Fin Wave 0.067, **Fin Interference 0.031**, Fin Base 0.000, Other Body Wave 0.084,
Protuberance 0.000.

**Column reading verified by sum, not assumed:** 0.306+0.026+0.057+0.050+0.042 = **0.481**,
exactly the printed CD Power Off; and 0.189+0.059+0.163+0.037+0.067+0.031+0.084 =
**0.630** against 0.631 printed (rounding).

| | Mach | fin friction term | Fin Interference | **ratio** |
|---|---|---|---|---|
| Users Manual p.90 | 0.50 | Fin Frict&Press 0.050 | 0.042 | **0.8400** |
| Users Manual p.92 | 2.00 | Fin Frict 0.037 | 0.031 | **0.8378** |

**The ratio changes by 0.26 % from M0.50 to M2.00. That is flat.**

### 2.3 Why this is a refutation and not just weak support

- **Rounding cannot hide a fade.** The values are printed to 3 decimals, so each ratio
  carries a band: M0.50 ∈ [0.8218, 0.8586], M2.00 ∈ [0.8133, 0.8630]. Those bands overlap
  over **100 % of the subsonic band** — a *constant* ratio is fully consistent with both
  rows. The largest decline the rounding permits, taking both worst corners, is **5.3 %**.
- **A fade to ×1.0 requires Fin Interference ≈ 0 at M2.00.** The manual prints **0.031**
  there — **4.9 % of that run's total CD**, the fourth-largest of its nine printed
  components. It is not fading; it is one of the run's larger terms.
- **The denominator ambiguity can only argue the other way.** M0.50's column is
  "Fin Frict&Press" (combined) while M2.00's is "Fin Frict" alone with Fin Wave split
  out. If RASAero's subsonic fin *pressure* were non-zero, subsonic fin *friction* would
  be below 0.050 and the friction-referenced subsonic ratio would be **higher** than
  0.840 — i.e. a subsonic **rise**, never a fade. (Our own kernel measures fin pressure CD
  as exactly 0 for a sharp double wedge subsonically, so 0.050 ≈ pure friction and the two
  ratios are directly comparable in our accounting.)
- **There is no third point.** Both manuals print exactly these two breakdown rows. The
  transonic regime (M0.91–1.04) prints **no component breakdown at all** — only CD
  power-off/on — so RASAero does not even expose fin interference across the transonic
  bridge the fade was supposed to pass through.

### 2.4 The premise was already void

The fade's physical argument is that this is *junction / horseshoe-vortex* interference,
a subsonic boundary-layer effect. `scorecard-junction-2026-08-25.md` had already
established, and the code comment already says, that **it is not a junction term**: a
junction is a corner effect whose drag area scales with t², while this scales with fin
wetted area × Cf, and its implied per-junction coefficient across the three finned cells
is 0.92 / 0.47 / 0.52 — a factor of two apart and *not* tracking fin thickness. It is a
lumped fin-in-presence-of-body component ported from RASAero. So the physical reasoning
for a fade does not attach to the thing being faded. **Both the data and the corrected
physical identification point the same way.**

### 2.5 And the supersonic half of the premise is now attributed elsewhere

The fade was to be "full strength subsonically … fading toward ~1.0 by M1.5–2 **where the
supersonic total-CD gates say we are long**". Those gates say the *total* is long. They
have never said *which component* is long — TN D-4013's fins-off data stops at M1.2, which
is precisely why `scorecard-junction-2026-08-25.md` ruled the six supersonic gates
un-attributable to this term.

The new fins-off gates now measure the body directly, and carrying that measured bias
forward at its M0.60 rate accounts for the overshoot on its own:

| cell | M | tunnel total | our total | overshoot | body excess if the measured M0.60 % holds | **share of overshoot** |
|---|---|---|---|---|---|---|
| arcas-short | 1.49 | 0.532 | 0.5952 | +0.0632 | +0.0338 | **53 %** |
| arcas-short | 1.80 | 0.470 | 0.4956 | +0.0256 | +0.0280 | **109 %** |
| arcas-short | 2.29 | 0.376 | 0.3999 | +0.0239 | +0.0225 | **94 %** |
| arcas-short | 2.95 | 0.300 | 0.3207 | +0.0207 | +0.0180 | **87 %** |
| arcas-short | 3.95 | 0.223 | 0.2457 | +0.0227 | +0.0138 | **61 %** |
| arcas-short | 4.65 | 0.198 | 0.2063 | +0.0083 | +0.0116 | **139 %** |
| arcas-long | 1.80 | 0.508 | 0.5357 | +0.0277 | +0.0621 | **224 %** |
| arcas-long | 2.29 | 0.410 | 0.4360 | +0.0260 | +0.0505 | **194 %** |
| arcas-long | 2.95 | 0.336 | 0.3518 | +0.0158 | +0.0408 | **259 %** |

**This is an extrapolation, and it is labelled as one** — it assumes the measured M0.60
relative body bias persists supersonically, and there is no fins-off measurement above
M1.2 to confirm that. It is offered as a plausibility argument, not a measurement. But it
is a far better-grounded one than the fade, whose supporting data is zero: its anchor is
now gated, and it is partly offset by a known body deficit running the other way (the
fixture's excluded base lip, worth ≈ −0.012 at M1.8 decaying to ≈ −0.005 at M4.65, which
still leaves the body accounting for the majority of the Short overshoot).

**The conclusion that matters:** fading this factor would take drag off the fin set —
which the only measurement of it says is already **10–38 % short** even at ×1.8 — in
order to pay for a **body** error that is now gated and failing. That is a second
compensating-error trade, of exactly the kind step 1 of this task existed to stop.
Building it would have been tuning the model to the anchors.

### 2.6 Verdict

**The factor stays flat at ×1.8, flag-on only. No kernel change.** The manual's two
points do not support a fade; per the standing instruction, none was invented.

---

## 3. What changed in the tree

**No physics.** Artifact md5 `bc0c742d0343d36a83e0a213f3159da7` → unchanged, verified
twice: once through a forced full TeaVM regeneration before any edit, and once after the
comment edit below.

| file | change |
|---|---|
| `validation/fixtures/arcas-short-finsoff.json` | NEW — arcas-short with the fin set deleted, nothing else |
| `validation/fixtures/arcas-long-finsoff.json` | NEW — arcas-long with the fin set deleted, nothing else |
| `validation/anchors.json` | NEW cells `arcas-short-finsoff` / `arcas-long-finsoff`; 2 gated rows + 4 info rows; 164 → 166 gates |
| `validation/README.md` | scoreboard, file list, and the "plain-body cell" entry corrected — that entry said no measured fins-off dataset existed |
| `engine-java/patches/…/FinSetCalc.java` | **comment only** — records that the fade was proposed, tested against the manual's two points, and refuted, so the next session does not re-litigate it |
| `engine-java/patches/LEDGER.md` | the same, as a sub-entry under the existing ×1.8 entry |
| `packages/engine/vendor/orkengine.mjs` | rebuilt; **byte-identical** |

**Classic stayed bit-identical**, as required: `difftest.mjs` **299 lines, ok** (187
bit-identical, 112 within ULP tolerance); `npm test -w @online-openrocket/engine`
**45/45**; and the classic scorecard's 164 pre-existing rows diff clean against the
pre-task baseline.

## 4. What got worse

**The score, on paper, and only on paper.** Classic 10/164 (6.1 %) → 10/166 (6.0 %) and
supersonic 70/164 (42.7 %) → 70/166 (42.2 %). Two gates were added and both fail, in both
models; no existing row moved by a single digit. The percentages fell because the anchors
got harder, which is the third time this has happened in this harness and the reason
`README.md` says percentages across anchor revisions are not comparable.

Nothing else regressed. There is no model change in this pass to regress anything.

## 5. What this leaves open

1. **The body's +8–18 % subsonic excess is now a red gate rather than a footnote**, in
   *both* models. The length-scaling measurement (§1.6) narrows it to skin friction at
   ~2× the measured rate on added length, which points at the fully-turbulent-only defect.
   That defect is carved classic physics used by every rocket in the app; fixing it moves
   desktop-OpenRocket parity and is not a validation-harness decision.
2. **Our fin increment is still 10–38 % short** where it can be measured, even at ×1.8.
   Named candidates, unchanged: fin LE bluntness (charged only when `finLeRadius` is
   given) and the fin-anchor brackets (not modelled; RASAero's own answer is a
   protuberance column).
3. **Were the D-4013 models boundary-layer tripped?** Unresolved, and it scales §1.6. If
   they were not, part of our fins-off excess is the fully-turbulent assumption and the
   fin shortfall is correspondingly larger.
4. **Upgrade the anchors from figure reads.** Two ways: read TN D-4013 ourselves, or
   retrieve the two "No Fins" `.CDX1` files Rogers attached to TRF 197207 #9 (they are
   *not* in `docs/User files/TRF RASAero Files`). Either would let the tolerance come from
   the report's own stated accuracy instead of a curve-read band.
5. **Fins-off above M1.2 remains the missing measurement.** Until it exists, no supersonic
   gate can be attributed to the fin term versus the body — the ruling from
   `scorecard-junction-2026-08-25.md`, unchanged and now better quantified.
6. **Our own read's M0.70/M0.80 Short points are gateable** and currently sit as info
   rows. They say the same thing (+0.025, +0.024). A future pass wanting a stronger
   subsonic body gate can promote them without any new data.

## 6. Reproducing this

```
node validation/score.mjs               # classic     -> 10/166
node validation/score.mjs --supersonic  # supersonic  -> 70/166
```

The fixture-pair consistency check, the length-scaling measurement and the supersonic
attribution were run as one-off drivers against `packages/engine/dist`, each taking the
fins-on and fins-off sweeps at matched `machAlt` and differencing them; the identity
checked is `fins-on total − fins-off total == the fins-on sweep's fin-set component row`,
over the full Mach grid. The manual rows in §2.2 come from `pdftotext -layout` over
`RASAero II Users Manual.pdf` pages 90 and 92, and both were sum-checked against the
printed CD before use.
