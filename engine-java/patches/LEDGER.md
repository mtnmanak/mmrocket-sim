# Patch ledger

Every file in `patches/` REPLACES the same-relative-path upstream file during carve
(`scripts/carve.mjs`). Patches must be minimal, documented here, and re-audited when
upgrading the upstream OpenRocket version. Diff a patch against upstream with:

```
git diff --no-index <openrocket-src>/<path> patches/<path>
```

## Active patches (all: TeaVM classlib gaps — not behavior changes)

### aerodynamics/BarrowmanCalculator.java - experimental Hybrid (2026-10-02 sandbox)
- **Why:** retain the Kbf force law below an experimental Mach band and the
  Supersonic force law above it, without changing flags on cached calculators.
- **Change:** `hybrid(low, high)` creates a Barrowman subclass with two permanent
  endpoint calculators: Kbf `(true,false)` and Supersonic `(true,true)`. It returns
  endpoint objects directly outside the band and smoothstep-blends complete forces
  inside. CP uses blended CNalpha first moments in all three coordinates; zero
  weight follows `AerodynamicForces`' `MathUtil.equals(0, weight)` convention.
  Final Cm/Cyaw are already damped; reported damping is blended separately, never
  subtracted twice. Each endpoint finishes its own drag/override scratch calculation.
- **Integration:** preserves `newInstance`, stall margin, CP/worst-CP and force
  analysis. The subtype and its Kbf flag retain RK4's pressure-thrust admission.
  The bridge selects it for static info, drag sweeps and simulations, opt-in only;
  defaults are Mach 0.8-1.2, with finite `0 <= low < high` bridge validation.
  Existing endpoint code and default/Auto selection are unchanged.
- **Evidence:** `packages/engine/src/hybridAero.test.ts` checks all 19 numeric
  force/CP fields, exact endpoints, the smoothstep law, reverse crossings, bounded
  0.005-Mach steps, preview/component sums and zero normal-force weight.
  `pressureThrust.test.ts` exercises Hybrid with the same pressure-thrust formula
  and staging/pod cases as the existing models. Review regressions use the bridge's
  `getAeroDiagnostics` to exercise getCP/getWorstCP at Mach 0.3 inside a custom
  band, asymmetric rounded freeform fins, newInstance band retention, and signed
  stall margins. The diagnostic clone switch calls the actual newInstance method.
  Sandbox build, golden comparison,
  differential checks and mutation results are recorded in `CODEX-REPORT.md`.
- **Limit:** the band and blend are an experiment, not a measured aerodynamic
  improvement or permission to change the default. No endpoint equations changed.

### simulation/BasicEventSimulationEngine.java
- **Why:** TeaVM 0.15's `java.util.Formatter` does not implement the `%g`
  conversion; the STAGE_SEPARATION handler logs `String.format("==>> @ %g; ...")`
  and threw `UnknownFormatConversionException` on EVERY staged flight under JS.
- **Change:** that one log line: `%g` → `%s` with `Double.toString(...)`.
  Log-only (stderr); zero physics/goldens impact. Found by the staging golden
  scenarios (2026-07-03, Phase 3 Release B).

### rocketcomponent/FreeformFinSet.java (audit 2026-09-22)
- **Why:** the same TeaVM `%g` gap, in the one place it could still be reached.
  `setPoints` refuses an outline that crosses or touches itself (a repeated point does it)
  and rolls back to the previous outline — on a fin set the bridge has just built, the
  constructor's DEFAULT fin — and reports the refusal through two `log.warn(String.format(
  "... (%g, %g) ..."))` lines in `intersects(int)`. On the JVM that logged and the build
  "succeeded" with a fin the design does not draw; under TeaVM the log line itself threw
  `UnknownFormatConversionException: Unknown format conversion: g` out of `buildTree`, which
  refused the build but named nothing. The two runtimes DISAGREED outright, and difftest never
  saw it because no golden ran the path. Audit 2026-09-22, "Degenerate values fail the whole
  build" (the kernel half; the app-side sanitize is separate).
- **Change (three lines changed in place, one block appended):** the two log lines `%g` →
  `%s` with `Double.toString(...)`, exactly as in BasicEventSimulationEngine; `if
  (intersects())` in `setPoints(ArrayList, boolean)` → `if (outlineRefused = intersects())`
  (the same single call); and a `private boolean outlineRefused` + `public boolean
  isOutlineRefused()` appended after upstream's last line. Nothing is inserted above line 609,
  so every line number upstream has — and the app's comments cite (`tree/finOutline.ts`,
  `position.ts`, `solidMesh.ts`, `FinPointsEditor.tsx`) — still holds in the carved copy.
- **The bridge half (not a patch — `api/ComponentFactory.java`):** the freeformfinset case
  now calls `setOutline(fins, pts, node)`, which runs `setPoints` and throws
  `Fin set "<name>": its outline crosses or touches itself, so it cannot be simulated.
  Redraw it in the fin editor.` when `isOutlineRefused()`. Deliberately NOT "roll back like
  the desktop": a design that silently flies the default fin while drawing its own is the
  worse outcome, and it is what the plain `%g` → `%s` alone would have produced in the
  browser — the app's kernel-agreement test (`finOutline.test.ts`, "rejects what buildTree
  dies on") pins the refusal. A DIVERGENCE from desktop's silent substitution, in the bridge,
  in all three aero models.
- **Oracle:** new goldens `freeform.outline.valid/crossing/repeated`
  (`freeformRefusalScenarios()`, appended at the end). **Before the fix difftest FAILED on
  exactly the two refused lines** — JVM `freeform.outline.crossing.info|0.575|...` (the
  default fin: its tip runs 25 mm aft of its root, so the rocket reads 0.575 m against the
  valid outline's 0.55 m) against TeaVM `freeform.outline.crossing.refused|Unknown format
  conversion: g`. After: both runtimes print the same named refusal; differential 377 → 380
  lines, clean (252 bit-identical, 128 within tolerance), and all 377 existing lines — the
  freeform and fillet goldens included — are bit-identical to before.
- **Behavioural guard:** `packages/engine/src/freeformOutline.test.ts` (the named message for
  a crossing and a repeated-point outline, the id fallback, and a valid outline still
  building at its own length). The first two fail against the pre-fix artifact.
- **Artifact:** md5 `dafd535038530da83eacef3083d33f19` → `ee941192e22db85624dd5ed9fd0a03fb`;
  `isOutlineRefused` 0 → 4 occurrences and the `between (%s` format string present.
- **Other `%g` left in the kernel, recorded not changed:** `FinSet.getPointDescr` (`%6.4g`;
  upstream marks it "for debugging", and only `toDebugDetail` calls it) and
  `BoundingBox.toString` (`%g`) — debug and `toString` output only; a grep of the carved
  sources, the patches and the bridge found no build or simulate path calling either. Same fix
  if one ever becomes reachable.

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

## Simulation correctness fixes

### simulation/SimulationStatus.java + simulation/BasicEventSimulationEngine.java (K9, 2026-09-30)
- **Why:** upstream 24.12 computes an effective launch rod length from launch lugs
  in SimulationStatus, but never uses it at the clearance check: BasicEventSimulationEngine
  compares travel with the full rod length. A lug above the rocket's aft end therefore
  gets excess guided travel and an overstated rod-exit speed. Rail buttons are ignored,
  and the lug search checks only instance [0], the forward instance of a line of guides.
  Register: `docs/open-items.md`, K9 - Rod clearance ignores the effective lug-aware length.
- **Change:** the clearance check uses `getEffectiveLaunchRodLength()`.
  SimulationStatus searches every absolute instance of every active launch lug and rail
  button for the aft-most guide point: lug origin + length, or button centre + outer
  radius. Effective travel is the rod length less the gap from that point to the
  rocket's aft bound, clamped at zero, following the existing length calculation.
- **Protuberance marker:** `engineTree` emits `launchGuide: false` on every
  synthetic RailButton carrier. `api.ComponentFactory` translates that key into
  the component comment `SimulationStatus.NOT_A_LAUNCH_GUIDE`
  (`mmrsim:not-a-launch-guide`); SimulationStatus skips marked buttons in its
  guide search. A comment is otherwise non-functional: it changes no mass, drag
  or geometry and needs no new component field. The marker is core-typed and
  defined in the core SimulationStatus class, so the API bridge references core;
  core never imports an API type across the api/core boundary. An absent flag
  leaves a real button eligible for guidance, including zero-mass/Cd overrides.
- **Why a patch, not a shim:** these are kernel geometry and flight-event decisions,
  not missing Java class-library methods. Correcting a displayed velocity alone would
  leave the rocket mechanically constrained for too long in the simulated flight.
- **Unchanged:** with no lug or button, the full rod length is used (tower semantics).
  Protuberance carriers do not count as guides and preserve that tower behaviour.
  A guide whose aft edge reaches the rocket's aft end also uses the full length.
  Guide mass and drag still apply; the tests override both to isolate clearance.
- **Behavioural guard:** `packages/engine/src/orkEngine.rodClearance.test.ts` flies the
  reference C6 curve on a tilted 1 m rod: no guide, aft lug, raised lug, and a forward-first
  pair of buttons against a lug at the aft button's aft edge. Distances allow one
  integration step of travel; comparisons do not store kernel float goldens.
  The same suite requires a lone `launchGuide: false` button to match the tower's
  exit exactly, while the same unmarked button shortens guided travel.
  `packages/app/src/tree/treeModel.test.ts` pins the flag on every protuberance
  class and its absence on real rail buttons and launch lugs.
  `packages/app/src/services/simReport.kernel.test.ts` pins that the report reads the
  departure at the kernel-reported effective length, at or before the kernel's
  end-of-step LAUNCHROD event.
- **One function, reported to the app:** upstream's inline constructor block is lifted
  into `public static double effectiveLaunchRodLength(FlightConfiguration, double)` on
  SimulationStatus; the constructor calls it, and `api.OrkEngine.simulate` calls it on
  the configuration it is about to fly and prepends `effectiveLaunchRodLength` to the
  result JSON. The app's launch report interpolates the rod-exit speed at that length
  (v0.097's crossing interpolation); without it the report could interpolate only at the
  full rod length, past the true departure whenever a guide sits above the aft end.
- **Impact:** measured: see the corpus comparison.

### simulation/SimulationStatus.java - rail lines and stations (K9-A1, 2026-09-30)
- **Ruling:** Eric's two-button rule, amended after Gemini's independent physics
  review accepted by the orchestrator (CODEX-AMEND-1.md). Rail buttons group by
  absolute atan2(z,y) azimuth with a 1 degree tolerance, wrapping at +/-180.
  On-axis (y=z=0) instances form their own line and never supplement other lines.
  **K9-A2 (same day, review finding):** candidate lines are WINDOWS, not a
  partition — for every button, the buttons within 1 degree above its azimuth (with
  wrap) form one candidate, and the best candidate's second station guides. The
  first cut (sort, cut at the largest angular gap, group greedily from each line's
  first angle) could hand one button of the only usable pair to a neighbour's group:
  buttons at 0 deg (forward) and 0.9 deg (aft) plus a third at -0.5 deg beside the
  forward station flew ZERO guided distance. Any set within 1 degree lies inside the
  window anchored at its lowest angle, so no usable line can be missed. Regression:
  orkEngine.rodClearance.test.ts "a neighbour below the pair cannot split it" and its
  rotated twin — both fail on the greedy code, pass on the windows (37/37).
- **Stations:** within a line, edges within 0.5 mm of its aft-most station edge
  are one station, not independent guides. Sort aft-first; the second distinct
  station's most-aft edge controls. Choose the most-aft such point over usable
  lines. Absolute coordinates include all parent/pod/strap-on instances. Keep K9's
  lug +length and button +outerRadius edges and ignore marked carrier buttons.
- **Alternative launchers:** lugs alone use the aft-most lug. Buttons alone use
  the best usable line, or zero distance if none has two stations. With both a
  lug and usable rail, use the SHORTER clamped guided travel. With lugs and only
  unusable button lines, the lug controls and ignoredButtons explains that choice.
- **Shared result:** launchGuide(configuration, length, allowance) returns length,
  reason (none, lug, buttons, single-button, mixed-lug, mixed-buttons, off), and
  ignoredButtons. Ties between viable launchers choose mixed-lug. The constructor
  and API use this one calculation; an AbstractSimulationListener.startSimulation
  applies it before flight, and stage status copies retain the flown length.
  guideAllowance defaults true; off uses full entered length. The bridge reports
  effectiveLaunchRodLength, launchGuideReason, and launchGuideIgnoredButtons.
- **Zero distance:** the first-pass t=0 LAUNCHROD insertion was REMOVED after the
  review. The existing clearance check runs at/after LIFTOFF (the 2 cm threshold).
  The report reads speed, time, AoA and thrust:weight at that kernel event, with
  no synthetic zero speed. Ground handling has not been changed.
- **Rail slides:** a long angle-holding guide/slide is modelled as a launch lug;
  no button-size heuristic. The UI and guide explain this distinction.
- **Verification:** expanded rodClearance guards cover line/station tolerances,
  wraps, pods, axis-line isolation, mixed launchers and liftoff ordering. App tests
  pin the event-state metrics and every reason/note. Delegate cannot build TeaVM;
  Claude must rebuild, verify shipped symbols, run engine mutations and difftest.

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
  **Since 2026-09-22 only from the stage's AFT-MOST base** (`isStageAftBase`): until then
  every base in the stage took an area of its own, pods and step-downs included — see
  "Correctness fixes", *the power-on nozzle credit lands on the stage's aft-most base*.
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
Net effect: CP moves slightly AFT, which **RAISES the static margin the app shows** — static
margin is `(xCP − xCG)/d` with x increasing aft, so "aft" is not "conservative", and this line
said *"more conservative margin"* until **2026-09-21**. It is the closer answer for the
geometries it was validated against, not automatically the safer one; on an erroneous aft
prediction it overstates how much margin the rocket has. *(Correction prompted by Ken Karbon,
Apogee Peak of Flight 687, which measures the base's own contribution to CP at 0.0015 caliber.)*
Two files + bridge:

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
  parent body + aft symmetric siblings; fins flush with the base get half carryover; since
  2026-10-08 the walk follows stations and an overhanging fin's overhang uses up the following parts -
  see the row 75 entry below).
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
- **barrowman/FinSetCalc.java — the sharp-AIRFOIL pressure model now runs in Kbf**
  (`(supersonicAero || rogersKbf) && crossSection == AIRFOIL`), 2026-08-27, v0.075.
  The owner's ruling, after the "subsonic only" middle path was measured and rejected:
  the classic transonic branch starts at `cd = 1.0` and is only meaningful as the
  continuation of the subsonic `(1−M²)^−0.417` rise it follows, so gating this branch at
  M0.90 leaves the top floating and puts a **step of +1.21 in fin pressure CD between
  M0.90 and M0.91** — a discontinuity in CD at the transonic onset, worse for an adaptive
  RK4 than the error it removes. All-Mach is the coherent form.
  **CONTAINMENT, measured artifact-vs-artifact over M0.1–3.0 on four cross-sections ×
  three models:** the ONLY case that moved is Kbf + AIRFOIL + no named `airfoilSection`.
  Classic (parity) bit-identical, Supersonic bit-identical, SQUARE (the FinSet default)
  and ROUNDED bit-identical in all three models, and a fin naming an `airfoilSection`
  bit-identical (it short-circuits above). Differential **309 lines** clean.
  **THE HARNESS CANNOT SEE THIS CHANGE** — all four finned validation fixtures name an
  `airfoilSection`, so they short-circuit before the branch; classic 10/175, Kbf 17/175,
  supersonic 71/175 are unchanged. That is a fact to record, not a pass to claim.
  **Magnitude on real files** (total CD, Kbf): `Mach2.trf.ork` −0.4 % at M0.3 → −8.2 % at
  M0.9 → −12.0 % at M2; `LEM-IV.ork` −0.6 / −11.5 / −15.7 %; `CT-Concep98` −0.3 / −6.2 /
  −9.1 %; `LEM-M2B.ork` unchanged (no airfoil fins). At flight level, a Mach 1.9 airfoil
  probe went **apogee 2226.6 → 2701.5 m (+21.3 %)**, maxV +13.4 %, maxMach +13.5 %; the
  same probe with SQUARE fins is bit-identical. **The DEFAULT model's numbers moved, a
  lot** — say so in the changelog.
  **UNRESOLVED, and worth keeping in view:** this moves Kbf AWAY from Buckeye's measured
  apogee (already +11.9 % over GPS; less drag makes that worse) and TOWARD the same
  flight's GPS-derived Cd trace (which said Kbf reads Cd high, +22/+28/+42 % supersonic).
  The two anchors have pointed opposite ways since Phase 2 and still do.
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

### RASAero feature #5 — pressure thrust (thrust varies with ambient pressure), 2026-09-08

A published thrust curve is a **sea-level test-stand measurement**. As the rocket climbs
the atmosphere presses less on the nozzle's exit plane, so the motor gains exactly the
exit area times the pressure lost. RASAero has always modelled this; we did not, and the
register carried it as "motor thrust still does not vary with ambient pressure" (§3 item 1,
C1). Chuck Rogers's own formulation, from his MESOS comparison deck, slides 10-12
(Dropbox `/online_open_rocket_reference/RASAero II Comparison with MESOS 293K Flight Data -
Rev B.pdf`):

**F(h) = F_curve(t) + A_exit × (101,325 Pa − P(h))**

The slope is exact physics (Sutton, the rocket thrust equation); the **sea-level reference
is a convention**, and it is the only one the data supports — a RASP `.eng` file carries no
test-site field, so nothing else could be filled in. A curve really shot at altitude is
overstated by a CONSTANT offset which the app already carries today; this term neither adds
to that bias nor removes it, it supplies only the exact slope above the pad. Assessment and
the four readers' evidence: `docs/research/thrust-with-altitude-2026-09-08.md` (+ `-readers`).
Eric's ruling, chat 2026-09-08: *"build it as per your recommendation"* — option C.

**One file.** `simulation/RK4SimulationStepper.java` (NEW patch, +139 lines against upstream
and **zero deletions**): `calculateThrust` gains a four-line guarded add after the existing
curve loop (plus its comment), a private helper `calculatePressureThrust`
and a `PRESSURE_THRUST_REFERENCE_PRESSURE = 101325.0` constant. Four imports
(`AerodynamicCalculator`, `BarrowmanCalculator`, `AxialStage`, `RocketComponent`). Nothing
else changed: no new field, no `AxialStage`/`FlightConditions`/`SimulationConditions` edit,
no bridge export, no TypeScript method. The nozzle already reaches the stage
(`OrkEngine.applySeparationConfig`) and the model flags already sit on the calculator that
`simulateJson` hands the stepper, so the helper reads both off objects it is already given.

- **Gate — the same one as the drag half, deliberately.** `(rogersKbf || supersonicAero)`,
  read as `status.getSimulationConditions().getAerodynamicCalculator() instanceof
  BarrowmanCalculator` then `isRogersKbf() || isSupersonicAero()` — the exact disjunction at
  `BarrowmanCalculator.java:1113`. Desktop OpenRocket 24.12 has no nozzle-exit model of any
  kind (`NozzleExitDiameter` appears in exactly two files in the release, both under
  `file/rasaero`, and nothing in `core/aerodynamics` reads it), so an ungated term would
  break the v0.069 parity proof that "OpenRocket — Extended Barrowman" computes what it
  computes with the nozzle deleted. Eric's standing ruling, 2026-08-25. Ways back for a
  user: pick Classic EB, or clear the stage's nozzle (which drops the drag half too).
- **Once per THRUSTING STAGE (per stage INSTANCE since 2026-09-22 — see the next bullet),
  not once per motor.** `AxialStage.nozzleExitDiameter` is
  defined app-side as the cluster's single equivalent nozzle with the exit AREAS summed
  (the `FIELDS.stage` entry in `packages/app/src/tree/schema.ts` — NOT `model/schema.ts`,
  which has never existed; corrected 2026-09-08 in the patch javadoc, this bullet and
  `pressureThrust.test.ts` together), RASAero Manual p.50, so multiplying by
  `MotorClusterState.motorCount` would count a cluster twice against a field that already
  holds the sum. It also keeps the two halves consistent — the drag half subtracts one
  nozzle area per stage INSTANCE (true of a stage with pods or a step-down only since
  2026-09-22, when the drag half stopped crediting every base in the stage — see "Correctness
  fixes"). Two mounts on one stage are de-duplicated by stage number,
  the way `applyThrustState` builds its thrusting-stage set. (This overrules the kernel
  reader's per-motor recommendation; the physics and inputs readers were right.)
- **RESOLVED 2026-09-22 (code review E2) — the halves now agree per stage INSTANCE.** This
  half multiplies each credited stage's term by `stage.getComponentLocations().length`, so
  an N-instance `ParallelStage` gets N areas, as the drag half always charged it; on a
  parallel stage the field therefore means ONE strap-on's equivalent exit. The throw below
  is gone for a `parallelstage` and kept for a `podset` (which is not a stage and never
  receives the field). Entry, goldens and measurements: "Correctness fixes" at the end of
  this ledger. The history this bullet recorded until then, kept because it is why the
  throw existed: **⚠ THE TWO HALVES WILL DISAGREE BY THE INSTANCE COUNT ONCE PARALLEL STAGES
  REACH THE BRIDGE.** The drag half applies the subtraction inside its per-component loop and then
  scales: `total += instanceCount * cd` (`BarrowmanCalculator.java` patch :1121), so an
  N-instance `ParallelStage` removes N nozzle areas of base drag. This half de-duplicates by
  `stage.getStageNumber()`, which is ONE number for the whole `ParallelStage`, so it adds
  exactly one area however many instances burn — while `MotorClusterState.getThrust` already
  returned N × the curve. **CORRECTED 2026-09-21: "not reachable because the bridge cannot
  build one" was FALSE, and had been since v0.021 (`727e6e0`).** The bridge builds both
  assemblies (`ComponentFactory.buildAssembly`) and applies `nozzleExitDiameter` to them
  (`ComponentFactory.java:962` → `OrkEngine.java:221`); measured through the raw API at
  ~86 kPa, two instances of a 32 N motor with a 10 mm nozzle produce **65.203822 N** where
  per-instance accounting gives **66.407645 N**, exactly one nozzle term short. What makes it
  unreachable is the APP — no `FIELDS.parallelstage` nozzle entry, and `applyStageNozzles`
  writes top-level stages only — and that is now ENFORCED instead of assumed:
  `OrkRocket.buildTree` throws on an exit diameter set on a `podset`/`parallelstage`
  (`orkEngine.ts` `assertNoAssemblyNozzle`, covered in `pressureThrust.test.ts`). **Resolving
  it means ruling the DEFINITION first** — is the field the per-instance exit or the
  assembly's total? — then either multiplying by the instance count here or changing the drag
  half. Recorded 2026-09-08 (review), because the old wording of the bullet above ("exactly
  one nozzle area per stage") was what hid it; corrected 2026-09-21 after the 19 September
  review measured it.

  *(The Java comment this mirrors was corrected in the same sitting. Both are COMMENT-ONLY
  edits: `orkengine.mjs` is unchanged and stays byte-identical to its v0.119 build, because
  comments do not survive compilation — so no `engine:js`, no difftest, and the artifact is
  not stale against its source in any way that can affect behaviour.)*
- **Staggered ignition over-credits a cluster, and the drag half does too.** The whole summed
  equivalent area is charged from the moment the stage's FIRST motor lights: a central motor
  at launch with three outboards airstarted at burnout + 1 (expressible today, per mount, via
  `setMotorIgnitionById`) is credited the four-motor area for the whole of the central
  motor's burn. The drag half is gated on the same stage-thrusting flag and behaves
  identically, so the two stay consistent; correcting it means scaling by the burning
  fraction in BOTH halves at once, which is a bigger change than this release. Recorded
  2026-09-08 (review); the guide's "Once per stage" bullet says it in words.
- **The stage is the burning motor MOUNT's own stage** (`((RocketComponent)
  m.getMount()).getStage()`), so a booster's nozzle can never be credited to the sustainer,
  overlapping burn or not.
- **Only while the motor's CURVE thrust is above zero** — `m.getThrust(t) > 0.0`, the same
  predicate the drag half switches on, so both halves turn on and off at the same sub-step.

  **CORRECTED 2026-09-08 (evening), by measurement.** This bullet said RASAero adds its term
  before ignition and after burnout as well (citing Chuck confirming the artefact, TRF 194463
  #17/#19) and called our behaviour *"a deliberate, stated deviation"*. **It is not a
  deviation — we match RASAero.** Eric exported paired RASAero runs (same design, nozzle on
  and nozzle off, so the thrust curve cancels exactly): across **8,515 rows outside the burn**
  on two designs, the difference between the two runs is **0.00000000 N**.

  | design | pre-ignition | post-burnout |
  |---|---|---|
  | G record 2023, F10, 0.45 in | 1 row, 0.00000000 N | 4,424 rows, 0.00000000 N |
  | Wildman2Stage, both 0.688 in | 1 row, 0.00000000 N | 4,091 rows, 0.00000000 N |

  The exported `Thrust (lb)` column demonstrably CARRIES the term during the burn (that is how
  the term was measured at all), so it would show one outside the burn if RASAero applied one.
  No code change: our gate was already right. What was wrong was the record — this claim was
  written as established fact about RASAero's simulation and never checked. It may still be
  true of a different RASAero version, or Chuck may have been describing the plot rather than
  the integrator; neither is established here, and the citation is kept so the next reader can
  go and look. Measurement written up in
  `docs/research/rasaero-pressure-thrust-measured-2026-09-08.md`.

  The same paired runs confirmed the three properties this bullet and its neighbours assert:
  the term is `A_exit x (101325 - P(h))` to within **0.0035 N** over 704 in-burn rows, it is
  added **once per thrusting stage** (a booster burn on a two-stage design with both nozzles
  set gives ONE nozzle's worth, not two), and it uses **the burning stage's own nozzle** —
  booster 0.688/sustainer 0 gives exactly 0.0000 N through the sustainer burn, and the mirror
  gives exactly 0.0000 N through the booster burn.
- **P(h) is `store.flightConditions.getAtmosphericConditions().getPressure()`** — the very
  same `AtmosphericConditions` object the drag term reads at this RK4 sub-step. Zero extra
  atmosphere-model calls, no second firing of the pre/post atmospheric listeners, and thrust
  and drag can never disagree about the altitude. The pad's typed temperature and pressure
  flow through unchanged (`ExtendedISAModel(alt, T, P)`), which is what makes a pad term at a
  high site possible at all. The golden `flight.pthrust.kbf.pad.sample.*` is the example the
  kernel actually produces: a 1,400 m / 86,000 Pa pad, a bit-exact 0 at t = 0 (the curve has
  not lit) and ≈ 2.36 N once it has. On real files, SS_Wild_Bash +10.655 N and StratoSpear
  +7.478 N at t = 0 — both from `.CDX1` files whose author typed a real station pressure.
  ⚠ **CORRECTED 2026-09-08 (review): this bullet used to cite "MESOS's 3,910 ft pad gives its
  M787 sustainer +31.7 N at t = 0", which the kernel cannot produce.** The M787 is the
  SUSTAINER, lit at ~37,861 ft, so the curve-thrust gate returns exactly 0 for it at t = 0;
  and `MESOS_Last_Preflight_File` states no pressure, so `OrkEngine`'s
  `ExtendedISAModel(alt, T, STANDARD_PRESSURE)` branch puts 101,325 Pa at its pad and the term
  would be ≈ 0 there even for a stage that WAS burning. The assessment's +31.7 N was a
  magnitude illustration, not a t = 0 claim.
  `deficit` may be NEGATIVE (a pad above 101,325 Pa, or a below-sea-level site), which is
  physically right — hence the test is `!= 0.0`, not `> 0.0`.
- **⚠ A FILE THAT STATES NO PRESSURE IS FLOWN AT 101,325 Pa AT ITS OWN SITE**, so its pad term
  is ~0 however high the site. `OrkEngine.simulateJson` takes the
  `ExtendedISAModel(launchAltitude, T, P)` branch when EITHER field is typed and defaults the
  missing one, and a `.CDX1` always carries a `<Temperature>` while `rasaeroFile.ts` leaves
  `pressureHPa` null unless `<Pressure>` is above 0. Measured: 21 of the 23 flown corpus
  designs have a pad term at or below zero; G record 2023 gains −0.003 N on its 8,800 ft pad
  as imported, and +2.906 N once the station pressure is typed. Nothing here is wrong — the
  kernel does what it was asked — but the guide and the changelog must say it, and the
  pressure-field relabel is now the largest input-quality lever open on Eric.
- **The corrected TOTAL is floored at zero (2026-09-08, review), a third stated deviation.**
  The term is signed, and a large exit typed against an above-standard pad drove a burning
  32 N motor to −9.6 N and a 0.000 m apogee with no reason attached. `MathUtil` is not used:
  the clamp is an `if (thrust < 0.0) thrust = 0.0;` INSIDE the `pressureThrust != 0.0` guard,
  so the flags-off path still executes no arithmetic on `thrust`. RASAero does not clamp; a
  real over-expanded nozzle separates and thrust floors near zero, so the clamp is the
  physical answer as well as the safe one, and it can only bite where the total was already
  negative.
- **Tail-off caveat, recorded rather than modelled:** the full geometric exit area assumes a
  full-flowing nozzle; during tail-off the flow separates and `A_e·ΔP` overstates. RASAero
  applies the full term whenever the motor burns and reproducing RASAero is the point.
- **Consequence for the UI, which the changelog must carry:** the stored `thrust` series
  (`TYPE_THRUST_FORCE`, and `TYPE_THRUST_WEIGHT_RATIO` with it, hence thrust:weight at rod
  departure) now sits ABOVE the catalogue curve by `A_e·ΔP` in every plot.
- **Guard — structural, not arithmetic.** With the flags off, or every stage's nozzle at 0,
  the helper returns `0.0` before any per-motor work and the caller's `if (pressureThrust !=
  0.0)` means **no floating-point operation touches `thrust` at all**; the existing loop's
  summation order is untouched. Proven, not asserted: `gradlew goldenJvm` before and after
  the patch, **all 324 pre-existing lines byte-identical**, only appended ones added, and
  `flight.pthrust.classic` (the mindia design, flags off, 14 mm nozzle) comes back
  `329.60970452899176|109.38572576554664|7.149247412564792` — the same three doubles as
  `flight.mindia`, digit for digit.
- **Goldens:** `pressureThrustScenarios()`, appended at the END of the roster (difftest
  compares BY LINE INDEX). 31 new lines: `flight.pthrust.{classic,kbf,ss,nonozzle,kbf.pad}`
  with five `…sample.<i>` rows each carrying (altitude, thrust) through the burn, plus
  `pthrust.term`, the formula worked by hand — `P(300 m) = 97806.50274834312`, deficit
  `3518.4972516568814`, `A_e = 1.539380400258999e-4`, term `0.5416305707565757` N (the area written with the KERNEL's own association, `PI * pow2(d/2)`; the row first shipped with `PI * d/2 * d/2`, one ulp away, so the documentation row and the code disagreed in their last digit — corrected 2026-09-08, review). `kbf`
  and `ss` are separate because the gate is a disjunction. Differential **324 → 355 lines**,
  JVM↔TeaVM clean (229 bit-identical, 126 within the existing tolerances).
- **Behavioural guards** (goldens cannot do this — difftest has no stored baseline, so a
  change that moves both runtimes together passes it; LEDGER 2026-08-25b):
  `packages/engine/src/pressureThrust.test.ts`, 8 tests — the formula asserted BIT-EXACTLY at
  every row of a burn (a 32 N dyadic plateau makes the curve reconstruction exact, so the
  stored total must equal `curve + A_e·(101325 − P)` under `toBe`), the vacuum limit at an
  80 km pad, exact zeros before ignition and through the coast on a 2,000 m pad where an
  ungated term would be 6.9 N, both gates (parity model, and nozzle 0 under each flag
  separately), a 3-ring cluster gaining ONE equivalent area and provably not three, a
  booster's 30 mm nozzle never reaching the sustainer's burn, and the mindia parity flight
  still at 329.6097045289919 m.
- **Artifact:** `packages/engine/vendor/orkengine.mjs` 2,736,841 → 2,743,381 bytes, md5
  `fdb06f286dcbab063983a3a77cf9098e` → `bef15ae395e45b0d271946d3234082fa` (the +57 bytes over the
  first build of this patch are the zero-floor clamp; `iocs_RK4SimulationStepper_calculateThrust`
  in the artifact reads `if (var$4 < 0.0) var$4 = 0.0;` inside the `$pressureThrust !== 0.0`
  guard). Post-build greps
  (TeaVM names a private method `<Class>_<method>`, not `$<method>`):
  `RK4SimulationStepper_calculatePressureThrust` **0 → 2**, `$isRogersKbf` **0 → 2**,
  `$isSupersonicAero` **0 → 2**, `$getNozzleExitDiameter` 3 → 4, `101325` 4 → 6. The two
  getters were dead-code-eliminated before this patch because nothing referenced them —
  that they are now linked is the proof the new code is really in the artifact.
- **Corpus A/B, measured 2026-09-08 (review) through the two artifacts.** Every RASAero corpus
  design that carries a nozzle, imported by the app's own `importCdx1`, motors resolved by
  `matchImportedMotor`, flown under Rogers Kbf at the file's own launch conditions, once against
  the committed v0.118 artifact and once against this one. 20 designs resolved (the rest are
  motor-database gaps). Apogee moves **+0.007 % to +29.655 %, median +0.274 %**; 12 under half a
  percent, 4 over five (G record 2023 +5.51, 38-54 2-stage +5.89, 2,4-D +9.59, OR vs RAS Test 1
  +29.65). **The no-op is proven, not asserted:** with the nozzle cleared, all 20 return the same
  apogee under BOTH artifacts to the last decimal printed — that is the "clear the nozzle" way
  back. The strip's own cost (nozzle on vs cleared, this kernel) is 0.084 % to 45.757 %, which is
  what the batch dialog's note and the guide now quote.
- **`validation/` cannot see this change at all:** `score.mjs` drives `getDragSweep`, which
  is static and never calls `calculateThrust`, and no fixture sets a nozzle. No tolerance
  question arises, and none may be invented — there is no published anchor for thrust versus
  altitude on disk.
- **Upstreamability: none, and that is intended.** Desktop OpenRocket has no nozzle exit
  diameter on a stage and no pressure term, so this is a MMRocket Sim extension living
  behind the same model gate as features #1-#4. On an upstream upgrade, re-diff
  `RK4SimulationStepper.java` against the new release and re-apply the helper plus the five
  lines in `calculateThrust`; the insertion touches nothing upstream is likely to move.

### models/wind/MultiLevelPinkNoiseWindModel.java — winds aloft through the engine API: a SEEDED `addWindLevel` (kernel pass 2, audit 2026-09-22)

Not a RASAero gap: this is desktop OpenRocket 24.12's OWN multi-level ("winds aloft") wind
model, made reachable. It sits here because it is default-off in the same sense as the
features above — absent its new input, every flight is bit-identical.

- **Why:** the class was carved with the rest of `models/wind` on day one, but nothing
  constructed it — `simulateJson` built the single-level `PinkNoiseWindModel` unconditionally —
  so TeaVM dead-code-eliminated it: **`MultiLevelPinkNoiseWindModel` 0 occurrences in the
  artifact at `3918947`**. Exposing it takes a bridge switch (below) and this patch, because
  upstream's `addWindLevel` builds each level's `PinkNoiseWindModel` with the no-arg
  constructor, which seeds from `new Random().nextInt()`: a different turbulence stream on
  every run, and a different one on the JVM and under TeaVM, so a multi-level flight with any
  standard deviation could be neither reproduced nor differentially tested. (Desktop does seed
  its single-level model from the simulation's `randomSeed` — `SimulationOptions` line 89 —
  and this bridge has done the same since Phase 0; only the multi-level levels are unseeded
  upstream.)
- **Change (appended below upstream's last method, so every upstream line keeps its
  number):** `addWindLevel(double altitude, double speed, double direction, double
  standardDeviation, int seed)` — upstream's four-argument body with `new
  PinkNoiseWindModel(seed)` for `new PinkNoiseWindModel()` and σ always applied. Same setter
  order — direction, average, THEN σ, which matters: `PinkNoiseWindModel.setAverage` rescales σ
  to hold the turbulence intensity, so σ must be set last to land as given — the same
  binary-search insertion, the same duplicate-altitude refusal.
- **Why a patch and not a shim:** the seed is a private final of `PinkNoiseWindModel`, set only
  by its constructor, and the level list is private to `MultiLevelPinkNoiseWindModel`. The only
  no-patch route is a same-package helper reaching into `LevelWindModel`'s protected `model`
  field to swap each level's model after upstream has built it — replacing upstream state behind
  its back. The appended overload is the smaller change, and the visible one.
- **The bridge half (not a patch — `api/OrkEngine.windModelFor`):** desktop's `WindModelType`
  switch, driven by the options JSON (the bridge builds `SimulationConditions` directly and never
  constructs a `SimulationOptions`). No `windLevels`, or an empty list → the single-level model,
  built by exactly the calls in exactly the order it always was. A non-empty `windLevels` →
  `MultiLevelPinkNoiseWindModel`: the constructor's default level (built from the preferences
  shim's unseeded average model) cleared; each level's altitude, speed and direction required
  finite (a NaN crosses JSON as null, so a missing number and a non-finite one both refuse,
  naming `windLevels[i]`, and neither can fly as a default); σ optional — ABSENT is a steady
  level, 0 — but a PRESENT σ must be a finite number too, so a null (a NaN or an Infinity on the
  wire) or a string refuses the same way. (As first committed σ was read with a fallback of 0,
  and `JsonLite.dbl` returns the fallback for anything not a number, so σ = null and σ = "0.6"
  both flew as a steady level with no error — 241.968 m on the C6 rocket, 3 s cut, seed 7 — while
  this entry said they refused. Found by the package's adversarial review; the σ read now takes
  a NaN fallback when the key is present.) A non-object entry refused; the levels sorted by
  altitude; level k seeded `randomSeed ^ (k * 0x9E3779B9)`; and
  `windAltitudeReference` `"MSL"` (the default, desktop's) or `"AGL"`, anything else refused.
  The lowest level takes `randomSeed` itself, so ONE level carrying the single-level speed, σ
  and direction π/2 IS the single-level flight, bit for bit; the golden-ratio multiplier keeps
  neighbouring levels off adjacent `java.util.Random` seeds, whose first draws are correlated.
  `windAverage` / `windStdDeviation` are ignored on that path, as desktop ignores its average
  model while the multi-level one is selected. TypeScript: `SimulationOptions.windLevels` /
  `windAltitudeReference` and the exported `WindLevel`; `assertWindLevels` refuses non-finite
  values, a negative speed or σ (the kernel would silently turn a negative speed into a wind
  from the opposite side), a repeated altitude and an unknown reference — naming the level —
  before anything crosses.
- **Direction convention, stated because it is easy to get backwards:** the direction the wind
  blows FROM, clockwise from north (desktop's table tooltip: 0 = from the north, 90° = from the
  east). `PinkNoiseWindModel`'s vector `speed × (sin d, cos d, 0)` points that way, and the
  stepper ADDS it to the rocket's velocity to get airspeed. The single-level model has only ever
  flown its default d = π/2.
- **Divergences from desktop:** (a) seeding — desktop's multi-level turbulence is random per
  run, ours is a function of `randomSeed`; (b) an EMPTY level list flies the single-level wind,
  where desktop's model with no levels would fly calm (`getWindVelocity` returns
  `Coordinate.ZERO`) — here absent and empty are the same request. Interpolation (the VECTOR,
  linear in altitude), holding the end levels' values outside the table, and the altitude
  reference are desktop's code, unchanged.
- **Scope: engine API only.** No app control sets `windLevels`, so every flight the app flies
  takes the unchanged single-level branch — **no user-visible number moves.** The `.ork` importer
  does not read desktop's multi-level wind block either; both are app work for whoever builds
  the UI.
- **Oracle:** the before/after `goldenJvm` diff, the before side rebuilt from `b4916b0`'s own
  source in a scratch export (and reproducing the recorded post-nozzle-fix baseline
  byte-for-byte). Goldens `windLevelScenarios()`, appended at the END (difftest compares by line
  index): the `conditionsScenarios` C6 rocket and 1,400 m / 303.15 K / 86 kPa pad, seed 7, cut
  at 8 s; columns maxAltitude, maxVelocity, timeToApogee and the horizontal drift at apogee.
  **All 395 pre-existing lines bit-identical; 395 → 400 lines, additions only.**
  `flight.conditions.windlevels.single` reprints the existing windy flight (365.4237143564062 m,
  as `flight.conditions.summary`), and `…one` — the same wind as one level at 0 m — equals it in
  EVERY column, drift 75.83418675209836 m included. `…shear` (three turbulent levels veering with
  height) 368.384 m, drift 55.620 m. `windlevels.steady.msl` / `.agl` — steady levels, calm at
  0 m and 4 m/s at 300 m: measured from sea level the whole flight sits above the top level in a
  steady 4 m/s (apogee 363.547 m, drift 77.763 m); measured from the pad it starts calm and builds
  (371.597 m, 43.661 m). Differential **395 → 400 lines**, JVM↔TeaVM clean (265 bit-identical,
  135 within tolerance — the five new lines all within it; `flight.conditions.*` take the
  turbulent tolerance, as the existing windy flight does, the steady pair the flight tolerance).
  Drift is taken AT APOGEE and as a distance on purpose: a scratch probe of the final per-axis
  position at the 8 s cut, after the chute-opening transient, FAILED the differential — `single`
  Px 74.00589 vs 74.00901 m, 4.2e-5 relative, over the 1e-5 turbulent budget, and Py 1.9e-4
  relative on a 0.018 m crosswind; the steady pair's Py 6.1e-9 (`msl`) and 1.3e-6 (`agl`)
  relative against the 1e-9 flight budget. (The probe's line names fell outside difftest's
  `flight.conditions` prefix, so its turbulent rows were re-judged against the 1e-5 budget by
  hand: `single` fails it, `shear` — 5e-7 and 7e-7 — would not.) The tolerances were not
  touched, and the probe was reverted before the artifact above was built.
- **Behavioural guards:** `packages/engine/src/windLevels.test.ts`, 7 tests — one level equal
  to the single-level flight bit for bit (at 0 m and at 5,000 m, with `windAverage` set to
  something else to prove it ignored) and an empty list equal to no list; the recorded `Vw`
  checked ROW BY ROW against the kernel's own vector interpolation over a whole sea-level flight
  whose wind swings from east to west between 100 and 250 m (and nearly vanishes at 175 m, where
  interpolating speed and direction separately would read 8 m/s), with `θw` held on each side;
  MSL by default, explicit `'MSL'` identical, AGL calm on the pad and building; seeds by altitude
  rank, so a reversed list is the same flight; each level its own stream (two identical levels
  bracketing the flight do NOT reproduce the single-level stream), reproducible per seed and
  moved by another; and the refusals, in the wrapper and in the raw kernel. Against the pre-change
  wrapper and artifact (`b4916b0`) **6 of the 7 fail**; the sort-order pin passes on both, by
  construction (the old kernel flew both lists calm). The raw-kernel refusal test carries
  σ = NaN (null on the wire) and σ = "0.6" since the review fix-up; against the first-committed
  artifact (`b60202a9…`) it fails — both flew — and it passes after.
- **Artifact:** `packages/engine/vendor/orkengine.mjs` 2,766,975 → 2,800,664 bytes, md5
  `e04d4a5aa19e3ee46bf4c8545cc4baae` → `b60202a9c44e4feeb8b2b0dc6f26d178`.
  `MultiLevelPinkNoiseWindModel` **0 → 139** occurrences, `LevelWindModel` 0 → 18,
  `OrkEngine_windModelFor` 0 → 2, both `addWindLevel` overloads linked
  (`…_addWindLevel` / `…_addWindLevel0`, 0 → 2 each) — the grep, not Gradle's `UP-TO-DATE`, is
  the evidence. Upstream's CSV import (`importLevelsFromCSV`, `FileReader`) stays unlinked: 0.
  **Review fix-up (the σ read):** → 2,800,745 bytes, md5 `11f2ebcdbfdffac4b0e58af928e43d4d`;
  the new `$row.$containsKey(…)` guard on σ is in `windModelFor`, 0 → 1 (a line diff of the two
  artifacts shows nothing else but the renumbered locals around it). `goldenJvm` 400 lines,
  byte-identical to the run before it — no golden sends a malformed σ — and the differential
  400 lines clean (265 bit-identical, 135 within tolerance).
- **Upstreamable:** arguably — desktop's multi-level runs are not reproducible run to run for
  exactly this reason, and passing the simulation's `randomSeed` through a seeded overload is
  the fix there too.

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

**Hardening addendum (2026-08-26)** — invalidation-correctness only, for the memo
this repo added above; not an upstream behavior change.

- **Why:** the componentChanged() sweep was this memo's ONLY invalidation, and
  Rocket withholds that sweep in four windows: while frozen (freeze() queues
  events until thaw), while events are disabled (the .ork build window, healed
  only by enableEvents()'s single AEROMASS sweep — in pre-order by luck), for a
  subtree removeChild has detached (the fire goes to the remaining tree), and
  past a mid-sweep throw (later components never swept). Verified: no
  reachable-now caller reads a stale value through any of them — but the
  invariant held by accident, and the golden harness builds rockets the same way
  the app does, so it could not catch a regression here.
- **Change:** the memo is STAMPED with the root it was computed under plus that
  Rocket's modID, served only while both still match, and never populated under
  a non-Rocket root — a read under one instead CLEARS the stamp, so a detached
  subtree stops pinning the rocket it used to hang from; clone() resets the
  stamp with the memo. Rocket bumps modID
  BEFORE its freeze check, so a frozen-window mutation kills the stamp even
  though the sweep never ran (that bump is skipped only for undo/redo events,
  whose sole producer here is Rocket.loadFrom — which adopts the source modID
  and swaps in freshly-cloned, memo-empty components before firing); the same bump (made before the sweep starts)
  covers a mid-sweep throw, and enableEvents()'s AEROMASS bump kills every
  build-window memo whether or not its healing sweep completes or in what
  order. Serving policy only got STRICTER — a refused memo is recomputed from
  the live tree — so no currently-reachable value can change.
- **Note:** one residual, documented at the guard: mutate-then-read strictly
  inside the events-disabled build window moves no modID and stays invisible
  until enableEvents(). Closing it needs Rocket's private eventsEnabled/frozen
  state, and Rocket.java is carved, not patched; verified unreachable today
  (ComponentFactory's in-window 'absolute' reads do not interleave with
  geometry mutation on the same components). Cost on a memo hit is a
  parent-chain walk plus two reference compares — nothing in simulation/ fires
  events, so a flight still populates once and hits for the whole run.

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

**Hardening addendum (2026-08-26)** — invalidation-correctness only, for the memo
this repo added above; not an upstream behavior change.

- **Why:** the memo is invalidated only by fireChangeEvent(), but three
  stage-flag mutators bypass that by upstream design — `_setAllStages`,
  `copyStages` and `copyStageActiveness` flip stage-active flags (an input to
  structure mass, which sums active stages only) and run their own
  updateMotors/updateActiveInstances refresh without firing. Every reachable-now
  caller hands them a freshly-built, memo-empty configuration
  (BasicEventSimulationEngine:71, SimulationStatus:208, Rocket:497/552,
  FlightConfiguration.clone()/copy()), so there is no live bug — but any future
  stage-toggle API on the selected configuration, or ported upstream
  loader/swing code (which calls setAllStages() freely), would silently serve
  the previous stage set's structure mass to the RK4 stepper 4× per step.
- **Change:** the three mutators now clear the memo directly via a new
  `invalidateStructureMassMemo()` helper (fireChangeEvent() delegates to the
  same helper, so there is one definition of the clear). A direct clear and NOT
  fireChangeEvent(): that method has side effects beyond invalidation — it
  bumps the Monitorable modID and re-runs updateStages() — which the current
  callers do not expect from these mutators (clone()/copy() overwrite modID
  right after their copyStage* call). Clearing an already-empty memo is
  provably a no-op; firing an event is not.
- **Note:** no reachable behavior changes — every current caller operates on a
  memo-empty config, where the clear writes INVALID over INVALID and null over
  null. All 309 golden lines must stay bit-identical.

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

## Correctness fixes (documented physics change — a kernel defect, fixed deliberately)

This section exists because Rule 1 below did not have a home for it. A performance
patch must prove a zero-line `goldenJvm` diff; a feature patch adds an opt-in model.
This is neither: it is a bug in upstream's own arithmetic that made the kernel
compute a body whose mass, centre of gravity and inertia tensor described three
different objects. Fixing it MOVES USERS' FLIGHT NUMBERS, on purpose, in every
aerodynamic model.

### masscalc/MassCalculation.java — a subtree mass override must scale the subtree's INERTIA too

- **Why:** when a component carries a mass override that covers its subcomponents
  (`<overridemass>` + `<overridesubcomponentsmass>` — what the UI calls a measured
  mass on a stage, and what every RASAero `.CDX1` import writes), upstream zeroes
  the children's centre-of-mass WEIGHT at `MassCalculation.calculateStructure()`
  and stops. `children.setCM(getCM().setWeight(0))` writes the `centerOfMass` field
  only; it does not touch `children.bodies`, so at `this.merge(children)` every
  descendant's `RigidBody` crosses over still carrying its GEOMETRIC mass. The mass
  is the user's, the CG is the user's, and the inertia is the un-overridden
  rocket's.
- **The measured symptom, from the golden this patch added:** with the booster
  stage pinned at 1.816x, 3.633x and 9.082x its geometric mass, the roll inertia
  came out `1.2522450621924655E-5` in all three cases and in the un-overridden case
  — BIT-IDENTICAL, i.e. low by exactly the override factor k. Pitch did move, but
  only through a transport term charged at the override mass ON TOP of the
  children's own rebases, which already carry that distance to the rocket CG
  (`RigidBody.rebase`, the `cm.weight * (x2 + z2)` term) — so the pitch error could
  go the other way. The sign of the error varied by design, which is why no single
  sentence could describe the old behaviour.
- **Change:** inside the `isMassOverridden() && isSubcomponentsOverriddenMass()`
  branch only — take the subtree's own tensor about its own CM
  (`children.calculateMomentOfInertia()`), fold in the parent's geometric body when
  the parent is itself massive (a no-op on a `ComponentAssembly`, whose unit
  inertias are zero), scale the whole tensor by `k = overrideMass / geometricMass`,
  clear `children.bodies`, and attach the one scaled body at `compCM` in place of
  the usual per-component term. `rebase()` then transports it exactly once.
- **The modelling ruling, stated because it is a ruling and not a derivation:**
  k is applied UNIFORMLY to Ixx, Iyy and Izz. The user has said the SHAPE is right
  and the MASS was wrong — "I put the stage on a scale" — so the geometry is kept
  and the tensor scaled with the mass it belongs to. Modelling the delta mass some
  other way (a uniform shell, a point mass at the CG) gives different pitch numbers
  and would need a reason this does not.
- **Attachment point:** `compCM`, which is the geometric subtree CM under an
  assembly override and the user's value under an active CG override. That reads as
  "keep the shape, put it where the user says the CG is", and keeps the body
  carrying the mass and the body carrying the inertia in the same place.
- **Safety:** `k` is guarded by the existing `MIN_MASS` sentinel. Unguarded, a
  subtree whose children are all massless gives Infinity or NaN, and NaN passes
  `RigidBody`'s negative-value check straight into the RK4 angular-acceleration
  divisor (`RK4SimulationStepper`).
- **Scope, and how it is proven:** `overrideMass` WITHOUT the subcomponents flag is
  a different, self-consistent behaviour (a coherent point mass at the subtree CG)
  that upstream and two shipped JS tests depend on. Golden
  `mass.override.unflagged` is the leak detector, and it did not move.
- **Divergence from upstream:** YES, deliberate, and in ALL THREE aerodynamic
  models. There is no flag and no carrier: `masscalc` contains no reference to
  `rogersKbf` or `supersonicAero` (they live on the JS bridge's per-handle context),
  so an ungated fix reaches every model by construction. Gating it on the aero
  pulldown was considered and rejected — see `docs/testing/response-2026-08-29b.md`
  §1 for the measurements behind that.
- **Oracle:** the before/after `goldenJvm` diff, NOT `difftest`. The differential
  compares JVM against TeaVM with no stored baseline, so a wrong formula moves both
  runtimes together and still reports "differential ok". Result: 310 of 314 lines
  bit-identical, movement confined to `mass.override.k1/k2/k5/offaxis`. The fix was
  then checked as arithmetic rather than as "the number changed": on the centreline
  roll carries no transport term, so `Ixx` must be exactly `A + k*B`; solving A and
  B from k1/k2 predicts k5 to 1.8e-16, and `A + B` reproduces the pre-fix constant
  to 4.1e-16.
- **Upstreamable:** yes. This is an upstream bug, not a MMRocket-specific model
  choice, and the patch is confined to one branch of one method.

### rocketcomponent/RocketComponent.java + aerodynamics/BarrowmanCalculator.java — a CD override may be a FRACTION OF THE BODY CD, re-evaluated at every Mach

- **Why:** the app has no protuberance calculator. A protuberance is lowered at the
  engine boundary to a `railbutton` carrying a scalar `overrideCD`, and
  `calculateOverrideCD` added that scalar unchanged at every Mach
  (`double cd = instanceCount * c.getOverrideCD();` — that one line was the whole
  defect). For the two STREAMLINED protuberance classes the scalar is meaningless as a
  constant: they implement Chuck Rogers' Streamlined Protuberance Method, which states
  the drag per unit frontal area of a streamlined bump as **equal to the rocket body's
  own, "for all Mach Numbers"** (TRF 197641 #1) — no-base class against body CD
  excluding base drag, with-base class including it. The app measured that body CD ONCE,
  at Mach 0.3, and froze it. The app's own user guide and property panel already claimed
  the method "at all Mach numbers".
- **The measured symptom** (ARCAS-Long fixture, app-default 20x10 mm `streamlinedbase`
  protuberance, area ratio 0.0779664, sea level, aoa 0, flags off, M0.10-2.00 step 0.05):
  delivered increment **0.0274806940522049 at all 39 points, max/min = 1.0000000000000020
  — exactly flat**. The method's own answer over the same range runs **0.0184820 (M2.00)
  to 0.0333464 (M1.10)**, a span ratio of 1.804, because the body CD it is a fraction of
  moves 80 % across the range these designs fly. Ours was 12.2 % LOW at M0.10, exact at
  M0.30, 2.8 % high at M0.50, **17.6 % LOW at the M1.10 transonic peak** — where a fast
  rocket spends its max-Q — 21.7 % high at M1.50 and **48.7 % HIGH at M2.00**.
- **Why it could not be fixed on the app side**, which is the finding that settles the
  design: `getAerodynamicForces` is the FLIGHT hot path and passes `null` for the force
  maps, so no per-component decomposition exists during a simulation, and the app hands
  the kernel one static tree per flight. A per-Mach protuberance drag is impossible
  without a kernel change.
- **Change, `RocketComponent`:** two new fields beside `overrideCD` —
  `double overrideCDBodyRatio` (default **NaN** = plain scalar, upstream behaviour) and
  `boolean overrideCDBodyIncludesBase` (default true) — plus four plain accessors. The
  setters deliberately fire no `ComponentChangeEvent` and forward to no config listener:
  the only writer is `api.ComponentFactory.applyOverrides`, which sets them once while
  the tree is built from JSON, the same treatment `AxialStage.setNozzleExitDiameter`
  gets. `setOverrideCD` / `setCDOverridden` are UNTOUCHED, so such a carrier still reports
  `isCDOverridden() == true` and the friction/pressure/base loops keep skipping it —
  the override remains the component's entire drag. `clone()` is `super.clone()`, a
  shallow field copy, so both primitives ride along.
- **Change, `BarrowmanCalculator`:** three private per-call scratch fields
  (`lastBodyFrictionCD`, `lastBodyPressureCD`, `lastBodyBaseCD`, all initialised 0)
  accumulating the **SymmetricComponent-only** half of each computed drag bucket, written
  at the end of the three methods that already run first at BOTH call sites. Then
  `calculateOverrideCD` charges `instanceCount * ratio * (friction + pressure [+ base])`
  when the ratio is non-NaN, and the untouched `instanceCount * getOverrideCD()`
  otherwise.
  - `calculateFrictionCD`: `correction * bodyFrictionCD` — fineness-corrected exactly as
    the return value is; `otherFrictionCD` (fins, lugs, buttons) is excluded, which is
    Rogers' own instruction to OpenRocket users ("removing the Fins from the rocket and
    running the rocket with No Fins").
  - `calculatePressureCD`: the component pressure term is taken INSIDE the
    `instanceof SymmetricComponent` block but **before** `cd` is reassigned to the
    stagnation-step term, and the step term is added after it. Reading `cd` once, after
    the reassignment, would charge the step twice and lose the component term.
  - `calculateBaseCD`: the loop already visits SymmetricComponents only, so its running
    total IS the body base drag.
- **The semantics-preserving carry-forward, and why it is in `calculatePressureCD`:** the
  app's stripped-rocket probe reads the whole `total` (= friction + pressure + base +
  overrideCD), so a user's own `<overridecd>` on a nose cone, tube, transition or boat
  tail has always been INSIDE the body CD it quotes. The three loops skip such a
  component, so it would have vanished from the new in-place reference. It is carried
  forward **before** the `continue`, guarded on `SymmetricComponent`,
  `!isCDOverriddenByAncestor()` and `Double.isNaN(getOverrideCDBodyRatio())` — that last
  guard is what stops a ratio component entering its own reference.
- **The oracle, and the load-bearing measurement:** summing the three fields reproduces
  the app's stripped-rocket probe — a *separate rocket* built with every appendage
  deleted — to at worst **5.551115123125783e-17 absolute (0 to 1 ulp) at all 20 Mach
  points 0.10-2.00** on ARCAS-Long, most points exactly 0. So the kernel's in-place body
  reference and the app's probe are the same quantity, and switching to it moves this
  fixture's Mach-0.3 number not at all. On a design whose fin tips overhang the airframe
  the two differ by ~0.1 %, because stripping the fins shortens
  `getLengthAerodynamic()` and moves Re; the in-place sum is the more faithful of the two,
  being the body drag of the rocket that is actually flying.
- **Divergence from upstream:** MMRocket-Sim-original. Desktop OpenRocket 24.12 has no
  such field and its file format has no way to express one. **INERT unless
  `overrideCDBodyRatio` is present**, and it is synthesized only by the app's
  `engineTree`, only for `dragClass` `streamlined` / `streamlinedbase`, and only when the
  user has typed no `cdFrontal` of their own. Everything else — every `.ork`
  `<overridecd>`, every stage/assembly override, every `plate`-class protuberance, every
  user-typed Cd — takes the identical old branch with unchanged arithmetic and is
  bit-identical by construction. `plate` is `1.17*sin^2(theta)`, modified-Newtonian, and
  a typed Cd is the user's own constant: neither carries a Mach term, correctly, and
  neither may gain a ratio.
- **What it does NOT touch:** no normal force, no CP, no CG, no mass — the override
  contributes drag only, and the carrier's geometry is unchanged. The camera shroud
  (`fairing`) path is deliberately left flat: its `cdFrontal` is a Hoerner constant with
  no Mach model of any kind and no Rogers mandate behind it, and giving it a body-CD
  shape is a modelling choice the owner has to rule on.
- **Consequence to state in the release note:** the drag now tracks the body CD of the
  aero model the user is actually flying, including the opt-in supersonic flag. The app's
  probe was always flags-OFF; measured on arcas-long-finsoff, `setSupersonicAero(true)`
  alone moves body CD -0.30 % at M0.30 but **+54.3 % at M1.00, +75.4 % at M1.50 and
  +59.8 % at M2.00**. That is the method behaving correctly, and it means the body's own
  known subsonic drag bias now propagates into the protuberance instead of being masked
  at one point — one fix to the body will fix both.


### masscalc/RigidBody.java + MassCalculation.java + RingComponent.java - true-CG-axis ROLL inertia (2026-09-30)

- **Ruling:** CODEX-GO.md approves centroidal roll composition only. Pitch/yaw keep
  their previous scalar approximation, explicitly, including its old radial reference
  and motor traversal. No aerodynamic model gate: this applies to all three models.
- **Defect:** E1's single-ring and motor-cluster centroids did not describe their
  actual radial mass placement. Transporting those bodies therefore centred roll on
  an incorrect whole-rocket centroid and missed nested offset cross terms. Already
  correct off-axis ballast must not receive another whole-rocket subtraction.
- **Composition:** for component/instance masses mi at radial centroids (yi, zi),
  c = sum(mi*ci)/M and Ixx(c) = sum(Ixx_i + mi*|ci-c|^2). Each Ixx_i is centroidal.
  `RingComponent` supplies the actual radial centroid for one instance as well as
  several, and its annulus inertia plus spread about that centroid. The radial mean
  comes from geometry even at zero material mass; a later component override can
  supply positive mass. `getLegacyTransverseCG` retains the former reference exactly. Axial line-pattern
  behaviour is unchanged. Motors use the mean of their instance offsets and their
  centroidal spread. The motor traversal now carries parent instance rotations for
  roll geometry, so both nested offsets and their cross terms are included.
- **Separate references:** the new `RigidBody` patch carries `cm` for roll and
  `transverseCM` for the legacy pitch/yaw approximation. Ordinary constructors set
  both to the supplied coordinate. `add` averages and rebases the two independently;
  `translateInertia` carries both and `rebase` preserves the body's mass (the old
  method adopted the target coordinate's weight). `MassCalculation` carries both
  references through merge, reset, overrides and aggregation, plus a separate legacy
  motor transform that retains the previous omission of instance rotation. This
  omission is intentionally preserved ONLY for the transverse model.
- **Overrides:** a covering mass override scales centroidal roll and mass by the
  same factor and retains the scaled geometry's radial centroid, including a massive
  parent's own geometry. Child bodies are consumed once; the finite geometric-mass
  guard remains. The previous axial CG override and unflagged assembly point-mass
  semantics remain. Motors still compose separately with the scaled dry structure.
- **Routing:** structure, launch, burnout and current-time motor wrappers remain the
  shared entry points. RK4 and flight-data Ir get the same corrected composition via
  `RigidBody.add`; no getter or stepper performs another subtraction. Active-stage
  selection still belongs to FlightConfiguration; the new harness checks recomputation
  after changing the active stage, including its cached structure mass.
- **Analytical evidence (SI, synthetic fixtures, not tester flights):** the historical
  `inertia.offaxis.single` was reproduced on the OLD shipped artifact with Node
  v24.19.0: M = 0.8637187376489845 kg, tube mass = 0.009581857593448866 kg,
  motor mass = 0.35 kg, offset = 0.03 m. True radial CG = 0.01248954695271123 m;
  correction M*c^2 = 0.00013473043481269508 kg*m^2. Old roll
  0.0018421849153740075 predicts corrected 0.0017074544805613123 kg*m^2;
  the old figure is 7.890718982353397% high. This is an analytical prediction,
  NOT a measurement of a rebuilt artifact in this sandbox.
- **Guards:** `rollInertia.test.ts` replaces the single-tube body-axis expectation;
  `rollInertiaCG.test.ts` adds complete cylinder arithmetic, dry/loaded/spent motors,
  unequal opposing loads, translated clusters, one/two levels of clocked pods,
  explicit legacy transverse arithmetic, covering and unflagged overrides, zero
  mass, already-correct ballast, and delayed-ignition Ir(t) with rounded/airfoil
  freeform fins. The golden roster appends `inertia.truecg.*` assertions for wrappers,
  composition, rebasing, translation, overrides, nested rotations, active stages and
  single fins. `flight.truecg.zerotorque.*` provides a controlled free-flight pair
  with an aerodynamic listener suppressing normal forces and all moments, including
  the stepper's pitch/yaw noise. Existing golden ordering/tolerances are unchanged.
- **Verification status:** carving succeeded. Gradle could not create its wrapper
  lock under C:/.gradle; per GO, no retry or alternate build was attempted. The
  committed vendor artifact is unchanged and has no `transverseCM` symbol. Against
  that OLD artifact, the two roll suites give 15 expected regression failures and
  10 passing controls (25 tests); this is not a post-fix pass. Java assertions,
  differential comparison, new-artifact tests and kernel mutations MUST run after
  rebuilding. Exact mutations and commands are in CODEX-REPORT.md. App eligibility
  tests pass (16); nine predicate mutations fail as intended and were restored.
- **Historical residuals:** this implementation targets E1 residuals (a), nested
  roll cross terms/rotation, and (d), the single-mount false centroid. The old E1
  measurements below remain historical evidence. Closure awaits the rebuilt gate;
  no runtime verification is claimed here.
- **Limits/decision for Eric:** the transverse scalar is still an approximation.
  Choosing an azimuthal average (Iyy+Izz)/2 versus a full tensor/dynamics treatment
  is a separate, explicit decision. RadiusRingComponent axial-line transverse
  spread remains outside this change. Off-centre thrust moments and general
  off-centre force application/tensor coupling are still absent. Roll motion can
  change with applied roll torque or existing roll; zero initial roll and zero
  roll torque preserve the trajectory while the reported inertia can change.
  Uncanted fins alone do not establish those conditions.
- **Saved runs and guide:** `revisionInertia.ts` exports the conservative
  `affectsRollInertia(tree)` predicate for Claude's revision-history integration.
  It intentionally includes symmetric and already-correct off-axis layouts and
  ignores neither overrides nor motorless/uncanted designs. The editable guide
  source is updated; its generated module must be regenerated by Claude.

### masscalc/MassCalculation.java + rocketcomponent/RingComponent.java — an OFF-AXIS mount carries its parallel-axis ROLL inertia (code review E1, 2026-09-22)

- **Why:** an inner tube placed off the centreline on its own (`radialPosition` ≠ 0 — the
  desktop "split cluster", one tube per motor, is the everyday case) contributed NO
  transport term to roll inertia, neither for the motor in it nor for the tube itself.
  Two holes, one per half:
  - **Motor** — `MassCalculation.calculateMountData` puts the motor's CM on the mount's
    PARENT axis (`clusterLocalCM` has y = z = 0) and adds `eachMass * d²` per instance,
    but only inside `if( 1 < instanceCount )` ("more than 1 motor => motors are not at
    the centerline"). `InnerTube.getInstanceOffsets()` carries the radial shift for every
    cluster count, so a single off-axis mount's offset was right there and was skipped.
  - **Tube** — `RingComponent.getRotationalUnitInertia` is the ring's own
    `(ro² + ri²)/2` and nothing else, while `getComponentCG` puts a single tube's mass on
    the parent axis and a cluster's at the MEAN of its offsets. So a single off-axis tube
    missed `m·r²` and a cluster's tubes missed their spread about the mean — the second
    one in EVERY cluster, including the ones built with the cluster dropdown.
  Upstream 24.12 has both holes byte for byte; this is an inherited defect, not a
  regression. Found by the 19 September code review
  (`docs/testing/review-2026-09-19-engine-app-physics.md` E1), verified and measured in
  `docs/testing/response-2026-09-21a.md` §1 (roll inertia 52.7 % low, peak roll rate
  6.2 % over, apogee 1.3 % on that sitting's motor-dominated split cluster). Ruled by Eric
  in `docs/testing/issues-2026-09-22a.md`: *"fix all the issues found in the code-review"*
  — that review's E1, whose own measured omission is `2 × (m_tube + m_motor) × 0.03²`, i.e.
  both halves.
- **The measured symptom, from the goldens this entry added** (`inertia.offaxis.*`, before
  the fix): `split` (two tubes at ±30 mm) printed the SAME seven numbers as `centre` (the
  same two tubes on the axis), bit for bit, while `double` — the identical geometry built
  as one 'double' cluster — carried its motors' `2 × 0.35 × 0.03²` = 6.3e-4 kg·m². And
  `ring3`'s DRY roll inertia equalled `ring3zero`'s (the same cluster at clusterScale 0)
  to the last digit: the tubes' spread was never charged.
- **Change, `MassCalculation` (the motor half, extends the v0.088 patch):** the guard is
  gone; every instance gets `eachMass * hypot(y, z)²`. The N > 1 path runs exactly the
  expression it always ran, and a centreline mount's single offset is (0, 0, 0), so the
  added term is `eachMass * 0² = +0.0` and `clusterIr` is bit-identical by construction.
- **Change, `RingComponent` (the tube half, NEW patch — promoted from carved):**
  `getRotationalUnitInertia` returns `own + instanceSpreadUnitInertia()` — the per-unit-mass
  `Σ|d_i − ref|² / N` of the instance offsets' lateral components — and returns `own`
  UNTOUCHED when the spread is exactly 0.0 (a structural guard, not `own + 0.0`). The
  spread is 0.0 for every centering ring, bulkhead, coupler and engine block (their
  offsets are the inherited single ZERO, or a RadiusRingComponent line pattern along x
  only) and for every centreline tube.
- **The modelling choice, stated because it is one:** `ref` is the lateral point
  `getComponentCG()` ALREADY reports — (0, 0) for one instance, the mean of the offsets for
  several — and the motor half's reference is the mount's parent axis, where
  `clusterLocalCM` already sits. So both halves add ROLL inertia and nothing else: no CG
  moves, and no pitch/yaw term appears through `rebase()`. Rejected: moving a single
  tube's CG out to its offset (the `MassObject` convention). That is exact inside a pod
  set, but it also adds `m·z²` to Iyy and `m·y²` to Izz through `rebase()` — and the
  stepper uses Iyy for BOTH pitch and yaw, so a tube's pitch/yaw inertia would depend on
  which way round the body it was clocked. Outside the ruling, and not an improvement.
- **Known residuals, recorded rather than modelled:** (a) the terms are about the mount's
  PARENT axis, so a tube that is off the axis INSIDE an off-axis pod set is charged
  `m(D² + d²)` for pod offset D and tube offset d, missing the `2m·D·d` cross term —
  shared with upstream's own cluster motors in pods, and `calculateMotors` applies no
  instance ROTATION to a pod's children, so the motor half could not be exact there
  without a wider rewrite; (b) an off-axis motor's thrust still makes no moment
  (upstream's own `TODO: HIGH` on `RK4SimulationStepper.calculateThrust`); (c) the pitch
  spread of a RadiusRingComponent LINE pattern (rings strung along x) is still missing
  from Iyy — the same species on the other axis, upstream, untouched here; (d) for a
  layout whose mass centre is itself OFF the axis — a single off-axis mount is the case —
  roll inertia is taken about the BODY axis, not the axis through the true CG, so it
  overstates by `M·ȳ²` for the CG's lateral offset ȳ. It follows from the choice above to
  keep the CG on the axis, and it is zero for every symmetric layout (a split pair, every
  dropdown cluster), whose CG IS on the axis. Measured on the golden
  `inertia.offaxis.single` (M = 0.8637187376489845 kg; tube + motor 0.3595818575934489 kg
  at 30 mm, so ȳ = 12.49 mm and `M·ȳ²` = 1.3473e-4 kg·m², 7.3 % of the reported figure):
  Ixx 1.8421849153740075e-3 kg·m² against 1.70745e-3 about the CG axis, **7.9 % high** —
  where the pre-fix 1.5185612435399036e-3 was **11.1 % low**, so this entry shrank that
  design's error and flipped its sign. Not listed until the seam review of the audit's
  wave A (2026-09-22) measured it; documentation only, no code change.
- **Divergence from upstream:** YES, deliberate, in ALL THREE aerodynamic models — masscalc
  has no carrier for the model flags, exactly as the v0.088 entry above records. It makes
  the app's mass model disagree with desktop OpenRocket 24.12 on purpose for any design
  with an off-axis tube — and a cluster's tubes ARE off-axis tubes, so that is EVERY
  cluster with a non-zero spacing, the ones built with the cluster dropdown included (the
  tube half; their motors already had the term). Roll inertia is printed in All stats, so
  under Classic Extended Barrowman too those designs now show a figure desktop 24.12 does
  not. **Copy that must say so:** the user guide's "If you want the 24.12 model's own
  answers" list (How It Works: Physics & Math) names what Classic Extended Barrowman does
  NOT switch off — the fixed turbulence seed, the v0.088 override inertia, the streamlined
  protuberance — and this belongs beside the v0.088 item. The guide is release copy, not a
  kernel file, so the wording rides in this package's return (audit 2026-09-22); until it
  lands, that paragraph overstates parity for every clustered design.
- **Oracle:** the before/after `goldenJvm` diff (difftest compares JVM with TeaVM and has no
  baseline). **All 355 pre-existing lines are bit-identical** — including
  `cluster.ring3.*` and `flight.cluster.ring3`: no pre-existing golden prints a cluster's
  Ixx, and that one cluster flight is vertical, windless and uncanted, so its roll moment
  is exactly 0 and `momZ / Ixx` is 0 whatever Ixx is. The prediction in the 21 September
  verification that the tube half "moves existing cluster goldens" did not hold. Movement
  is confined to the new `inertia.offaxis.split/double/single/ring3` and
  `flight.offaxis.split.canted`; `centre` and `ring3zero` did not move. **Checked as
  arithmetic, not as "the number changed":** `split − centre` Ixx = 6.472473436682075e-4
  against `2 × (0.009581857593448866 + 0.35) × 0.03²` = 6.47247343668208e-4; the dry
  difference 1.72473436682077e-5 against `2 × 0.009581857593448866 × 0.03²`;
  `single − centre-of-one` likewise at one mount; `ring3 − ring3zero` = 3.4555816514730e-4
  against `3 (m_t + m_m) r²` with `r = 2·ro/√3`; and `split` equals `double` in Ixx
  (0.0022048313168307873) and dry Ixx to the last printed digit.
- **User-visible, measured** on the golden fixture (98 mm airframe, two 31 mm mounts at
  ±30 mm, 0.35 kg motors), through the shipped wrapper and the TeaVM artifact: loaded roll
  inertia **1.5575839731625798e-3 → 2.2048313168307873e-3 kg·m²** (the old value 29.4 %
  low), dry **1.4839964731625797e-3 → 1.5012438168307874e-3** (1.1 % low). Mass, CG and
  pitch inertia unchanged bit for bit. With 0.5° of fin cant the roll is quasi-steady (a
  steady roll rate does not depend on inertia) and max roll rate moves 7.98266 → 7.98173
  rad/s, apogee +0.0001 m; with a 0.4 s, 800 N burn per motor and 2° of cant, max roll
  rate **166.534 → 164.595 rad/s** (the old value 1.2 % over) and apogee 867.222 →
  867.203 m. The verification's own motor-dominated case is the one quoted above (52.7 %).
  **A cluster built with the dropdown moves too, by the tube half alone** (the goldens,
  before → after, same airframe): `ring3` — three 31 mm tubes touching, 3-ring, 0.35 kg
  motors — loaded roll inertia 1.9329567027852556e-3 → 1.94216486793256e-3 kg·m²
  (+0.48 %), dry 1.4862254527852556e-3 → 1.49543361793256e-3 (+0.62 %); `double` at
  ±30 mm, loaded 2.1875839731625795e-3 → 2.2048313168307873e-3 (+0.79 %), dry +1.16 %.
  Small, because a paper tube is light against its motor, but no longer bit-identical to
  desktop for any spaced cluster.
- **Goldens:** `offAxisInertiaScenarios()`, appended at the END of the roster (difftest
  compares by line index). Differential **355 → 362 lines**, JVM↔TeaVM clean (235
  bit-identical, 127 within the existing tolerances).
- **Behavioural guards:** `packages/engine/src/rollInertia.test.ts`, 6 tests — the split's
  loaded and dry increments as parallel-axis arithmetic on masses the kernel reports, the
  split equal to the double cluster, the single asymmetric mount, the 3-ring cluster's
  tube spread, a centreline design pinned to its pre-fix values with `toBe`, and the split
  and double FLYING identically with canted fins. Five of the six fail against the pre-fix
  artifact; the centreline pin passes on both, which is its job.
- **Artifact:** `packages/engine/vendor/orkengine.mjs` 2,743,381 → 2,751,636 bytes, md5
  `bef15ae395e45b0d271946d3234082fa` → `dec183bb5dd8d3cae8a0e857e97377a1`.
  `instanceSpreadUnitInertia` 0 → 2 in the artifact (TeaVM links it only if something calls
  it, so the count is the proof the tube half is really in). The Gradle log said
  `teavmClasses UP-TO-DATE` while `compileJava` recompiled — the grep, not the log, is the
  evidence.
- **Upstreamable:** yes, both halves — an upstream arithmetic bug, confined to one guard and
  one accessor.

### simulation/RK4SimulationStepper.java — pressure thrust is charged once per stage INSTANCE, as the drag half does (on a one-base stage always; on every stage since kernel pass 2) (code review E2, 2026-09-22)

- **Why:** `calculatePressureThrust` (feature #5 above) de-duplicated its term by
  `stage.getStageNumber()` and stopped there. That is ONE number for a whole
  `ParallelStage`, so N strap-ons collected one nozzle's worth of pressure thrust while
  `MotorClusterState` flew N curves (`motorCount = mount.getComponentLocations().length`) and
  the power-on base-drag half removed N nozzle areas (`BarrowmanCalculator.calculateBaseCD`,
  `total += instanceCount * cd`). Found by the 19 September code review
  (`docs/testing/review-2026-09-19-engine-app-physics.md` E2): through the raw API at ~86 kPa,
  two instances of a 32 N motor behind a 10 mm exit flew 65.203822 N where per-instance
  accounting gives 66.407645 N. v0.136 made that input THROW in `OrkRocket.buildTree`
  (`assertNoAssemblyNozzle`) rather than fly it short; this entry is the arithmetic that lets
  the throw go. Ruled in `docs/testing/issues-2026-09-22a.md` with the rest of the review.
- **The definition, stated because the feature #5 bullet said it had to be ruled first:**
  per INSTANCE — on a parallel stage the field is ONE strap-on's equivalent exit. That is what
  it already meant to the drag half, so choosing it changes one half, not both; the other
  reading (the assembly's total) would have meant rewriting the drag half's per-component
  subtraction. The app has no nozzle field on a parallel stage yet (`FIELDS.parallelstage`
  carries none; `applyStageNozzles` writes top-level stages), so no user file carries either
  reading today.
- **Change:** after the stage-number de-dup, the credited stage's term is multiplied by
  `stage.getComponentLocations().length` — the accessor `MotorClusterState` reads on the
  MOUNT for `motorCount`, here read on the stage, so an enclosing assembly's multiplicity
  counts the way the motors' curve thrust counts it. The multiply is STRUCTURAL: skipped when
  the count is 1, which it always is for a serial stage (its parent is the `Rocket`), so every
  path the app can reach runs exactly the arithmetic it ran before. `orkEngine.ts`: the guard
  is now `assertNoPodSetNozzle` — a `podset` is still refused (it is not an `AxialStage`,
  `ComponentFactory` never hands it the field, and its pods burn as part of the enclosing
  stage, so the value would be dropped without a word); a `parallelstage` is accepted.
- **Divergence from upstream:** none new — pressure thrust is a feature patch that upstream
  does not have; gated, as before, to Rogers Kbf / Supersonic.
- **Oracle:** the before/after `goldenJvm` diff. Goldens `flight.pthrust.para1..3`
  (`parallelPressureThrustScenarios()`, appended at the end: a motorless core with N = 1, 2, 3
  strap-ons, each a 32 N plateau motor behind a 10 mm exit, Kbf, the 1,400 m / 303.15 K /
  86,000 Pa pad, cut at 3 s). **367 of 377 lines bit-identical** — every pre-existing line and
  all five `para1` lines (the N = 1 path takes no multiply). Movement is confined to `para2` and
  `para3`, and it checks as arithmetic: `para2.sample.5` reads P = 86015.92597998893 Pa and
  thrust 66.40474372372645 N, which is `2 × 32 + 2 × (π × 0.005²) × (101325 − P)` to the last
  digit; before the fix the same row read 65.20237145593025 N, `64 +` ONE term. Altitude at the
  3 s cut: `para2` 234.335 → 237.920 m, `para3` 264.015 → 278.388 m. Differential 362 → 377
  lines, JVM↔TeaVM clean (250 bit-identical, 127 within tolerance).
- **User-visible:** none today. No app path puts a nozzle exit on a parallel stage (above), so
  the only way to reach the old or the new arithmetic is the raw engine API, where the old one
  now cannot be reached at all. When the queued parallel-stage nozzle field lands, it gets the
  per-instance reading both halves share.
- **Residual found while doing this — FIXED the same day (kernel pass 2, audit 2026-09-22):**
  the drag half subtracted the nozzle area from EVERY base in the stage, pods included (a
  pod's `getStage()` is the enclosing stage), so a stage with more than one base per instance
  recovered more than one area while this half charged exactly one — measured at M0.3 (a 58 mm
  airframe, radius 29 mm, 20 mm exit, two 24 mm pods) as 0.046980 against one area's 0.015660,
  exactly three. The credit now lands on the stage's aft-most base only; entry, goldens and
  measurements under "Correctness fixes", *the power-on nozzle credit lands on the stage's
  aft-most base*, the next entry. (This bullet was the only record of the defect until then —
  it had reached neither the board nor `open-items.md`, which the fixing package could not
  write either; its return hands the closure over for filing.)
- **Behavioural guard:** `packages/engine/src/pressureThrust.test.ts`, *"credits a parallel
  stage one nozzle area per strap-on"* — for N = 1, 2, 3, every plateau row bit-exact against
  `N × 32 + N × term` and, for N > 1, NOT equal to the pre-fix `N × 32 + term`. It fails
  against the pre-fix artifact (65.20240478887837 read where 66.40480957775674 is due) and
  passes after. *"still refuses a nozzle exit diameter on a pod set"* keeps the other half of
  the v0.136 guard pinned.
- **Artifact:** `packages/engine/vendor/orkengine.mjs` 2,751,636 → 2,755,268 bytes (the harness
  scenario is most of it), md5 `dec183bb5dd8d3cae8a0e857e97377a1` →
  `dafd535038530da83eacef3083d33f19`. `getComponentLocations` 13 → 14 occurrences — the new
  call site in `calculatePressureThrust`, which is the proof the change is in the build.
- **Upstreamable:** n/a — upstream has no pressure-thrust term.

### aerodynamics/BarrowmanCalculator.java — the power-on nozzle credit lands on the stage's aft-most base, once per stage INSTANCE (kernel pass 2, audit 2026-09-22)

- **Why:** feature #2's `calculateBaseCD` subtracted the stage's equivalent nozzle-exit area
  from EVERY `SymmetricComponent` base whose `getStage()` was the thrusting stage. Two kinds
  of base were over-credited: a POD's tube (a pod's components are children of their
  `PodSet`, but their stage is the enclosing one) and a STEP-DOWN part way along the stage's
  own line (a wide tube straight onto a narrower one, no transition). So a stage with k bases
  per instance recovered k nozzle areas — clamped at each base's own area — while the
  pressure-thrust half charged exactly one per stage instance (E2, the entry above). Found
  while doing E2, recorded there as a residual, verified twice on 2026-09-22 and confirmed at
  `3918947` by a failing test before this change: through the shipped wrapper at M0.3, Rogers
  Kbf, a 29 mm airframe (radius 14.5 mm) with a 20 mm exit, the reduction was
  **0.18791914387633768 with two 24 mm pods against 0.06263971462544587 without — 3.000
  areas** — and a 40 mm tube stepping onto a 29 mm one recovered **0.06585, two areas**. The
  field is defined app-side as the stage's single equivalent exit (areas summed), so one area
  per stage instance is the accounting both halves are meant to share.
- **Change:** one more conjunct on the credit — `&& isStageAftBase(s, stage)`, evaluated LAST,
  after the model gate, the nozzle and the thrusting flag — and a private static
  `isStageAftBase` appended after `calculateBaseCD`: true only for the LAST `SymmetricComponent`
  child of the stage itself. A pod's parts are children of their `PodSet`, so they never
  qualify; an earlier part of the stage's line never qualifies, so a step keeps its whole
  base. The stage's children are its body line in axial order (`AxialStage` and
  `ParallelStage` accept `BodyComponent`s only, and in this kernel every `BodyComponent` is a
  `SymmetricComponent`) — the same child order `getNextSymmetricComponent` reads to decide that
  a base exists at all. `total += instanceCount * cd` is untouched, so the one credited base
  still scales by the stage's instance count and an N-strap-on `ParallelStage` recovers N
  areas, exactly as E2 made the pressure-thrust half charge them. If the stage's last
  component is not a base (a sustainer onto an equally wide interstage, or flush on the stage
  below), the stage gets no credit anywhere, a step earlier in its line included — correct, the
  exhaust has no base of that stage to pressurize.
- **Scope, structurally:** the new conjunct runs only when the old credit would have been
  taken, so Classic Extended Barrowman (the gate), every design without a nozzle and every
  coasting step execute nothing new, and a stage whose one base IS its last component — the
  whole corpus bar the three shapes below — takes the identical branch with identical
  arithmetic.
- **Who moves — the wording a CHANGELOG needs (corrected in review, 2026-09-23; "pods or a
  step" alone understated it):** under Rogers Kbf / Supersonic / Auto, a stage with a nozzle
  exit set AND a base anywhere other than its aft-most component. (a) **Pods** on the stage:
  each pod's base had taken an area of its own. (b) **A step-down** part way along the stage's
  own line, no transition: the step had taken one. (c) **A step on a stage that sits flush on
  the stage below:** that stage's ONE base is the step, and it now takes NOTHING — its motors
  fire into the stage below, not through the step. (a) and (b) lose the credit they had on top
  of the aft base's; (c) loses its whole credit. (c) shows only while the stage below is
  attached: always in the Drag panel's power-on curve (`getDragSweep` marks every stage
  thrusting with every stage active), in flight only when a stage burns before the stage below
  separates. Measured through the raw bridge at M0.3, Kbf — a sustainer of nose, 40 mm tube and
  29 mm tube with a 20 mm exit, on a flush 29 mm finned booster: power-on base CD 0.098775 →
  0.1317 (one area → none), found by the fix's adversarial review. Every mover gains base drag;
  none loses any.
- **Divergence from upstream:** none new — feature #2 is ours, gated to Rogers Kbf /
  Supersonic / Auto as before. The comment in `RK4SimulationStepper.calculatePressureThrust`'s
  javadoc that said the drag half subtracts "from each aft base" is corrected in the same
  commit (comment only: the stepper's bytecode, and its part of the artifact, are unchanged).
- **Oracle:** the before/after `goldenJvm` diff. Goldens `podNozzleBaseDragScenarios()`,
  appended at the END (difftest compares by line index): `podnozzle.{bare,pods,step,pods.ss}.*`
  (mach, offBase, onBase, offTotal, onTotal at M0.3/0.9/1.5 through `getDragSweep`) and
  `flight.podnozzle.{pods.kbf,pods.classic,podmotors.kbf}`. The scenario was added FIRST and
  run on the unfixed kernel, then the fix: **all 380 pre-existing lines bit-identical, and 384
  of 395 overall** — `podnozzle.bare.*` (one base: must not move) and
  `flight.podnozzle.pods.classic` (the model-gate leak detector) are among the unmoved.
  Movement is confined to the 11 `pods`/`step`/`pods.ss`/`pods.kbf`/`podmotors.kbf` lines.
- **Checked as arithmetic, not as "the number changed":** `pods` at M0.3 now reduces base CD by
  0.31210237812128416 − 0.24946266349583826 = 0.0626397146254459, against `bare`'s
  0.06263971462544587 and `0.1317 × (10/14.5)²` = 0.06263971462544589 (last-place rounding);
  before, the same row read 0.12418323424494648 on, a reduction of 0.18791914387633768 =
  3.000000000000001 × `bare`'s. The pods' power-OFF base drag is untouched: `pods` − `bare`
  power-off = 0.18040237812128418 = `2 × 0.1317 × (12/14.5)²`. `step` at M0.3: 0.1317 −
  0.098775 = 0.032925 = `0.1317 × (10/20)²` on its 40 mm reference (before: 0.06585, two
  areas); at M1.5, 0.16666666666666669 − 0.125 = one area of `0.25/1.5`. Differential **380 →
  395 lines**, JVM↔TeaVM clean (265 bit-identical, 130 within tolerance).
- **User-visible, measured** through the app's own importer, motor matcher, nozzle database
  and tree translator on both artifacts (`vite-node`, scratch driver): **LEM-IV** (Eric's own
  design, `docs/User files/LEM-IV.ork` — two 25.4 mm pods on the fin can, whose 5.07 cm² bases
  are each smaller than the exit and so were zeroed outright), with the M1500G its flown
  configuration names and that motor's published 1.875 in exit applied to its stage as the
  nozzle-follow rule applies it: **Rogers Kbf apogee 3924.038 → 3894.020 m (−30.0 m,
  −0.76 %)**, max velocity 453.730 → 450.231 m/s; **Supersonic 3783.646 → 3760.178 m
  (−23.5 m, −0.62 %)**. The file's default configuration (HP-K535W, 1.25 in exit): −0.38 %
  under both. The same flights with no nozzle are bit-identical on both artifacts (3823.480 /
  3704.954 m) — the way back is unchanged. The whole nozzle model's effect on LEM-IV's M1500G
  flight falls from +2.63 % to +1.84 % of apogee (Kbf). Golden fixture: `pods.kbf` 359.368 →
  354.145 m (−1.45 %), `podmotors.kbf` 541.833 → 537.388 m (−0.82 %). Every mover LOSES
  apogee: the old kernel shed base drag the pods never lost.
- **Every tester file, scanned (review fix-up, 2026-09-23):** all 31 `.ork` files under
  `docs/User files`, a 20 mm exit put on each stage in turn, power-on base CD at M0.3 under Kbf
  through the app's importer on both artifacts. Four files move: the three LEM-IV copies (pods)
  and **`TRF RASAero Files/Wildman Mach 2 this one.ork`** — shape (b): a single-stage minimum-
  diameter design whose 56.5 mm airframe meets a boattail the file gives an explicit 55.4 mm
  fore diameter, a 0.96 cm² step the old kernel credited a whole exit against and so zeroed.
  Measured the LEM-IV way, with each motor's published 1.25 in exit: the file's default
  configuration **K805G, Kbf 5024.910 → 5016.904 m (−0.16 %), Supersonic 4824.915 → 4817.597 m
  (−0.15 %)**; L1000 −0.26 % under both; K250W, a long low-thrust burn and the largest mover
  of the three configurations measured (of 41), **Kbf 8756.892 → 8699.200 m (−0.66 %),
  Supersonic 8265.735 → 8215.166 m (−0.61 %)**.
  No-nozzle flights bit-identical on both artifacts. **No tester file has shape (c):** every
  upper stage in the seven multi-stage files sits flush with no step and is credited nothing,
  before and after.
- **Known residual, recorded rather than modelled:** the clamp `max(0, area − nozzleArea)` now
  applies to one base, so a stage whose motors sit ONLY in pods, on a core whose own aft base
  is smaller than the summed equivalent exit (a core tapering to a point, say), is credited
  less than one area in the drag half while the pressure-thrust half still charges the full
  one. Crediting the remainder onto the pods' bases would mean knowing which mounts burn
  through which base — the kernel's thrusting flag is per stage, not per mount. Before this
  fix the same design was over-credited by up to one area per pod, so the error shrank and
  changed sign; no tester file has the shape (LEM-IV's motor is in the core).
- **Behavioural guards:** `packages/engine/src/nozzleBaseDrag.test.ts`, 5 tests — the pod
  design's reduction equals the podless design's and one area, under Kbf and Supersonic, at
  M0.3 and M0.9, with the pods' power-off base drag pinned; the stepped airframe credited once;
  a stepped sustainer flush on its booster credited NOTHING for its own nozzle (`on === off`)
  and exactly one area when the booster carries one; a parallel stage still credited N areas
  for N strap-ons; and Classic inert (`on === off`) on all three single-stage designs, plus the
  pod design with no nozzle under Kbf. The first three fail against the pre-fix artifact
  (0.18791914387633768, 0.06585 and 0.098775 read where one area, one area and none are due);
  the last two pass on both, which is their job.
- **Artifact:** `packages/engine/vendor/orkengine.mjs` 2,759,604 → 2,766,975 bytes (the golden
  scenario is most of it), md5 `5f8d53e985b754d457b1710343f8a300` →
  `e04d4a5aa19e3ee46bf4c8545cc4baae`. `isStageAftBase` 0 → 2 occurrences (the definition and
  the call inside the nozzle branch) — the grep, not Gradle's `UP-TO-DATE`, is the evidence.
  The HEAD artifact was first rebuilt from HEAD source and reproduced byte-for-byte, so the
  before side of every measurement above is the kernel users have.
- **Upstreamable:** n/a — upstream has no nozzle-exit model.

### aerodynamics/BarrowmanCalculator.java — pods-only nozzle budget on motor-carrying pod bases (2026-09-30; build verification pending)

- **Ruling/scope:** CODEX-GO.md approves the pods-only aggregate model. One stage-instance
  equivalent exit budget is distributed over the terminal exposed bases of the pod lines
  carrying that stage's motors. This closes the small/pointed-core residual recorded in
  the 2026-09-22 entry above; it does not introduce per-mount plume physics.
- **Implementation:** `podsOnlyNozzleCredits` runs lazily after the existing non-Classic,
  positive-nozzle and stage-thrusting gates. Loaded mounts from the selected flight
  configuration decide ownership; an empty core mount is ignored when pod motors are
  loaded. If this stage has no installed motors, the static power-on preview uses its
  declared active mounts. With no mount layout, or a core/mixed loadout, the existing
  `isStageAftBase` path remains. A mount's nearest PodSet identifies its body line;
  ownership never crosses an AxialStage/ParallelStage. Decorative and unloaded pod
  lines, intermediate steps and the motorless core cannot spend a pods-only budget.
- **Geometry/accounting:** `B_j = pi (r_aft^2 - r_next^2)` when positive, using the same
  active-next and zero-length-disk rules as the base loop. Let `n_j` be the base's active
  instance count divided by the owning stage's structural instance count, and
  `S = sum(n_j B_j)`. Each base gets `B_j min(1, Ae/S)` for positive S, zero otherwise.
  The original final instance multiplication yields `min(Ae,S)` per stage instance.
  Allocation includes overridden bases geometrically, before the original CD-override
  suppression; an overridden base's unused share cannot spill onto another body.
  Force-map reporting and `lastBodyBaseCD` remain in the existing loop.
- **Unchanged:** pressure-thrust arithmetic, boattail/wave formulas, Classic and coast
  gates, zero-nozzle paths, and ordinary core/mixed allocation. The stepper's javadoc
  alone now explains the pods-only destination and that the base-area cap does not cap
  pressure thrust. New Java lines/comments are ASCII; carved copies were generated
  only with `node engine-java/scripts/carve.mjs`, not hand-edited.
- **Who can move after rebuilding:** pods-only stages under Rogers Kbf, Auto or
  Supersonic with a positive nozzle while thrusting. Small-core designs can recover
  missing drag credit, but the boundary is not confined to pointed cores: moving the
  destination/cap from the core to eligible pod bases can also reduce available credit.
  No flight/apogee direction or percentage is claimed. No corpus was run.
- **Tests/oracles:** `packages/engine/src/nozzleBaseDrag.test.ts` adds nine tests for
  pointed/small cores, unequal bases, aggregate cap, decorative pods/steps, overridden
  shares, per-instance normalization on repeated strap-ons, loaded versus declared
  mount selection, mixed/core fallback, nested stages, zero-length disks, Classic/OFF,
  and no-layout fallback. Expectations derive from geometry and `0.12 + 0.13 M^2`,
  with 1e-12 decimal-place CD comparisons (Vitest absolute threshold 5e-13).
  Freeform fins use rounded and airfoil cross-sections. `pressureThrust.test.ts` adds
  clustered strap-on and pods-only-over-cap flights, deriving thrust from the plateau
  curve and each row's measured pressure, tolerance 5e-10 N. GoldenMain appends four
  `podsonly.*` rows (pointed, finite core, capped unequal pods, installed pod motor)
  after all prior scenario calls; these new rows have NOT been compiled/run.
- **Actual verification, Node v24.19.0:** carve exit 0; patch/carved byte equality
  confirmed. The authorized `JAVA_HOME=C:/Users/peltz/.online-openrocket/jdk-17.0.20+8
  npm run engine:js` attempt exited 1 before compilation: Gradle could not create
  `C:\.gradle\wrapper\dists\gradle-8.12.1-bin\...\gradle-8.12.1-bin.zip.lck`.
  No retry/workaround was attempted, per GO. The vendor artifact is unchanged.
  Against that OLD artifact, the final two-file engine run exits 1: 18 passed,
  eight new pods-only drag tests failed at the expected old allocation; all 12
  pressure-thrust tests pass. This is regression sensitivity, NOT validation of
  the new Java implementation. No successful rebuilt-artifact test, before/after
  golden measurement, JVM/TeaVM differential, or Java mutation run is claimed.
- **Remaining gate/mutations:** Claude must rebuild/copy, clear the app Vite cache,
  verify `podsOnlyNozzleCredits` in the shipped artifact, run both engine test files
  and `node engine-java/scripts/difftest.mjs`, and compare before/after JVM goldens.
  Rebuild for each mutation: restore core-only allocation; give every pod a full exit;
  remove the aggregate cap/nonnegative clamp; include decorative or intermediate bases;
  remove per-stage-instance normalization; include overridden bases' shares in other
  bodies; use declared mounts despite loaded motors; treat an empty core mount as
  loaded; cross stage ownership; remove the no-layout fallback; remove model/thrusting/
  positive-exit gates; change disk/active-next geometry; cap or double-count pressure
  thrust. Restore and rebuild the fixed artifact afterward. See CODEX-REPORT.md for
  the exact command list, mutation-to-test mapping and remaining coverage limits.
- **Limits:** a scalar stage exit cannot recover separate exit areas for unequal pod
  motors. Stage-level thrusting still spends the whole budget when the first owned
  motor lights; staggered ignition/per-mount plume allocation remain outside this fix.
  A separate inactive-following-component scenario still needs a harness with stage
  activation control; the helper deliberately mirrors the existing active-next rule.

### aerodynamics/BarrowmanCalculator.java - Fix 1: stage-less active components (2026-09-30)

- **Supersedes the artifact status above:** the orchestrator rebuilt the initial
  pods-only implementation before this follow-up. That artifact throws in 13 of
  14 nozzle-base-drag tests; all 12 pressure-thrust tests pass. This is a real
  regression in the new allocation, not an old-artifact numerical mismatch.
- **Cause:** the declared-mount fallback called `c.getStage()` before checking
  `c instanceof MotorMount`. The active instance map includes Rocket: its stage
  number is -1, which FlightConfiguration considers active, but its ancestry has
  no AxialStage and `getStage()` throws. The same throwing API was used for
  installed mounts and the base's nozzle owner.
- **Fix:** the private `nozzleStage` parent walk returns the nearest AxialStage
  (including ParallelStage), or null for a root/unowned component. All three
  nozzle ownership lookups use it; the fallback filters declared motor mounts
  first. No exception is swallowed, no stage is guessed, and no allocation,
  pressure-thrust, core/mixed fallback or exposed-base arithmetic was changed.
  Patches were applied through carve; no carved source was hand-edited.
- **Actual Fix 1 checks:** carve exit 0. With the approved worktree-local
  GRADLE_USER_HOME and portable JDK 17, Java compilation completed, but
  `npm run engine:js` exited 1 with `java.nio.file.AccessDeniedException` at
  `C:\git\oor-wt\nozzle\engine-java\build\reports\problems\problems-report.html`.
  No retry/workaround was attempted. The vendor artifact still contains the
  throwing lookup and lacks `BarrowmanCalculator_nozzleStage`. The two-file
  engine run exits 1: 13 failed / 13 passed, all failures the reported exception.
  This confirms the pre-fix regression only; the fixed runtime is unverified.
  `gradlew.bat -p engine-java --stop` with the same environment exited 0 and
  reported `1 Daemon stopped`.
- **Remaining gate:** rebuild and verify both helper symbols, clear the app Vite
  cache, rerun the two engine files and difftest without changing tolerances.
  Rebuild a mutation restoring the unsafe fallback condition and require the
  core/pod/step/flush/parallel tests to fail. Also exercise the ownership helper
  on a Rocket, detached mount, null, attached mount and nested ParallelStage;
  mutate its null result/nearest-stage stop. Run the preceding entry's allocation
  and pressure mutations on rebuilt artifacts. No Java mutation or differential
  pass was possible in this sandbox; CODEX-REPORT.md's Fix 1 section details it.

### aerodynamics/BarrowmanCalculator.java - Fix 2: installed motors in static sweeps (2026-09-30)

- **Cause:** buildRocket selects the same fcid that applyMotor stores on mounts,
  and getDragSweep uses that selected FlightConfiguration. The IDs were correct.
  BodyTube/InnerTube.setMotorConfig stores the new MotorConfiguration without a
  component-change event; FlightConfiguration.getActiveMotors returns its cached
  list. A static sweep directly after setMotorById could therefore see no cached
  motors and incorrectly use every declared mount, including empty core/pod mounts.
- **Fix:** inside the existing lazy nozzle allocation, walk the active instance
  map, filter declared MotorMounts by nearest owning stage, and read each mount's
  getMotorConfig(configuration.getFlightConfigurationID()). Nonempty records form
  the installed list; only an empty installed list uses the declared layout.
  This works without mutating configuration state or refreshing global caches in
  an aerodynamic calculation. Area/override/instance arithmetic, API setters,
  pressure thrust, model gates and all existing test expectations are unchanged.
- **Verification:** with the approved local Gradle home and portable JDK 17,
  carve and the kernel build/copy succeeded. The shipped helper contains the
  direct per-fcid lookup. All 26 tests in nozzleBaseDrag.test.ts and
  pressureThrust.test.ts pass, including both previously failing installed-motor
  cases and all four legacy regressions. Existing tolerances were not changed.
  Differential summary: `differential ok: 404 lines (269 bit-identical, 135 within
  tolerance - JS Math ULP noise; flight.* lines 1e-9 rel/1e-12 abs, others 1e-13 rel)`.
  This supersedes the preceding build-blocked status, not its historical results.
- **Mutation evidence:** rebuilt artifacts restoring the cached lookup, using
  the default instead of selected fcid, or accepting empty records each reproduce
  both installed-motor failures. In total, 18 mutations were rejected by the
  unchanged base-drag tests, including the unsafe-root lookup, stage ownership,
  preview/legacy fallbacks, area sharing/cap, instance divisor, override shares,
  intermediate bases, disk geometry, Classic/thrusting gates and core-only path.
  All 36 mutation/restoration builds exited 0; every mutation was restored and
  rebuilt. The final two-file engine run exits 0, all 26 tests pass. The daemon
  was stopped (exit 0, one daemon). Patch/carved and generated/vendor byte equality
  passed. Exact mutation counts, commands and remaining limits are recorded in
  CODEX-REPORT.md, Fix 2. These checks do not replace an accepted-baseline JVM
  golden comparison, corpus validation or the orchestrator's integration gate.

### aerodynamics/barrowman/RocketComponentCalc.java (NEW patch) + FinSetCalc.java + TubeFinSetCalc.java (NEW patch) - bounded fin CP at low aspect ratio (OpenRocket #3196 / PR #3262, superseding #3235; 2026-10-08)

- **Ruling:** Eric, 2026-10-08, decision 70 - apply the upstream aerodynamic fixes in ALL models,
  Classic included. No flag and no Classic-parity exception. `calculateCPPos` was never model-gated, so
  Classic, Kbf, Supersonic and Hybrid (through its two endpoint calculators) all take the change.
  Plan: `docs/research/or-issues-sweep-2026-10-07/BUG-PLAN.md` sections 12 and 24; worktree plan
  `.claude/aero-plan.md`.
- **Defects:** (1) above Mach 2 the fin CP fraction along the MAC is `(AR*beta - 0.67)/(2*AR*beta - 1)`,
  which has a POLE at AR*beta = 0.5 (NACA 1307 eq. 63 holds only for AR*beta > 1). A fin with
  AR < 0.289 crosses it above Mach 2: measured on a 3-fin AR 0.2 rectangle on a 25 mm body, whole-rocket
  CP read 4,078 mm on a 400 mm rocket at M2.69 (Classic). (2) Between Mach 0.5 and 2 a fifth-order
  polynomial with Mathematica coefficients rounded to six figures and the common denominator
  `(1 - 3.4641*AR)^2` - singular at AR 0.2887 (AR 0.29: CP fraction -2.0 at M0.51) and forward-moving
  for low/intermediate AR (AR 0.6). (3) #3235: TubeFinSetCalc in 24.12 allocates the same polynomial
  but never fills it, so a tube fin's CP between M0.5 and M2 sat at the tube's LEADING EDGE (fraction 0).
- **Change:** upstream PR #3262 ported, merged onto OUR files. RocketComponentCalc gains upstream's
  block verbatim (`SUBSONIC_CP_POS`, `supersonicCPPos` - quarter chord below AR*beta 0.84, a cubic Hermite
  bridge to the source formula at AR*beta = 1, the source formula above; `transonicCPPos` - the same
  quintic computed from exact endpoint constraints, and above slope ratio 5/3 a monotone continuation
  `0.25 + delta * B(t)^(k/(5/3))`). FinSetCalc (our feature patch) loses `poly`, the constructor's
  `calculatePoly()` call and `calculatePoly()` itself; its `calculateCPPos` calls the two helpers.
  Nothing else in FinSetCalc moved - the Kbf root-quarter-chord carryover, the NACA-1307 split, the
  ssaero scale, cross-section/airfoil drag and `calculateAfterbodyFactor` are untouched (the last is a
  separate known defect, docs/research/supersonic-cp-2026-10-08/REPORT.md, deliberately out of scope).
  TubeFinSetCalc (new patch, upstream 24.12 + #3262's hunks) does the same; #3235's `calculatePoly()`
  call is NOT taken - #3262 deletes the polynomial it would fill.
- **Limit (upstream's own, kept):** the low-AR quarter-chord fallback and bridge are a bounded continuity
  device, not a measured low-aspect-ratio CP; they remove the singularity, not the model gap.
- **Behavioural guard:** `packages/engine/src/lowArFinCP.test.ts` (9 tests, through the shipped bridge,
  fin CP isolated exactly by subtracting the same rocket without fins): AR 0.2 through the old pole
  (finite, aft-moving, < 1 % chord per 0.01 Mach, quarter chord at M4, source branch at M5.2); AR 0.29 and
  AR 0.6 transonic; Classic equals the regularised curve at AR 0.2/0.35/0.6/2.5 (1e-9, a TS transcription,
  no kernel float literals); continuity at M0.5 and M2; tube fins AR 0.2 and AR 1 in all four models;
  rounded and airfoil low-AR freeform fins in all four models.
  **Fail-on-old:** against the pre-change artifact all 9 fail (vitest exit 1). **Mutations** (each a rebuilt
  artifact, exit 1): tube-fin patch removed -> the 2 tube tests fail, the 7 others pass; low-AR bridge
  bypassed (`supersonicCPPos` returns the source formula) -> 7 fail; monotone continuation bypassed (always
  the quintic) -> the AR 0.6 test fails. Restored artifact md5 identical to the pre-mutation build.
- **Artifact:** md5 `270fc0d6e7cd46afc4ec5e7e24e13f9d` -> `c72255847906eaecc4cefe08e5ad2316`;
  `transonicCPPos` 0 -> 3, `supersonicCPPos` 0 -> 4, `sourceSupersonicCPGradient` 0 -> 4,
  `calculatePoly` 2 -> 0 occurrences.
- **Goldens (JVM before/after `goldenJvm`, 421 lines):** 32 lines move, all fin-CP consumers on ordinary-AR
  fins: 16 `aero.cp` + 12 `aero.forces` (M0.8-1.5, CP x by at most 4.9e-8 m - the six-figure coefficient
  rounding, nothing else), `rogerskbf.0.8`, `ssaero.1.2`, and two flights by ULP-chaos
  (`flight.offaxis.split.canted` max speed 323.576 -> 323.617 m/s, 1.3e-4 rel, apogee +1.3e-5 m;
  `flight.podnozzle.podmotors.kbf` apogee 1.2e-11 m). Lines at M <= 0.5 and at M >= 2 with AR*beta >= 1 are
  bit-identical. Differential: `differential ok: 421 lines (283 bit-identical, 138 within tolerance)`.
- **Validation harness (`validation/score.mjs`, all four models, old vs new artifact):** gate points
  unchanged - Classic 13/191, Kbf 21/191, Supersonic 77/191, Hybrid 73/191; 4-5 rows per model move in the
  fourth decimal of %L (e.g. 70.9611 -> 70.9612).
- **Measured design-level change (whole-rocket CP x, 400 mm rocket, 25 mm body, Classic):** 6 tube fins
  AR 1: M0.8 344.9 -> 358.9 mm, M1.0 344.9 -> 360.7, M1.5 344.9 -> 364.3 (+14 to +19 mm, 0.6-0.8 cal, aft);
  6 tube fins AR 0.4: M0.8-1.99 327.1 -> 338.6 mm (+11.6 mm); 3 rectangular fins AR 0.2: M2.69
  4,077.6 -> 177.5 mm, M2.5 245.2 -> 184.0, M1.5 253.3 -> 238.5; an ordinary trapezoid (50/30/20/30 mm):
  unchanged to 1 um at every Mach sampled. Aft CP = more displayed margin for tube-fin designs between
  M0.5 and M2, where the old kernel UNDERSTATED it.

### aerodynamics/barrowman/FinSetCalc.java + aerodynamics/BarrowmanCalculator.java - transonic CNa lower-endpoint slope (OpenRocket PR #3236) and body-friction fineness on the DIAMETER (OpenRocket PR #3237; 2026-10-08)

- **Ruling:** Eric, 2026-10-08, decision 70 (as the #3262 entry above): ALL models, Classic included, no
  flag. Neither line was model-gated, so Classic, Kbf, Supersonic and Hybrid (both endpoint calculators)
  take both changes. Plan: `BUG-PLAN.md` sections 22 and 23.
- **#3236 defect:** `calculateFinCNa1` bridges M0.9-1.5 with a quartic `PolyInterpolator` (value and
  slope at both ends, zero curvature at 0.9). The lower slope `subD` - d(CNa)/dM of the subsonic formula
  at M0.9 - was written with the QUERIED `mach` in place of `CNA_SUBSONIC`, so the endpoint data moved
  with every query and the curve was not the interpolant (its value/slope at 0.9 and 1.5 happened to
  survive, because the slope's basis function vanishes at both ends; only the interior was wrong).
  **Change:** `2 * mach * Math.PI` -> `2 * CNA_SUBSONIC * Math.PI` (TeaVM folds it to
  `5.654866776461628`). Nothing else in FinSetCalc moved.
- **#3237 defect:** the body skin-friction wetted-area correction `1 + 1/(2 fB)` (technical documentation
  eq. 3.85) took fB = length / max RADIUS; the equation's fB is length / max DIAMETER, so the correction
  term was halved (L/D 10: 1.025 where 1.05 is right; body friction +2.4 %, NOT total CD). **Change:**
  upstream's `static calculateBodyFrictionCorrection(bodyLength, maxRadius)` added to our monolithic
  BarrowmanCalculator (upstream has split it into BarrowmanDragCalculator); `calculateFrictionCD` calls it
  with the same `maxX - minX + 0.0001` length. `maxR = 0` still gives correction 1. The per-component
  forceMap correction, `lastBodyFrictionCD` (the body-ratio override reference) and the return value all
  use the one `correction`, so every drag breakdown still sums; fins and appendages stay outside it.
- **Known defect left in place (BUG-PLAN 23, its own item):** with `supersonicAero` the bridge's upper
  slope is `sscale * dK1/dM`; it omits `d(ssaeroScale)/dM * K1` (ssaeroScale depends on Mach through beta
  above its 0.25 floor). Measured on the new kernel (fin CNa slope at M1.5 from the supersonic side vs the
  coded `superD`): rectangle AR 1.6 -38.8 %, a 3FNC-like trapezoid -28.8 %, AR 0.8 -127 % (sign flips),
  AR 3.2 -16.2 %; refitting the quartic with the true slope would move the Supersonic/Hybrid fin CNa in
  the bridge by up to 2.7 % (AR 1.6), 1.9 %, 9.4 % (AR 0.8) and 1.0 % around M1.35. Classic/Kbf's upper
  slope is the analytic `-2M/beta^3` of K1 while their supersonic side is the 0.1-Mach K1 grid's secant
  (upstream behaviour, not touched). Not fixed here: it needs its own ruling, change and test.
- **Behavioural guards:** `packages/engine/src/transonicFinCNa.test.ts` (8 tests): the M0.9 slope equals
  the analytic `0.9 k^2/(sq(1+sq))` ratio for three rectangles (finite-difference check of the endpoint);
  every interior Mach 0.92-1.48 lies on the ONE quartic the endpoint data define (rect at three spans in
  Classic/Kbf/Supersonic; rounded and airfoil freeform fins in Classic/Kbf/Supersonic; Hybrid = the
  smoothstep mix of the Kbf and Supersonic quartics), 1e-7 relative; values and one-sided slopes at both
  endpoints (guard; passes on both kernels). `packages/engine/src/bodyFrictionFineness.test.ts` (2 tests,
  all four models, flight path AND drag sweep): two lone tubes of one length and two radii scale by exactly
  corr(R1)/corr(R2) with corr = 1 + R/(L + 1e-4) (Cf cancels); the fin increment divided by the bare
  tube's implied Cf is the same at L 0.3/0.6/1.2 (fins uncorrected), and in Classic equals
  `n (1 + 2t/c) 2S / Aref`. The body-ratio override's decomposition is guarded by the existing
  `orkEngine.test.ts` "a body-proportional CD override" tests.
  **Fail-on-old:** pre-change artifact - transonicFinCNa exit 1 (6 of 8 fail; the 2 endpoint guards pass),
  bodyFrictionFineness exit 1 (2 of 2 fail). **Mutations** (each a rebuilt artifact): `subD` back to
  `mach` -> transonicFinCNa exit 1 (6 fail), bodyFrictionFineness exit 0; `bodyDiameter = maxRadius` ->
  bodyFrictionFineness exit 1 (2 fail), transonicFinCNa exit 0; `lastBodyFrictionCD` on the old radius
  correction -> orkEngine body-ratio exit 1 (both method tests fail, including the unpinned no-base one).
  Restored artifact md5 identical to the pre-mutation build.
- **Artifact:** md5 `c72255847906eaecc4cefe08e5ad2316` -> `d9bb4cdc6f87644c152d00ad4c563e44`;
  `calculateBodyFrictionCorrection` 0 -> 2, `$fB` 3 -> 0, `2.0 * $mach * 3.141592653589793` 1 -> 0,
  `5.654866776461628` 0 -> 1 occurrences.
- **Goldens (JVM before/after `goldenJvm`, 421 lines):** 218 move. CP/CNa: only `aero.cp` at M0.95 and
  M1.05 (8 of 32) and `ssaero.1.2` (1 of 4) - nothing at M <= 0.8 or M >= 1.5, `rogerskbf.*` unchanged.
  Drag: every friction consumer (all 32 `aero.forces`, `dragsweep`, `cdratio`, `finish.*`, `ssaerocd`,
  `ssphase5/6`, `transition.*`, `fins.crosssection.*`, `finsection.*`, `ssjunction`, `nozzle.basecd`,
  `podnozzle.*`) and every flight. Mass,
  inertia, geometry, ISA, tree and event-structure lines unchanged. C6 reference flight 331.7669 ->
  330.7504 m (-0.31 %), mindia 329.6097 -> 328.6945 m.
- **Differential: `DIFFERENTIAL FAILURE: 5 mismatched line(s) of 421`** - all 416 non-flight lines (every
  aero/drag line) agree; the five are flights: `flight.geodetic.absent/spherical/flat` (flightTime 7.3e-7
  rel), `flight.offaxis.split.canted` (1.5e-9 rel vs 1e-9) and the turbulent `flight.conditions.summaryext`
  (1.1e-4 rel vs 1e-5). Same five with #3237 alone (mutation build, #3236 reverted); #3236 alone passes
  (`421 lines (284 bit-identical, 137 within tolerance)`). Diagnosed as a step-count knife edge, not a
  fidelity break: in the JVM run itself `geodetic.absent` and `geodetic.wgs84` (same dynamics, ULP-different
  coordinates) now land 7.5e-5 s apart (were 4.8e-11 s), and JS `absent` equals JVM `wgs84` to 2e-13;
  in JS alone, 6 of 48 single-input perturbations of 1-4 ulp (rodAngle, launchAltitude, pressure,
  rodLength, temperature) reproduce the JVM's 103.600745357 s exactly - one extra integration row
  (743 vs 742). The tolerance was NOT widened.
- **Resolved 2026-10-08 (Stage A4): three golden SCENARIOS moved off their knife edges; no kernel, tolerance
  or difftest change.** Re-diagnosed independently by dumping every integration row of each failing flight
  on both runtimes (`api.OrkEngine.simulateJson`, series `full`) and on the kernel before #3236/#3237:
  - *Not a #3237 runtime divergence.* `calculateBodyFrictionCorrection` is `2*R`, `L/D`, `1 + 1/(2 fB)`:
    IEEE-exact `+ - * /` on both runtimes, no transcendental; every aero/drag line through it agrees.
    In the geodetic and off-axis flights the first rows agree to 1e-16..1e-13 relative and the state stays
    within ~1e-11 (near-zero crosswind components aside) until one discrete step decision; the turbulent
    flight grows chaotically instead (1e-5 in step size by t = 2.4 s).
  - *Geodetic (absent/spherical/flat): a last-bit coin flip.* C6-5 ejected at 7.0 s, before apogee (~7.17
    s), so the 3DOF Euler recovery stepper landed apogee itself (`AbstractEulerStepper`, t = |v/a|).
    Rows 0-242 agree (v at row 242: 0.49213449572114 JVM vs 0.49213449570823 JS); row 243 leaves
    v + a t = 5.55e-17 (2^-54) on the JVM and exactly 0 on TeaVM. The JVM's positive residual is a
    second "apogee", a 1 ms MIN_TIME_STEP step (row 244 at 7.1678 s against JS 7.2381 s), and the
    descent is resampled: flightTime 7.3e-7 apart, 743 vs 742 rows. Across 12 rod angles
    0.0864-0.0875 x {absent, flat, wgs84}: **9 of 36 fail with delay 5, 0 of 36 with delay 7** (worst
    6.3e-11). The kernel before #3237 already failed 1 of 12 (absent). **Change:** `geodeticScenarios`
    ejection delay 5 -> 7 s (C6-7): ejection follows apogee, so the Euler stepper never lands one.
  - *Off-axis canted: a lottery draw.* A windless vertical flight whose only pitch/yaw motion is the
    stepper's seeded random moment (`RK4SimulationStepper` PITCH_YAW_RANDOM). At t = 1.73 s (row 326),
    where the pitch rate crosses zero, the JVM/JS pitch-rate difference jumps from 1e-11 to 5e-7 relative
    and step sizes then differ by up to 1e-4 relative: timeToApogee ends 1.47e-9 apart (budget 1e-9).
    The same amplification is intrinsic to the flight: on the JVM alone a 1-ulp rodLength change moves
    timeToApogee 4.2e-8. Rods 1.495-1.505 m: 2 of 11 fail on the #3237 kernel, 5 of 11 on the one
    before; launch altitudes 0-70 m: 3 of 11 and 2 of 11. No structural setting was found (timeStep
    0.02/0.01, flat geodetics, a 0.087 rod angle, later ejection, 100 N thrust all still fail 1-11 of 11).
    **Change:** `offAxisInertiaScenarios` canted flight rod 1.5 -> 1.497 m, which agrees to ~3e-15 with
    equal row counts on BOTH kernels. A re-drawn ticket, stated as one in the code.
  - *Turbulent conditions: a lottery per seed.* The 8 s windy flight's drift past the 1e-5 budget sits
    near apogee (deploymentVelocity, optimumDelay - small speeds). Seeds 1-16 fail 11 of 16 on the
    kernel before #3237 and 11 of 16 on the #3237 kernel (not the same eleven); seed 7 drew 2.0e-6 before and 1.1e-4 after.
    Earlier ejection (delay 3 or 4) fails 10 and 9 of 16. Seed 4 drew 2.1e-7 before and 7.3e-9 after,
    and failed 2 of 11 rod angles 0.0865-0.0870 where seed 7 failed 8 of 11 and seed 5 failed 5.
    **Change:** `conditionsScenarios` randomSeed 7 -> 4, and `windLevelScenarios`' pad with it (its
    `single` row reprints this flight; seed 7's `single` driftAtApogee sat at 8.2e-6 of the 1e-5 budget).
  - **Goldens (JVM before/after `goldenJvm`, 421 lines): 13 move, all in the three changed scenarios**
    (difftest keeps no stored baseline, so nothing else is regenerated): `flight.conditions.summary`,
    `.summaryext`, `.serieslens` (372 -> 364 rows), the five `windlevels` rows (seed 4; the two steady
    rows move too, because the stepper's random pitch/yaw moment is seeded by randomSeed - their wind
    does not move: steady.msl reads exactly 4 m/s throughout on seeds 7, 4 and 1), `flight.offaxis.split.canted`, and the four `flight.geodetic.*`
    rows (C6-7: apogee 365.0989 -> 365.2777 m, flightTime 103.60 -> 101.33 s, landing 215.46 -> 195.27 m
    from the pad). The geodetic harness checks (absent == spherical bit for bit; flat lands elsewhere;
    wgs84 reports another longitude) hold on both runtimes. Worst JVM/JS difference now, line by line:
    conditions 2.3e-10 / 7.3e-9 / 0 rows, windlevels 5.5e-9 / 5.5e-9 / 1.7e-10 (turbulent budget 1e-5)
    and 2.5e-11 / 5.4e-11 (steady, 1e-9), offaxis 2.9e-15, geodetic 7.2e-12 / 7.2e-12 / 4.0e-12 /
    1.9e-12. Artifact: harness strings only (8 lines of `orkengine.mjs`), md5
    `d9bb4cdc6f87644c152d00ad4c563e44` -> `108eb93c223a23e74c0175f7a2bfa0c9`.
  - **Differential:** `differential ok: 421 lines (278 bit-identical, 143 within tolerance)`, exit 0.
  - The off-axis and turbulent lines remain lotteries by construction (a vertical windless flight; a
    chaotic one); a later kernel change may re-draw them. Re-pick the same way: sweep one input on both
    runtimes, take a value that agrees with margin on the old and the new kernel, and record it here.

### aerodynamics/barrowman/FinSetCalc.java - Supersonic afterbody: count only the body behind the fin (board Tier 0 row 75, option (a); 2026-10-08)

- **Ruling:** Eric, 2026-10-08, board Tier 0 row 75, option (a): fix the Supersonic model's afterbody
  bookkeeping AT EVERY MACH (subsonic Supersonic and Hybrid's blend may move; Classic and Kbf must not).
  Investigation: `docs/research/supersonic-cp-2026-10-08/REPORT.md` (section "Body-fin interference:
  confirmed geometry defect"); results: `docs/research/supersonic-cp-2026-10-08/FIX-RESULTS.md`.
- **Defect (our feature #1 Phase 1 patch, not upstream):** `calculateAfterbodyFactor` set the afterbody
  to `max(0, parentLength - (finTop + rootChord))` and then added the FULL length of every later
  `SymmetricComponent` sibling. A fin overhanging the aft end of its tube has a negative remainder; the
  `max(0, ...)` threw the overhang away and the boattail behind it was counted whole. ARCAS (fins 39.1161 mm
  past the tube onto a 45.974 mm boattail): afterbody 45.974 mm where 6.8579 mm lies behind the root
  trailing edge, `fa = min(1, 0.5 + afterbody/rootChord)` saturated at 1 instead of
  0.5 + 6.8579/85.852 = 0.579880, fin+carryover CNa x1.1364 (K_W(B) + fa K_B(W): 1.818487 vs 1.600229,
  tau 0.348513) - the CP aft at every Mach. Kbf and Classic never read `afterbodyFactor`.
- **Change:** the remainder is kept SIGNED and the walk follows stations in the grand's frame
  (`getPosition().x`): a following symmetric body counts while contiguous with the body before it
  (`|fore - bodyEnd| <= 1e-6 m`: its full `getLength()`, the old arithmetic in the old order); a gap
  (`fore > bodyEnd + 1e-6`) ends the afterbody; an overlap adds only `max(0, aft - bodyEnd)`. The total is
  clamped at zero AFTER the walk, so an overhang uses up as many following parts as it covers and a fin
  overhanging the whole body gets the flush-base 0.5. A remainder within 1e-6 m of zero is flush (0), as the
  old `max(0, ...)` had it. A non-overhanging fin on a contiguous body is unchanged bit for bit. The overlap
  term is written `Math.max(0.0, aft - bodyEnd)` because the first build emitted `afterLen + aft - bodyEnd`
  (TeaVM printed `a + (b - c)` without its parentheses, i.e. `(a + b) - c` in JS - a JVM/JS rounding
  difference on that branch); the call keeps the grouping. Out of scope, unchanged: the walk stays inside
  the fin's own (pod/)stage; the `fa` heuristic itself, and where the carryover acts (fin CP), are the
  REPORT's open steps 2-4.
- **Artifact:** md5 `108eb93c223a23e74c0175f7a2bfa0c9` -> `81a8c799a7aa6cc131a5104ef53639b4`; grep:
  `$bodyEnd` 0 -> 5 lines, `1.0E-6` in the afterbody walk 3, `jl_Math_max(0.0, $aft - $bodyEnd)` 1. Vite
  cache cleared. Build via `npm run engine:js` (JAVA_HOME = jdk-17.0.19+10) after `carve.mjs`.
- **Differential:** `differential ok: 421 lines (278 bit-identical, 143 within tolerance)`, exit 0.
  **Goldens:** `goldenJvm` before/after byte-identical (421/421 lines) - no golden scenario has a fin
  overhanging its tube (the ARCAS fixtures live in `validation/`, not the harness), which is why the
  vitest guard below carries the behaviour.
- **Behavioural guard:** `packages/engine/src/finAfterbody.test.ts` (8 tests, M0.3/0.8/1.2/2/3, fin load
  isolated by subtracting the finless rocket): the ARCAS fin overhanging onto its boattail loads exactly
  like the same fin with 6.8579 mm of plain tube behind it (Supersonic and Hybrid, CNa 1e-9 rel, CP 1e-9 m -
  station-arithmetic rounding only); its CNa against a long-afterbody copy is K(fa)/K(1) = 0.880 from a TS
  transcription of NACA 1307 eq. 14; an overhang through two following parts; an overhang past the whole
  body = flush; a rounded freeform fin with PK-68's planform overhanging onto a tail cone; gap and overlap
  stations; control (no overhang, fa < 1, unchanged rule); Classic/Kbf independent of the afterbody and
  Hybrid below its band identical to Kbf. **Fail-on-old:** pre-change artifact `108eb93c...` -> exit 1,
  6 of 8 fail (the control and the Classic/Kbf guard pass on both). **Mutations** (each a rebuilt artifact,
  exit 1): final clamp removed -> the past-the-whole-body test fails; gap `break` removed -> the station
  test fails; overlap counted whole -> the station test fails. Restored build md5 identical
  (`81a8c799...`).
- **Measured, every design in `docs/User files` (113) + 22 repo fixtures + LEM-IV + the two ARCAS fixtures,
  19 Machs 0.1-4.63 x AoA 0 and 0.1 rad, all four models, old vs new artifact:** Classic and Kbf
  byte-identical on every design. Changed: ARCAS (both fixtures and Chuck Rogers' `ARCAS-Long - 2.CDX1`)
  and one tester design, `Buckeye Files/PK-68 Minie-Magg_UPDATED-MylesAZ.ork` (rounded freeform fins
  6.35 mm past the tube onto a 75 mm tail part: fa 0.751 -> 0.730, Supersonic CP -0.3 to -0.5 mm,
  -0.03 to -0.05 %L, CNa -0.25 to -0.46 %). Everything else, LEM-IV and WM 4 Extreme included, identical.
  **ARCAS Short, Supersonic, whole-rocket CP:** M0.3 832.8 -> 814.1 mm (-1.802 %L), M0.8 -1.701 %L,
  M1.0 -1.627 %L, M1.5 -1.586 %L, M2 -2.099 %L, M3 -2.975 %L; whole-rocket CNa -11.3 % subsonic, -9.5 %
  at M4.63; Long -1.880 %L at M0.3. Forward CP = LESS displayed margin (Short -0.33 cal subsonic).
  **Hybrid:** identical to Kbf below M0.8 (its band), then blends in: M0.9 -0.241 %L, M1.0 -0.782 %L,
  equal to Supersonic from M1.2. C6 reference flight (fins flush on the last tube): identical in all models.
- **Validation (`validation/score.mjs`, old vs new):** Classic 13/191 and Kbf 22/191 output byte-identical;
  **Supersonic 78 -> 83, Hybrid 74 -> 79** (Hybrid is Supersonic above M1.2, so the same rows). ARCAS CP
  gates **2/9 -> 7/9**: Short M2 +3.502 -> +1.403, M2.5 +2.243 -> -0.319, M3 +2.274 -> -0.701 %L and Long
  M2 +3.822 -> +1.634, M2.5 +2.362 -> -0.308, M3 +2.405 -> -0.696 FAIL -> PASS; Short M3.5 +1.410 -> -1.929
  stays PASS; **Long M3.5 +1.360 -> -2.120 PASS -> FAIL; Short M1.5 +4.900 -> +3.314 stays FAIL.**
  Informational rows: Short M4.5/M4.63 and Long M4.5/M4.63 ok -> off (-2.7 to -3.6 %L), Long M4 off -> ok.
  No drag row moved. No tolerance changed. This is a bookkeeping fix inside a provisional model, not CP
  validation complete (REPORT section 8).
- **A5b (review fix, 2026-10-08): station order, not child order.** The first version walked the siblings in
  CHILD order and stopped at the first gap, so a part listed later that bridges that gap was lost (Codex
  review: tube ending 5 mm behind the fin TE, two following tubes positioned explicitly and listed far-first
  -> afterbody 5 mm instead of the continuous length; Supersonic fin CNa off 10-11 %). **Rule now:** the
  chain is the parent plus every `SymmetricComponent` sibling in the parent's own container (the fin's stage
  or pod - other stages, pods and inner assemblies never count, as before), as intervals
  `[getPosition().x, + getLength()]`, stable-sorted by fore station (ties keep child order); from the
  parent's aft end, contiguous (within 1e-6 m) adds the full length, a part starting inside the body adds
  only its length past the end, a part wholly inside (parts ahead of the parent, zero-length parts) adds
  nothing, and the first part starting past the body end is a gap that nothing later can bridge. A
  station-ordered contiguous body is summed in the old order, so the arithmetic is unchanged there.
  **Artifact:** md5 `81a8c799a7aa6cc131a5104ef53639b4` -> `13a9104e2275ac9eb47ea07c6c0adf84` (three
  `$rt_createDoubleArray` arrays and the insertion sort in `calculateAfterbodyFactor`). **Differential** exit 0
  (`421 lines (278 bit-identical, 143 within tolerance)`); `goldenJvm` byte-identical. **Guard:** new
  `finAfterbody.test.ts` case "stations, not child order" (both list orders == plain tube, Supersonic; both
  orders equal in Hybrid/Classic/Kbf; a zero-length part in a gap does not bridge it) - on the A5 artifact
  `81a8c799...` exit 1 (that test only, reversed order CNa off 10.3 %), on `108eb93c...` exit 1 (7 of 9),
  new exit 0 9/9, Node 22 9/9. **Measured vs A5:** all 113 docs/User files designs + 22 repo fixtures +
  LEM-IV + ARCAS fixtures byte-identical in all four models; score.mjs output identical (13/22/83/79);
  C6 flight identical. Engine vitest 260/260.

### rocketcomponent/SymmetricComponent.java - a zero-material slice keeps a finite centroid (OR #3161 / PR #3202, tumble release T1, 2026-10-08)

- **Defect (upstream 24.12):** `calculateProperties` integrates 128 slices and divides
  each slice's first moment by its material volume `dV`. A slice with NO material
  (`dV` exactly 0) gave `0/0 = NaN`, and `dV * (x1 + dCG)` / `dV * pow2(x1 + dCG)` then
  made the whole component's CG and longitudinal inertia NaN while its volume stayed
  right. Reproducer (upstream Banshee Mk2): a flipped POWER tail, parameter 0, length
  1 mm, radius 11 mm, wall 2 mm - POWER with parameter 0 has radius 0 for x <= 1e-5 m,
  so its last slice is empty. The flight threw `BugException: Simulation resulted in
  not-a-number (NaN) value for structureMass.getCenterOfMass()`.
- **Change (one expression):** `dCG = dV == 0.0 ? l / 2.0 : (...) / dV`. Exactly zero,
  NOT an EPSILON test: a very thin but nonzero slice keeps its true centroid. Slices with
  `dV == 0` contribute zero moment either way; every other slice is bit-identical.
- **Scope:** shared mass behaviour, every aerodynamic model. Moves numbers only where a
  component has an empty slice and nonzero total volume (it previously produced NaN).
- **Evidence:** `engine-java/src/test/java/info/openrocket/core/rocketcomponent/ZeroSliceCentroidTest.java`
  (JUnit 5.10.0, `gradlew test`): tail volume/CG against the analytic profile (126 hollow
  cylinders, one solid cone slice, one empty slice), assembled structure finite, flight
  reaches apogee; analytic controls (filled conical frustum: volume, CG and Simpson-
  quadrature inertias at rel 1e-9; thin 10 um frustum shell: true CG at rel 1e-9; zero-
  thickness shell; ogive finite-only). Old kernel: 3 of 7 fail (NaN CG, NaN assembled CM,
  the BugException). Mutations: unconditional division -> those 3 fail; `dV < EPSILON`
  branch -> the thin-shell true-centroid test fails. GoldenMain `mass.zeroslice.*` and
  `flight.zeroslice.summary` rows carry it through the JVM/TeaVM differential.

### rocketcomponent/RocketComponent.java + MotorMount.java + DeploymentConfiguration.java + simulation/BasicEventSimulationEngine.java - ejection charges deploy only their own assembly's devices, and a device deploys once (OR #2092 / PR #3204, tumble release T1, 2026-10-08)

- **Defects (upstream 24.12):** (a) `RocketComponent.getAssembly()` never advanced its
  walk, so any non-assembly caller looped forever (it had no callers, which is why it
  never showed). (b) An EJECTION-deployed recovery device fired on ANY ejection charge
  in the same stage NUMBER: a pod motor's charge deployed the core airframe's chute and
  vice versa. (c) An already-deployed device was deployed again by a later or a
  simultaneous second charge: a duplicate RECOVERY_DEVICE_DEPLOYMENT event, the landing
  stepper re-initialised, optimum coast recomputed, and FlightData's deployment velocity
  overwritten by the LAST deployment event.
- **Change (five hunks, applied together - the ownership call without the walk fix
  hangs):** `getAssembly()` uses `instanceof` and steps to the parent (patch on the
  existing RocketComponent replacement; its memoization/stamps untouched). `MotorMount`
  declares `getAssembly()` (Coordinate[] kept, not upstream's CoordinateIF[]).
  `DeployEvent.EJECTION`: when the event data is a `MotorClusterState`, deploy iff the
  motor mount's innermost assembly equals the device's; otherwise the old stage-number
  fallback. The event engine skips already-deployed devices when SCHEDULING and when
  EXECUTING a deployment (the `%g` log fix and K9 rail code untouched). The 1 ms minimum
  deployment delay is kept.
- **Not changed, on purpose:** the listener callbacks (`handleFlightEvent`,
  `recoveryDeviceDeployment`) run before the execution guard, so two duplicates queued
  at the same instant both still reach listeners; only one is recorded. Two physical
  instances of one PodSet are still one device; separating parallel boosters unchanged.
- **Evidence:** `engine-java/src/test/java/info/openrocket/core/simulation/AssemblyRecoveryTest.java`
  (14 tests; flights and walks under `assertTimeoutPreemptively` so a hang FAILS). Old
  kernel: 9 of 14 fail (walks time out; pod/core 4 deployments instead of 2; nested pods 6
  instead of 2; duplicate charges recorded twice); the 5 controls pass on both. Mutations,
  each restored: no ownership -> 2 ownership tests fail; no ancestor step -> 11 fail (all
  walks and flights time out); no scheduling guard -> the delayed-charge test fails on the
  listener count; no execution guard -> the simultaneous-charge test fails. GoldenMain
  `flight.assembly.*` rows: PodChute 2.501 s then CoreChute 5.001 s; simultaneous charges
  record 1 deployment.
- **Before/after `goldenJvm` (Rule 1):** with both fixes the first 421 golden lines are
  byte-identical to the pre-change kernel; only the 6 appended rows are new. No existing
  golden scenario had an empty slice, a motorised pod or two charges per device.

### simulation/RK4SimulationStepper.java + BasicEventSimulationEngine.java - TUMBLE judges thrust at the event, not from the last recorded sample (OR #3375 / PR #3382, NARROW port, tumble release T2, 2026-10-08)

- **Defect (upstream 24.12):** the TUMBLE handler decided "tumble" vs abort
  `TUMBLE_UNDER_THRUST` from `getFlightDataBranch().getLast(TYPE_THRUST_FORCE)`, the
  thrust recorded at the START of the last accepted step. That sample can predate
  burnout (a coasting rocket aborted under a thrust it no longer has) or ignition (a
  burning rocket entered the tumble stepper). Worst case: a separated booster branch
  copies its parent's rows, so a finless booster's geometry TUMBLE at separation read
  the parent's powered sample (measured in the CHAD fixture: 1.5 N copied, 0 N actual).
- **Change:** new package-private `RK4SimulationStepper.calculateEventThrust(status)`: a
  fresh local DataStore holding only the atmosphere at position.z + launch-site
  altitude (atmosphere listeners fire; the wind model is never sampled), then the
  existing `calculateThrust` - active motors at the status time, pre/post thrust
  listeners, the model-gated signed pressure term once per thrusting stage INSTANCE, its
  zero floor - plus a NaN/non-finite guard. The TUMBLE handler calls it on the engine's
  `flightStepper` (explicit cast; no step/initialize, so valid whichever stepper is
  current) with the unchanged strict `> 0.01 N` threshold, landed/deployed inhibition,
  abort cause and stepper transition.
- **Deliberately NOT ported:** upstream also changed RECOVERY_DEVICE_DEPLOYMENT's
  under-thrust policy (any motor's curve thrust > `MathUtil.EPSILON` -> summed corrected
  thrust > 0.01 N, non-RK steppers exempt). That is a separate policy change, not the
  stale-sample fix; the deployment check is UNCHANGED and pinned by a control test
  (0.005 N curve thrust still aborts DEPLOY_UNDER_THRUST). This is therefore not a
  byte-for-byte port of PR #3382.
- **Evidence:** `engine-java/src/test/java/info/openrocket/core/simulation/EventThrustTest.java`
  (8 tests): seeded stale-high after burnout -> tumbles (two steps); seeded stale-low
  mid-burn -> TUMBLE_UNDER_THRUST; the same either side of burnout on a linear tail;
  unseeded finless separated booster (CHAD) tumbles, sustainer ignites at separation;
  helper arithmetic for Classic/Kbf/Supersonic/Hybrid at site 0 and 1500 m (0.005 N
  curve + pressure term > 0.01 N under the gated models), zero exit, zero floor at
  105000 Pa, two-instance ParallelStage, inactive stage, no wind sample, motor state and
  time untouched; pre/post thrust listener overrides; recovery-policy control. Mutation
  (`.claude/t2-mutate.py`, each restored byte-exact): event expression back to `getLast`
  -> 5 fail (all staleness tests incl. CHAD); no atmosphere in the event store -> the
  arithmetic test fails; no per-instance multiplication -> the arithmetic test fails.
  GoldenMain `flight.eventthrust.stalehigh|stalelow` rows.
- **Integration 2026-10-08 (v0.165 merge with aerofix): golden SCENARIO re-drawn; no kernel, tolerance or
  difftest.mjs change.** On the merged kernel `flight.eventthrust.stalehigh` failed difftest (ground hit JVM
  31.75875431920723 vs TeaVM 31.758721583985132 s, 1.0e-6 rel). Row dump: rows 0-223 bit-identical; at row 224
  (the tumble stepper landing apogee) residual vz +5.55e-17 (2^-54) on the JVM, -5.55e-17 on TeaVM, so the JVM
  alone takes one 1 ms step - the knife edge of Stage A4's geodetic case. Twelve triggers 2.2-3.0 s all agree
  within the flight tolerance; injecting after apogee is impossible (the #3183 detector's own TUMBLE ~1 s after
  apogee pre-empts it). GoldenMain trigger 2.5 -> 2.45 s, a re-drawn ticket, said so in the harness comment.

### aerodynamics/AerodynamicCalculator.java + AbstractAerodynamicCalculator.java + BarrowmanCalculator.java + simulation/BasicEventSimulationEngine.java + api/OrkEngine.java - stall is judged from the recorded AOA against a fixed stall angle (OR #3093, tumble release T2, 2026-10-08)

- **Defect (upstream 24.12):** `getStallMargin()` returned `17.5 deg - AOA` of the
  calculator's LAST `getAerodynamicForces` call - RK4's k4 sub-step, or any diagnostic
  or listener call made after the step - while the event engine compared it with the
  RECORDED k1 row's CP/CG. A stall warning or stall TUMBLE could follow an AOA that was
  never recorded, and miss one that was.
- **Change (upstream's contract, mapped onto our monolithic calculator):**
  `getStallMargin()` -> `getStallAngle()` (radians, constant, independent of evaluation)
  in the interface and abstract class (new replacement files, copied from carved ==
  reference). BarrowmanCalculator keeps `stallAngle = 17.5*PI/180`, drops the mutable
  `stallMargin` field and its assignment; HybridCalculator drops its `margin` field and
  its three assignments and inherits the constant (endpoints, flags, smoothstep and
  newInstance band untouched). The event engine computes `margin = getStallAngle() -
  aoa` with `aoa` = the branch's recorded TYPE_AOA (strict `< 0` kept; this block is
  replaced wholesale by #3183 later in this release). API `getAeroDiagnostics` keeps its
  JSON `stallMargin` field (radians) as `getStallAngle() - queried AOA` and no longer
  runs a force evaluation just to populate it.
- **Not changed:** the 17.5 deg warning angle and the 20 deg fin-force saturation remain
  distinct; no force arithmetic moves.
- **Evidence:** `engine-java/src/test/java/info/openrocket/core/simulation/RecordedStallAngleTest.java`
  (6 tests): getStallAngle 17.5 deg before/after getCP, getWorstCP, forces at 30 and 0
  deg, at Mach 0.3/1/1.5, and on newInstance, all four models; calculator poisoned at 30
  deg after every step with recorded AOA below stall -> no LargeAOA/TUMBLE; recorded 30
  deg with calculator reset to 0 -> LargeAOA at that row (or TUMBLE when recorded CG >
  CP); boundaries stall-1e-9 and stall (no) and stall+1e-9 (yes). Mutation: reinstating
  last-evaluation semantics (a static last-AOA set in getAerodynamicForces, read by the
  event engine) -> all 5 event-level tests fail. `packages/engine/src/hybridAero.test.ts`
  pins the bridge field after a different-AOA forceSamples call and with clone=true
  (a contract pin only: the old bridge re-evaluated at the queried AOA, so it was
  already right there). GoldenMain `aero.stallangle`, `flight.stallangle.poisoned`.
- **Before/after `goldenJvm` (Rule 1), both T2 fixes together:** the first 427 lines are
  byte-identical to the T1 kernel's; only the 4 appended rows are new. difftest: 431
  lines (290 bit-identical, 141 within tolerance).

### aerodynamics/AerodynamicForces.java + AbstractAerodynamicCalculator.java + BarrowmanCalculator.java - above 20 deg AOA the REPORTED CP is force-consistent, x = d*Cm/CN; the force law is unchanged (decision 66(b), Eric 2026-10-08, tumble release T3)

- **Defect (upstream 24.12, ours too):** the reported CP is always the CNa-weighted
  (derivative) CP, sum(CNa_i x_i)/sum(CNa_i). Above the fin-force saturation the
  component normal forces stop scaling with CNa (body lift ~ sin^2(AOA), saturated fin
  CN), so the point where the SAME force model's normal force actually acts,
  x = d*Cm/CN, moves forward of it: at Mach 0.3, Kbf, 45 deg, ARCAS short reads
  12.0031 cal derivative vs 10.4317 cal force-consistent, Basic Finner 7.3501 vs 6.4962
  (`docs/open-items.md` CP register block). The flight already flies the force-consistent
  moment (RK4 shifts the coefficient Cm to the CG); only the CP and stability REPORTED
  from it were inconsistent with it.
- **Change (DESIGN section 8):**
  - `AerodynamicForces` (new replacement, copied from carved == reference 24.12): an
    output-only `reportedCP` override. `getCP()` returns it when set, otherwise
    `getDerivativeCP()` (the complete, unchanged 24.12 getCP body). `setReportedCP`
    sets it; `setCP` (so `zero()`) and `merge` clear it, and `setCP` still renews the
    modID when it clears an override over an equal derivative CP; `setCm` does NOT clear
    it (later damping, RK4 noise and listener torques do not move it). The cpCNa
    first-moment accumulator, CNa and every merge are untouched; `reset()->setCP(null)`
    is left as it was.
  - `AbstractAerodynamicCalculator`: `FORCE_CONSISTENT_CP_AOA = 20 deg` (strictly above;
    not the 17.5 deg warning angle), `FORCE_CONSISTENT_CN_CUTOFF = 1e-8`,
    `aboveForceConsistentAOA`, `forceConsistentCP` (x = refLength*Cm/CN; NaN x when
    |CN| <= 1e-8 or anything is nonfinite or refLength <= 0 - never an infinite lever
    arm, a tip CP or a silent derivative fallback; y, z and the derivative weight kept),
    `zeroRates` (a clone with pitch/yaw/roll rates 0; the caller's conditions untouched).
    `getWorstCP` skips planes with nonfinite x, and a HIGH-AOA query in which no plane
    has a defined CP returns (NaN, 0, 0, NaN) instead of the Double.MAX_VALUE sentinel;
    low-angle queries keep the sentinel (OrkEngine.getStaticInfo relies on it).
  - `BarrowmanCalculator`: at and below 20 deg every public method runs its 24.12 path
    with no extra work. Above 20 deg: `getCP` returns the force-consistent CP of a
    zero-rate `calculateNonAxialForces`; `getAerodynamicForces` keeps the actual-condition
    CN/Cm/drag/damping and sets the reported CP from a separate zero-rate normal-force
    evaluation (warnings to the discarded sink), computed before the drag block (the
    body-reference ORDER note is untouched) and set after damping; `getForceAnalysis`
    is a wrapper over the unchanged body (`getRawForceAnalysis`) that, after the NaN
    sanitation, sets each completed entry's reported CP from the matching entry of a
    zero-rate NON-AXIAL-ONLY map (`zeroRateNormalForceMap`, `ignoreWarningSet`, assembly
    and leaf keys as getForceAnalysis keys them). Hybrid: endpoints (w = 0/1) return the
    endpoint result; `mixForces` blends DERIVATIVE CPs; midband above 20 deg the
    reported CP (getCP, total forces, every force-analysis entry) is
    d*mix(Cm0_kbf, Cm0_sup)/mix(CN0_kbf, CN0_sup) from the endpoints' zero-rate raw
    normal forces - never a CNa-weighted blend of corrected positions; all force and
    damping fields stay the plain blend.
  - Outside patches: `packages/engine/src/orkEngine.ts` types (`AeroForceSample.cpX`,
    the AeroDiagnostics CP tuple's x and cna, `DragSweep.cp` nullable; the bridge's
    `nums` already writes nonfinite values as null); `packages/app/src/services/dragTable.ts`
    `sweepCp` requires a usable CNa AND a finite x.
- **Not changed:** CN, Cm, CD and every drag field, damping, CNa, the flight's moments
  and kinematics; static info (Mach 0.3, AOA 0), the design canvas and static stability.
  Consumers that now read the corrected value above 20 deg: recorded TYPE_CP_LOCATION
  and TYPE_STABILITY, the interim `cg > cp` stall-TUMBLE check (removed by #3183 later in
  this release), RK4's OPEN_AIRFRAME_FORWARD warning filter, forceSamples /
  aeroDiagnostics / dragSweep CP. Nothing here validates the high-AOA force model.
- **Evidence:** `engine-java/src/test/java/info/openrocket/core/aerodynamics/ForceConsistentCPTest.java`
  (12 tests): register values (ARCAS 45 deg 10.4317407349 cal, Basic Finner
  6.4961848984, derivative 12.0030834497 / 7.3501185135 still readable, CNa unchanged);
  at 0..19.99 deg and EXACTLY 20 deg no override and getCP bitwise == derivative, all
  four models; just above 20 an override; x*CN == Cm*d at 25-90 deg (classic, Kbf,
  Supersonic); rates change Cm (damping) but not the reported CP or the caller's
  conditions; ratio guard (+/-1e-8, nonfinite, d <= 0, overflow, signed, weight kept);
  representation (setCP/merge/zero clear, setCm and clone keep, modID); per-entry force
  analysis, including after a geometry edit (CN/Cm and reported CP from one cache state); Hybrid midband blend identity, its derivative CP, endpoints, low-angle mixCP,
  single damping; worst CP (all-undefined -> NaN, low-angle sentinel, -Inf/NaN skipped,
  real fixture = min over planes); newInstance; a real crosswind flight whose recorded
  TYPE_CP_LOCATION/TYPE_STABILITY above 20.5 deg equal the corrected law and below
  19.5 deg the derivative CP. Nineteen mutations (`.claude/t3-mut-specs.py`,
  `.claude/t3-mutate.py`) each fail it: every correction site reverted singly and all
  together, CNa-weighted Hybrid corrected positions, mixForces blending reported CPs,
  recorded CP/stability reading the derivative CP, damped Cm in the CP, weight = CN, no
  |CN| guard, threshold at 17.5 deg, worst-CP sentinel/NaN-acceptance, setCP/merge not
  clearing, setCm clearing, a zero-rate map that calls checkCache (review finding). TS: `packages/engine/src/forceConsistentCp.test.ts`, a new
  Hybrid test in `hybridAero.test.ts` (fail on the T2 artifact), `dragTable.test.ts`.
  Old-vs-new artifact sweep (9 fixtures incl. freeform rounded/airfoil and a 2-fin
  asymmetric variant, 4 models, 12 Mach, 3 rate sets, forceSamples / aeroDiagnostics /
  dragSweep / staticInfo): every output at <= 20 deg byte-identical, every non-CP output
  above 20 deg byte-identical. GoldenMain `aero.forcecp.*` rows.
- **Before/after `goldenJvm` (Rule 1):** 439 lines; of the first 431 (the T2 kernel's) one
  row moves - `staging.auto.b1.events` gains `TUMBLE` - and nothing else. Mechanism: the
  separated booster flies backward; at t = 9.735 s, AOA 157.8 deg, its force-consistent
  CP (0.4581490 m) sits 0.2 um forward of its CG (0.4581491 m) where the derivative CP
  was 3.5 mm aft, so the INTERIM `cg > cp` stall check fires (ground hit 23.285 s ->
  22.418 s). That comparator is deleted by #3183 later in this release. 8 appended rows.
  difftest: 439 lines (295 bit-identical, 144 within tolerance).

## Rules

1. A patch NEVER changes physics or observable behavior (except documented quirks-ledger
   bug fixes, the documented FEATURE patches above, the PERFORMANCE patches above —
   which change nothing observable BY CONSTRUCTION and must prove it with a zero-line
   `goldenJvm` diff against the pre-patch kernel, not just a clean differential — and
   the CORRECTNESS FIXES above, which change observable numbers ON PURPOSE and must
   prove the change is confined to the intended case with a before/after `goldenJvm`
   diff, plus an arithmetic check that the new values are RIGHT and not merely
   different).
2. Prefer shims over patches; patch only when the carved file itself must change.
3. On upstream upgrade: re-diff every patched file against its new upstream version and
   re-apply the minimal change.

### simulation/FlightDataType.java + AbstractSimulationStepper.java - recorded pitch natural frequency, rad/s (OR #3002 prerequisite ONLY, tumble release T4, 2026-10-08)

- **Why:** #3183's sustained-AOA detector (next entry) takes its time constant from the
  rocket's pitch natural frequency, which upstream added in PR #3002 together with five
  damping/corrective diagnostics. Only the frequency is a dependency.
- **Change:** new replacement `FlightDataType.java` (copied from carved == reference):
  `TYPE_NATURAL_FREQUENCY`, symbol `"ωn"`, `UnitGroup.UNITS_ROLL` (rad/s - NOT
  UNITS_FREQUENCY/Hz), group STABILITY, priority 4, in `ALL_TYPES` right after
  TYPE_STABILITY. `AbstractSimulationStepper.DataStore.storeData` records it on every
  row from that store's OWN k1 conditions/mass/forces (the same row as the recorded AOA,
  CP and density - never the calculator's last k4 state) via a private
  `computeNaturalFrequency`: `sqrt(0.5 rho v^2 A_ref CNa (xCP - xCG) / I_long)`, CNa =
  the reported CP's weight (per rad, unchanged by 66(b)), xCP = the REPORTED CP (so
  above 20 deg AOA the force-consistent CP of decision 66(b)), I_long =
  `getLongitudinalInertia()` (pitch/yaw, kg m^2; not roll). 0 on the launch guide and
  for neutral stiffness; NaN for negative stiffness or any missing/non-finite/invalid
  input (our hardening: upstream checks NaN only).
- **Deliberately NOT ported:** the corrective-moment, damping-ratio and three damping
  moment types, the jet-damping diagnostic (signed motor-mass derivative and mount-X
  "nozzle" proxy), UnitGroup moment groups, the Hz alias, localisation resources and the
  extension deprecation. The shim's DebugTranslator names the type
  `[FlightDataType.TYPE_NATURAL_FREQUENCY]`; no resource bundle is introduced. Physical
  pitch/yaw/roll damping in Barrowman/RK4 is untouched.
- **Limit (stated, not hidden):** above 20 deg AOA this is upstream's stiffness PROXY fed
  with the force-consistent CP, not the tangent stiffness of the nonlinear moment law;
  a corrected CP forward of the CG gives NaN and the detector's 0.05 s fallback.
- **Bridge/app:** no new friendly field or API method. Full-series payloads carry the new
  symbol key (summary mode does not); `packages/app/src/services/flightDataCsv.ts`
  labels it "Natural frequency (rad/s)".
- **Evidence:** see the #3183 entry below (shared test run and mutations).

### simulation/SimulationStatus.java + BasicEventSimulationEngine.java + logging/Warning.java - tumbling is decided by a SUSTAINED-AOA detector; the instantaneous cg > cp comparator is removed (OR #3183 / PR #3190, tumble release T4, 2026-10-08)

- **Defect (upstream 24.12, and our T2/T3 interim):** after every accepted step the engine
  queued TUMBLE when the recorded AOA exceeded the 17.5 deg stall angle AND the recorded
  CG lay aft of the recorded CP. One step was enough, so a gust or the rail-exit
  transient of a STABLE rocket in a steady crosswind tumbled it (under thrust: abort
  TUMBLE_UNDER_THRUST), and the CP it compared is produced by a model outside its
  envelope at exactly those angles.
- **Change:** upstream's `TumbleDetector`, nested as `SimulationStatus.TumbleDetector`
  (carve.mjs refuses orphan patch files, so no new `TumbleDetector.java`). It low-pass
  filters the recorded AOA (rad) with `tau = 2 periods * 2 pi / omega_n` clamped to
  [0.05, 2] s (0.05 s when omega_n is NaN/zero/negative/non-finite), and the branch is
  tumbling while the filtered AOA exceeds 60 deg. Samples on the guide, below 1 Pa
  dynamic pressure, with a non-finite input or with no time advance HOLD the value (no
  reset) and still advance the last time, so an unobservable gap is never integrated
  later; the first sample only establishes time. Our adaptation: finite-input guards.
  SimulationStatus carries the detector and a `separatedStage` flag, deep-copied by the
  copy constructor and by `clone()` (RK trial states never share it), NOT by
  `copyProperties` (a kinematics-only copy). The engine block after the apogee check:
  detector updated with the status time, `isLaunchRodCleared`, the recorded TYPE_AOA,
  airspeed = recorded Mach x recorded speed of sound, recorded density and recorded
  TYPE_NATURAL_FREQUENCY; tumbling -> TUMBLE at the status time; otherwise a LargeAOA
  warning when the recorded AOA > `getStallAngle()` (OR #3093 kept), the branch is not a
  separated stage and `recordWarnings()`. The `cg`, `cp`, `margin`, `cg > cp` lines are
  gone. Booster branches get `setSeparatedStage(true)` at STAGE_SEPARATION (the sustainer
  never). New replacement `Warning.java`: LargeAOA priority NORMAL -> LOW (type, text and
  value unchanged; the app only distinguishes HIGH, so nothing it shows moves).
- **Kept as upstream, stated:** the detector's time is the END-of-step status time while
  its data is the branch's last (k1, start-of-step) row - a bounded one-step sample lag,
  not the stale-k4 bug #3093 fixed. No ascent-only gate; the detector is not latched (the
  engine's switch to the tumble stepper is the latch). CP still enters, INDIRECTLY,
  through omega_n's lever arm (see the previous entry): the detector is not independent of
  aerodynamics, whatever upstream's class comment says.
- **Evidence:** `engine-java/src/test/java/info/openrocket/core/simulation/`
  `NaturalFrequencyTest.java` (6: type contract - symbol, UNITS_ROLL, STABILITY, ALL_TYPES
  order; storeData synthetic oracle sqrt(0.5*1.2*50^2*0.01*4*0.3/0.02) = 30 rad/s, v x2 ->
  x2, I_long x4 -> /2; rail 0, neutral 0, negative NaN; every non-finite/negative input
  NaN, including forward-CP cases where only the sign guard can say NaN; reported vs
  derivative CP decides NaN vs finite and so the 0.05 s fallback; a real ballasted flight
  where EVERY powered-ascent row matches an independent recomputation from its recorded
  fields, NaN where the predicted stiffness is negative), `TumbleDetectorTest.java` (9:
  tau = 4 pi/10 at omega 10 and the clamps/fallbacks; the exact exponential recurrence at
  0.005/0.01/0.05 s and alternating 0.01/0.04 s with the crossing strictly after
  tau ln 2 and within one step; first sample; brief 150 deg gust of 0.1 pitch period and a
  one-step 179 deg spike never tumble; 120/95 deg sustained do; rail, q 0.999/1/1.001 Pa,
  hold without reset, a 10 s low-q gap not integrated, invalid inputs, repeated/backward/
  non-finite time; copy independence), `TumbleReleaseIntegrationTest.java` (8, real
  BasicEventSimulationEngine: brief forced 150 deg gust with recorded CG > CP (the OLD
  comparator's trigger, asserted as a precondition) -> no TUMBLE, LOW LargeAOA, flight
  completes, two steps; sustained forced 120 deg with CP held AFT of CG -> powered abort
  TUMBLE_UNDER_THRUST, coast and descent TUMBLE, each after the minimum dwell and within the
  analytic bound, and at exactly the step a fresh detector replaying the recorded inputs
  crosses; detection dwell converges with step (0.11672 / 0.11552 / 0.11454 s at 0.005 /
  0.0025 / 0.00125 s, each within one step) and the k1-row lag is one accepted step;
  ballasted stable rocket, 0.5 m rod, steady 8 m/s crosswind: the old comparator fires at
  rail exit (0.119 s, AOA 29.8 deg, force-consistent CP 3.8 mm forward of CG) and the new
  kernel flies to 414.3 m (calm 434.3 m; 6 m/s control 420.6 m, old comparator silent);
  finless rocket still departs via the NaN fallback; separated flag suppresses only the
  warning; booster flagged, sustainer never; copy/clone inherit but never share,
  copyProperties excludes), `RecordedStallAngleTest.java` updated to the #3183 contract (a
  single forced row warns from its recorded AOA, LOW, never tumbles). JUnit: 70/70.
  Mutations (`.claude/t4-mutate.py`, specs `.claude/t4-mut-specs.py`, 24, each exit 1 and
  restored byte-exact): old behaviour combined (11 fail), instantaneous comparator (6), no
  rail gate, no q gate, reset on low q, Hz, always-minimum tau, clone shares, copy
  constructor shares, no booster flag, warning ignores flag, no producer, roll inertia,
  no sqrt, /2 pi, derivative CP, NORMAL priority, copyProperties copies, hold without
  time advance, first sample integrates, no rho/inertia/area sign guard, negative
  stiffness -> 0. TS: `packages/engine/src/tumbleRelease.test.ts` (full-series omega_n
  oracle, summary omits it, LOW LargeAOA through the bridge; 2 of 3 fail on the T3
  artifact, the summary test is a pin), `flightDataCsv.test.ts` (+1, fails without the
  metadata), `warningUnits.kernel.test.ts` priority pin NORMAL -> LOW. GoldenMain
  `tumbleReleaseScenarios` (7 rows, appended last; the forced sustained-coast row carries
  discrete outcomes, not event times, because JVM/TeaVM step-size drift in that violent
  flight measured 1.2e-9 / 2.4e-9 relative, over the unchanged 1e-9 budget).
- **Measured number changes (old = T3 artifact):** no existing golden row moved (439/439
  byte-identical). Ballasted stable rocket in a steady 8 m/s crosswind off a 0.5 m rod:
  previously aborted TUMBLE_UNDER_THRUST at rail exit; now completes to 414.3 m. Same
  rocket, calm, no recovery device: previously no TUMBLE, ground 19.858 s; now TUMBLE
  1.03 s after apogee (falls tail-first), ground 44.246 s (3 m/s wind: unchanged, it arcs
  over). Two-stage staging fixture's booster: TUMBLE 9.735 s (T3's interim comparator;
  T2: none, ground 23.285 s) -> 5.971 s, ground 22.418 -> 22.661 s. NOT corpus-measured
  in this stage.
