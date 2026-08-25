# Boundary-layer transition, and the owner's accuracy ruling in the kernel — 2026-08-25

The task named the fully-turbulent-only friction model as *"the best-evidenced defect we
have"* and asked for it to be verified before being fixed. **It was verified, and it is not
the cause.** The partial-laminar branch was exposed anyway — being unreachable is a defect
on its own terms — but it is **off by default in every model**, and this pass does not move
the ARCAS body-drag numbers by a single digit.

What *did* move is the parity boundary, under Eric's standing ruling of 2026-08-25: the
×1.8 fin interference factor now runs in **Rogers Kbf** (the default model), and two
extensions that were silently changing **classic** numbers were moved out of it.

| | before | after |
|---|---|---|
| **OpenRocket — Extended Barrowman** (parity) | 11/175 (6.3 %) | **10/175 (5.7 %)** — RMS \|Δ\|/tol 5.634 → **6.075** |
| **Rogers Modified Barrowman (Kbf)** — the DEFAULT | 15/175 (8.6 %) | **17/175 (9.7 %)** — RMS 4.928 → **4.617** |
| **Supersonic** | 71/175 (40.6 %) | **71/175 — byte-identical, all 258 rows** |
| Buckeye apogee, Kbf (GPS 18,006 ft) | 21,498 ft (+19.4 %) | **20,154 ft (+11.9 %)** |
| LEM-IV apogee, Kbf (3 altimeters, 11,755 ft) | 12,617 ft (+7.3 %) | **12,008 ft (+2.2 %)** |
| artifact md5 | `bc0c742d…` | `458d9f15…` |
| differential | 299 lines, ok | **309 lines, ok** |

**The DEFAULT model's numbers have moved. Every user's predicted altitude changes and old
runs stop comparing.** Section 7 states the size of it, in both directions, including the
part that got worse.

`difftest.mjs` **309 lines, ok** (194 bit-identical, 115 within ULP tolerance);
`npm test -w @online-openrocket/engine` **45/45**; `npm test -w @online-openrocket/app`
**901/901**; `carve.mjs` **0 copied, 259 verified unchanged, 13 patched**.

---

## 1. Verifying the suspected cause — and refuting it

### 1.1 What `isPerfectFinish` actually is

Carved `BarrowmanCalculator.java` gates two things on `Rocket.isPerfectFinish()`:

* **line 667, `calculateFrictionCoefficient`** — the friction law. On: `Re < 1e4` → constant
  1.33e-2; `Re < 5.39e5` → fully laminar Blasius `1.328/√Re`; above → the turbulent
  flat-plate value **minus `1700/Re`**. (The three branches join up: at Re = 5.39e5 the
  turbulent 4.9618e-3 minus 3.1540e-3 = 1.8078e-3 against Blasius 1.8089e-3, agreeing to
  0.06 %, which is what fixes the transition Reynolds number at ≈5.4e5.) The
  compressibility correction differs
  too: `(1+0.045 M²)^-0.25` where the turbulent branch uses `(1+0.15 M²)^-0.58`.
* **line 582, `calculateFrictionCD`** — roughness limiting. On: take the roughness-limited
  Cf only when `Re > 1e6`. Off: plain `max(Cf, roughnessLimited)`.

**It is not per component.** One Reynolds number is built from
`FlightConfiguration.getLengthAerodynamic()` (line 651–653) and the resulting Cf is charged
to every aerodynamic component, fins included.

### 1.2 The premise "desktop users can set it and ours cannot" is false — nobody can set it

Grepping the whole 24.12 release for `erfectFinish` returns **five files and no writer**:

```
core/.../aerodynamics/BarrowmanCalculator.java:527, :612     (the two reads)
core/.../rocketcomponent/Rocket.java:83, 448-465, 558        (field, default false, accessors)
core/.../util/TestRockets.java:768, :962                     rocket.setPerfectFinish(false)
```

Nothing in `swing/`, nothing in `file/` (it is not written or read by `RocketSaver`, so it
is **not stored in `.ork`**), nothing in preferences. `perfectFinish` initialises to
`false` (Rocket.java:83) and the only assignment in the release sets it to `false` again.
**Desktop OpenRocket 24.12 is unconditionally fully turbulent, and the branch is dead
code.** That does not make exposing it wrong — it makes it *ours to decide*, which is
exactly what the owner's ruling contemplates.

### 1.3 The measurement, on the two ARCAS fins-off fixtures

Forced on (Kbf, so the new gate lets it through), tunnel-Re-matched, base-excluded.
Reynolds number computed from each fixture's own `machAlt` through the kernel's own
atmosphere (`ExtendedISAModel` + its 500 m interpolation, `getMachSpeed`,
`getKinematicViscosity`) — i.e. the number `calculateReynoldsNumber` actually sees.

**ARCAS Short, L_aero 1.04013 m**

| M | Re | tunnel | fully turbulent | laminar-run on | ΔCD | err turb | err lam |
|---|---|---|---|---|---|---|---|
| 0.60 | 1.103e7 | 0.2214 | 0.2446 | 0.2347 | −0.0099 | **+10.5 %** | **+6.0 %** |
| 0.70 | 1.102e7 | 0.2231 | 0.2482 | 0.2384 | −0.0098 | +11.2 % | +6.8 % |
| 0.80 | 1.072e7 | 0.2309 | 0.2531 | 0.2432 | −0.0099 | +9.6 % | +5.3 % |
| 0.90 | 1.020e7 | 0.2611 | 0.2591 | 0.2489 | −0.0103 | −0.8 % | −4.7 % |
| 0.95 | 1.013e7 | 0.2930 | 0.2628 | 0.2553 | −0.0075 | −10.3 % | −12.9 % |
| 1.00 | 1.003e7 | 0.4174 | 0.2669 | 0.2627 | −0.0042 | −36.1 % | −37.1 % |
| 1.20 | 1.036e7 | 0.4297 | 0.2843 | 0.2912 | **+0.0069** | −33.8 % | −32.2 % |

**ARCAS Long, L_aero 1.35890 m**

| M | Re | tunnel | fully turbulent | laminar-run on | ΔCD | err turb | err lam |
|---|---|---|---|---|---|---|---|
| 0.60 | 1.440e7 | 0.2491 | 0.2958 | 0.2857 | −0.0102 | **+18.8 %** | **+14.7 %** |
| 0.70 | 1.439e7 | 0.2489 | 0.2987 | 0.2887 | −0.0100 | +20.0 % | +16.0 % |
| 0.80 | 1.400e7 | 0.2520 | 0.3030 | 0.2929 | −0.0101 | +20.3 % | +16.2 % |
| 0.90 | 1.332e7 | 0.2663 | 0.3085 | 0.2981 | −0.0105 | +15.9 % | +11.9 % |
| 1.00 | 1.310e7 | 0.3665 | 0.3160 | 0.3133 | −0.0027 | −13.8 % | −14.5 % |
| 1.20 | 1.353e7 | 0.4219 | 0.3322 | 0.3438 | **+0.0115** | −21.3 % | −18.5 % |

**The length-scaling measurement — the sharpest evidence in the task's premise**

| M | tunnel (Long − Short) | ours, turbulent | ratio | ours, laminar-run on | ratio | Δ |
|---|---|---|---|---|---|---|
| 0.60 | 0.0277 | 0.0512 | **1.85×** | 0.0510 | **1.84×** | −2.07e-4 |
| 0.65 | 0.0273 | 0.0509 | 1.86× | 0.0507 | 1.86× | −2.05e-4 |
| 0.70 | 0.0258 | 0.0505 | 1.96× | 0.0503 | 1.95× | −2.05e-4 |
| 0.75 | 0.0235 | 0.0502 | 2.14× | 0.0500 | 2.13× | −2.05e-4 |
| 0.80 | 0.0211 | 0.0499 | 2.37× | 0.0497 | 2.36× | −2.07e-4 |

### 1.4 Three independent reasons this is not the cause

**(a) The tunnel models were tripped, so the anchors cannot test a transition model at
all.** TN D-4013 p.4: *"In order to obtain turbulent flow over the model, a 0.25-cm-wide
(0.10-in.) strip of No. 120 carborundum grains was affixed around the model 3.17 cm
(1.25 in.) aft of the nose and 1.27 cm (0.5 in.) aft of the leading edge of each fin."*
The trip sits 1.25 in down a 41-in body. Fully turbulent is the **correct** modelling
choice for these cells — `scorecard-finsoff-figs-2026-08-25.md` §1.1 already said so, and
both fins-off fixtures carry it in their `_notes`. Every "improvement" in the tables above
is the model being made *less* like the article that produced the anchor.

**(b) The credit is mathematically independent of body length, so it cannot produce the
length signature.** The laminar-run credit in CD terms is
`ΔCD = (1700/Re_L)·(S_wet/S_ref)·corr`. For a cylinder `Re_L ∝ L` and `S_wet ∝ L`, so **L
cancels exactly**: the credit is the same absolute CD on a short body and a long one, and
subtracting it from both leaves their difference untouched. Measured: −0.0099 (Short) and
−0.0102 (Long), a residual of **2.07e-4 — 0.4 % of the 0.0512 increment** — and the residual
exists only because the nose and boat tail are not cylinders. **The over-scaling ratio goes
1.85× → 1.84×.** The defect this branch was suspected of causing survives it intact.

**(c) Even taken at face value it closes less than half the level error, and both gates
still fail.** Short |Δ| 0.0232 → 0.0133 (**43 % closed**, still 1.7× the ±0.008 tolerance);
Long |Δ| 0.0467 → 0.0366 (**22 % closed**, still 4.6×). And above M1.0 it goes the *other*
way (+0.0069 / +0.0115 at M1.20) for the reason in §1.5.

### 1.5 What the branch actually does to the whole harness — and why its gate gains are an error

Forced on across all 175 gates:

| model | gates before | gates with transition forced on |
|---|---|---|
| Rogers Kbf | 15/175 (RMS 4.928) | **25/175 (RMS 4.520)** |
| Supersonic | 71/175 | **68/175** |

**+10 gates in the default model is not a reason to ship it.** Where they come from:

| cell / series | Kbf, off | Kbf, forced on |
|---|---|---|
| **arcas-short-finsoff + arcas-long-finsoff** (the cells this was aimed at) | **1/11** | **0/11** |
| arcas-short + arcas-long `cd-transonic` | 6/20 | **4/20** |
| arcas-short + arcas-long `cd-supersonic` | 0/11 | 3/11 |
| rma53d02 `cd0-freeflight` | 1/29 | 7/29 |
| basic-finner `cd0-freeflight` | 0/23 | 4/23 |

Every gained gate sits at **M2.95–M10**, and at those Mach numbers the branch **adds**
friction rather than removing it, because it carries a *laminar* compressibility law:

| fixture | Re at M0.60 | Cf ratio (perfect ÷ turbulent), M0.60 → M4.00 |
|---|---|---|
| basic-finner (L 0.300 m, ISA SL) | 4.14e6 | 0.876 → 1.026 → 1.203 (M2) → 1.459 (M3) → **1.731** |
| rma53d02 (L 0.0635 m) | 8.77e5 | **0.589** → 0.838 → 1.057 → 1.328 → **1.602** |
| arcas-short (L 1.040 m) | 1.10e7 | 0.946 → 1.040 → 1.190 → 1.426 → **1.674** |

At M4 the branch gives a compressibility factor of `1/(1+0.045·16)^0.25 = 0.873` where Van
Driest II — the correlation this kernel's own Phase-4 patch uses,
`1/(1+0.144 M²)^0.65` — gives **0.462**, and the turbulent branch gives 0.494. So the
supersonic gates are won by **applying a laminar friction law at Re ≈ 1e7**, on two cells
(`basic-finner`, `rma53d02`) whose known deficit is finned-body base pressure, not
friction. rma53d02 M10 goes from CD 0.0572 to 0.1128 — its friction very nearly doubles.
(There is a second consequence: because it is a separate branch, turning it on in the
Supersonic model **bypasses the Phase-4 Van Driest II fit entirely**.)

Taking those gates would be fitting the model to the anchors through an error that happens
to point the right way, on cells the change was never aimed at, while the cell it *was*
aimed at loses its only passing row. **Refused.**

### 1.6 One thing the branch does that is worth knowing regardless

**For a normally-finished rocket above Re 1e6 it is a complete no-op.** With the default
regular-paint finish the roughness-limited Cf exceeds the flat-plate Cf, and both branches
then return the roughness-limited value — the perfect-finish path only skips it below
Re 1e6. Measured on the golden reference rocket, friction CD with the setting off then on:

| | M0.30 | M0.85 | M1.50 | M4.00 |
|---|---|---|---|---|
| regular paint, Kbf off → on | 0.507707 → **0.507707** | 0.475303 → **0.475303** | 0.364639 → **0.364639** | 0.132041 → 0.188672 |
| polished, Kbf off → on | 0.333942 → **0.272728** | 0.260880 → 0.240739 | 0.216630 → 0.238140 | 0.108552 → 0.188672 |

That is why LEM-IV's apogee moves by **0.002 m** with transition on (§6): its surfaces are
roughness-limited and the setting cannot reach them. Both rows are pinned as goldens.

---

## 2. What was shipped: the branch is now reachable, and gated

`OrkEngine.setPerfectFinish(handle, boolean)` → `OrkRocket.setPerfectFinish(enabled)`.
The kernel gate is `BarrowmanCalculator.partialLaminar(configuration)` =
`(rogersKbf || supersonicAero) && configuration.getRocket().isPerfectFinish()`, replacing
both raw `isPerfectFinish()` reads.

**Why the gate rather than an honest passthrough.** Desktop cannot express this property at
all, so honouring it with both model flags off would let a bridge call — or a future UI
checkbox — move a number in the one model that promises desktop's exact answer. Putting the
gate in the kernel makes that structurally impossible instead of a convention. In "Rogers
Kbf" and "Supersonic" it works; in "OpenRocket — Extended Barrowman" it is inert, and the
golden `transition.paint.*` / `transition.polished.*` lines pin that inertness as an
equality at four Mach numbers on two surface finishes.

**Default: off, in every model.** §1.4 and §1.5 are the whole argument. There is no
measurement in the anchor set that can set this default, and the one cell that looks like
it could was tripped.

---

## 3. The owner's ruling, applied — the three decisions asked for

### (i) Should transition/finish handling differ between classic and Kbf+Supersonic?

**In reachability, yes. In default numbers, no — and the measurement is §1.5.** The control
exists only outside the parity model; both sides still compute fully turbulent unless a
user asks otherwise. Enabling it by default in Kbf would gain 10 gates and lose the
fins-off cell, through a friction law that is wrong by ~1.9× at M4. It was measured and
rejected, not shelved for lack of nerve.

### (ii) The ×1.8 fin interference factor moves into Kbf

`if (rogersKbf || supersonicAero) cd *= 1.8;` — `scorecard-junction-2026-08-25.md` closed
with this as *"the option the data supports … not a change to make without Eric"*. Eric
ruled. Re-measured on the current 175-gate anchors, Kbf only:

| | before | after |
|---|---|---|
| gates | 15/175 | **17/175** |
| RMS \|Δ\|/tol, all 175 gated rows | 4.928 | **4.617** |
| gated CD rows (102) closer / worse / unchanged | — | **80 / 3 / 19** |
| gate flips | — | arcas-short `cd-transonic` M0.90 (Δ −0.0570 → **−0.0299**), arcas-long `cd-transonic` M0.90 (Δ −0.0440 → **−0.0181**) — both FAIL→PASS |
| classic rows moved | — | **0 (byte-identical, all 258)** |
| Supersonic rows moved | — | **0 (byte-identical, all 258)** |

The 3 rows that move away are rma53d02 subsonic, where we already read high — the same
three the junction scorecard named.

### (iii) `airfoilSection` moves out of classic — the known parity VIOLATION

`if (airfoilSection != null && (rogersKbf || supersonicAero))`. Desktop's `FinSet` knows
only the three-valued `CrossSection`; naming one of our eight RASAero sections used to
replace desktop's pressure-drag model **in every aero model, including the parity one**.

**Proof it is gone, and that "gated" means "as if the input were never given":** with the
gate in place, the classic drag sweep of each finned fixture is compared against the same
fixture with `airfoilSection` / `finLeRadius` / `airfoilLeDiamond` / `airfoilTeDiamond`
deleted, over every Mach and every drag component plus CP:

| fixture | Machs compared | worst \|Δ\| across total / friction / pressure / base / CP |
|---|---|---|
| arcas-short | 199 | **0** |
| arcas-long | 199 | **0** |
| basic-finner | 199 | **0** |
| rma53d02 | 419 | **0** |

Size of what was removed, on the golden reference rocket at M1.80 (fin pressure CD,
SQUARE cross-section, with and without a `doublewedge` section named) — the golden
`parity.airfoilsection` line:

| | no section named | + doublewedge |
|---|---|---|
| classic (parity) | 0.653218 | **0.653218** ← was 0.079901 |
| Rogers Kbf | 0.653218 | 0.079901 (unchanged) |

**An 8.2× swing in fin pressure drag, in the model whose entire claim is that nothing
changes.** On the validation fixtures the effect on total CD is +54…+62 % at M1.80.

### (iv) The same bug, found while doing (iii): nozzle-exit power-on base drag

Feature #2 was input-gated the same way. `NozzleExitDiameter` appears in exactly **two**
files in the whole 24.12 release — `file/rasaero/export/BoosterDTO.java` and
`file/rasaero/RASAeroCommonConstants.java` — and **nothing in `core/aerodynamics` reads
it**, so desktop has no nozzle-exit aerodynamics whatever. Our power-on base recovery was
applying in the parity model. Now gated. Golden `parity.nozzlebase`, base CD at M0.90:

| | power-off | power-on |
|---|---|---|
| classic (parity) | 0.225300 | **0.225300** ← was 0.125167 |
| Rogers Kbf | 0.225300 | 0.125167 (unchanged) |

**No validation row moves** (all 175 gates are power-off; no fixture sets a nozzle). Two
engine tests moved, and their movement is the fix working — see §9.

This one is beyond the three items the task listed. It is the same species, the same
ruling covers it explicitly, and leaving it would have made "classic is now honestly
desktop-parity" a false statement. Reverting it is one token.

---

## 4. Per-change record

Every row is its own kernel build; each md5 was taken after `carve.mjs` + `build-engine.mjs`
and re-checked after the measurements, so no number here mixes two builds.

| # | change | artifact md5 | classic | Kbf | Supersonic |
|---|---|---|---|---|---|
| 0 | baseline (task start) | `bc0c742d0343d36a83e0a213f3159da7` | 11/175 | 15/175 | 71/175 |
| A | expose transition + kernel gate | `09a4a21ffc308e75b4c740d68cbc25f1` | 11/175 *(all 3 scorecards byte-identical to 0)* | 15/175 | 71/175 |
| B | + ×1.8 in Kbf | `c863e08292257c3d8b2647e238c995d2` | 11/175 *(byte-identical)* | **17/175** | 71/175 *(byte-identical)* |
| C | + `airfoilSection` out of classic | `4aa1ea06491e0d0192f2c62827d0f5e6` | **10/175** | 17/175 *(byte-identical to B)* | 71/175 *(byte-identical)* |
| D | + nozzle base drag out of classic | `a9238af90ca2e1566a7f686c6634d243` | 10/175 *(byte-identical to C)* | 17/175 *(byte-identical)* | 71/175 *(byte-identical)* |
| — | + goldens & comments (no physics) | **`458d9f15be60bbac85f1ed47edefc0c9`** | 10/175 | 17/175 | 71/175 |

Side experiments, measured and **not shipped**: transition forced on in Kbf
(25/175, §1.5) and in Supersonic (68/175).

---

## 5. Before/after per series, all three models

| cell / series | classic before | classic AFTER | Kbf before | Kbf AFTER | Supersonic |
|---|---|---|---|---|---|
| arcas-short `cd-supersonic-tunnel` | 0/6 | **1/6** | 0/6 | 0/6 | 1/6 → 1/6 |
| arcas-short `cd-transonic-tunnel` | 3/10 | **2/10** | 3/10 | **4/10** | 6/10 → 6/10 |
| arcas-short `cp-supersonic-tunnel` | 0/5 | 0/5 | 1/5 | 1/5 | 1/5 → 1/5 |
| **arcas-short-finsoff** `cd0-finsoff-tunnel` | 1/6 | **1/6** | 1/6 | **1/6** | 1/6 → 1/6 |
| arcas-long `cd-supersonic-tunnel` | 0/5 | **1/5** | 0/5 | 0/5 | 3/5 → 3/5 |
| arcas-long `cd-transonic-tunnel` | 3/10 | **1/10** | 3/10 | **4/10** | 8/10 → 8/10 |
| arcas-long `cp-supersonic-tunnel` | 0/4 | 0/4 | 0/4 | 0/4 | 1/4 → 1/4 |
| **arcas-long-finsoff** `cd0-finsoff-tunnel` | 0/5 | **0/5** | 0/5 | **0/5** | 0/5 → 0/5 |
| rma53d02 `cd0-freeflight` | 1/29 | 1/29 | 1/29 | 1/29 | 12/29 → 12/29 |
| basic-finner `cd0-freeflight` | 0/23 | 0/23 | 0/23 | 0/23 | 0/23 → 0/23 |
| basic-finner `cna-freeflight` | 0/23 | 0/23 | 1/23 | 1/23 | 16/23 → 16/23 |
| basic-finner `cp-freeflight` | 1/23 | 1/23 | 3/23 | 3/23 | 17/23 → 17/23 |
| hb2 `cna-aedc` | 0/9 | 0/9 | 0/9 | 0/9 | 0/9 → 0/9 |
| hb2 `xcp-aedc` | 2/9 | 2/9 | 2/9 | 2/9 | 5/9 → 5/9 |
| hb2 `ca0-aedc` | 0/8 | 0/8 | 0/8 | 0/8 | 0/8 → 0/8 |
| **TOTAL** | 11/175 | **10/175** | 15/175 | **17/175** | 71/175 → **71/175** |

**Both fins-off cells are byte-identical in every model, before and after.** The body-drag
defect this task set out to attack is exactly where it was: **+10.5 % (Short) / +18.8 %
(Long) at M0.60, 1/11 gates.** Saying that plainly is the main result.

### 5.1 The classic rows that moved, and why they moved that way

122 of 258 classic rows moved, all of them on the four finned cells (the two fins-off cells
and hb2 are finless and are untouched). The pattern is one mechanism: with the section
model gone, classic charges the carved rounded-LE plateau
`cd = 1.214 − 0.502/M² + 0.1095/M⁴` on `crossSection: airfoil` fins, which never decays
with Mach.

| cell | series | M | anchor | classic BEFORE | classic AFTER | tol | |
|---|---|---|---|---|---|---|---|
| arcas-short | cd-transonic | 0.70 | 0.300 | 0.2828 | 0.3461 | ±0.030 | PASS → **FAIL** |
| arcas-short | cd-transonic | 0.80 | 0.309 | 0.2873 | 0.3909 | ±0.030 | PASS → **FAIL** |
| arcas-short | cd-transonic | 0.95 | 0.460 | 0.3049 | 0.4742 | ±0.030 | FAIL → **PASS** |
| arcas-short | cd-supersonic | 1.80 | 0.470 | 0.3003 | 0.4865 | ±0.020 | FAIL → **PASS** |
| arcas-short | cd-supersonic | 4.65 | 0.198 | 0.1439 | 0.3688 | ±0.020 | FAIL → FAIL |
| arcas-long | cd-transonic | 0.70 | 0.348 | 0.3319 | 0.3952 | ±0.030 | PASS → **FAIL** |
| arcas-long | cd-transonic | 0.80 | 0.353 | 0.3358 | 0.4395 | ±0.030 | PASS → **FAIL** |
| arcas-long | cd-supersonic | 1.80 | 0.508 | 0.3414 | 0.5276 | ±0.020 | FAIL → **PASS** |
| basic-finner | cd0 | 1.799 | 0.594 | 0.4439 | 0.8012 | ±0.030 | FAIL → FAIL |
| basic-finner | cd0 | 4.127 | 0.285 | 0.2350 | 0.6850 | ±0.030 | FAIL → FAIL |
| rma53d02 | cd0 | 0.60 | 0.360 | 0.4124 | 0.3803 | ±0.029 | FAIL → **PASS** |
| rma53d02 | cd0 | 1.06 | 0.538 | 0.5284 | 0.4938 | ±0.043 | PASS → **FAIL** |

(Twelve representative rows of the 122; the full listing is reproducible with the commands
in §11.) Basic Finner is the extreme case: classic goes from 0.15–0.45 **low** to
0.08–0.44 **high** at supersonic Mach. That is desktop OpenRocket's own answer for a fin
declared `airfoil`, and it is precisely the defect the LEDGER's feature #1 Phase 2 entry
was written against — *"the classic model charges [a sharp airfoil] the swept-cylinder LE
drag plateau (~1.2 on the LE frontal area), which neither decays with Mach nor belongs on
a sharp section."* **The parity model's job is to reproduce desktop including its
weaknesses.** It now does, and `README.md`'s standing sentence — *"that classic model —
desktop OpenRocket's exact physics — scores 10/164"* — is literally true instead of
approximately true.

---

## 6. The flights

Both files replayed through the app's own path (`importOrk` → `engineTree` → motor from the
motor database with file-header masses → `simulate` with the file's own launch conditions).
The instrument is validated by the classic column: Buckeye **6552.5984 m** against the
handoff's recorded 6552.5984, LEM-IV **12,620 ft** against its recorded 12,616–12,621.

**`docs/User files/Mach2.trf.ork` — Buckeye's WM Mach 2 on a K480W, GPS 18,005.6 ft**

| model | apogee | vs measured | max Mach |
|---|---|---|---|
| classic (parity) — unchanged by this pass | 21,498 ft | +19.4 % | 1.971 |
| **Kbf (default) — before** | 21,498 ft | +19.4 % | 1.971 |
| **Kbf (default) — after** | **20,154 ft** | **+11.9 %** | 1.937 |
| Kbf + transition (opt-in, off by default) | 20,124 ft | +11.8 % | 1.935 |
| Supersonic — unchanged | 19,623 ft | +9.0 % | 1.919 |
| Supersonic + transition | 19,602 ft | +8.9 % | 1.918 |

**`docs/User files/LEM-IV.ork`, M1500G configuration — 11,755 ft, three altimeters (0.37 % spread)**

| model | apogee | vs measured | max Mach |
|---|---|---|---|
| classic (parity) — unchanged by this pass | 12,620 ft | +7.4 % | 1.307 |
| **Kbf (default) — before** | 12,617 ft | +7.3 % | 1.308 |
| **Kbf (default) — after** | **12,008 ft** | **+2.2 %** | 1.289 |
| Kbf + transition | 12,008 ft | +2.2 % | 1.289 |
| Supersonic — unchanged | 12,155 ft | +3.4 % | 1.288 |

Two things to read off this table. **The default model's over-prediction is now less than
half what it was on the better-instrumented flight** (LEM-IV +7.3 % → +2.2 %; it is now
closer than the Supersonic model). And **the transition setting is worth −30 ft on Buckeye
and +0.005 m on LEM-IV** — §1.6 explains the second: both rockets are roughness-limited, so
the branch cannot reach them.

Standing caveat, unchanged from `scorecard-junction-2026-08-25.md`: **Buckeye's 18,006 ft
is not a clean anchor** — the same kit on the same motor has been measured twice more at
22,285 and 22,757 ft. LEM-IV is the datum that carries weight.

---

## 7. The DEFAULT model's numbers have moved — say this to users

**Rogers Modified Barrowman is the default, and it now predicts less altitude for any
rocket with fins.** Size, on the two real designs in hand: **−1,344 ft (−6.3 %)** on
Buckeye's Mach 2 and **−609 ft (−4.8 %)** on LEM-IV. The mechanism is +80 % of the fin
set's skin-friction drag, at every Mach, so the shift scales with how much of a design's
drag is fin friction. Saved simulations from earlier versions will not reproduce.

**And the part that got worse, stated as plainly as the part that got better.** Against
Buckeye's GPS-derived Cd on his own file:

| Mach | measured | classic (parity) | **Kbf (default), after** | Supersonic |
|---|---|---|---|---|
| 0.30 | 0.397 | 0.4353 (+10 %) | **0.4844 (+22 %)** | 0.4825 (+22 %) |
| 0.50 | 0.384 | 0.4487 (+17 %) | **0.4969 (+29 %)** | 0.4910 (+28 %) |
| 0.80 | 0.361 | 0.4901 (+36 %) | **0.5365 (+49 %)** | 0.5116 (+42 %) |
| 1.10 | 0.721 | 0.5051 (−30 %) | **0.5457 (−24 %)** | 0.6266 (−13 %) |
| 1.20 | 0.717 | 0.4889 (−32 %) | **0.5282 (−26 %)** | 0.6028 (−16 %) |
| 1.30 | 0.604 | 0.4727 (−22 %) | **0.5107 (−15 %)** | 0.5652 (−6 %) |

The apogee improvement is bought partly by **adding drag subsonically, where his trace says
we already have too much**, to cover a transonic hole this term does not touch. That is the
handoff's *"a shape error answered with a flat offset"*, and it now applies to the default
model as it already did to Supersonic. It is a real improvement on the totals and on the
only fins-on/fins-off measurement we hold (where our fin increment is still **10–38 %
short** even at ×1.8) — but it is not a shape fix, and the subsonic body excess in §5 is
still the thing that needs fixing.

---

## 8. Is classic still bit-identical? — the honest answer, in full

**Through changes A and B: yes, byte-identical on every one of the 258 classic rows.** The
transition exposure and the ×1.8-into-Kbf move do not touch the parity model, verified by
diffing whole scorecards, not by inspection.

**Through changes C and D: no, and deliberately — classic moved TOWARD desktop, not away
from it.** 122 of 258 classic rows changed. This is the one commitment, so the reasoning is
worth stating exactly:

* The commitment is **bit-identical to desktop OpenRocket**, not bit-identical to
  yesterday's scorecard. Two of our extensions were firing inside the parity model, so the
  parity model was **not** desktop before this pass for any design that named a fin airfoil
  section or a nozzle exit diameter. Both are reachable from our own UI and from a RASAero
  import.
* The owner's ruling names this case explicitly: *"The mirror case is a BUG: anything that
  currently moves CLASSIC numbers away from desktop must move OUT of classic (the known
  one: `airfoilSection` changes classic drag today)."*
* The fix is verified as an **exact** equivalence, not an approximation: classic's sweep on
  all four finned fixtures is bit-identical (worst |Δ| = **0**, every Mach, every drag
  component, and CP) to the same fixture with the section inputs deleted — i.e. to what a
  desktop that never saw them would compute (§3(iii)).
* Everything else about classic is untouched. The two **finless** cells (both fins-off
  configs) and **hb2** are byte-identical before and after in classic, as are all CP and
  CNα rows on every cell.
* `difftest.mjs` (JVM ↔ TeaVM, 309 lines) passes, so the kernel is still one implementation
  compiled two ways.

**Kbf and Supersonic:** Supersonic is byte-identical across all 258 rows for the whole pass
(it already carried both the ×1.8 and the section model). Kbf changed only through
change B, and its 122 fin-section rows are unchanged — the gate reads
`rogersKbf || supersonicAero`, so no non-parity user's numbers move by (iii) or (iv).

---

## 9. What got worse

1. **The classic scorecard.** 11/175 → 10/175, RMS |Δ|/tol 5.634 → 6.075. Deliberate; §8.
2. **The default model's subsonic Cd** against the one flight trace we can compare it to:
   +10…+36 % → +22…+49 %. §7. Its apogees and its aggregate gate accuracy both improve; its
   subsonic drag does not.
3. **Two engine tests changed their expected values**, and both changes are the parity
   fixes doing what they claim:
   * `flies a minimum-diameter rocket` — that design carries a `nozzleExitDiameter` and
     flies with no flags, so it keeps its full base drag through boost now:
     333.4645 → **329.6097 m** (golden `flight.mindia` moved with it).
   * `fin airfoil sections: blunt-base wedge adds fin base drag…` — the section model now
     needs a non-parity model, so the test asks for Kbf, and it gained an assertion that the
     parity model is blind to the section.
4. **The `nozzle.basecd.*` goldens now record no reduction** (they run flag-free). The
   flag-on path is covered by the new `parity.nozzlebase` line instead, so coverage is
   preserved rather than lost.
5. **Nothing in the Supersonic model regressed** — it did not move at all.

---

## 10. What this leaves open

1. **The body's +10.5 % / +18.8 % subsonic excess and the ≤1.85× friction over-scaling on
   added length are exactly where they were**, in all three models, and this pass removed
   the leading hypothesis for them. Trip: confirmed. Re: matched. Fin anchors: they push the
   Short number the other way. Transition: refuted here, three ways. **The cause is
   unidentified.**
2. **A candidate this pass surfaced but did not pursue:** OpenRocket charges *fins* the same
   Cf as the body, built from the **whole rocket's** aerodynamic length. A fin's own chord
   Reynolds number is one to two orders lower, so its true Cf is materially higher — which
   is the direction the one fins-on/fins-off measurement wants (our fin increment is 10–38 %
   short). The same is true of the roughness limit, which uses rocket length in `(k/L)^0.2`.
   Fixing it would overlap with the ×1.8 factor and must be measured against it, not added
   on top.
3. **A UI for the transition setting.** The bridge is done and the kernel gate is done;
   nothing in `packages/app` exposes it yet (out of scope here). It belongs next to the
   per-component surface finish, labelled as what it is — *allow a laminar run* — with the
   note that it does nothing for a normally-finished rocket above Re 1e6 (§1.6).
4. **Whether any third input-gated extension is still firing inside classic.** Two were
   found and fixed; the audit that found them was a grep of the 24.12 release for each
   patch's distinguishing identifier, and it should be finished for the remaining feature
   patches rather than left at two.
5. **The fins-on transonic anchor doubt** (`scorecard-finsoff-figs-2026-08-25.md` §6, eight
   gated rows possibly wrong by up to 0.11) is untouched and still gates rows that moved in
   classic here.

---

## 11. Files changed, and reproducing this

| file | change |
|---|---|
| `engine-java/patches/…/aerodynamics/BarrowmanCalculator.java` | `partialLaminar()` (new) replacing both `isPerfectFinish()` reads; nozzle-exit base recovery gated to non-parity models |
| `engine-java/patches/…/barrowman/FinSetCalc.java` | ×1.8 factor `supersonicAero` → `rogersKbf \|\| supersonicAero`; `airfoilSection` path gated to non-parity models |
| `engine-java/src/api/java/api/OrkEngine.java` | `setPerfectFinish` (new bridge export) |
| `packages/engine/src/orkEngine.ts` | `OrkRocket.setPerfectFinish` + docs |
| `packages/engine/src/orkengine-module.d.ts` | one ambient declaration for the new export |
| `packages/engine/src/orkEngine.test.ts` | the two expectations in §9.3 |
| `engine-java/src/harness/java/harness/GoldenMain.java` | `transitionScenarios` + `modelBoundaryScenarios` (10 new differential lines) |
| `engine-java/patches/LEDGER.md` | the entry for all of the above |
| `packages/engine/vendor/orkengine.mjs` | rebuilt — `bc0c742d…` → `458d9f15…` |
| `validation/scorecard-transition-2026-08-25.md` | this file |

`validation/anchors.json` and `validation/fixtures/**` were **not touched**; no tolerance
and no anchor moved in this pass.

```
node engine-java/scripts/carve.mjs                 # 0 copied, 259 verified, 13 patched
node engine-java/scripts/build-engine.mjs          # -> 458d9f15be60bbac85f1ed47edefc0c9
node engine-java/scripts/difftest.mjs              # 309 lines, ok
npm test -w @online-openrocket/engine              # 45/45
npm run build -w @online-openrocket/engine
node validation/score.mjs                          # parity model  -> 10/175
node validation/score.mjs --supersonic             # Supersonic    -> 71/175
```

`score.mjs` has no switch for the Kbf model (it scores flag-off and `--supersonic` only), so
the **17/175** default-model figure comes from a copy of it in the session scratchpad with
`rocket.setRogersModifiedBarrowman(true)` and an optional `rocket.setPerfectFinish(true)`
added — verified to reproduce `score.mjs` byte-for-byte with neither flag set. Adding a
`--kbf` flag to `score.mjs` is the obvious follow-up and is outside this pass's file
manifest: **the default model has never had a scorecard of its own**, which is worth fixing
now that it differs from classic in drag as well as CP. The transition/Reynolds tables in
§1.3 and §1.6 and the flight replays in §6 come from one-off drivers in the same scratchpad;
the flight driver imports the app's own `orkFile` / `treeModel` / `motorDb` / `thrustcurve`
modules rather than re-implementing them, which is what lets its classic column reproduce
the recorded session values to the digit.
