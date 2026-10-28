// The API's XML structure budgets, apart from index.ts so a test can read them without installing the parser.
//
// The DOM budget is set from memory, not from the corpus maximum alone (audit
// S1-1, 2026-10-28): content the gate KEEPS (a sample branch holding an
// <extension/>, rows under <simulation>, .rkt/.CDX1 simulation data) builds the
// DOM in full, and 40,641 such elements needed 101 MiB of Node old space to fly
// (scripts/import-memory.mjs, attack shape; 62 MiB in workerd). At 16,000 kept
// elements the shape flies in 55 MiB of Node old space (rows under <simulation>:
// 60), under the 64 MiB target, with 2.4x headroom over the largest kept count
// the owner measured locally (about 6,510, a RASAero .CDX1); nodes stay at the x4
// default (64,000), and no text budget is needed: 16.7 M characters of text in
// 156 elements flew in 48 MiB (README, measurements). Stored .ork sample
// branches are validated but never reach the DOM, so the budget counts only
// what the DOM gets. Their content has its own budget: the gate validates a
// skipped element without building it in about 0.85 us (Node 22, 4.2 M bare
// elements in 16 MiB, scripts/import-memory.mjs), so 1,000,000 bounds each of
// the two gate passes near a second of CPU and still covers a 16 MiB file of
// one-value datapoints (about 700,000).
export const API_XML_LIMITS = { maxElements: 16_000, maxDepth: 64, omitOrkSamples: { maxElements: 1_000_000 } } as const;
