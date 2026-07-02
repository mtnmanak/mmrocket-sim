# Patch ledger

Every file in `patches/` REPLACES the same-relative-path upstream file during carve
(`scripts/carve.mjs`). Patches must be minimal, documented here, and re-audited when
upgrading the upstream OpenRocket version. Diff a patch against upstream with:

```
git diff --no-index <openrocket-src>/<path> patches/<path>
```

## Active patches (all: TeaVM classlib gaps — not behavior changes)

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

## Rules

1. A patch NEVER changes physics or observable behavior (except documented quirks-ledger
   bug fixes, which get their own section here with upstream issue links).
2. Prefer shims over patches; patch only when the carved file itself must change.
3. On upstream upgrade: re-diff every patched file against its new upstream version and
   re-apply the minimal change.
