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
 * motor file as a `new File(...)`. xmlParse.guard.test.ts greps for exactly
 * that and fails if a file is in neither list below, so a new importer test is
 * run both ways unless someone writes down why not.
 *
 * Paths are relative to packages/app.
 */
export const XML_JS_SUITES = [
  'src/services/addComponent.test.ts',
  'src/services/autosaveBackup.test.ts',
  'src/services/exMotors.test.ts',
  'src/services/importApply.repick.test.ts',
  'src/services/importLimits.test.ts',
  'src/services/motorMatch.policy.test.ts',
  'src/services/nozzleStage.test.ts',
  'src/services/nozzleWiring.test.ts',
  'src/services/orkFile.test.ts',
  'src/services/orkFileHardening.test.ts',
  'src/services/orkFilledTube.test.ts',
  'src/services/orkFlippedNose.test.ts',
  'src/services/orkGeodetic.test.ts',
  'src/services/orkNewFields.test.ts',
  'src/services/orkPackedSize.test.ts',
  'src/services/orkRadial.test.ts',
  'src/services/rasaeroFile.test.ts',
  'src/services/recoveryMass.test.ts',
  'src/services/rocksimFile.test.ts',
  'src/services/rocksimFileHardening.test.ts',
  'src/services/rocksimFileIgnored.test.ts',
  'src/services/rocksimRecovery.test.ts',
  'src/services/rocksimRingBore.test.ts',
  'src/services/statedLaunchWeight.test.ts',
  'src/services/transitionShoulders.test.ts',
  'src/services/untrustedFileHardening.test.ts',
  'src/services/windProfile.test.ts',
  'src/services/xmlUtil.test.ts',
  'src/tree/motorLength.test.ts',
  'src/components/TreeSchematic.golden.test.tsx',
  // These three reach an importer THROUGH the app rather than by calling one
  // (verify-step2 finding 2): App.session opens rocksimTestRocket1.rkt and
  // App.nozzle ThreeCarbYen-2018.CDX1 as a user would, and MotorBrowser drops a
  // hand-written .rse — an edge case (exit diameter in inches) no other suite
  // carries — on its import input, which reaches parseRse via parseMotorFile.
  'src/App.session.test.tsx',
  'src/App.nozzle.test.tsx',
  'src/components/MotorBrowser.test.tsx',
  // Proves this project really runs the JS parser (and the default project the
  // browser's): without it, a setup file that stopped installing the parser
  // would leave every suite above passing under happy-dom twice.
  'src/services/xmlParse.project.test.ts',
];

/** Files that call an importer but are NOT run twice, each with the reason. */
export const XML_JS_EXCLUDED = {
  'src/App.flight.test.tsx': 'drives the whole app through a flight; it opens files only to have a design, '
    + 'and the importer suites above cover what it would parse',
  'src/App.save.test.tsx': 'presses every Save and Export entry; its imports read back what the app itself '
    + 'wrote, which the round-trip suites above already cover under both parsers',
  'src/services/lemivSweep.test.ts': 'a measurement driver that prints a sweep of simulated flights; it opens '
    + 'one fixture, which the golden test already holds to Chrome',
};

/** The setup file that installs the JS parser for that project. */
export const XML_JS_SETUP = 'src/services/xmlParseJs.setup.ts';
