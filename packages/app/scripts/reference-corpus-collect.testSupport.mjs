import { createVitest } from 'vitest/node';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from '../../../scripts/is-main.mjs';

export async function collectMissingCorpora(manifest, setupName = 'reference-corpus-null.testSupport.mjs') {
  const here = dirname(fileURLToPath(import.meta.url));
  const setup = join(here, setupName);
  const result = [];
  for (const [packageName, cases] of Object.entries(manifest)) {
    const root = join(here, '..', '..', packageName);
    const runner = await createVitest('test', { root, watch: false, maxWorkers: 1, reporters: [],
      config: join(root, packageName === 'app' ? 'vite.config.ts' : 'vitest.config.ts'),
      ...(packageName === 'app' ? { project: ['missing-corpus'] } : {}),
    }, { test: { setupFiles: [setup],
      ...(packageName === 'app' ? { projects: [{ extends: true, test: { name: 'missing-corpus', setupFiles: [setup] } }] } : {}),
    } });
    try {
      // Vitest 5 defaults to static parsing, which never evaluates discovery or
      // setup mocks and marks skipIf expressions skipped without checking them.
      const collected = await runner.collect(Object.keys(cases), { staticParse: false });
      const errors = runner.state.getUnhandledErrors();
      if (errors.length) throw new Error(errors.map(error => String(error.stack ?? error)).join('\n'));
      for (const module of collected.testModules) {
        if (!module.ok()) throw new Error(`Corpus collection failed: ${module.moduleId}`);
        result.push({ packageName, file: module.relativeModuleId.replaceAll('\\', '/'),
          tests: [...module.children.allTests()].map(test => ({ name: test.fullName, mode: test.options.mode })) });
      }
    } finally { await runner.close(); }
  }
  return result;
}

if (isMain(import.meta.url)) {
  const results = await collectMissingCorpora(JSON.parse(process.argv[2]), process.argv[3]);
  console.log(`MMRSIM_MISSING_CORPORA=${JSON.stringify(results)}`);
}
