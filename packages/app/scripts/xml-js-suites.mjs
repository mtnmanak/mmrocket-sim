/**
 * The test files vitest runs a SECOND time with the JS XML parser installed
 * (the `jsxml` project in vite.config.ts; headless step 2, 2026-10-01).
 *
 * WHY (critique F1). The corpus and the committed fixtures cannot see many
 * kinds of silent parser defect: of 25 deliberate defects in a JS DOM, 10
 * changed no corpus file and 12 no fixture, because the paths that would show
 * them — stray motor configs, wind levels with and without a standard
 * deviation, pods and boosters, hand-written edge cases — appear only in the
 * importers' own unit and hardening tests. So those tests run twice: once
 * under happy-dom's DOMParser, as always, and once through
 * services/xmlParseJs.ts. They pass unchanged both ways.
 *
 * WHICH. Every test file that calls an importer entry point (importOrk,
 * importRkt, importCdx1, parseRse, parseMotorFile, rocksimMotorEvidence) or
 * an XML reader helper (xmlText, xmlNum), or that hands the app a design or
 * motor file as a `new File(...)` or a share link via encodeShareFragment.
 * xmlParse.guard.test.ts greps for exactly
 * that and fails if a file is in neither list below, so a new importer test is
 * run both ways unless someone writes down why not.
 *
 * Paths are relative to packages/app.
 */
export const XML_JS_SUITES = [
  // C-H3: diagnostic messages are taken from the real importer refusals.
  'src/services/sessionDebugLog.imports.test.ts',
  'src/App.a11y.test.tsx',
  // Per-line note tiers on file open, and the tier surfaces that render them (rows 93/94, 2026-10-12).
  'src/services/importNotes.test.ts',
  'src/components/NoticeBar.groups.test.tsx',
  'src/components/NoteSurfaces.test.tsx',
  'src/services/configLayers.wiring.test.ts',
  'src/services/legacyPositionCheck.test.ts',
  'src/services/legacyPositionCheck.round2.test.ts',
  'src/services/legacyPositionCheck.round3.test.ts',
  'src/services/rasaeroConfigMass.test.tsx',
  'src/services/addComponent.test.ts',
  'src/services/baseDragImportNotes.test.ts',
  'src/services/componentTable.test.ts',
  'src/services/configSync.test.ts',
  'src/services/autosaveBackup.test.ts',
  'src/services/exMotors.test.ts',
  // EX validation and same-id nozzle imports (audit 2026-10-11, S1c-4/S3c-2).
  'src/services/exMotors.audit.test.ts',
  'src/hooks/useNozzleFollow.test.tsx',
  'src/services/importApply.repick.test.ts',
  'src/App.openMotorChoices.test.tsx',
  'src/services/importLimits.test.ts',
  // The 2,000-part refusal (board row 84) in all three importers.
  'src/services/designPartLimit.test.ts',
  'src/services/motorMatch.policy.test.ts',
  'src/services/nozzleStage.test.ts',
  'src/services/nozzleWiring.test.ts',
  'src/services/deployOverrideNote.test.ts',
  'src/services/orkFile.test.ts',
  'src/services/partComments.test.ts',
  // C-A2: recent copies reopen through the real file door, including nonstandard names.
  'src/services/recentDesigns.test.ts',
  'src/services/orkFile.layers.test.ts',
  'src/services/orkFile.audit-fidelity.test.ts',
  'src/services/orkExtensions.test.ts',
  'src/services/orkFile.version.test.ts',
  'src/services/orkExMotors.test.ts',
  'src/services/orkExRound2.test.ts',
  'src/services/orkFileHardening.test.ts',
  'src/services/orkLongitude.test.ts',
  'src/services/orkFlightData.test.ts',
  'src/services/orkDesktopPredictions.test.ts',
  'src/services/warningImport.test.ts',
  'src/services/warningUnits.kernel.test.ts',
  'src/services/warningUnits.test.ts',
  'src/services/orkAero.test.ts',
  'src/services/orkFilledTube.test.ts',
  'src/services/orkFlippedNose.test.ts',
  'src/services/orkGeodetic.test.ts',
  'src/services/orkNewFields.test.ts',
  'src/services/orkPackedSize.test.ts',
  'src/services/orkRadial.test.ts',
  'src/services/rasaeroFile.test.ts',
  'src/services/rasaeroFile.audit.test.ts',
  'src/services/rasaeroStatedFigures.test.ts',
  'src/services/recoveryMass.test.ts',
  'src/services/rocksimFile.test.ts',
  // Mount fidelity and early part bounds (audit 2026-10-11, S1b-6/S1b-3).
  'src/services/rocksimFile.fidelity.test.ts',
  'src/services/rocksimFile.bounds.test.ts',
  'src/services/rocksimAmbiguousLoadout.test.ts',
  'src/services/rocksimFileHardening.test.ts',
  'src/services/rocksimFileIgnored.test.ts',
  'src/services/rocksimRecovery.test.ts',
  'src/services/foreignFile.layers.test.ts',
  'src/services/rocksimRingBore.test.ts',
  'src/services/rocksimAttachRules.test.ts',
  'src/services/rocksimFile.lossNotes.test.ts',
  'src/services/rocksimLaunchSite.test.ts',
  'src/services/rocksimPackedChute.test.ts',
  'src/services/statedLaunchWeight.test.ts',
  'src/services/transitionShoulders.test.ts',
  'src/services/untrustedFileHardening.test.ts',
  'src/services/windProfile.test.ts',
  'src/services/xmlUtil.test.ts',
  'src/tree/motorLength.test.ts',
  'src/components/TreeSchematic.golden.test.tsx',
  // These five reach an importer THROUGH the app rather than by calling one
  // (verify-step2 finding 2): App.session opens rocksimTestRocket1.rkt and
  // App.nozzle ThreeCarbYen-2018.CDX1 as a user would, and MotorBrowser drops a
  // hand-written .rse — an edge case (exit diameter in inches) no other suite
  // carries — on its import input, which reaches parseRse via parseMotorFile.
  // App.rodAim and App.weather open designs through share links.
  'src/App.session.test.tsx',
  'src/App.nozzle.test.tsx',
  'src/App.rodAim.test.tsx',
  'src/App.weather.test.tsx',
  'src/components/MotorBrowser.test.tsx',
  // Proves this project really runs the JS parser (and the default project the
  // browser's): without it, a setup file that stopped installing the parser
  // would leave every suite above passing under happy-dom twice.
  'src/services/xmlParse.project.test.ts',
  'src/services/xmlParse.guard.test.ts',
  // The DOCTYPE refusal (Tier 0 row 59, v0.150): the same answer on both paths.
  'src/services/xmlParse.doctype.test.ts',
  // The headless door (step 1, 2026-10-01): simulateFile opens bytes through
  // the importers, which is exactly the path a server takes under this parser.
  'src/services/simulateFile.test.ts',
  'src/services/digestPick.test.ts',
  'src/services/flyBuiltDesign.test.ts',
  // Fin root fillets (C-B14): .ork reopen and the .rkt/.CDX1 loss notes.
  'src/components/PropertyPanel.fillets.test.tsx',
  'src/services/filletExport.test.ts',
];

/** Files that call an importer but are NOT run twice, each with the reason. */
export const XML_JS_EXCLUDED = {
  'src/components/RecentDesignsDialog.test.tsx': 'passes mocked File objects through the chooser callback '
    + 'without calling an importer or parsing XML',
  'src/App.simulate.test.tsx': 'holds the mounted app and the headless Launch to the same flight; BOTH sides '
    + 'parse with the same parser, so a second run tests nothing the importer suites and simulateFile.test.ts '
    + '(above) do not, at the cost of a full app mount per case',
  'src/services/shareLink.test.ts': 'encodes and decodes the link payload as text and never parses it: no importer '
    + 'and no XML parser is reached (the scan counts encodeShareFragment( as reaching one, which is true of the App '
    + 'suites that then open the link)',
  'src/App.flight.test.tsx': 'drives the whole app through a flight; it opens files only to have a design, '
    + 'and the importer suites above cover what it would parse',
  'src/App.save.test.tsx': 'presses every Save and Export entry; its imports read back what the app itself '
    + 'wrote, which the round-trip suites above already cover under both parsers',
  'src/App.longitudeCheck.test.tsx': 'mounts the app to prove the longitude row is wired to a real open; the '
    + 'reading itself is orkLongitude.test.ts (above), which runs under both parsers',
  'src/services/lemivSweep.test.ts': 'a measurement driver that prints a sweep of simulated flights; it opens '
    + 'one fixture, which the golden test already holds to Chrome',
  'src/services/motorDigest.census.test.ts': 'a measurement driver (scripts/digest-census.mjs) that skips unless '
    + 'its manifest is named; it opens local-only designs, never run in npm test',
};

/** The setup file that installs the JS parser for that project. */
export const XML_JS_SETUP = 'src/services/xmlParseJs.setup.ts';
