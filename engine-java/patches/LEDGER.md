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
- **Why:** `InstanceMap extends HashMap<RocketComponent, ...>` and `RocketComponent`
  has no `hashCode()` override, so iteration order follows *identity hash codes*,
  which vary per JVM process (HotSpot's identity-hash PRNG is time-seeded).
  `BarrowmanCalculator` iterates this map when accumulating per-component forces
  every simulation step; a run-to-run change in FP summation order produces
  ULP-level differences that chaos-amplify over a flight. Observed 2026-07-03: the
  same golden harness produced different `flight.*` lines (different sample counts,
  e.g. 866 vs 867 rows in the windy scenario) across two fresh JVM runs — making
  the bit-identical JVM↔TeaVM differential intermittently impossible to pass.
  Reproduced under `-Xint`, so not JIT-related.
- **Change:** `extends HashMap` → `extends LinkedHashMap` (import + extends, 2
  tokens). Iteration becomes insertion order — the deterministic configuration
  tree-walk order — identical on JVM and TeaVM.
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

## Rules

1. A patch NEVER changes physics or observable behavior (except documented quirks-ledger
   bug fixes and the documented FEATURE patches above, which get their own section here).
2. Prefer shims over patches; patch only when the carved file itself must change.
3. On upstream upgrade: re-diff every patched file against its new upstream version and
   re-apply the minimal change.
