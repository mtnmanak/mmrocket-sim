/**
 * Does the startup graph carry a module that must load only when its dialog opens?
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
 * The modules, relative to the app package, that no startup chunk may carry: the
 * two dialogs and the two texts only they import.
 */
export const LAZY_ONLY = [
  'src/changelog.ts',
  'src/components/ChangelogDialog.tsx',
  'src/components/GuideDialog.tsx',
  'src/data/userGuide.ts',
];

function relativeModule(id, root) {
  const base = `${root.replace(/\\/g, '/').replace(/\/+$/, '')}/`;
  const path = id.replace(/\\/g, '/');
  return path.toLowerCase().startsWith(base.toLowerCase()) ? path.slice(base.length) : path;
}

/** Bootstrap loads main immediately after the browser gate; both are startup roots. */
function startupChunks(bundle, root) {
  const eager = new Map();
  let foundMain = false;
  const visit = (chunk) => {
    if (chunk?.type !== 'chunk' || eager.has(chunk.fileName)) return;
    eager.set(chunk.fileName, chunk);
    for (const name of chunk.imports ?? []) visit(bundle[name]);
  };
  for (const chunk of Object.values(bundle)) {
    if (chunk.type !== 'chunk') continue;
    const main = Object.keys(chunk.modules).some(id => relativeModule(id, root) === 'src/main.tsx');
    if (main) foundMain = true;
    if (chunk.isEntry || main) visit(chunk);
  }
  if (!foundMain) throw new Error('no chunk of the build renders src/main.tsx; update the startup root in scripts/lazy-chunks.mjs.');
  return eager;
}

/** Fetch startup JS and CSS from HTML without evaluating main before the browser gate. */
export function startupPreloadLinks(bundle, root) {
  const tags = new Map();
  for (const chunk of startupChunks(bundle, root).values()) {
    if (!chunk.isEntry) tags.set(chunk.fileName, 'modulepreload');
    for (const file of chunk.viteMetadata?.importedCss ?? []) tags.set(file, 'stylesheet');
  }
  return [...tags].map(([file, rel]) => ({ tag: 'link', attrs: { rel, crossorigin: '', href: `./${file}` }, injectTo: 'head' }));
}

/**
 * Rendered LAZY_ONLY modules in the startup graph, as `<chunk file>: <module>`.
 * Ignore tree-shaken bindings. Refuse to pass when guarded modules are absent
 * altogether — a stale list would otherwise pass every build.
 */
export function lazyModulesInEntry(bundle, root) {
  const rendered = new Set();
  const inEntry = [];
  const eager = startupChunks(bundle, root);
  for (const chunk of Object.values(bundle)) {
    if (chunk.type !== 'chunk') continue;
    for (const [id, mod] of Object.entries(chunk.modules)) {
      const name = relativeModule(id, root);
      if (!LAZY_ONLY.includes(name) || mod.renderedLength === 0) continue;
      rendered.add(name);
      if (eager.has(chunk.fileName)) inEntry.push(`${chunk.fileName}: ${name}`);
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
