# MMRocket Sim API: local S1

A Cloudflare module Worker that opens and flies a raw `.ork`, `.rkt` or `.CDX1` through the app's existing headless path and OpenRocket 24.12 Java core compiled with TeaVM. GPL-3.0-or-later; see the repository LICENSE.

**not deployed; no hostname yet**

From the repository root, build the engine once (`npm run build -w @online-openrocket/engine`), then run:

```sh
npm run dev -w @online-openrocket/api
npm test -w @online-openrocket/api
```

`GET http://127.0.0.1:8787/health` reports app/engine versions and the bundled catalogue dates. POST a raw file to `http://127.0.0.1:8787/experimental/fly?filename=reference.ork` (for example, `curl --data-binary @reference.ork 'http://127.0.0.1:8787/experimental/fly?filename=reference.ork'`). The experimental JSON includes apogee in m, velocity in m/s, Mach, flight time in s, installed motors with counts and flown delays (`"plugged"` for no charge), existing warnings and notes, and wall timings in ms. This is not the API contract.

`parseMs` includes upload/body reading, bundled preset loading and import; `flyMs` includes motor resolution, planning, build, flight and report. Both can include waiting behind other flights in the same isolate; they do not isolate contention or CPU cost. There is no lock-queue timing field. `totalMs` also includes summary preparation. Every timing block labels its basis: wall-clock, not CPU time; deployed Workers advance the clock only at I/O, so treat these as local-only. The tests record first-per-fixture and repeat values in `packages/api/.wrangler/timing-previews.json`.

S2 measures resources from outside: host-side elapsed time and workerd process memory locally, then Workers CPU metrics after deploy. The inherited 64 MiB (67,108,864 byte) whole-file cap does not establish safety within a 128 MB isolate: body + inflate + DOM + kernel, and concurrent requests, can exceed it. S2 decides measured API admission and inflate/body limits. Content-Length only enables early rejection above the cap; it never reserves memory. All bodies retain received chunks until one final assembly, briefly retaining both chunks and output. A header declaring 64 MiB but sending ten bytes assembles ten bytes. The reader passes the assembled ArrayBuffer to simulateFile without slicing it; format decoding can allocate further buffers.

Responses explicitly say `outcome: "completed" | "aborted"`; `aborts` gives the reason and stopping event, and `partial: true` marks their top-level numeric block as incomplete (`partial: false` for completed flights). SIM_ABORT or EXCEPTION on any flight branch marks the result aborted. The required Show-off.CDX1 fixture currently aborts when recovery deploys under thrust. `motorFailures` preserves kernel build refusals with the same mount display labels used by the flight runner. The motor list uses post-projection ignition and excludes ignition `never`, and warnings use the app's human text. Error bodies retain import notes, including the reason for a missing motor. `/health` pairs OpenRocket 24.12 with the app version; there is no independent kernel build identity yet.

The headless barrel defaults to a timer-free microtask yield; the underlying service retains its timer default for app parity tests, and App still yields between auto-delay probes. The Worker also explicitly passes the microtask yield and keeps the real flight in `ctx.waitUntil` as defence in depth. There is no macrotask boundary inside the kernel lock, so there is no cancellation point there; serialization between requests comes from the single-threaded event loop. S1 has no queue bound, BUSY response or holder watchdog. Any future in-lock I/O or timer requires revisiting cross-request lock lifecycle before relying on it. Contention and admission control are S2 questions to measure from outside. Platform termination cannot be caught as JSON.

The Worker requests summary series and uses primitive sample columns: the shipped Wrangler bundles' smallest workerd V8 old-space caps fell from 88 to 60 MiB across the measured designs (flight-bound worst 88 to 44; Worker start floor 38 to 22), comparing the old unminified kernel/full-series Worker with the new minified ASCII patched-kernel/summary-series Worker in 2 MiB steps; typed-array storage is outside these caps. The API returns neither load peaks (maxQ/max q-alpha) nor an airspeed check, but does return low rod-exit thrust-to-weight warnings in notes.flight; summary uses the same WGS84 model evaluated at the pad latitude and interpolated height rather than reading the kernel's per-step g (which also follows the rocket's drifting latitude), a rounding-level difference with 129/129 corpus API responses identical apart from timing.

`limits.cpu_ms = 30000` applies only on a paid deploy; local workerd does not enforce it. A request can run up to eight auto-delay target probes, one Mach probe, and two reported flights after an aero upgrade (eleven kernel flights in total). Cost/admission policy belongs to S2 before public use.

- S1 only: local Worker/kernel/file-to-flight; S2 measures, S3 describes, S4 measures fragments, S5 comes later.
- Thin app-owned headless exports; no moved or copied importer/flight implementation.
- Engine access uses only `@online-openrocket/engine`'s public API.
- Fixed `network: 'forbid'`; bundled motor snapshot, no thrustcurve.org calls or caller options.
- Raw design files only; no scripts, accounts or persisted state.
- `simulateFile` owns its kernel lock; never wrap it in `withKernel`.
- Install `setXmlParser(jsXmlParser)` once at Worker module scope; browser entry cannot import the headless entry.
- Wrangler selects fflate's browser ESM build; no `nodejs_compat`.
- Reuse the app's whole-file cap, including streamed bodies; errors are JSON without stacks.
- No CORS, routes, custom domains or account configuration in S1.
- Tests use Wrangler 4's `unstable_startWorker` and real local workerd; a test-only entry traps outbound fetch, counts attempts and request timer calls and checks its own fetch trap. Ordinary fixture checks use production catalogue state; only the separate missing-curve isolate installs a newer test overlay. Late fetch observation awaits waitUntil work plus 100 ms; unregistered work beyond that window remains unverified.

For fully offline local commands, set `WRANGLER_HIDE_BANNER=true`, `WRANGLER_SEND_METRICS=false` and `CLOUDFLARE_CF_FETCH_ENABLED=false` to disable the update-banner check, telemetry and development `Request.cf` metadata refresh. The tests set these before loading Wrangler.

API numeric parity assertions use 1e-10 relative (floor 1e-10 SI) for apogee, maximum velocity and Mach. The round-2 review measured at most 1e-12 SI drift for the compared non-time quantities, and identical Node 22/24 results for all five designs reviewed. Event times, flight time and motor delays use 1e-5 relative (floor 1e-5 s): the cluster's descent-time drift across workerd/Node was 1.7e-6 relative. Every expected flight and outcome is computed afresh in the Node host; this is cross-runtime parity, not a published-data accuracy tolerance. Test-only motor selections follow the current bundled catalogue rather than specific upstream motor identities or snapshot dates.
