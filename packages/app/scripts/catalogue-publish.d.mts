/**
 * Type surface of catalogue-publish.mjs for the app's tests: only what
 * services/catalogueClient.test.ts imports, to hold the app's manifest check
 * to the publisher's. tsconfig has no allowJs, so the .mjs needs this beside
 * it. The script uses node: modules and is never imported by app code.
 */
export function validatePreviousManifest(manifest: unknown): void;
