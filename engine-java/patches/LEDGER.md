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

## Rules

1. A patch NEVER changes physics or observable behavior (except documented quirks-ledger
   bug fixes and the documented FEATURE patches above, which get their own section here).
2. Prefer shims over patches; patch only when the carved file itself must change.
3. On upstream upgrade: re-diff every patched file against its new upstream version and
   re-apply the minimal change.
