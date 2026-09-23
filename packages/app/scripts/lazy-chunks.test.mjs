/**
 * lazy-chunks.mjs is the build check that the user guide, the changelog and
 * their two dialogs stay out of the entry chunk (vite.config.ts runs it on every
 * `vite build`; audit 2026-09-22, row 510). Its failure mode would be silence — a
 * check that passes everything — so these pin that it names a module folded into
 * the entry, ignores one tree-shaken to nothing, reads Windows and POSIX ids
 * alike, and refuses to answer when it cannot find the modules it guards at all.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LAZY_ONLY, lazyModulesInEntry } from './lazy-chunks.mjs';

const ROOT = 'E:/git/online_open_rocket/packages/app';

/** An output chunk in the shape Rollup hands generateBundle, cut to what the check reads. */
function chunk(fileName, isEntry, modules) {
  return {
    type: 'chunk', fileName, isEntry,
    modules: Object.fromEntries(Object.entries(modules)
      .map(([name, renderedLength]) => [`${ROOT}/${name}`, { renderedLength }])),
  };
}

/** The shape of the v0.140 build after row 510: the dialogs and their texts in chunks of their own. */
function cleanBundle() {
  return {
    'assets/index-CeoafHzG.js': chunk('assets/index-CeoafHzG.js', true, {
      'src/main.tsx': 2100, 'src/App.tsx': 180000, 'src/version.ts': 30,
    }),
    'assets/GuideDialog-DraQJ6Fg.js': chunk('assets/GuideDialog-DraQJ6Fg.js', false, {
      'src/components/GuideDialog.tsx': 2400, 'src/data/userGuide.ts': 263000,
    }),
    'assets/ChangelogDialog-BymykZtK.js': chunk('assets/ChangelogDialog-BymykZtK.js', false, {
      'src/components/ChangelogDialog.tsx': 1100, 'src/changelog.ts': 448000,
    }),
    'assets/index-B7c9.css': { type: 'asset', fileName: 'assets/index-B7c9.css' },
  };
}

describe('lazy chunks — the guide and the changelog stay out of the entry chunk', () => {
  it('passes a build that keeps them in chunks of their own', () => {
    expect(lazyModulesInEntry(cleanBundle(), ROOT)).toEqual([]);
  });

  it('names each one an import folded into the entry chunk', () => {
    // The fold review measured: one import of the changelog from root.tsx put
    // the 0.140 entry's text back into index-*.js and left ChangelogDialog-*.js
    // at 1,055 bytes.
    const bundle = cleanBundle();
    bundle['assets/index-CeoafHzG.js'].modules[`${ROOT}/src/changelog.ts`] = { renderedLength: 448000 };
    delete bundle['assets/ChangelogDialog-BymykZtK.js'].modules[`${ROOT}/src/changelog.ts`];
    expect(lazyModulesInEntry(bundle, ROOT)).toEqual(['assets/index-CeoafHzG.js: src/changelog.ts']);
  });

  it('ignores an import whose bindings were tree-shaken to nothing', () => {
    const bundle = cleanBundle();
    bundle['assets/index-CeoafHzG.js'].modules[`${ROOT}/src/data/userGuide.ts`] = { renderedLength: 0 };
    expect(lazyModulesInEntry(bundle, ROOT)).toEqual([]);
  });

  it('reads a root written with backslashes or a trailing slash, and a drive letter in either case', () => {
    const bundle = cleanBundle();
    bundle['assets/index-CeoafHzG.js'].modules[`${ROOT}/src/components/GuideDialog.tsx`] = { renderedLength: 2400 };
    const found = ['assets/index-CeoafHzG.js: src/components/GuideDialog.tsx'];
    expect(lazyModulesInEntry(bundle, ROOT.replace(/\//g, '\\'))).toEqual(found);
    expect(lazyModulesInEntry(bundle, `${ROOT}/`)).toEqual(found);
    expect(lazyModulesInEntry(bundle, ROOT.replace(/^E:/, 'e:'))).toEqual(found);
  });

  it('refuses to pass anything when a guarded module is in no chunk at all', () => {
    // A rename would leave LAZY_ONLY naming a file the build no longer has, and
    // an entry chunk that can never contain it.
    const bundle = cleanBundle();
    delete bundle['assets/GuideDialog-DraQJ6Fg.js'].modules[`${ROOT}/src/data/userGuide.ts`];
    expect(() => lazyModulesInEntry(bundle, ROOT)).toThrow(/renders src\/data\/userGuide\.ts/);
    // So does a root the ids are not under: nothing would match.
    expect(() => lazyModulesInEntry(cleanBundle(), 'E:/elsewhere/app')).toThrow(/no chunk of the build renders/);
  });

  it('names modules that exist, relative to the app package', () => {
    const app = join(dirname(fileURLToPath(import.meta.url)), '..');
    expect(LAZY_ONLY.filter((name) => !existsSync(join(app, name)))).toEqual([]);
  });
});
