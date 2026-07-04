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

## Rules

1. A patch NEVER changes physics or observable behavior (except documented quirks-ledger
   bug fixes, which get their own section here with upstream issue links).
2. Prefer shims over patches; patch only when the carved file itself must change.
3. On upstream upgrade: re-diff every patched file against its new upstream version and
   re-apply the minimal change.
