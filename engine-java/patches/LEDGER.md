# Patch ledger

Every file in `patches/` REPLACES the same-relative-path upstream file during carve
(`scripts/carve.mjs`). Patches must be minimal, documented here, and re-audited when
upgrading the upstream OpenRocket version. Diff a patch against upstream with:

```
git diff --no-index <openrocket-src>/<path> patches/<path>
```

## Active patches (all: TeaVM classlib gaps — not behavior changes)

### simulation/BasicEventSimulationEngine.java
- **Why:** TeaVM 0.15's `java.util.Formatter` does not implement the `%g`
  conversion; the STAGE_SEPARATION handler logs `String.format("==>> @ %g; ...")`
  and threw `UnknownFormatConversionException` on EVERY staged flight under JS.
- **Change:** that one log line: `%g` → `%s` with `Double.toString(...)`.
  Log-only (stderr); zero physics/goldens impact. Found by the staging golden
  scenarios (2026-07-03, Phase 3 Release B).

### rocketcomponent/FlightConfigurationId.java + motor/MotorConfigurationId.java
- **Why:** TeaVM 0.15's `java.util.UUID` is string-backed; it lacks `UUID(long, long)`,
  `getMostSignificantBits()`, and `compareTo` — all used by these two key classes.
- **Change:** `java.util.UUID` → `info.openrocket.core.util.LongUUID` (shim), a faithful
  reimplementation of the JDK UUID surface used (identical toString/hashCode/equals/
  compareTo semantics). Pure type swap; no logic changed.
- **Note:** `LongUUID.randomUUID()` is deterministic (counter-based) — intentional, for
  reproducible differential runs. Identical on JVM and TeaVM sides by construction.

### rocketcomponent/FlightConfiguration.java
- **Why:** TeaVM 0.15 has no `java.util.concurrent.ConcurrentLinkedQueue`.
- **Change:** `ConcurrentLinkedQueue` → `java.util.LinkedList` (2 tokens: import +
  instantiation). Same FIFO iteration order; the engine is single-threaded in the
  browser and in the harness, so the concurrency property was unused.

### rocketcomponent/ComponentAssembly.java
- **Why:** `getComponentBounds()` returns `Collections.emptyList()`, and
  `Transformation.transform(Collection)` calls `clear()`/`addAll()` on it. On the JDK,
  `AbstractCollection.clear()` on an *empty* immutable list is a silent no-op; TeaVM's
  immutable-list template throws `UnsupportedOperationException` unconditionally. Upstream
  survives on unspecified JDK behavior.
- **Change:** return `new java.util.ArrayList<>()` (empty, mutable). Behavior-identical.
- **Upstreamable:** yes — this is arguably an upstream latent bug worth a PR.

### aerodynamics/BarrowmanCalculator.java
- **Why:** `buildCalcMap` constructs per-component calculators via
  `Reflection.construct(...)` — walks the component class hierarchy calling
  `Class.forName(<SimpleName> + "Calc")`. No reflection metadata exists under TeaVM
  ("BUG: Suitable constructor for component ... not found" at runtime).
- **Change:** replaced the reflective call with an explicit `createCalcObject()`
  instanceof chain that reproduces the hierarchy-walk resolution exactly
  (FinSet→FinSetCalc, TubeFinSet→TubeFinSetCalc, LaunchLug→LaunchLugCalc,
  RailButton→RailButtonCalc, SymmetricComponent→SymmetricComponentCalc,
  ComponentAssembly→ComponentAssemblyCalc; TubeCalc is abstract and was never
  directly instantiable via reflection either).
- **Note:** must be revisited if upstream adds new `*Calc` classes.

## Determinism fixes (documented behavior change — within upstream's own envelope)

### rocketcomponent/InstanceMap.java
- **Why:** upstream `InstanceMap extends ConcurrentHashMap<RocketComponent, ...>`.
  Two problems: (a) TeaVM's classlib needs a plain `java.util` map here; (b)
  `RocketComponent` has no `hashCode()` override, so hash-map iteration order
  follows *identity hash codes*, which vary per JVM process (HotSpot's
  identity-hash PRNG is time-seeded).
  `BarrowmanCalculator` iterates this map when accumulating per-component forces
  every simulation step; a run-to-run change in FP summation order produces
  ULP-level differences that chaos-amplify over a flight. Observed 2026-07-03: the
  same golden harness produced different `flight.*` lines (different sample counts,
  e.g. 866 vs 867 rows in the windy scenario) across two fresh JVM runs — making
  the bit-identical JVM↔TeaVM differential intermittently impossible to pass.
  Reproduced under `-Xint`, so not JIT-related.
- **Change:** `extends ConcurrentHashMap` → `extends LinkedHashMap` (import +
  extends, 2 tokens). Iteration becomes insertion order — the deterministic
  configuration tree-walk order — identical on JVM and TeaVM. LinkedHashMap is
  plain classlib, so it also satisfies the TeaVM constraint.
- **INCIDENT (2026-08-04 audit):** the LinkedHashMap version had been sitting at
  the dead path `patches/rocketcomponent/InstanceMap.java` since it was written
  (carve.mjs resolves patches at the full manifest-relative path
  `patches/info/openrocket/core/...`), while the active path carried an
  undocumented interim `ConcurrentHashMap → HashMap` classlib-only patch — so
  the shipped kernel had identity-hash iteration order the whole time (the
  differential passed on tolerances + the JS side's deterministic object ids).
  Restored 2026-08-04; carve.mjs now FAILS on any patch file that doesn't match
  a manifest entry, so a mis-pathed patch can't go silent again.
- **Physics note:** this *selects one* FP summation order from the set upstream
  randomly wanders across runs; every result stays inside upstream's own
  run-to-run envelope (ULP-level). Aligned with this project's "deterministic
  simulations by choice" rule (seeded wind, LongUUID).
- **Upstreamable:** arguably — upstream simulations are nondeterministic at the
  ULP level run-to-run because of this.

## Feature patches (documented physics extension — RASAero gap features)

These add capability OpenRocket lacks. Each is designed to be **default-off**: with
its new input at its zero default, every drag value is bit-identical to upstream, so
all pre-existing goldens/differential lines are unaffected. New behavior appears only
when a design opts in.

### RASAero feature #2 — power-on vs power-off base drag (nozzle-exit plume model)

RASAero computes a distinct power-on drag coefficient: during motor burn the exhaust
plume pressurizes the base area over the nozzle-exit footprint, recovering that area's
base pressure and lowering base drag (nozzle exit dia = 0 → power-on CD = power-off CD).
OpenRocket's `calculateBaseCD` is Mach-only with no thrust/nozzle term. Model chosen
(no published formula exists): **power-on base area = max(0, baseArea − nozzleExitArea)**
while the owning stage's motor thrusts — the literal geometric mechanism the RASAero
Manual and Rogers & Cooper (2011) describe. Reproduces the exact ARCAS power-off↔power-on
CD split (constant ~0.017 at low Mach). Supersonic large-nozzle *augmentation* (beyond
neutralizing base drag) is deferred to feature #1. Four files:

- **rocketcomponent/AxialStage.java** — add `double nozzleExitDiameter` (metres, default
  0) + getter/setter. Primitive, so `copyWithOriginalID`'s clone copies it; no other change.
- **aerodynamics/FlightConditions.java** — add `Set<Integer> thrustingStages` (empty =
  coast) + getter/setter/`isStageThrusting(int)`; deep-copied in `clone()`. Excluded from
  `equals()/hashCode()` (transient force-model input, not a defining condition).
- **simulation/AbstractSimulationStepper.java** — in `calculateFlightConditions`, populate
  `thrustingStages` from `status.getActiveMotors()` (thrust > 0 → add mount's stage number),
  mirroring `RK4SimulationStepper.calculateThrust`. Applied on all exit paths.
- **aerodynamics/BarrowmanCalculator.java** — in the instance `calculateBaseCD` aft-base
  block, subtract the owning stage's nozzle-exit area from the base area when that stage
  `isStageThrusting`. (This file already carried a TeaVM reflection patch — see below.)
- Bridge (not a patch): `api/OrkEngine.applySeparationConfig` reads `nozzleExitDiameter`
  off the stage node and calls the setter. App side: `<nozzleexitdiameter>` in `.ork`
  (metres) + a per-stage schema field.
- **Guard:** default 0 keeps all goldens bit-identical; the `nozzle.basecd.*` golden
  scenario exercises the power-on path (power-off must equal the no-nozzle base CD, power-on
  must be strictly lower). Run difftest AND engine vitest after rebuild.

### RASAero feature #3 — opt-in Rogers Modified Barrowman body-fin interference (Kbf)

Classic Barrowman (and OpenRocket) applies only the "fins in presence of body" factor
`Kfb = 1 + τ` (τ = r/(s+r)) to the fins and DROPS the reciprocal body carryover `Kbf`
(NACA 1307 `K_B(W)`). RASAero's "Rogers Modified Barrowman" adds it back. Opt-in: default
OFF ⇒ CP/CNα bit-identical to classic Barrowman. Model: slender-body theory gives total
fin+carryover load `(1+τ)² · (fin-alone)`; OpenRocket already credits `(1+τ)`, so the body
carryover that completes it is `τ(1+τ)·(fin-alone) = τ·cna`, placed at the fin ROOT
quarter-chord (NACA 1307 puts the carryover near the root; forward of the swept-fin MAC).
Net effect: CP moves slightly AFT (more conservative margin). Two files + bridge:

- **aerodynamics/BarrowmanCalculator.java** (extends the existing TeaVM-reflection patch):
  add `boolean rogersKbf` + `setRogersKbf`/`isRogersKbf`; `newInstance()` preserves it;
  `createCalcObject` becomes an instance method and binds the flag onto each `FinSetCalc`.
- **aerodynamics/barrowman/FinSetCalc.java** (NEW patch): add `boolean rogersKbf` +
  `setRogersKbf`; in `calculateNonaxialForces`, when enabled and τ>0, average a
  `Coordinate(rootQuarterChord, 0, 0, τ·cna)` carryover into the emitted fin CP (and use
  the combined weight for CN/Cm). Flag off ⇒ the original `Coordinate(x,0,0,cna)`.
- Bridge (not a patch): `api/OrkEngine` — a per-design `RocketCtx.rogersKbf` set by the
  `setRogersModifiedBarrowman(handle, bool)` @JSExport; `getStaticInfo` and `simulateJson`
  build the `BarrowmanCalculator` with the flag so the displayed CP AND the flight sim agree.
- **Guard:** default off keeps all goldens bit-identical; the `rogerskbf.*` golden scenario
  asserts on≠off (CP shifts aft) and JVM↔JS parity. Deferred (per the research, mixed
  foundation): the low-α nose→body carryover (unpublished Rogers formula) and upgrading the
  existing Galejs body-lift term to full Jorgensen η·Cd_c (proprietary DATCOM Cd_c). See the
  session's #3 research (wcs25co8u) — OpenRocket's Galejs term is ALREADY a ∝sin²α crossflow.

### RASAero feature #1 Phase 1 — opt-in supersonic aerodynamics (CP/CNα vs Mach)

The classic kernel freezes body CNα/CP at the slender-body value for ALL Mach and uses
the single-surface Busemann coefficient (K1 = 2/β) as the whole supersonic fin slope —
HALF of 2D linear theory. Result (measured by validation/score.mjs): combined CP races
forward ~2× too far (ARCAS model 27 %L vs tunnel 57 %L at M4.63) and CNα is ~half of
free-flight data. Opt-in flag `supersonicAero`, default OFF ⇒ bit-identical. Model
calibrated against NASA TN D-4013/D-4014 (ARCAS), DREV-TM-9703 (Basic Finner) — see
docs/research/validation-anchors-2026-08-03.md and the spec doc areas 6/7. Files:

- **aerodynamics/BarrowmanCalculator.java** (extends existing patch): `boolean
  supersonicAero` + setter/getter, preserved in `newInstance()`, bound onto each
  `FinSetCalc` AND `SymmetricComponentCalc` in `createCalcObject`.
- **aerodynamics/barrowman/FinSetCalc.java** (extends existing patch), flag-on only:
  (1) supersonic branch scaled by `2·(1 − 1/(2·AR·β))` (2D 4/β level with the standard
  finite-span tip correction, floored at 0.25), evaluated ANALYTICALLY (no grid ⇒ no
  M4.9 clamp); the transonic bridge endpoint scales identically so the 0.9–1.5 quintic
  stays continuous. (2) Body-fin interference `(1+τ)` replaced by the exact NACA Report
  1307 Eq. 14 split `K_W(B) + fa·K_B(W)` at all Mach, with afterbody carryover factor
  `fa = min(1, 0.5 + afterbody/rootChord)` (computed in the constructor by walking the
  parent body + aft symmetric siblings; fins flush with the base get half carryover).
  The `rogersKbf` term is suppressed while this flag is on (1307 already contains the
  full carryover — double counting otherwise).
- **aerodynamics/barrowman/SymmetricComponentCalc.java** (NEW patch — first SCC patch):
  flag-on, for NOSE components only (foreRadius ≈ 0): `CNα(M) = CNα_slender · (1 +
  g·(min(M,5) − 1))` above M1, g = 0.10 conical / 0.07 ogive-class — a calibrated
  surrogate bracketed by exact Taylor–Maccoll values (Sims SP-3004 class results reach
  ~1.2–1.4× slender by M4–5), pending full SOSE. Transitions/boattails stay slender
  (Phase-2+ work; HB-2's flare physics is documented as out of Phase-1 scope).
- Bridge (not a patch): `RocketCtx.supersonicAero`, `setSupersonicAero(handle, bool)`
  @JSExport, applied in `getStaticInfo`, `simulateJson` AND `getDragSweep`.
- **Guard:** default off keeps all goldens bit-identical; the `ssaero.*` golden
  scenarios lock CP/CNα at M1.2/2/4/8 for both flag states JVM↔JS. Scored result:
  validation harness gate points 8/137 (classic) → see the Phase-1 scorecard.

**Phase 2 additions (drag fidelity, same `supersonicAero` flag, same files):**

- **FinSetCalc.calculatePressureCD**: AIRFOIL (sharp streamlined) sections no longer
  get the swept-cylinder blunt-LE drag plateau (~1.2 on LE frontal area, Mach-flat,
  with a (1−M²)^−0.417 subsonic form that blows up at M0.9). Flag on: subsonic
  pressure ≈ 0 (profile drag lives in the friction form factor), supersonic
  thin-airfoil wave drag K·4(t/c)²/β (K=4/3 biconvex) × cos²(LE sweep) on planform
  area, blended M0.9–1.2. ROUNDED/SQUARE unchanged (their bluntness is real).
- **FinSetCalc.calculateFrictionCD**: flag on ×1.8 — fin-body junction interference
  drag, calibrated to the D-4013 fins-on/off tunnel increment (fin set adds ~2× bare
  fin friction) and consistent with RASAero's printed "Fin Interference" component.
- **SymmetricComponentCalc.calculatePressureCD**: (a) boattails/reducers get
  supersonic wave drag (linearized strip Cp = −2θ/β on the expansion surface),
  blended M0.8→1.5 from the classic subsonic estimate (the 1/β form diverges near
  M1, so the bridge skips the divergent region); classic flag-off path returns the
  identical old values. (b) Nose interpolators no longer clamp flat past their last
  data point: conical/ogive continue on their analytic branch (2.1 sinφ² + 0.5 sinφ/β,
  physical 1/β decay, any Mach); TR R-100 table shapes decay with the Fleeman/Bonney
  Mach shape (1.59 + 1.83/M²).
- **BarrowmanCalculator.effectiveBaseCD**: flag on caps 0.25/M at 1.2/M² (≈0.85 of
  the vacuum base limit 2/(γM²)) — crossover ≈ M4.8, matches HB-2 base data trend.
- **Bridge getDragSweep**: optional `machAlt` [[M, alt_m], …] table pins the ISA
  atmosphere (hence Re) per Mach point — the harness matches wind-tunnel Re/ft with
  it (same mechanism as RASAero's Mach-Alt input). Not a physics change.
- **Goldens:** `ssaerocd.*` lines lock the flag-on CD decomposition at M1.2/2/4/8
  (differential 252 → 256 lines).
- **Scored result:** 52/137 → **68/137**; ARCAS-Short supersonic CD 7/7, Long 5/6,
  subsonic green with polished fixtures + Re-matching. Documented limitations: the
  transonic peak band M0.95–1.2 underpredicts against the tunnel by up to ~0.2–0.3
  CD (fin transonic drag rise ≈4× subsonic in the tunnel data; RASAero underpredicts
  the same anchors by 0.10–0.22) — the transonic-refinement backlog item; Basic
  Finner Cx0 low ~0.05–0.13 pending its wedge fins' blunt-TE base drag (feature #4
  airfoils); HB-2 flare/bluntness unchanged (hypersonic phase).

### RASAero feature #4 (build Phase 3) — fin airfoil cross-sections + LE radius

RASAero's 8 fin sections vs the kernel's 3 (square/rounded/airfoil). Input-gated like
feature #2 (no flag): absent inputs ⇒ bit-identical classic behavior. Files:

- **rocketcomponent/FinSet.java** (NEW patch — additive only): properties
  `airfoilSection` (null | "hexagonal" | "naca" | "doublewedge" | "biconvex" |
  "hexbluntbase" | "singlewedge"), `airfoilLeDiamond` / `airfoilTeDiamond` (m,
  chordwise chamfer lengths at mid-span), `finLeRadius` (m); accessors fire
  AERODYNAMIC_CHANGE. RASAero's "Rounded"/"Square" sections stay the classic
  CrossSection values.
- **aerodynamics/barrowman/FinSetCalc.java** (extends existing patch):
  `sectionPressureCD` — per-shape linearized thickness wave drag (DATCOM 4.1.5.1 /
  Hoerner): hexagonal τ²/β(1/a1+1/a2); naca & biconvex (16/3)τ²/β (naca adds the
  implicit nose radius 1.1019·τ²·c as LE bluntness); doublewedge τ²/(β·m(1−m));
  hexbluntbase τ²/(β·a1) + base; singlewedge τ²/β + base. Wave blends in over
  M0.9–1.2, swept by cos²Γ_LE, referenced to planform. Blunt-base sections carry
  fin base drag baseCD·τ at all Mach (RASAero's "Fin Base" component). Optional LE
  radius adds the kernel's swept-cylinder Mach fit on its 2r frontal height.
  Sections do not alter CNα/CP (thickness is drag-only in linear theory).
- Bridge: ComponentFactory parses the four inputs on any FinSet type.
- **Goldens:** `finsection.wedge` / `finsection.hexle` lines (differential 256 → 258).
- **Scored result:** 68 → 65/137 — an HONEST decrease: Basic Finner's fixture now
  uses its true `singlewedge` section, and the correct wedge thickness term (τ²/β)
  is smaller than the biconvex placeholder (16/3·τ²/β) that had been accidentally
  masking a remaining systematic deficit. Finner Cx0 now reads −0.04 (M4) to −0.13
  (M1.8) below free-flight across the board — suspected free-flight base-drag
  environment (base pressure behind a FINNED body runs below the clean-cylinder
  Hoerner law) + the transonic band; flagged for the refinement phase (candidates:
  McCoy/BRL base-pressure correlation, NACA RM A53D02 digitization). ARCAS keeps
  its biconvex-class 'airfoil' (its rounded-LE double wedge is well-approximated
  and all its CD/CP series stay green).

### RASAero feature #1 Phase 4 — hypersonic corrections (same `supersonicAero` flag)

- **BarrowmanCalculator.calculateFrictionCD**: the turbulent compressibility fit
  `1/(1+0.15M²)^0.58` tracks Van Driest II only to M≈4; flag on fades to the VD-II
  adiabatic-wall engineering fit `1/(1+0.144M²)^0.65` (Hopkins & Inouye, NASA TN
  D-6945) over M3.5–4.5.
- **SymmetricComponentCalc**: the analytic cone/ogive extension's `2.1·sinφ²`
  asymptote is a transonic-range calibration; exact cone solutions and modified-
  Newtonian theory sit lower hypersonically. Flag on fades the coefficient from 2.1
  to `Cp_max(M)` (Rayleigh-pitot stagnation Cp, NACA Rep. 1135 Eq. 100, → 1.839)
  over M4–8. New helper `stagnationCpMax`.
- **Scored:** score unchanged at 65/137, but the physics moved the right way where
  it matters: HB-2 CA0 excess at M8–10 fell ~45% (+0.25 → +0.14) and ARCAS M4.65
  tightened to −0.003. Remaining HB-2 gaps are DOCUMENTED limitations, deliberately
  unmodeled: (a) spherical-cap nose bluntness (HB-2's 0.300 d cap — needs a tip-
  radius input + MNT cap/Jackson matching); (b) flare-effectiveness decay with Mach
  (HB-2 CNα measured 4.6→3.1 /rad over M2→10 while slender flare theory is
  Mach-flat — flare-specific physics with no hobby-rocket relevance and only one
  dataset to calibrate on). Both parked as the "blunt/flare body" refinement item.

### RASAero feature #1 Phase 5 — boat-tail transonic shape + ogive nose wave drag + LE-sonic fin sweep (same `supersonicAero` flag)

Three shape-selective corrections, each aimed at a defect that the 2026-08-25 anchor
revision made harness-visible. Full before/after accounting:
`validation/scorecard-phase5-2026-08-25.md`.

- **SymmetricComponentCalc — boat-tail wave drag rebuilt (the "M1.5 kink").**
  Phase 2 blended LINEARLY from the subsonic base-scaled estimate at M0.8 to the
  linearized strip value `2θ/β` at M1.5, which put the boat-tail's MAXIMUM at
  exactly M1.500. Measured on the re-fixtured ARCAS Long (flag on, Re-matched):
  the Transition row climbed to 0.3768 at M1.500 and the total-CD curve carried
  **two** transonic peaks — M1.150 (0.6552) and M1.500 (0.6601) — with the false
  one as the global maximum. Two testers saw it. Phase 5 replaces the branch with
  `M ≤ 0.90` classic estimate → smoothstep to M1.05 → plateau M1.05–1.20 → **exact
  Prandtl–Meyer** expansion Cp above M1.20 (new `prandtlMeyerNu` / `pmExpansionCp`;
  θ clamped at 20° where a boat tail separates and goes base-like, Hoerner FDD).
  The linearized `2θ/β` also ran OVER exact PM by a Mach-dependent factor —
  measured for the ARCAS 15° turn: exact/linear 0.66 (M1.2), 0.73 (M1.8), 0.50
  (M4.65) — so the level moved too, not only the shape. **Measured result:** the
  boat-tail row now has a single maximum at **M1.050 = 0.4376** and decays
  monotonically to M10 (0.29390 at M1.500, where the false peak used to be).
  `pmExpansionCp` inverts ν(M₂)=ν₂ by a **fixed-count bisection** (exactly 48
  halvings of [M, 60], no epsilon test) so the JVM and TeaVM run an identical
  operation sequence — the kWB1307/stagnationCpMax determinism discipline; the new
  `ssphase5.boattail` goldens are bit-identical across both backends.
- **SymmetricComponentCalc — Fleeman ogive NOSE wave drag.** The classic OGIVE
  branch derives its whole supersonic curve from `sinphi`, the surface slope over
  the aft 1 % of the shape — which for a *tangent* ogive is zero by construction.
  Measured: sinphi 0.00105 (ARCAS nose) / 0.00123 (RM A53D02 nose), nose pressure
  CD **0.00031 at M2** on a nose-plus-tube isolation run. The only supersonic nose
  pressure left was a **spurious transonic bump** (0.058/0.075 at M1.05/1.10
  collapsing to 0.0006 at M1.3) that the fixed sonic slope `4/(γ+1)` drives through
  the M1–1.3 cubic between two near-zero endpoints. Flag on, and only for NOSE
  ogives with shape parameter ≥ 0.35 (cone-like secants and every CONICAL nose keep
  the classic branch, so Basic Finner and HB-2 are untouched — verified byte-equal):
  rebuild the same M1–1.3 bridge around `CD = (1.59 + 1.83/M²)·(atan(0.5/(l_N/d)))^1.69`
  (Fleeman, *Tactical Missile Design*, base-area referenced — the Fleeman/Bonney
  lineage Phase 2 already uses for table-end decay) and continue on it above M1.3.
  The 1.59 floor IS the hypersonic asymptote, so no Phase-4 style fade is needed.
  New `CAL_BRIDGE_SLOPE_CAP` (2.0) bounds the sonic drag-rise slope; **measured**
  over its declared range [1.5, 3.0] the largest gate-row movement is 0.0093 CD
  (ARCAS-long M1.1) and **no gate flips**, so it is a weak knob and 2.0 is simply
  the middle. Measured nose CD on the ARCAS nose: 0.0180 (M1.0), 0.0570 (M1.2),
  0.0600 (M1.3), 0.0459 (M2), 0.0361 (M10).
- **FinSetCalc — `sweepWaveFactor`, LE-sonic fade of the cos²Γ sweep relief.**
  Phases 2/3 apply simple-sweep cos²Γ relief on fin thickness wave drag at every
  Mach. That is valid only while the LE is subsonic-normal (Mn = M·cosΓ < 1); once
  the LE goes sonic the independence principle fails and the section behaves 2D at
  the streamwise Mach (Puckett–Stewart; DATCOM 4.1.5.1 sweep charts). Measured on
  RM A53D02 (tanΓ_LE = 3 exactly ⇒ cos²Γ = 0.100): fin wave drag 0.00053 at M5
  where ≈0.005 is right. The factor now fades cos²Γ → 1 over Mn 0.90–1.05 and then
  follows the sheared-wing form `β·cosΓ/βn`, capped at 1 (sweep never *increases*
  thickness drag here). **Unswept fins return exactly 1 at every Mach**, so Basic
  Finner is bit-identical — verified, all 69 of its gate rows byte-equal.
  Applied at the flag-on AIRFOIL path and, **wrapped in `supersonicAero`**, at the
  feature-#4 `sectionPressureCD` path. That second gate is deliberate and is the
  one place this patch departs from its spec: feature #4 is input-gated rather than
  flag-gated, so the un-gated version would have moved CLASSIC numbers for any
  design with a section AND swept fins. Classic is desktop parity and is not this
  session's to move. **Open for Eric** (docs handoff §6a step 2): if sections are
  ruled a flag-free physics extension, deleting the ternary is the whole change.
- **Goldens:** `ssphase5.boattail.*` (five samples across all four bands of the new
  boat-tail curve — the bisection's fidelity canary), `ssphase5.finsweep.*` and
  `ssphase5.finstraight.*` (a 60°-swept and an unswept hexagonal-blunt-base fin
  either side of the LE-sonic band). Differential 271 → **286 lines**, all 15 new
  lines bit-identical JVM↔TeaVM.
- **Scored:** supersonic **52/164 → 69/164**; classic **10/164, every one of the
  164 rows byte-identical** (flag-off untouched, as required). Movement is confined
  to the two cells that carry the defects: rma53d02 `cd0-freeflight` **1/29 → 12/29**
  (M2–5, Eric's primary band, from −25…−33 % to −18.6…+1.1 % against the measured
  free-flight anchors; M10 from −62 % to −16 %), arcas-long `cd-transonic` **4/10 → 8/10**, arcas-long `cd-supersonic`
  **2/5 → 3/5**, arcas-short `cd-transonic` **4/10 → 5/10**. HB-2 (all three series)
  and Basic Finner (all three series) moved **zero rows, byte-identical** — the
  shape-selectivity claim is verified, not asserted.
- **Known-still-wrong, measured (do not oversell this):** (a) the ARCAS *total*
  curve now has a single transonic peak but it sits at **M1.200**, not M1.05–1.10 —
  the fin-wave bridge (linear M0.9→1.2) and the nose bridge (M1.0→1.3) still top
  out at their band ends, so M1.15/M1.2 overshoot the tunnel by +0.071/+0.120.
  That is the §6a **step 3** transonic-rise item, deliberately not attempted here.
  (b) ARCAS supersonic still reads high (+0.017…+0.033 at M1.8–2.95, +0.070 at
  M1.49); the Mach-flat ×1.8 fin-junction factor is worth **+0.0222 (M1.8),
  +0.0172 (M2.95), +0.0112 (M4.65)** and removing it alone would flip six of those
  gates — but it would push rma53d02 and Basic Finner further LOW, so it stays
  bundled and stays Eric's §6a step-2 decision. (c) rma53d02 subsonic still reads
  +26 %/+38 % HIGH at M0.60/M0.91; measured attribution in the scorecard (fully-
  turbulent friction and the `0.12+0.13M²` base law, both carved classic physics).

### RASAero feature #1 Phase 6 — fin thickness-wave transonic shape (same `supersonicAero` flag)

One change, finishing the transonic defect class Phase 5 opened. Full before/after
accounting, the printed curves, and the two measured-and-rejected variants:
`validation/scorecard-phase6-2026-08-25.md`.

- **FinSetCalc — `thicknessWave` / `betaEffThickness`.** Phases 2/3 blended the
  linearized thickness wave drag LINEARLY from zero at M0.9 up to the branch
  value at M1.2 and only then followed `factor·τ²/β`. That branch *decreases*
  with Mach (2.07× larger at M1.05 than at M1.20 for the ARCAS fin), so the
  ramp put the term's maximum at exactly **M1.200 — the top of its own bridge**
  — while the physics it bridged onto was already falling. Measured on the
  re-fixtured ARCAS Long (flag on, Re-matched, fin-only isolation): fin-set
  pressure CD climbed 0.0254 (M1.05) → 0.0673 (M1.20) where the tunnel total
  FALLS 0.085 across the same interval, and the total-CD curve peaked at
  M1.200 instead of the physical M1.05–1.10.
  Phase 6 gives it the Phase-5 boat tail's construction:
  `M ≤ 0.90` zero → smoothstep to M1.05 → `factor·τ²/β_eff` above, with
  `β_eff = max(√(M²−1), √K·[(γ+1)M²τ]^(1/3))`, K = 1.
  The band edges are **RASAero's own regime boundaries** (RASAero II Users
  Manual p.90: Subsonic M0.01–0.90, Transonic M0.91–1.04, Supersonic-Hypersonic
  M1.05–25) — the same pair Phase 5 chose for the boat tail. The peak HEIGHT is
  set by the **transonic-similarity floor**, not by the band edge:
  K = (M²−1)/[(γ+1)M²τ]^(2/3) is the similarity parameter and linearized
  (Ackeret) thin-section theory is valid for K ≳ 1 (Liepmann & Roshko,
  *Elements of Gasdynamics* ch. 12; Ashley & Landahl, *Aerodynamics of Wings
  and Bodies* ch. 12). Freezing β at the K = 1 crossover freezes the branch at
  its last trustworthy value instead of chasing the 1/β singularity to M1; the
  frozen value is `factor·τ²/[(γ+1)τ]^(1/3) ∝ τ^(5/3)`, so the classic
  transonic-similarity scaling of peak section wave drag falls out of the floor
  rather than being asserted. **Measured result:** the fin term now peaks at
  M1.05 and decays; every value at and above M1.20 is bit-identical to Phase 5
  (the floor stops binding at M ≈ 1.13 for a 4.4 % section), so no supersonic
  gate moves. Applied at BOTH flag-on call sites — the `AIRFOIL` cross-section
  path and the feature-#4 `sectionPressureCD` path. The second is
  **flag-gated deliberately**, exactly like the Phase-5 sweep fade: feature #4
  is input-gated, so an ungated change would move CLASSIC numbers for any
  design naming an airfoil section, and classic is desktop parity. Same open
  Eric decision (docs handoff §6a step 2).
- **Deliberately NOT changed: the nose wave bridge.** The task for this pass
  called for the same treatment there. Measuring first killed the premise: put
  through the kernel's own fineness extrapolation at the ARCAS nose's fineness
  4.711, the kernel's own measured TR R-100 streamlined-nose tables ALSO rise
  through M1.05→1.20 (von Kármán +0.0146 CD; the Phase-5 bridge +0.0260 CD), so
  the nose is not a term whose maximum belongs at M1.05. The bridge's literal
  "maximum at the top of its ramp" is worth **0.0001 CD** (0.0601 at M1.275 vs
  0.0600 at M1.3). The literal fix was built and scored anyway — Fleeman
  trusted from M1.05 — and measured **70/164 → 64/164**, making the two rows the
  acceptance test wanted reduced *worse* (Fleeman over-predicts near M1: 0.155
  at M1.05 against the measured von Kármán f=3 table's 0.055). Not shipped;
  nose rows are byte-identical.
- **Also measured and rejected:** dropping the Phase-5 boat-tail plateau and
  trusting exact Prandtl–Meyer from M1.05 — **70/164 → 67/164**, exact PM over-
  predicts the boat tail by **+0.12 CD at M1.05**. The plateau is a working
  transonic limiter, not an artifact.
- **Goldens:** `ssphase6.finwave.*` and `ssphase6.airfoilwave.*` — five samples
  each at M0.85/0.95/1.05/1.10/1.30 (below onset, mid-smoothstep, the peak,
  inside the floored band, plain 1/β branch), unswept so `sweepWaveFactor ≡ 1`
  and the samples isolate the thickness term. They exist because the similarity
  floor introduces the kernel's only cube root and nothing else exercises it —
  every Phase-5 fin golden samples M ≥ 1.5, where the floor never binds.
  Differential 286 → **296 lines, all 10 new lines bit-identical JVM ↔ TeaVM**.
- **Scored:** supersonic **66/164 → 70/164** (the 66 baseline is against the
  ARCAS fixtures as revised at 11:15 on 2026-08-25, after the Phase-5 scorecard
  was written against the earlier boat-tail rear diameter); classic **10/164,
  all 164 rows byte-identical**. Movement is confined to arcas-long
  `cd-transonic` 5/10 → **8/10** and arcas-short `cd-transonic` 5/10 → **6/10**;
  HB-2 moved zero rows, Basic Finner and rma53d02 moved four transonic rows
  between them and no gates, and every CP/CNα row and every gated row above
  M1.20 is byte-identical.
- **Known-still-wrong, measured (do not oversell this):** the acceptance test's
  other half is NOT met. M1.15 got **worse** (+0.0571 → +0.0780 Long,
  +0.0412 → +0.0621 Short) and M1.20 is byte-identical (+0.1055 / +0.0991).
  That is not a shape error and cannot be reached from these bridges: at M1.20
  all three wave terms already sit ON their monotone-decreasing supersonic
  branches. The measured M1.20 budget on ARCAS Long is friction 0.2766
  (including +0.0252 of Mach-flat ×1.8 fin junction) + boat tail 0.3396 + nose
  0.0570 + fin 0.0673 = 0.7405 against a tunnel 0.635 — i.e. the residual is a
  **level** error dominated by the exact-PM boat-tail term in the low supersonic
  band (~40 % over at M1.20, ~17 % at M1.49, right to a few percent at M1.8+).
  Fixing that means real afterbody physics (pressure recovery along the boat
  tail toward the base, Eggers-class second-order shock expansion), and it is
  the next item.

### The ×1.8 fin interference factor — measured, provenance corrected, NUMBER UNCHANGED

Handoff §6a **step 2**. The owner's instruction was "remove the ×1.8 junction factor and
see what happens". It was removed, built, and scored — **and the measurement says do not
remove it.** No physics changed in this pass; both scorecards are byte-identical to the
pass before it (all 328 rows across the two models). Full accounting:
`validation/scorecard-junction-2026-08-25.md`.

- **What actually changed in the tree:** the comment above the factor in
  `FinSetCalc.calculateFrictionCD` (its stated provenance was wrong and had been
  mis-read three times), this entry, and three new golden lines. Artifact md5
  `8456e660a9284f3fcfe2f93131f77188` → `bc0c742d0343d36a83e0a213f3159da7`; the md5
  moved because the harness grew, not because a number did.
- **Provenance, corrected.** The factor is a port of **RASAero II's own "Fin
  Interference" drag component**, not an ARCAS calibration. RASAero's Run Test output
  prints it at **0.84 × the fin friction term at both ends of its Mach range** — *RASAero
  II Users Manual* p.90 (M0.50: Fin Frict&Press 0.050, Fin Interference 0.042; the eight
  printed components sum to the printed CD 0.481 exactly) and p.92 (M2.00: Fin Frict
  0.037, Fin Wave 0.067, Fin Interference 0.031). Our 0.8 reproduces that to 5 %.
  The old comment's anchor — the ARCAS fins-on/fins-off increment — is **not** a valid
  calibration target: it also contains the tunnel model's fin-anchor brackets, which
  RASAero books in a **separate Protuberance column** (manual p.92 note; its ARCAS deck
  slide 2 says the anchors were entered as a rail guide), and fin LE bluntness this
  kernel charges only when `finLeRadius` is given. Read literally it asks for
  **2.08–2.28×**, not 1.8×.
- **It is not junction interference in the Hoerner sense.** A junction is a corner effect
  whose drag area scales with t²; this scales with fin wetted area × Cf. Implied
  per-junction coefficient across the three finned cells: **0.92** (ARCAS, t/c 0.044),
  **0.47** (Basic Finner, t/c 0.080), **0.52** (RM A53D02, t/c 0.039) — a factor of two
  apart and not tracking thickness. A correctly-scaled junction term would be ≈0 for the
  2–5 % sections rockets use, i.e. indistinguishable from deleting it.
- **Removal measured (flag-on, factor 1.0):** gate score 70/164 → **71/164**, but that
  +1 is tolerance-edge luck. Row-level, **65 of the 83 gated CD rows move AWAY** from the
  data and 18 move closer, and the scale-free aggregate (RMS of |delta|/tol over all 164
  gated rows) goes **2.455 → 2.595**. Both tester flights over-predict further:
  Buckeye's Mach 2 Buster 19,623 → 20,905 ft against 18,006 ft GPS, LEM-IV 12,155 →
  12,765 ft against a three-altimeter 11,755 ft.
- **Intermediates measured too:** 1.2 → 73/164 (RMS 2.548), 1.4 → **76/164** (RMS 2.509).
  1.4 wins the gate count and loses the accuracy aggregate and both flights; it has no
  source, and picking it would be fitting to the anchors. Shipped value stays 1.8.
- **The six ARCAS supersonic gates removal would flip cannot be attributed to this term**:
  TN D-4013's fins-off data stops at M1.2. Below M1.2, where the data exists, 1.8×
  leaves our fin increment **14–39 % short** of the measured one and our *body*
  **+10…+19 % over** — the term is under-charging fins, not over-charging them.
- **Measured for the owner, deliberately NOT enabled:** applying the term in BOTH models
  (§6a step 2's "baseline for everyone at all speeds"). Classic 10/164 → **12/164**, RMS
  5.279 → **4.970**, **80 of 83 gated CD rows closer** and 3 worse; LEM-IV +7.3 % →
  **+2.2 %**, Buckeye +19.4 % → **+11.9 %**. It is the option the data supports and it
  **breaks desktop-OpenRocket parity**, so it is the owner's call, not this pass's.
- **Goldens:** new `ssjunction.0.3 / 0.6 / 0.85` lines pin flag-off AND flag-on total CD
  and friction CD on the reference rocket at three subsonic Mach numbers — the regime the
  factor actually changes for most users and the one nothing pinned (every `ssaerocd`
  sample sits at M1.2 or above). Square-section fins, so the Phase-2 AIRFOIL pressure
  change cannot contaminate the off→on ratio. Differential **296 → 299 lines, all 3 new
  lines bit-identical JVM ↔ TeaVM**. They also print the user-visible size of the term:
  at M0.30 the reference rocket's CD goes 0.998023 → 1.077198 (**+7.9 %**) on the flag
  alone, friction 0.426869 → 0.507707 (+18.9 %).

#### Follow-on the same day: Mach-dependence tested and REFUTED; still ×1.8, still flat

The recommended follow-on to the entry above was to make the factor Mach-dependent —
full strength subsonically, fading to ~1.0 by M1.5–2
(`docs/research/trf-aero-research-2026-08-25.md` §1.3). **It was tested against the only
Mach-resolved data that exists for the quantity and it does not survive.** No kernel
change; the comment in `FinSetCalc.calculateFrictionCD` is the only edit, and the
artifact rebuilt **byte-identical** (`bc0c742d0343d36a83e0a213f3159da7`, confirmed
through a forced full TeaVM regeneration). Full accounting:
`validation/scorecard-finsoff-2026-08-25.md`.

- **The data says flat, to 0.26 %.** RASAero's printed Fin Interference component is
  **0.042 / 0.050 = 0.840** at M0.50 (Users Manual p.90) and **0.031 / 0.037 = 0.838** at
  M2.00 (p.92). Both rows were re-extracted from the PDF and their columns verified by
  sum against the printed CD (0.481 exactly; 0.630 vs 0.631). From 3-decimal rounding
  alone the ratios span [0.822, 0.859] and [0.813, 0.863] — **overlapping over 100 % of
  the subsonic band**, so a constant ratio fits both rows. A fade to ×1.0 needs Fin
  Interference ≈ 0 at M2.00; the manual prints 0.031 there, **4.9 % of that run's total
  CD**. There is no third point: the transonic regime prints no component breakdown at
  all, in either manual.
- **The physical premise was already void.** The fade's argument is that junction /
  horseshoe-vortex interference is a subsonic boundary-layer effect — but the entry above
  established this is **not** a junction term. The reasoning does not attach to it.
- **The supersonic "we run long" half is now attributed to the BODY.** New fins-off gates
  (below) measure our body at **+8.3 % / +17.9 %** at M0.60; carried forward at that rate
  it accounts for **53–139 %** of the ARCAS-Short supersonic overshoot and **194 %+** of
  ARCAS-Long's — all of it, before the fins are touched. Fading the factor would take
  drag off a fin set that is already **10–38 % short** where it can be measured, to pay
  for a body error. That is a compensating-error trade, not a fix.
- **New gates that make this checkable instead of arguable** (`validation/`, not a kernel
  change): `arcas-short-finsoff` / `arcas-long-finsoff` gate TN D-4013's fins-off (body
  only) CD at M0.60, 164 → **166 gates**. Both **FAIL HIGH in both models**; classic
  10/164 → 10/166, supersonic 70/164 → 70/166, with every pre-existing row byte-identical.
  The pair also measures, for the first time, that our skin friction on 12.55 in of added
  body length is **2.05× the tunnel's** and 100 % friction — a direct reading on the
  fully-turbulent-only defect, and the reason the body error grows with length.

### Boundary-layer transition exposed, and the PARITY BOUNDARY enforced (2026-08-25)

Three edits, one ruling. Eric's standing ruling of 2026-08-25 (`docs/working-notes.md`)
says only **"OpenRocket — Extended Barrowman"** is a parity commitment; Rogers Kbf and
Supersonic are decided on accuracy alone, and *"anything that currently moves CLASSIC
numbers away from desktop must move OUT of classic"*. Full measurement:
`validation/scorecard-transition-2026-08-25.md`.

- **aerodynamics/BarrowmanCalculator.java — `partialLaminar()` (NEW).** OpenRocket carries
  a partial-laminar friction branch gated on `Rocket.isPerfectFinish()`: fully laminar
  (Blasius) below Re 5.39e5, turbulent minus a `1700/Re` laminar-run credit above, a
  weaker compressibility correction, and roughness limiting only above Re 1e6. **In
  OpenRocket 24.12 it is dead code** — `perfectFinish` defaults false (Rocket.java:83),
  the .ork format does not store it, no UI writes it, and the only call anywhere in the
  release passes `false` (TestRockets.java:768, :962). So the long-standing claim that
  "desktop users can set it and ours cannot" was wrong: *nobody* could set it. It is now
  reachable (`OrkEngine.setPerfectFinish`) and gated to the non-parity models, so no
  bridge call can move a classic number. **Default OFF in every model, including Kbf** —
  the evidence for that is in the scorecard, and it is the honest answer, not a
  cautious one:
  - The one cell that could arbitrate it, ARCAS fins-off, was **boundary-layer tripped**
    (TN D-4013 p.4). Fully turbulent is the correct model there.
  - The `1700/Re` credit is analytically independent of body length
    (`ΔCD = 1700·ν·π·d /(V·S_ref)` for a cylinder) and measures as such: it moves the
    Short→Long friction increment by 2.1e-4 and the over-scaling ratio from **1.85× to
    1.84×**. It cannot be the cause of the friction-vs-length defect it was suspected of.
  - Above M1.1 the branch ADDS friction (+19 % at M2, +43 % at M3, +67…+73 % at M4) —
    a laminar compressibility law (1+0.045M²)^-0.25 in place of the turbulent
    (1+0.15M²)^-0.58, at Re 1e7 where the layer is turbulent (Van Driest II wants ≈0.46
    at M4, this gives 0.87). Forcing it on wins Kbf **+10 gates** — and every one of them
    comes from that error, while the fins-off cell it was meant to fix goes **1/11 → 0/11**
    and the ARCAS transonic cells lose two. It also bypasses the Phase-4 VD-II fit.
- **barrowman/FinSetCalc.java — the ×1.8 fin interference factor now runs in Kbf**
  (`rogersKbf || supersonicAero`). `scorecard-junction-2026-08-25.md` had measured this
  as "the option the data supports … not a change to make without Eric"; Eric ruled.
  Re-measured on the 175-gate anchors: Kbf **15 → 17 gates**, aggregate RMS |Δ|/tol
  **4.928 → 4.617**, **80 of 102 gated CD rows closer / 3 worse / 19 unchanged**, and on
  the tester flights LEM-IV **+7.3 % → +2.2 %** and Buckeye **+19.4 % → +11.9 %**.
  Classic and Supersonic byte-identical. **The DEFAULT model's numbers moved** — say so
  in the changelog.
- **barrowman/FinSetCalc.java — `airfoilSection` is no longer honoured in classic**
  (feature #4 was input-gated, so naming a section replaced desktop's pressure-drag model
  in the parity model too; desktop's FinSet knows only the three-valued CrossSection).
  Proven: with the gate in place, the classic sweep for all four finned fixtures is
  **bit-identical (worst |Δ| = 0 over 199/419 Machs, every drag component and CP)** to the
  same fixture with the section inputs deleted. Cost, stated plainly: classic
  **11 → 10 gates**, RMS **5.634 → 6.075**, 122 classic rows moved — because classic now
  charges the carved rounded-LE plateau on `crossSection: airfoil` fins, which is
  desktop's own known weakness and the reason feature #1 Phase 2 exists. Kbf and
  Supersonic byte-identical.
- **aerodynamics/BarrowmanCalculator.java — nozzle-exit power-on base drag (feature #2)
  gated the same way.** Same species, found while doing the above: the identifier
  `NozzleExitDiameter` appears in exactly two files in the 24.12 release, both under
  `file/rasaero`, and nothing in `core/aerodynamics` reads it — so our power-on base
  recovery was ours alone and was applying in the parity model. No validation row moves
  (all 175 gates are power-off, no fixture sets a nozzle); the engine test
  `flies a minimum-diameter rocket` moves 333.4645 → **329.6097 m** and the golden
  `flight.mindia` with it, which is the fix doing exactly what it says.
- **Goldens:** `transition.paint.*` / `transition.polished.*` (4 Mach × 2 surfaces × 3
  models × 2 settings — they RECORD the gate as an equality, the laminar-run credit,
  and the supersonic compressibility swap; the *paint* rows also record that the setting
  is a **no-op subsonically for a normally-finished rocket**, because the roughness limit
  binds in both branches, which is why the LEM-IV flight moves by 0.002 m),
  `parity.airfoilsection` and `parity.nozzlebase` (both sides of both boundaries).
  Differential **299 → 309 lines**, all 10 new lines JVM↔TeaVM clean.
  Corrected 2026-08-25b: "record", not "pin". difftest compares a JVM run to a
  TeaVM run with **no stored baseline**, so a golden line cannot catch a change
  that moves both runtimes together — it catches a MISCOMPILE. The behavioural
  guards for these three gates are in `packages/engine/src/orkEngine.test.ts`
  ("fin airfoil sections", "nozzle-exit power-on base drag is gated to the
  non-parity models", "perfectFinish … inert in the parity model"), which run
  under `npm test`. `parity.airfoilsection` / `parity.nozzlebase` also gained a
  supersonicAero-only column that same day, because both gates are
  `(rogersKbf || supersonicAero)` and only the first disjunct was exercised.

## Performance patches (behaviour-preserving — bit-identical goldens REQUIRED)

Added 2026-08-26 after a beta tester reported 40-second flights and repeated
"page not responding" dialogs (`docs/testing/issues-2026-08-26a.md`). None of
these changes physics: each was landed only after `gradlew goldenJvm` produced a
**zero-line diff against the pre-patch kernel across all 309 golden lines**, and
the JVM↔TeaVM differential stayed clean. That two-oracle rule is not optional
here — the differential alone CANNOT catch a change that moves both runtimes
together (see the harness note above), and every patch in this section is
exactly the kind of change that would move both.

**Why these are ours to make and not TeaVM's.** `fastGlobalAnalysis = true` in
`build.gradle` is required — dropping it still prunes reachable virtual methods
on TeaVM 0.15, verified 2026-08-26 (`$c.$getFinCount is not a function` at
AGGRESSIVE, `$component.$getRotationalUnitInertia is not a function` at NONE, so
it is the dependency ANALYZER, not the optimizer). And `TeaVMTool` forces
`optimizationLevel = SIMPLE` whenever fast analysis is on:

    vm.setOptimizationLevel((fastDependencyAnalysis || incremental)
        ? TeaVMOptimizationLevel.SIMPLE : optimizationLevel);

So the `optimization = NONE` line beside it has never had any effect — builds at
NONE, BALANCED and AGGRESSIVE are byte-identical, verified — and TeaVM performs
**no** inlining, scalar replacement or loop-invariant motion for us at all.
Measured JVM:TeaVM ratio on the same kernel and designs: **11–16×**. The
optimizations the compiler cannot do, we do by hand, in the places a CPU profile
points at.

### rocketcomponent/RocketComponent.java — memoize getComponentLocations()

- **Why:** the single hottest method in a flight (~45 % inclusive, recursion-safe
  measure, on a LEM-IV run of 2,336 RK4 steps / 634 stored samples; 2.38 M
  calls). It recurses to the rocket root allocating a
  `Coordinate[]` and a `Transformation` (`double[3][3]`) at every level, and
  recurses AGAIN into `getComponentAngles()`, so one call at depth d costs
  O(d²) allocations. The automatic ring-radius accessors reach it through
  `toRelative` twice per accessor, per ring, per RK4 sub-step, all flight — on
  geometry that cannot change while a simulation runs.
- **Change:** a `private Coordinate[] locationsCache` field, returned when set;
  cleared in `componentChanged(ComponentChangeEvent)` — the hook upstream's own
  javadoc nominates ("subclasses may override this method to e.g. invalidate
  cached data"), which every component receives on every event — and cleared in
  `clone()`, because `super.clone()` is a shallow field copy and
  `copyWithOriginalID` detaches the clone from the parent chain the memo was
  computed against.
- **Safety:** the array is never mutated by a caller (`toAbsolute`/`toRelative`
  both allocate their own results; `ParallelStage.getComponentBounds` only
  reads). No subclass overrides `getComponentLocations`. FIVE subclasses override
  `componentChanged` — FinSet, LaunchLug, RailButton, SymmetricComponent,
  Transition — and all five call `super` unconditionally (FinSet's call sits
  outside its `if`, so it fires for every event type). Nothing in `simulation/`
  fires a ComponentChangeEvent, so a flight never invalidates it and an editor
  edit always does.
- **Also:** `toRelative` had `this.getComponentLocations()[0].add(c)` INSIDE its
  loop though it is loop-invariant; hoisted. `destLocs.length` is 1 on every
  single-instance design, where the hoist saves nothing — but where `dest` is a
  clustered or multi-instance component it removes a full recursive walk per
  extra instance. Free, correct, and an upstreamable bug report.
- **Upstreamable:** yes, both halves.

### masscalc/MassCalculator.java + rocketcomponent/FlightConfiguration.java — memoize structure mass

- **Why:** `AbstractSimulationStepper.calculateStructureMass` runs four times per
  accepted RK4 step, and upstream recomputes the whole rocket's structure mass
  from scratch every time — `MassCalculator`'s own cache fields have been
  commented out since at least 24.12 and its `modID` is dead. Measured: 9,726
  full tree walks on a LEM-IV flight (2,336 RK4 steps x 4 derivative evaluations,
  plus the descent stepper's own calls), collapsing to 3 — one per distinct
  (configuration, mass-state) pair reached during the run.
  Structure mass excludes motors and propellant, so nothing about it can move
  during a flight.
- **Change:** `calculateStructure(config)` consults and populates a memo held on
  the FlightConfiguration, keyed on that configuration's modID AND the rocket's
  `massModID` — the same idiom upstream already uses for `cachedBounds`
  (`boundsModID`) and `cachedRefLength` (`refLengthModID`), invalidated in the
  same `fireChangeEvent()` and reset in the same `clone()`/`copy()`.
- **Why on FlightConfiguration and NOT on a component:** `clone()`/`copy()` there
  build a fresh object, so a stale memo cannot ride into a copy. A component-level
  radius memo was tried and measurably moved apogee, because `Object.clone()`
  (and TeaVM's `Platform.clone`) copy the field wholesale.
- **Deliberately BELOW the listener hooks:** `AbstractSimulationStepper` fires
  `firePreMassCalculation`/`firePostMassCalculation` around its call, so a
  simulation listener still sees every step.
- **`RigidBody` is immutable** (all fields final; `add`/`rebase` return new
  instances), so sharing the cached instance is safe.
- **NOT done, deliberately:** memoizing `CenteringRing.getInnerRadius` /
  `RadiusRingComponent.getOuterRadius`. Those accessors are ~100 % downstream of
  this cache — it removes essentially all of their calls — and a component-level
  memo there is the unsafe one described above. Do not re-file it.

### aerodynamics/BarrowmanCalculator.java — skip checkGeometry when its output is discarded

- **Why:** `calculateNonAxialForces` calls `checkGeometry` on every aerodynamic
  evaluation, i.e. four times per RK4 step. `checkGeometry` decides whether two
  radii are "discontinuous" by FORMATTING both as display strings and comparing
  the text — deliberate (that is the user-visible definition of a step in the
  airframe) but expensive: over a million number-to-string conversions per flight
  on one corpus file, producing five distinct answers, plus four `toAbsolute()`
  tree walks per symmetric pair.
- **Change:** one guard — `if (warnings != ignoreWarningSet) checkGeometry(...)`.
  `ignoreWarningSet` is the sentinel this method substitutes for a null
  WarningSet, and across the whole of OpenRocket 24.12 (core AND swing) that
  field is only ever assigned into a local and **never read back**. Work whose
  only sink is that set is discarded by construction.
  `RK4SimulationStepper` passes null whenever `SimulationStatus.recordWarnings()`
  is false — before launch-rod clearance, for 0.25 s after, and through the whole
  low-speed descent, which on a design with no recovery device is most of the
  flight.
- **Identity compare, NOT `warnings != null`:** `getAerodynamicForces` substitutes
  the sentinel at its own call site BEFORE invoking this method, so by the time
  the guard runs `warnings` is never null and a null test would skip nothing.
- **Divergence from upstream:** yes — 24.12 calls `checkGeometry` unconditionally.
  Every geometry warning the app consumes (`simWarnings.ts`: DISCONTINUITY,
  OPEN_AIRFRAME_FORWARD, AIRFRAME_GAP, AIRFRAME_OVERLAP, PODSET_FORWARD,
  PODSET_OVERLAP, ZERO_VOLUME_BODY) is still produced, because those runs pass a
  real WarningSet. Upstreamable.

### Measured effect of the three together

Same machine, same designs, cold node process per point, classic model, each
design's own time step. Physics bit-identical throughout (309/309 golden lines).

| design | v0.070 | patched | |
|---|---|---|---|
| LEM-IV (2).ork | 6921 ms | 1899 ms | 3.6× |
| Mach2.trf.ork (dt 0.01) | 36434 ms | 12161 ms | 3.0× |
| 38-54 2-stage.ork | 17120 ms | 4740 ms | 3.6× |
| SS Wild Bash v0.rkt | 16017 ms | 6312 ms | 2.5× |
| test01.ork (dt 0.01) | 3094 ms | 1728 ms | 1.8× |
| complexj.ork | 3408 ms | 2080 ms | 1.6× |

The designs that gain most are the ones with the most automatic-radius ring
components (centering rings, bulkheads, tube couplers) — which is exactly the
"some files were fine and some were super slow" pattern from the report.

## Rules

1. A patch NEVER changes physics or observable behavior (except documented quirks-ledger
   bug fixes, the documented FEATURE patches above, and the PERFORMANCE patches above —
   which change nothing observable BY CONSTRUCTION and must prove it with a zero-line
   `goldenJvm` diff against the pre-patch kernel, not just a clean differential).
2. Prefer shims over patches; patch only when the carved file itself must change.
3. On upstream upgrade: re-diff every patched file against its new upstream version and
   re-apply the minimal change.
