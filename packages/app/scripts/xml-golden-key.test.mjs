import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { importerKeyFiles } from './xml-golden-key.mjs';

it('follows real static, re-export and literal dynamic imports only', () => {
  const app = mkdtempSync(join(tmpdir(), 'xml-key-'));
  try {
    mkdirSync(join(app, 'src/services'), { recursive: true });
    writeFileSync(join(app, 'src/services/xmlParseParity.ts'), [
      "// import './old.js'", "/* export * from './absent.js'; */",
      'const message = "import(\'./missing.js\')";',
      "import type { Missing } from './type-only.js';",
      "export type { Other } from './also-types.js';",
      "import './static.js';", "export * from './exported.js';",
      'const lazy = import(`./helper.js`);',
      "const quoted = import('./quoted.js');",
    ].join('\n'));
    for (const file of ['static', 'exported', 'helper', 'quoted']) {
      writeFileSync(join(app, `src/services/${file}.ts`), 'export const value = 1;');
    }
    expect(importerKeyFiles(app)).toEqual(['exported', 'helper', 'quoted', 'static', 'xmlParseParity']
      .map(file => `src/services/${file}.ts`));
  } finally { rmSync(app, { recursive: true, force: true }); }
});
