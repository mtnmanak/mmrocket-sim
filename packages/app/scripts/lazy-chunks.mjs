/**
 * Does the entry chunk carry a module that must load only when its dialog opens?
 *
 * WHY. The user guide's text (src/data/userGuide.ts) and the changelog
 * (src/changelog.ts) were ~730 KB of source at v0.140, and both grow every
 * release. They rode in the entry chunk, which every visit must load and parse
 * before the app draws, until App.tsx lazy-loaded the two dialogs that read them
 * (audit 2026-09-22, row 510). What keeps them out is only that nothing on the
 * startup path imports them, and one import there folds a chunk back into the
 * entry with nothing visibly wrong: the app works, the tests pass, and startup
 * carries 700 KB more. App.lazyDialogs.test.tsx catches such an import from
 * anything the app's tree loads; it cannot run main.tsx, whose own imports it
 * does not see (from review). This reads the build's own chunk graph instead, so
 * an import from anywhere is caught: vite.config.ts runs it on every
 * `vite build` and fails the build on a hit.
 *
 * Node-only; imported by vite.config.ts, typed for it by lazy-chunks.d.mts
 * beside it.
 */

/**
 * The modules, relative to the app package, that no entry chunk may carry: the
 * two dialogs and the two texts only they import.
 */
export const LAZY_ONLY = [
  'src/changelog.ts',
  'src/components/ChangelogDialog.tsx',
  'src/components/GuideDialog.tsx',
  'src/data/userGuide.ts',
];

/**
 * The LAZY_ONLY modules rendered into an entry chunk of a Rollup output
 * `bundle`, as `<chunk file>: <module>`; `root` is the app package's directory,
 * which module ids are resolved against. A module counts only when some of its
 * code was rendered (renderedLength > 0): an import whose bindings go unused is
 * tree-shaken and costs startup nothing.
 *
 * Throws when a LAZY_ONLY module is rendered into no chunk at all — renamed,
 * deleted, or its ids no longer resolved against `root` — because a list that
 * names only modules the build does not have passes every build.
 */
export function lazyModulesInEntry(bundle, root) {
  const base = `${root.replace(/\\/g, '/').replace(/\/+$/, '')}/`;
  const relative = (id) => {
    const path = id.replace(/\\/g, '/');
    return path.toLowerCase().startsWith(base.toLowerCase()) ? path.slice(base.length) : path;
  };
  const rendered = new Set();
  const inEntry = [];
  for (const chunk of Object.values(bundle)) {
    if (chunk.type !== 'chunk') continue;
    for (const [id, mod] of Object.entries(chunk.modules)) {
      const name = relative(id);
      if (!LAZY_ONLY.includes(name) || mod.renderedLength === 0) continue;
      rendered.add(name);
      if (chunk.isEntry) inEntry.push(`${chunk.fileName}: ${name}`);
    }
  }
  const missing = LAZY_ONLY.filter((name) => !rendered.has(name));
  if (missing.length > 0) {
    throw new Error(`no chunk of the build renders ${missing.join(', ')}, so the check that keeps `
      + 'them out of the entry chunk would pass anything. Update LAZY_ONLY in '
      + 'scripts/lazy-chunks.mjs to the modules the build has.');
  }
  return inEntry.sort();
}
