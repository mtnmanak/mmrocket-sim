import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('holds the API and both manually maintained deployment Wrangler pins together', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { devDependencies: { wrangler: string } };
  const workflow = readFileSync(new URL('../../../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  const pins = [...workflow.matchAll(/(?:wranglerVersion:\s*['"]?|wrangler@)(\d+\.\d+\.\d+)/g)].map(m => m[1]);
  expect(pins).toHaveLength(2);
  expect(pins).toEqual([pkg.devDependencies.wrangler, pkg.devDependencies.wrangler]);
});

it('keeps Wrangler out of automatic npm updates while its deployment pins are manual', () => {
  const dependabot = readFileSync(new URL('../../../.github/dependabot.yml', import.meta.url), 'utf8');
  expect(ignoresApiWrangler(dependabot)).toBe(true);
});

/** Structural reader for this file's block-style updates/ignore lists; no YAML dependency. */
function ignoresApiWrangler(source: string): boolean {
  // Preserve quoted # characters, discard YAML comments, then compare decoded scalars.
  const lines = source.split(/\r?\n/).map(line => {
    const code = line.match(/^(?:[^#'"\n]|'[^']*(?:''[^']*)*'|"(?:[^"\\]|\\.)*")*/)?.[0] ?? '';
    return { indent: code.search(/\S/), text: code.trim() };
  }).filter(line => line.text);
  const scalar = (value: string) => {
    if (value.startsWith('"')) return JSON.parse(value) as string;
    if (value.startsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
    return value;
  };
  const updates = lines.findIndex(line => line.text === 'updates:');
  if (updates < 0) return false;
  const entryIndent = lines[updates + 1]?.indent;
  if (entryIndent === undefined) return false;
  const entries: (typeof lines)[] = [];
  for (const line of lines.slice(updates + 1)) {
    if (line.indent <= lines[updates]!.indent) break;
    if (line.indent === entryIndent && line.text.startsWith('- ')) entries.push([]);
    entries.at(-1)?.push(line);
  }
  return entries.some(entry => {
    const property = (name: string) => entry.find(line =>
      (line.indent === entryIndent || line.indent === entryIndent + 2)
      && line.text.replace(/^- /, '').startsWith(`${name}:`))?.text.replace(/^- /, '').slice(name.length + 1).trim();
    const ecosystem = property('package-ecosystem');
    const directory = property('directory');
    if (!ecosystem || scalar(ecosystem) !== 'npm' || !directory) return false;
    const scope = scalar(directory).replace(/\/$/, '');
    if (scope !== '' && scope !== '/packages' && scope !== '/packages/api') return false;
    const ignoreIndex = entry.findIndex(line => line.indent === entryIndent + 2 && line.text === 'ignore:');
    if (ignoreIndex < 0) return false;
    const ignores: (typeof lines)[] = [];
    for (const line of entry.slice(ignoreIndex + 1)) {
      if (line.indent <= entryIndent + 2) break;
      if (line.indent === entryIndent + 4 && line.text.startsWith('- ')) ignores.push([]);
      ignores.at(-1)?.push(line);
    }
    // A lone dependency-name ignores all versions; update-types/versions restrict it.
    return ignores.some(item => item.length === 1 && item[0]!.text.startsWith('- dependency-name:')
      && scalar(item[0]!.text.slice('- dependency-name:'.length).trim()) === 'wrangler');
  });
}

it.each(['wrangler', "'wrangler'", '"wrangler"'])('reads quoted/unquoted npm, directory and ignore scalars: %s', name => {
  expect(ignoresApiWrangler(`updates:
  - package-ecosystem: 'npm'
    directory: "/packages/api" # comment
    ignore:
      - dependency-name: ${name} # pinned
`)).toBe(true);
});

it.each([
  ['commented ignore', '/', '# - dependency-name: wrangler'],
  ['different workspace', '/packages/app', '- dependency-name: wrangler'],
  ['directory prefix only', '/packages/api-other', '- dependency-name: wrangler'],
  ['restricted updates', '/', "- dependency-name: wrangler\n        update-types: ['version-update:semver-major']"],
  ['restricted versions', '/', "- dependency-name: wrangler\n        versions: ['4.x']"],
])('rejects %s', (_name, directory, ignore) => {
  expect(ignoresApiWrangler(`updates:
  - package-ecosystem: npm
    directory: ${directory}
    ignore:
      ${ignore}
  - package-ecosystem: github-actions
    directory: /
    ignore:
      - dependency-name: wrangler
`)).toBe(false);
});
