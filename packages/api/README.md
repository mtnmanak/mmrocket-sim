# MMRocket Sim API: local S1, S3 describe draft

A Cloudflare module Worker that opens and flies a raw `.ork`, `.rkt` or `.CDX1` through the app's existing headless path and OpenRocket 24.12 Java core compiled with TeaVM. GPL-3.0-or-later; see the repository LICENSE.

Experimental Worker; the response format is not a public API contract.

From the repository root, build the engine once (`npm run build -w @online-openrocket/engine`), then run:

```sh
npm run dev -w @online-openrocket/api
npm test -w @online-openrocket/api
```

`GET http://127.0.0.1:8787/health` reports app/engine versions and the bundled catalogue dates. POST a raw file to `http://127.0.0.1:8787/experimental/fly?filename=reference.ork` (for example, `curl --data-binary @reference.ork 'http://127.0.0.1:8787/experimental/fly?filename=reference.ork'`). The experimental JSON includes apogee in m, velocity in m/s, Mach, flight time in s, installed motors with counts and flown delays (`"plugged"` for no charge; a flown mount with no motor entry is left out of `motors` rather than failing the request), existing warnings and notes, and wall timings in ms. This is not the API contract.

Every JSON body, success or error, from every route carries the same version stamp as top-level keys beside the route's own: `appVersion`, `engine: { openRocket: "24.12", appVersion }` and `catalogue: { motorsGenerated, curvesGenerated }`. An error body is `{ error: { code, message, importNote? }, appVersion, engine, catalogue }`; the `error` object is unchanged. The catalogue dates are the bundled snapshot's: the Worker flies with `network: 'forbid'` and never installs a catalogue overlay. The test-only overlay isolate does, and its stamp still shows the bundled dates. One builder (`src/stamp.ts`) makes every response.

`parseMs` includes upload/body reading, bundled preset loading and import; `flyMs` includes motor resolution, planning, build, flight and report. Both can include waiting behind other flights in the same isolate; they do not isolate contention or CPU cost. There is no lock-queue timing field. `totalMs` also includes summary preparation. Every timing block labels its basis: wall-clock, not CPU time; deployed Workers advance the clock only at I/O, so treat these as local-only. The tests record first-per-fixture and repeat values in `packages/api/.wrangler/timing-previews.json`.

S2 measures resources from outside: host-side elapsed time and workerd process memory locally, then Workers CPU metrics after deploy. A body over 8 MiB (8,388,608 bytes), a ZIP member whose declared size is over 16 MiB (16,777,216 bytes), or gzip XML that expands past 16 MiB returns HTTP 413 `FILE_TOO_LARGE` and points to https://mmrsim.mountainmanrockets.com for larger files. ZIP data that inflates past its own declared size is refused as damaged with HTTP 400 `INVALID_FILE`, whatever its size. These API-only caps leave the app's 64 MiB limits unchanged. They do not establish safety within a 128 MB isolate: deployed memory peaked at 118.7 MB, leaving about 9 MB of headroom. Content-Length only enables early rejection above the cap; it never reserves memory. Bodies retain received chunks until one final assembly, briefly retaining both chunks and output. A header declaring 8 MiB but sending ten bytes assembles ten bytes. The reader passes the assembled ArrayBuffer to simulateFile without slicing it; format decoding can allocate further buffers.

Responses explicitly say `outcome: "completed" | "aborted" | "incomplete"`; `aborts` gives the reason and stopping event, and `partial: true` means at least one flight branch did not complete (`partial: false` for completed flights). SIM_ABORT or EXCEPTION on any flight branch marks the result aborted. Without an abort, an INCOMPLETE_FLIGHT warning on any branch marks it incomplete, matching the app's stopped-flight signal. The top-level numbers always describe the main flight. If only a booster is incomplete, `outcome` is still `incomplete` and `partial` is true, but the completed main flight's numbers remain valid, including its time to landing in `flightTimeS`. If the main flight is incomplete, its numbers cover only the recorded part of that flight and `flightTimeS` is its last recorded sample time, not time to landing. The required Show-off.CDX1 fixture currently aborts when recovery deploys under thrust. `motorFailures` preserves kernel build refusals with the same mount display labels used by the flight runner. The motor list uses post-projection ignition and excludes ignition `never`, and warnings use the app's human text. Error bodies retain import notes, including the reason for a missing motor. The stamp pairs OpenRocket 24.12 with the app version; there is no independent kernel build identity yet.

The headless barrel defaults to a timer-free microtask yield; the underlying service retains its timer default when the watchdog is off for app parity tests, and App still yields between auto-delay probes. Enabling the watchdog without an explicit yield also selects microtask-only yields. The Worker explicitly passes the microtask yield and keeps the real flight in `ctx.waitUntil` as defence in depth. It opts into a 10 s dead-holder watchdog only while a call waits for the kernel lock. Because locked API work is microtask-only, a watchdog timer firing means no holder is running: the instance is then poisoned, the waiter and later flights return HTTP 503 `KERNEL_UNAVAILABLE` with `Retry-After: 5`, and the client should retry. This guard is unsafe with browser macrotask yields and is off by default. Any future in-lock I/O or timer requires revisiting this assumption. A poisoned instance keeps answering 503 until Cloudflare replaces it; a redeploy replaces every instance. Resetting the lock instead is unsafe: the per-flight kernel reset (`OrkEngine.reset`) clears handles only, not the kernel's static state or class initialisers. There is no queue bound or BUSY response; on the deployed Worker (2026-10-23), Cloudflare spread concurrent requests over isolates, and eight simultaneous requests for the memory-heaviest corpus design all succeeded. Platform termination itself cannot be caught as JSON.

The Worker requests summary series and uses primitive sample columns: the shipped Wrangler bundles' smallest workerd V8 old-space caps fell from 88 to 60 MiB across the measured designs (flight-bound worst 88 to 44; Worker start floor 38 to 22), comparing the old unminified kernel/full-series Worker with the new minified ASCII patched-kernel/summary-series Worker in 2 MiB steps; typed-array storage is outside these caps. The API returns neither load peaks (maxQ/max q-alpha) nor an airspeed check, but does return low rod-exit thrust-to-weight warnings in notes.flight; summary uses the same WGS84 model evaluated at the pad latitude and interpolated height rather than reading the kernel's per-step g (which also follows the rocket's drifting latitude), a rounding-level difference with 129/129 corpus API responses identical apart from timing.

`limits.cpu_ms = 300000` is the paid Workers maximum (300 s); local workerd does not enforce it. The budget was raised on 2026-10-24 after the old 60 s budget killed the heaviest design on cold isolates (47-56 s warm). Cold-isolate CPU P999 was about 124 s, giving about 2.4x headroom. Deploy B returned 129/129 corpus responses (111 HTTP 200 flight results and 18 HTTP 422 refusals), with 0 kills; the HTTP 503 `KERNEL_UNAVAILABLE` path was verified on Cloudflare. These measurements size the budget; they are not a guarantee for other designs. `.github/workflows/api-deploy.yml` deploys the Worker to workers.dev or deletes it, by hand from main only. A request can run up to eight auto-delay target probes, one Mach probe, and two reported flights after an aero upgrade (eleven kernel flights in total). Cost/admission policy belongs to S2 before public use.

Clients must allow more than 300 s of wall time before response headers for a flight near the CPU budget: cold startup and scheduling add wall time. Node 22's default fetch has an undici headersTimeout of 300 s; use a client with a longer headers timeout as well as an appropriate overall request timeout. A proxy with a 60-120 s idle timeout can also abort before the first byte. Check every proxy in the route. If the client times out or disconnects, Worker execution continues and its CPU is still billed; avoid immediate automatic retries that duplicate that work.

API flights use a time step of at least 0.05 s, including auto-delay and Mach probes. The floor is applied before import planning, so the plan, its step-change note and the flight all use the floored step; the reader's own caution for a file below the 0.01 s Time step minimum still describes the app (flown at 0.01 s there). If this raises the step the app would fly after its reader clamp, `notes.api` says, for example, "This API flies at a time step of at least 0.05 s; in the app this design flies at 0.01 s." Otherwise `notes.api` is an empty array. The app's own chosen time step is unchanged.

Results come from the same engine as the app, but the Worker's JavaScript runtime computes some floating-point Math differently. The initial deployed Worker comparison against Node covered 127 responses: 109 HTTP 200 flight results and 18 HTTP 422 refusals. Across those 109 flights, Worker-versus-Node differences reached 0.26% in flight time and 0.026% in apogee; most were in the 11th-13th significant digit. A browser is a third runtime, so app results may also differ slightly; those measurements do not quantify browser differences.

- S1: local Worker/kernel/file-to-flight; S2 measures, S3 describes (first draft below, not deployed), S4 measures fragments, S5 comes later.
- Thin app-owned headless exports; no moved or copied importer/flight implementation.
- Engine access uses only `@online-openrocket/engine`'s public API.
- Fixed `network: 'forbid'`; bundled motor snapshot, no thrustcurve.org calls or caller options.
- Raw design files only; no scripts, accounts or persisted state.
- `simulateFile` owns its kernel lock; never wrap it in `withKernel`.
- Install `setXmlParser(createJsXmlParser(API_XML_LIMITS))` once at Worker module scope; browser entry cannot import the headless entry. `API_XML_LIMITS` is `{ maxElements: 50_000, maxDepth: 64, omitOrkSamples: { maxElements: 1_000_000 } }`. The SAX gate refuses excessive structure before building a DOM with HTTP 413 `FILE_TOO_LARGE`: more than 50,000 elements, depth over 64, or more than 200,000 nodes (elements, attributes, text, comments, processing instructions and CDATA counted together, `maxElements` × 4). The 50,000 budget was set against all 185 local XML/design files measured (40,610 elements, depth 14, almost all of the largest in stored flight data); the app keeps its native parser without these structural limits.
- Stored `.ork` flight samples never reach the DOM (`omitOrkSamples`, API only). The gate validates every byte, then hands xmldom the text with the content of each `openrocket > simulations > simulation > flightdata > databranch` cut, the branch itself left self-closing with its attributes. Names match exactly as written, so prefixed or relocated lookalikes stay; a branch holding an `extension` or `parsererror` element (both still read document-wide) stays whole. No importer reads below `<flightdata>`: its attributes (the stored summary), the simulation wrappers, conditions, configuration ids, warnings and extensions all remain. The element and node budgets above count the elements the DOM gets; depth counts the source. The omitted content has its own budgets and messages: 1,000,000 elements (`Stored flight data element limit is 1,000,000.`) and 4,000,000 nodes. The gate validates a skipped element without building it in about 0.85 µs on Node 22 (4.2 M bare elements in 16 MiB), so each of its two passes stays near a second of CPU; a 16 MiB file of one-value datapoints is about 700,000. `.rkt` and `.CDX1` are unchanged: RockSim reads `SimulationResults` and `EngineSet` document-wide, and RASAero's simulations carry motors and masses. `node packages/api/scripts/import-memory.mjs` generates stored-flight designs from reference.ork and measures a baseline tree against this one.
- Wrangler selects fflate's browser ESM build; no `nodejs_compat`.
- API-only 8 MiB whole-file and 16 MiB inflated XML caps, including streamed bodies; errors are JSON without stacks.
- No CORS, routes, custom domains or account configuration in S1.
- Tests use Wrangler 4's `unstable_startWorker` and real local workerd; a test-only entry traps outbound fetch, counts attempts and request timer calls and checks its own fetch trap. Ordinary fixture checks use production catalogue state; only the separate missing-curve isolate installs a newer test overlay. Late fetch observation awaits waitUntil work plus 100 ms; unregistered work beyond that window remains unverified.

For fully offline local commands, set `WRANGLER_HIDE_BANNER=true`, `WRANGLER_SEND_METRICS=false` and `CLOUDFLARE_CF_FETCH_ENABLED=false` to disable the update-banner check, telemetry and development `Request.cf` metadata refresh. The tests set these before loading Wrangler.

Ordinary fixture numeric parity assertions use 1e-10 relative (floor 1e-10 SI) for apogee, maximum velocity and Mach. The round-2 review measured at most 1e-12 SI drift for the compared non-time quantities, and identical Node 22/24 results for all five designs reviewed. Event times, flight time and motor delays use 1e-5 relative (floor 1e-5 s): the cluster's descent-time drift across workerd/Node was 1.7e-6 relative. The time-step-floor cases also compare apogee at the event-time tolerance and prove the floor by checking that its apogee is nearer the floored Node oracle than the unfloored one. Every expected flight and outcome is computed afresh in the Node host; this is cross-runtime parity, not a published-data accuracy tolerance. Test-only motor selections follow the current bundled catalogue rather than specific upstream motor identities or snapshot dates.

Stored-flight import memory (2026-10-27, Node v22.22.0, `node packages/api/scripts/import-memory.mjs measure`): generated designs are reference.ork with one stored simulation (configuration id, conditions and summary attributes kept) and one sample branch of 39 values per datapoint. Main `31cb6f1` (E1 budgets) is compared with `omitOrkSamples` (`f3a62d3`; `12ff682` for the 40,500-point and 60,000-point rows, which changes only the script). Each tree's `src/index.ts` is bundled by esbuild and each request runs in a fresh, cold Node process. "Import" is importOrk with the 16 MiB inflated cap; "fly" is the Worker's whole fetch handler. Old space is the smallest passing `--max-old-space-size`, found by binary search at 1 MiB resolution with the boundary rerun three times. It excludes young generation, code space and ArrayBuffer backing stores. Peak RSS (resourceUsage maxRSS) and the largest heap used before a GC (`--trace-gc`) are medians of three uncapped runs. These are different populations, so do not add them.

| Datapoints | XML bytes (zip) | Elements / depth | Import old space, MiB | Peak RSS, MiB | Peak heap before GC, MB |
|---:|---:|---:|---:|---:|---:|
| 1,000 | 382,280 (156,566) | 1,140 / 11 | 25 → 25 | 148 → 141 | 32.5 → 32.1 |
| 5,000 | 1,882,075 (763,998) | 5,140 / 11 | 31 → 26 | 171 → 147 | 45.9 → 32.6 |
| 10,000 | 3,756,798 (1,523,310) | 10,140 / 11 | 39 → 27 | 184 → 152 | 57.6 → 34.8 |
| 20,000 | 7,516,263 (3,042,115) | 20,140 / 11 | 58 → 28 | 221 → 176 | 78.0 → 45.9 |
| 40,500 | 15,223,159 (6,155,614) | 40,640 / 11 | 95 → 36 | 278 → 200 | 113.8 → 53.6 |
| 60,000 (20 values) | 12,415,357 (4,799,830) | 60,140 / 11 | refused by main (`XML element limit is 50,000.`) → 33 | — → 192 | — → 50.5 |

Fly, the same files: 1,000 datapoints 31 → 31 MiB old space; 40,500 datapoints 98 → 41 MiB (peak RSS 317 → 257 MiB). Main's import old space grows by about 1.8 MiB per 1,000 datapoints; with the omission, by about 0.3 MiB. The 40,500-point design matches the decoded size (15.2 MB) and element count of the local-only "Wildman Mach 2 this one.ork" but not its geometry or flight; that file must be measured itself. These are Node figures, a proxy for workerd: they do not establish safety within a 128 MB isolate.

## S3 draft: `POST /describe` (first draft for owner review; not deployed)

**Status.** A first draft of the contract and its implementation, for review before any integration or shipping decision. Nothing here is deployed, the shape may change, and `api: "s3-draft"` says so on every response. `/health` is unchanged; `/experimental/fly` gains the version stamp's `engine` and `catalogue` beside its `appVersion`.

**Request.** `POST /describe?filename=<name>` with the raw `.ork`, `.rkt` or `.CDX1` bytes as the body: the same reader, caps and importer as `/experimental/fly` (the extension picks the importer, case-insensitively; anything else reads as `.ork`). There are no caller options: no launch, site, motor, curve, aero or delay fields, and any other query parameter is ignored and cannot enable the network. The bundled motor snapshot is the only motor source (`network: 'forbid'`); a motorless or unmatched-motor design is described like any other. Nothing is flown: no flight, no auto-delay solve and no auto-aero Mach probe.

**Response** (HTTP 200, `application/json`). Types, then a real example.

```ts
{
  experimental: true,
  api: "s3-draft",
  name: string,
  sourceFormat: "ork" | "rkt" | "cdx1",
  analysis: {
    basis: "dry; no installed motors",
    aeroModel: string,                      // "classic+kbf" today: the app's first-visit default
    mach: 0.3,
    angleOfAttackRad: 0,
    lengthM: number,
    referenceDiameterM: number,             // the kernel's aerodynamic reference diameter
    dryMassKg: number,
    dryCgM: number | null,
    cpM: number | null,                     // forward CP over all roll angles
    stabilityCalibers: number | null,       // (cpM − dryCgM) / referenceDiameterM
    cdEstimate: {
      value: number | null,
      mach: 0.3,
      angleOfAttackRad: 0,
      powerState: "off",
      atmosphere: "kernel default; no Mach-altitude table",
      referenceAreaM2: number               // π · referenceDiameterM² / 4 (an area)
    }
  },
  mounts: [{
    key: string,                            // "m1", "m2", … request-local traversal order; not a placement instruction
    name: string,
    stageIndex: number,                     // 0 = sustainer (top stage)
    stageName: string,
    diameterM: number,                      // fit diameter: bore, or the outside for a case airframe; 0 for a solid tube
    maxMotorLengthM: number | null,         // the mount's stored limit; null = unset, 0 is a real limit
    count: number                           // motors one motor here becomes: cluster × pods/strap-ons × enclosing clusters
  }],
  fragment: string,                         // "#d=1.…", no motor suffix and no placement key
  link: string,                             // exactly "https://mmrsim.mountainmanrockets.com" + fragment
  notes: {
    import: { text: string, severity: string },   // the app's own import note
    analysis: string[],                     // why a figure is null, and other cautions
    export: string[]                        // what the fragment left out, and the writer's own save notes
  },
  appVersion: string,                       // the version stamp, as on every response
  engine: { openRocket: "24.12", appVersion: string },
  catalogue: { motorsGenerated: string, curvesGenerated: string }
}
```

Example: `reference.ork` at app 0.195 (the fragment and link are truncated here; the full fragment is about 2,100 characters). The numbers are illustrative and move with the app, kernel and catalogue.

```json
{
  "experimental": true, "api": "s3-draft",
  "name": "Reference Rocket", "sourceFormat": "ork",
  "analysis": {
    "basis": "dry; no installed motors", "aeroModel": "classic+kbf", "mach": 0.3, "angleOfAttackRad": 0,
    "lengthM": 0.37, "referenceDiameterM": 0.024, "dryMassKg": 0.02733579215809241,
    "dryCgM": 0.19313402043559422, "cpM": 0.2990617804118221, "stabilityCalibers": 4.413656665676161,
    "cdEstimate": { "value": 1.0840587963267343, "mach": 0.3, "angleOfAttackRad": 0, "powerState": "off",
      "atmosphere": "kernel default; no Mach-altitude table", "referenceAreaM2": 0.0004523893421169302 }
  },
  "mounts": [{ "key": "m1", "name": "Inner Tube", "stageIndex": 0, "stageName": "Sustainer",
    "diameterM": 0.018, "maxMotorLengthM": null, "count": 1 }],
  "fragment": "#d=1.vVjbbuM2EH3fryD0khZ…",
  "link": "https://mmrsim.mountainmanrockets.com#d=1.vVjbbuM2EH3fryD0kh…",
  "notes": {
    "import": { "text": "Loaded “Reference Rocket”.\nMotor “C6” loaded as Estes C6 … Check it is the motor you fly, or pick another via Browse motor database.", "severity": "warn" },
    "analysis": [],
    "export": ["Motor selections were removed from the link: 1 on the opened motor set and 1 across 1 saved configuration (unmatched references included). Each selected motor's ejection delay went with it; mount ignition settings are kept."]
  },
  "appVersion": "0.195", "engine": { "openRocket": "24.12", "appVersion": "0.195" },
  "catalogue": { "motorsGenerated": "2026-10-12", "curvesGenerated": "2026-10-12" }
}
```

**Units and meaning.** Lengths, CG and CP in metres, measured aft from the nose tip; mass in kilograms; angles in radians; Mach, Cd, count and calibers are dimensionless, and one caliber is `referenceDiameterM`. The figures are the Design tab's, with **no motor installed**: `basis` says so, and the margin is the DRY margin, not pad, rod-exit or flight stability. The design is the configuration the app's open selects (the flight route's choice), projected as a flight reads it (`resolveFlightState`); mounts, mass and CG all come from that one projection. Aerodynamics are the app's first-visit default (`APP_DEFAULT_AERO`: classic Barrowman with Rogers Kbf), with imported design overrides (Cd, mass/CG, stage overrides) kept; Auto never upgrades here because nothing flies. `cpM`/`stabilityCalibers` are the app's forward-CP figures (`shownCp`/`shownStability`), and both are `null` with a note when no part produces normal force (the kernel's no-force sentinel would otherwise read as a large negative margin). `cdEstimate` is the Design tab's one-point power-off drag sweep at Mach 0.3, angle of attack 0, in the kernel's default atmosphere: an estimate under those stated conditions, not a measured or flown coefficient. A Cd-only failure gives `null` plus a note; a missing dry CG likewise. JSON never carries NaN or Infinity; a non-finite length, reference diameter or dry mass is a build failure (422), not a zero.

**Kernel lock.** The build, `staticInfo` and drag sweep share one `withKernel` turn, under the same 10 s dead-holder watchdog as a flight; all of it is synchronous, with no I/O or timer inside the lock. The import before it and the fragment compression after it run outside. A refused build releases the lock; a poisoned instance answers 503.

**Fragment and projection.** The fragment is the app's existing share-link codec, format 1 (`#d=1.` + base64url of deflate-raw .ork XML, `shareLink.ts`), unchanged; any existing `#d=1.` link still decodes, and a future packing change must keep this reader. It is written by `exportOrk` from a private, motor-free projection of the opened design (`describeFile.ts`, `motorFreeProjection`), never by editing XML text:

- Removed: the working motor set and every saved configuration's motors (exportOrk's `motors: {}` alone would have kept the inactive ones), unmatched motor references and their text, motor-loadout refusals, the weighed pad mass (it rides on the motor record) and so any embedded EX motor archive; no stored simulation summaries, warnings, provenance or series are written (every `<simulation>` is `notsimulated`).
- Kept: the normalized tree (geometry, motor-mount tubes and flags, fins including freeform/rounded/airfoil, materials, component and stage mass/CG overrides, nozzle settings), each mount's ignition default and every configuration's ignition, deployment, separation, stage-activeness and stage mass/CG layers, the launch conditions the open merged (there is no caller location field), the Measured mass & CG box and the design notes. Scripts follow the exporter's existing inert rules.
- A configuration with no motor and no overrides is written with its simulation conditions; the app's reader folds such a lone empty configuration into the launch conditions on reopen, as it does for any dry save.
- Delay: each selected motor's ejection delay is removed with the motor (said in `notes.export`); a mount's ignition delay is kept. The ruled file-delay fallback (S5) has no carrier here; see the review questions.

**Determinism.** Node ids come from a module counter, so they depend on earlier requests in the isolate. The projection renames every node depth-first (`n1`, `n2`, …) on its clone, with every id-keyed map and id-naming record (`mountId`) following; configuration ids already come from the bytes (the `.ork` configid, `rocksim-sim-N`, `rasaero-sim-N`) and are kept; `exportOrk` takes an optional id source (absent in the app, so app saves and share links keep random UUIDs) and the projection passes a counter. The global counter is never reset. Tests repeat identical describes around unrelated describes and flights in one isolate and compare the complete JSON and fragment.

**Errors** (S1's `{ error: { code, message, importNote? } }` envelope with the version stamp beside it, `{ error, appVersion, engine, catalogue }`; no stacks):

| HTTP | code | when |
| --- | --- | --- |
| 404 | `NOT_FOUND` | unknown route |
| 405 | `METHOD_NOT_ALLOWED` | not POST on `/describe` (`Allow: POST`) |
| 400 | `FILENAME_REQUIRED` / `EMPTY_FILE` | no `?filename=` / empty body |
| 400 | `INVALID_FILE` | the importer's own explanation; false-small ZIP sizes included |
| 413 | `FILE_TOO_LARGE` | body over 8 MiB, inflated XML over 16 MiB, or the XML structure budget; points to the app |
| 413 | `LINK_TOO_LARGE` | the design is past the share link's own limits (4 MiB of XML, 1,048,576 characters); no partial result |
| 422 | `DESIGN_BUILD_FAILED` | the kernel will not build the design (with the import note); missing motors are not an error here |
| 503 | `KERNEL_UNAVAILABLE` | poisoned instance, `Retry-After: 5` |
| 500 | `INTERNAL_ERROR` | anything else: "The design could not be described." |

A refusal that repeats `?filename=` (both routes) shows at most 200 code points of it, a longer name keeping its head and last 16 code points around `…`, with control, line-separator, bidi-control and lone-surrogate characters shown as `?`; the full name still picks the importer.

Every row's body carries `appVersion`, `engine` and `catalogue` beside `error`.

**Tests.** `describe.test.ts` runs in real local workerd (a normal and a fetch-trapped Worker): the three formats against a fresh Node `describeFile` oracle (non-time quantities at 1e-10 relative, the S1 tolerance; mounts, notes and the decoded fragment XML exactly, since deflate bytes may differ between runtimes), motorless/unmatched/cluster designs, ignored options, zero fetch attempts and zero timers, determinism around unrelated requests, overlapping describes and flights, a forced build refusal followed by success, the poisoned kernel, every error row above (`LINK_TOO_LARGE` for both the XML-byte and the fragment-character limit) and the body/stream/inflate/XML caps. `packages/app/src/services/describeFile.test.ts` holds the service in Node to the flight build's own dry figures, the Design tab's loaded-build Cd (1e-12 relative: same kernel, same tree), the fixture XML's tube walls, pod, strap-on, cluster, case-airframe and length-limit semantics, a share link written by release v0.100 (`__fixtures__/share-link-v0.100.txt`, made with that release's own code) decoding and describing like its source file, a fixed point through the fragment (the reopened fragment describes to the same analysis and mounts), motor-free inactive configurations, unchanged source state, id-independent projection and lock ordering. All on committed fixtures; the owner's 276 tester files are local-only and have NOT been run.

**Review questions for the owner** (open; nothing here decides them):

1. Delay hint: the ruled S5 rule retains the file's delay if the new motor offers it. With motors removed, the fragment carries no file delay. Keep it out of v1, or add a representation (for example a per-mount `fileDelayS` in `mounts`, or an app extension in the XML)?
2. `notes.import` is the app's full import note, which talks about the motors the file named (matched, ambiguous, unloaded). Keep it verbatim, or filter motor lines for a motor-independent result?
3. `aeroModel` is a compact string (`"classic+kbf"`). Keep it, or split into `aeroModel` + `rogersKbf: boolean` like a stored run?
4. Mount `key` is traversal order (`m1`…). Is that enough for TC's display, given the link motor is not placed by mount id?
5. `link` is the bare origin + fragment, as specified (no `/`). Confirm, or use `https://mmrsim.mountainmanrockets.com/` + fragment?
6. Stage mass/CG overrides that the import could not back a motor out of (`overrideIncludesMotor`) are kept and flagged in `notes.analysis`, so the dry figures then include that motor. Keep, or drop those overrides from the dry analysis?
7. Nozzle exit diameters (RASAero per-simulation) stay on the stages as the opened configuration applied them; other configurations' nozzle maps are not written by the .ork exporter. Acceptable for v1?
8. Error precedence: a design both over the share-link limit and unbuildable reports the build failure first (422), since the build runs before the export. Confirm.
