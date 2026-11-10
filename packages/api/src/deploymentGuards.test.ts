import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const normalizeKeys = (text: string) => text.replace(/\r\n/g, '\n').replace(/^[ \t]*#[^\n]*/gm, '')
  .replace(/^(\s*(?:- )?)(?:"([\w-]+)"|'([\w-]+)'|([\w-]+))[ \t]*:/gm, '$1$2$3$4:');

function isolatedPinnedWorkflow(text: string): boolean {
  // These owned workflows need no YAML references; reject rather than resolve them.
  if (/(?:^[ \t]*|:[ \t]+|[[{,][ \t]*|^[ \t]*-[ \t]+)[&*][^\s[\]{},]+/m.test(text)) return false;
  const source = normalizeKeys(text);
  const uses = [...source.matchAll(/\buses:\s*(\S+)/g)].map(match => match[1]!);
  if (!uses.length || !uses.every(action => action.startsWith('./') || /^[\w-]+\/[\w-]+@[a-f0-9]{40}$/.test(action))) return false;
  // The context can be passed whole (toJSON(secrets)), not just indexed.
  const secretReference = /\bsecrets\b/i;
  // Workflow/job keys are unordered. Bound each value by the next peer key.
  const properties = (block: string, indent = 4) => {
    const keys = [...block.matchAll(new RegExp(`^ {${indent}}["']?([\\w-]+)["']?:`, 'gm'))];
    return keys.map((key, i) => ({ name: key[1], text: block.slice(key.index, keys[i + 1]?.index) }));
  };
  const root = properties(source, 0);
  const jobs = properties(root.find(field => field.name === 'jobs')?.text ?? '', 2);
  const job = (name: string) => jobs.find(field => field.name === name)?.text ?? '';
  if (/^ {4}secrets:/m.test(job('test'))) return false;
  if (['build', 'deploy', 'delete'].some(name => !/^ {4}runs-on: ubuntu-24\.04(?:\s*#.*)?$/m.test(job(name)))) return false;
  if (secretReference.test(job('build')) || /^ {4}environment:/m.test(job('build'))) return false;
  // Job/global env could expose secrets to npm before step-level checks apply.
  for (const name of ['deploy', 'delete']) {
    const fields = properties(job(name));
    if (fields.some(field => field.name !== 'steps' && secretReference.test(field.text))) return false;
    const steps = (fields.find(field => field.name === 'steps')?.text ?? '').split(/^ {6}- /m).slice(1);
    // Inspect the entire run value, including literal/folded block scalars.
    const installs = (step: string) => {
      // Flow mappings can put run after another field; exclude following fields.
      const flowRun = step.trimStart().startsWith('{')
        ? step.match(/[{,][ \t]*["']?run["']?[ \t]*:[ \t]*("[^"]*"|'[^']*'|[^,}]*)/)?.[1] : undefined;
      let run = (flowRun ?? step.match(/(?:^|\n {8})run:[ \t]*([^\n]*(?:\n(?:[ \t]*(?=\n|$)| {9,}[^\n]*))*)/)?.[1] ?? '').trim();
      // Decode the owned scalar forms before recognizing shell commands.
      if (/^>[+-]?\n/.test(run)) run = run.replace(/^>[+-]?\n/, '').replace(/\n/g, ' ');
      if ((run.startsWith('"') && run.endsWith('"')) || (run.startsWith("'") && run.endsWith("'"))) run = run.slice(1, -1);
      const aliases = new Set(['install', 'ci', 'i', 'clean-install', 'add', 'in', 'ic', 'it', 'isntall', 'install-clean', 'install-test']);
      return run.split(/\n|&&|\|\||[;|]/).some(command => {
        const tokens = command.trim().split(/\s+/);
        while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0] ?? '')) tokens.shift();
        if (tokens.shift() !== 'npm') return false;
        while (tokens[0]?.startsWith('-')) {
          const option = tokens.shift()!;
          // Options may be switches, --key=value, or -x/--key value.
          if (!option.includes('=') && tokens[0] && !tokens[0].startsWith('-') && !aliases.has(tokens[0])) tokens.shift();
        }
        return aliases.has(tokens[0] ?? '');
      });
    };
    if (!steps.some(installs)) return false;
    // Preserve the base whole-step guard even when run extraction misses a key.
    if (steps.some(step => (/run\s*:\s*['"]?npm (install|ci)/.test(step) || installs(step)) && secretReference.test(step))) return false;
  }
  return !root.some(field => field.name !== 'jobs' && secretReference.test(field.text));
}

it('guards API action SHAs, runner parity and secret-free build/install steps', () => {
  const workflow = readFileSync(new URL('../../../.github/workflows/api-deploy.yml', import.meta.url), 'utf8');
  expect(isolatedPinnedWorkflow(workflow)).toBe(true);
  for (const match of workflow.matchAll(/uses: (?!\.\/)(\S+)|runs-on: ubuntu-24\.04/g)) {
    const replacement = match[1] ? 'uses: ' + match[1].replace(/@.*/, '@v4') : 'runs-on: ubuntu-latest';
    const changed = workflow.slice(0, match.index) + replacement + workflow.slice(match.index! + match[0].length);
    expect(isolatedPinnedWorkflow(changed), match[0]).toBe(false);
  }
  for (const addition of ['    environment: api-production', '    env:\n      TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}']) {
    expect(isolatedPinnedWorkflow(workflow.replace('  build:', '  build:\n' + addition))).toBe(false);
  }
  for (const [from, to] of [
    ['  deploy:', '  deploy:\n    env:\n      TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}'],
    ['jobs:', 'env:\n  TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}\n\njobs:'],
  ]) {
    expect(workflow).toContain(from);
    const changed = workflow.replace(from!, to!);
    expect(changed).not.toBe(workflow);
    expect(isolatedPinnedWorkflow(changed), from).toBe(false);
  }
  for (const match of workflow.matchAll(/run: npm (?:install|ci)[^\n]*/g)) {
    const changed = workflow.slice(0, match.index! + match[0].length) + '\n        env:\n          TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}' + workflow.slice(match.index! + match[0].length);
    expect(isolatedPinnedWorkflow(changed), match[0]).toBe(false);
  }
});

it.each(['deploy', 'delete'])('rejects %s job env after steps in either secret syntax', name => {
  const workflow = readFileSync(new URL('../../../.github/workflows/api-deploy.yml', import.meta.url), 'utf8');
  for (const reference of ['secrets.CLOUDFLARE_API_TOKEN', "secrets['X']"]) {
    const changed = workflow.replace(new RegExp(`(\\n  ${name}:[\\s\\S]*?)(?=\\n  [a-z][\\w-]*:|$)`),
      `$1\n    env:\n      TOKEN: \u0024{{ ${reference} }}\n`);
    expect(changed).not.toBe(workflow);
    expect(isolatedPinnedWorkflow(changed), reference).toBe(false);
  }
});

it('rejects bracket secret references anywhere in build and inherited workflow env', () => {
  const workflow = readFileSync(new URL('../../../.github/workflows/api-deploy.yml', import.meta.url), 'utf8');
  for (const [from, to] of [
    ['  build:', "  build:\n    env:\n      TOKEN: ${{ secrets['X'] }}"],
    ['- run: npm ci', "- run: echo ${{ secrets['X'] }}"],
    ['jobs:', "env:\n  TOKEN: ${{ secrets['X'] }}\n\njobs:"],
    ['run: npm install', "env:\n          TOKEN: ${{ secrets['X'] }}\n        run: npm install"],
  ]) {
    expect(workflow).toContain(from);
    expect(isolatedPinnedWorkflow(workflow.replace(from!, to!)), from).toBe(false);
  }
});

it('rejects inherited workflow env after jobs', () => {
  const workflow = readFileSync(new URL('../../../.github/workflows/api-deploy.yml', import.meta.url), 'utf8');
  expect(isolatedPinnedWorkflow(workflow + "\nenv:\n  TOKEN: ${{ secrets['X'] }}\n")).toBe(false);
});

it.each(['secrets.X', "secrets['X']", 'secrets["X"]', 'toJSON(secrets)'])('rejects %s throughout inherited scopes', reference => {
  const workflow = readFileSync(new URL('../../../.github/workflows/api-deploy.yml', import.meta.url), 'utf8');
  for (const quote of ['', "'", '"']) {
    const env = `${quote}env${quote}:\n      TOKEN: \u0024{{ ${reference} }}`;
    for (const name of ['build', 'deploy', 'delete']) {
      const changed = workflow.replace(`  ${name}:`, `  ${name}:\n    ${env}`);
      expect(changed).not.toBe(workflow);
      expect.soft(isolatedPinnedWorkflow(changed), `${name} ${quote} ${reference}`).toBe(false);
    }
    expect.soft(isolatedPinnedWorkflow(`${quote}env${quote}:\n  TOKEN: \u0024{{ ${reference} }}\n${workflow}`)).toBe(false);
  }
});

it.each(['ci', 'install', 'i', 'clean-install', 'add', 'in', 'ic', 'it', 'isntall', 'install-clean', 'install-test',
  '--prefix packages/api ci', '-C packages/api install', '--silent ci', '--prefix=packages/api ci'])('rejects secrets in npm %s steps in inline and block forms', command => {
  const workflow = readFileSync(new URL('../../../.github/workflows/api-deploy.yml', import.meta.url), 'utf8');
  for (const scalar of ['', '|', '>', '|-', '>-', '|+', '>+']) {
    for (const quote of ['', "'", '"']) {
      const install = `${quote}run${quote}: ${scalar ? scalar + '\n          ' : ''}npm ${command}`;
      const clean = workflow.replace(/run: npm install[^\n]*/, install);
      expect.soft(isolatedPinnedWorkflow(clean), `clean ${command} ${scalar} ${quote}`).toBe(true);
      for (const reference of ['secrets.X', "secrets['X']", 'toJSON(secrets)']) {
        // Add an extra install so the required-install presence check cannot
        // conceal a missed secret check for an unfamiliar command spelling.
        for (const name of ['deploy', 'delete']) {
          const changed = workflow.replace(new RegExp(`(  ${name}:[\\s\\S]*?    steps:\\n)`),
            `$1      - ${install}\n        ${quote}env${quote}:\n          TOKEN: \u0024{{ ${reference} }}\n`);
          expect(changed).not.toBe(workflow);
          expect.soft(isolatedPinnedWorkflow(changed), `${name} ${command} ${scalar} ${quote} ${reference}`).toBe(false);
        }
      }
    }
  }
});

it('handles final-round blank lines, comments and nine-space block contents', () => {
  const workflow = readFileSync(new URL('../../../.github/workflows/api-deploy.yml', import.meta.url), 'utf8');
  for (const run of ['|\n          # install\n          npm i evil-pkg',
    '|\n          echo prep\n\n          npm i evil-pkg', '|\n         npm i evil-pkg']) {
    const clean = workflow.replace(/run: npm install[^\n]*/, `run: ${run}`);
    expect.soft(isolatedPinnedWorkflow(clean), `clean ${run}`).toBe(true);
    for (const name of ['deploy', 'delete']) {
      const changed = workflow.replace(new RegExp(`(  ${name}:[\\s\\S]*?    steps:\\n)`),
        `$1      - run: ${run}\n        env:\n          TOKEN: \u0024{{ secrets.CLOUDFLARE_API_TOKEN }}\n`);
      expect(changed).not.toBe(workflow);
      expect.soft(isolatedPinnedWorkflow(changed), `${name} ${run}`).toBe(false);
    }
  }
});

it('preserves r5 f6a59fae whole-step rejection across installer layouts', () => {
  const workflow = readFileSync(new URL('../../../.github/workflows/api-deploy.yml', import.meta.url), 'utf8');
  expect(isolatedPinnedWorkflow(workflow)).toBe(true);
  const layouts = [
    '{\n          run: npm ci,\n          env: { T: "TOKEN" } }',
    '{ name: x,\n          run: npm ci, env: { T: "TOKEN" } }',
    '{ env: { T: "TOKEN" },\n          run: npm ci }',
    '  run: npm ci\n          env:\n            T: "TOKEN"',
    '{ env: { run: harmless, T: "TOKEN" }, run: npm ci }',
  ];
  for (const name of ['deploy', 'delete']) {
    for (const layout of layouts) {
      const clean = workflow.replace(new RegExp(`(  ${name}:[\\s\\S]*?    steps:\\n)`), `$1      - ${layout}\n`);
      expect(clean).not.toBe(workflow);
      expect.soft(isolatedPinnedWorkflow(clean), `clean ${name} ${layout}`).toBe(true);
      const changed = clean.replace('"TOKEN"', '"${{ secrets.X }}"');
      // Exact f6a59fae whole-step install/secret predicate and step boundary.
      const baseRejects = changed.split(/^ {6}- /m).slice(1).some(step =>
        /run: npm (?:install|ci)\b/.test(step) && /\bsecrets\s*(?:\.|\[)/.test(step));
      expect(baseRejects, layout).toBe(true);
      const currentAccepts = isolatedPinnedWorkflow(changed);
      expect.soft(currentAccepts, `${name} ${layout}`).toBe(false);
      expect.soft(baseRejects && currentAccepts, `new rejection must contain base: ${name} ${layout}`).toBe(false);
    }
  }
});

it('rejects r4 secret-bearing flow-mapping installers', () => {
  const workflow = readFileSync(new URL('../../../.github/workflows/api-deploy.yml', import.meta.url), 'utf8');
  expect(isolatedPinnedWorkflow(workflow)).toBe(true);
  for (const name of ['deploy', 'delete']) {
    for (const run of ['run: npm ci', '"run" : "npm install"', "'run': 'npm i'"]) {
      for (const fields of [`${run}, env: { T: "TOKEN" }`, `env: { T: "TOKEN" }, ${run}`]) {
        const clean = workflow.replace(new RegExp(`(  ${name}:[\\s\\S]*?    steps:\\n)`), `$1      - { ${fields} }\n`);
        expect(clean).not.toBe(workflow);
        expect.soft(isolatedPinnedWorkflow(clean), `clean ${name} ${fields}`).toBe(true);
        expect.soft(isolatedPinnedWorkflow(clean.replace('"TOKEN"', '"${{ secrets.X }}"')), `${name} ${fields}`).toBe(false);
      }
    }
  }
});

it('rejects r3 punctuation anchors and equivalent install scalars', () => {
  const workflow = readFileSync(new URL('../../../.github/workflows/api-deploy.yml', import.meta.url), 'utf8');
  for (const name of ['.tok', ':tok', '?tok', '@tok', '\u96ea']) {
    const anchored = workflow.replace('apiToken: $', `apiToken: &${name} $`);
    expect.soft(isolatedPinnedWorkflow(anchored), `anchor ${name}`).toBe(false);
    expect.soft(isolatedPinnedWorkflow(anchored.replace('  delete:', `  delete:\n    env:\n      TOKEN: *${name}`)), `inherited ${name}`).toBe(false);
    expect.soft(isolatedPinnedWorkflow(workflow.replace('  delete:', `  delete:\n    env:\n      TOKEN: *${name}`)), `alias ${name}`).toBe(false);
  }
  for (const run of ['"npm ci"', "'npm i'", '>\n          npm\n          ci', 'NODE_ENV=production npm ci']) {
    const clean = workflow.replace(/run: npm install[^\n]*/, `run: ${run}`);
    expect.soft(isolatedPinnedWorkflow(clean), `clean ${run}`).toBe(true);
    for (const name of ['deploy', 'delete']) {
      const changed = workflow.replace(new RegExp(`(  ${name}:[\\s\\S]*?    steps:\\n)`),
        `$1      - run: ${run}\n        env:\n          TOKEN: \u0024{{ secrets.X }}\n`);
      expect(changed).not.toBe(workflow);
      expect.soft(isolatedPinnedWorkflow(changed), `${name} ${run}`).toBe(false);
    }
  }
});

it('rejects r2 spaced keys, echoed installs, anchors and aliases', () => {
  const workflow = readFileSync(new URL('../../../.github/workflows/api-deploy.yml', import.meta.url), 'utf8');
  for (const quote of ['', "'", '"']) {
    const key = (name: string) => `${quote}${name}${quote} :`;
    expect.soft(isolatedPinnedWorkflow(workflow.replace(/^(\s*(?:- )?)([\w-]+):/gm, `$1${quote}$2${quote} :`)), 'clean spaced keys').toBe(true);
    const extra = workflow.replace('  delete:', `  delete:\n    ${key('env')}\n      TOKEN: \u0024{{ secrets.X }}`);
    expect.soft(isolatedPinnedWorkflow(extra), 'spaced env before steps').toBe(false);
    expect.soft(isolatedPinnedWorkflow(`${workflow}\n    ${key('env')}\n      TOKEN: \u0024{{ secrets.X }}\n`), 'spaced env after steps').toBe(false);
  }
  const extra = workflow.replace(/( {2}delete:[\s\S]*? {4}steps:\n)/, '$1      - "run" : npm i\n        env:\n          TOKEN: ${{ secrets.X }}\n');
  expect.soft(isolatedPinnedWorkflow(extra), 'extra spaced run with safe installer retained').toBe(false);
  expect.soft(isolatedPinnedWorkflow(workflow.replaceAll('run: npm install', 'run: echo npm install')), 'echo is not install').toBe(false);
  const anchored = workflow.replace('apiToken: $', 'apiToken: &tok $');
  expect.soft(isolatedPinnedWorkflow(anchored), 'anchor alone').toBe(false);
  expect.soft(isolatedPinnedWorkflow(anchored.replace('  delete:', '  delete:\n    env:\n      TOKEN: *tok')), 'secret alias').toBe(false);
  expect.soft(isolatedPinnedWorkflow(workflow.replace('  delete:', '  delete:\n    env:\n      TOKEN: *tok')), 'alias alone').toBe(false);
});

it.each(["'", '"'])('checks equivalent %s-quoted workflow keys', quote => {
  const workflow = readFileSync(new URL('../../../.github/workflows/api-deploy.yml', import.meta.url), 'utf8');
  const quoted = (text: string) => text.replace(/^(\s*(?:- )?)([\w-]+):/gm, `$1${quote}$2${quote}:`);
  expect(isolatedPinnedWorkflow(quoted(workflow))).toBe(true);
  expect(isolatedPinnedWorkflow(workflow.replace('  build:', `  build:\n    ${quote}environment${quote}: api-production`))).toBe(false);
  const unpinned = workflow.replace(/(uses: actions\/checkout)@[a-f0-9]+/, '$1@v4');
  expect(unpinned).not.toBe(workflow);
  expect(isolatedPinnedWorkflow(quoted(unpinned))).toBe(false);
});

/** Read the active block for each job, excluding comments and normalizing line endings. */
function productionGuards(workflow: string): boolean {
  const source = normalizeKeys(workflow);
  return ['build', 'test', 'deploy', 'delete'].every(job => {
    const block = source.split(`\n  ${job}:`)[1]?.split(/\n {2}[a-z][\w-]*:/)[0] ?? '';
    const gate = job === 'delete' ? 'delete' : 'deploy';
    const condition = block.match(/^ {4}if: (.*)$/m)?.[1];
    if (job === 'test' && /^ {4}uses:/m.test(block)) {
      return !/^ {4}secrets:/m.test(block) && condition === `inputs.action == '${gate}' && github.ref == 'refs/heads/main'`;
    }
    const checkouts = block.split(/- uses: actions\/checkout@/).slice(1);
    return condition === `inputs.action == '${gate}' && github.ref == 'refs/heads/main'`
      && (job === 'build' || /^ {4}environment: api-production$/m.test(block))
      && checkouts.length > 0 && checkouts.every(checkout =>
        /^ {10}persist-credentials: false$/m.test(checkout.split(/\n {6}- /)[0]!));
  });
}

it('pins main-only build/test/deploy/delete, the production environment and credential-free checkouts in the actual workflow', () => {
  const workflow = readFileSync(new URL('../../../.github/workflows/api-deploy.yml', import.meta.url), 'utf8');
  expect(productionGuards(workflow)).toBe(true);
  const reusableDeploy = workflow.replace(/\n {2}deploy:[\s\S]*?(?=\n {2}delete:)/,
    "\n  deploy:\n    if: inputs.action == 'deploy' && github.ref == 'refs/heads/main'\n    uses: ./.github/workflows/test-suites.yml\n");
  expect(reusableDeploy).not.toBe(workflow);
  expect(productionGuards(reusableDeploy)).toBe(false);
  for (const key of ['secrets:', '"secrets":', "'secrets' :", 'secrets :']) {
    const changed = workflow.replace('  test:', `  test:\n    ${key} inherit`);
    expect(isolatedPinnedWorkflow(changed), key).toBe(false);
    expect(productionGuards(changed), key).toBe(false);
  }
  for (const token of [" && github.ref == 'refs/heads/main'", 'environment: api-production', 'persist-credentials: false']) {
    // Prove every occurrence is guarded without modifying the workflow file.
    let start = workflow.indexOf(token);
    while (start >= 0) {
      expect(productionGuards(workflow.slice(0, start) + workflow.slice(start + token.length)), token).toBe(false);
      start = workflow.indexOf(token, start + token.length);
    }
  }
});

it('requires checks of the checked-out SHA before uploading the Worker', () => {
  const workflow = readFileSync(new URL('../../../.github/workflows/api-deploy.yml', import.meta.url), 'utf8');
  const assertGate = (text: string) => {
    const source = normalizeKeys(text);
    const job = (name: string) => source.split(`\n  ${name}:`)[1]?.split(/\n {2}[a-z][\w-]*:/)[0] ?? '';
    const build = job('build');
    const upload = build.indexOf('uses: actions/upload-artifact@');
    expect(upload).toBeGreaterThan(0);
    for (const command of ['npm run typecheck', 'npm run lint -- --max-warnings 0']) {
      const check = build.indexOf(`- run: ${command}\n`);
      expect(check, command).toBeGreaterThan(0);
      expect(check, command).toBeLessThan(upload);
    }
    expect(build).not.toMatch(/- run: npm test\s*$/m);
    expect(build).not.toMatch(/continue-on-error|^ {8}if:|if:.*always\(/m);
    expect(job('test')).toMatch(/^ {4}uses: \.\/\.github\/workflows\/test-suites\.yml$/m);
    const test = job('test');
    expect(test).not.toMatch(/^ {4}secrets:/m);
    expect(test.match(/^ {4}permissions:\n((?: {6}[^\n]*\n)*)/m)?.[1]?.trim()).toBe('contents: read');
    expect(job('deploy')).toMatch(/^ {4}needs: \[build, test\]$/m);
  };
  assertGate(workflow);
  for (const [from, to] of [
    ['- run: npm run typecheck', '- run: echo skip typecheck'],
    ['- run: npm run lint -- --max-warnings 0', '- run: echo skip lint'],
    ['- run: npm ci', '- run: npm test'],
    ['uses: ./.github/workflows/test-suites.yml', 'uses: ./wrong.yml'],
    ['needs: [build, test]', 'needs: build'], ['needs: [build, test]', 'needs: test'],
    ['- run: npm ci', '- run: npm ci\n        continue-on-error: true'],
    ['- run: npm ci', "- run: npm ci\n        if: always()"],
    ['- run: npm run typecheck', '- run: npm run typecheck\n        if: false'],
    ['    uses: ./.github/workflows/test-suites.yml', '    uses: ./.github/workflows/test-suites.yml\n    secrets: inherit'],
    ...['"secrets":', "'secrets' :", 'secrets :'].map(key =>
      ['    uses: ./.github/workflows/test-suites.yml', `    uses: ./.github/workflows/test-suites.yml\n    ${key} inherit`]),
    ['uses: ./.github/workflows/test-suites.yml\n    permissions:\n      contents: read',
      'uses: ./.github/workflows/test-suites.yml\n    permissions:\n      contents: write'],
    ['uses: actions/upload-artifact@', 'uses: missing/upload@'],
  ]) {
    expect(workflow).toContain(from);
    expect(() => assertGate(workflow.replace(from!, to!)), from).toThrow();
  }
  for (const command of ['npm run typecheck', 'npm run lint -- --max-warnings 0']) {
    const late = workflow.replace(`      - run: ${command}`, '      # moved check')
      .replace('\n  test:', `\n      - run: ${command}\n\n  test:`);
    expect(() => assertGate(late), `late ${command}`).toThrow();
  }
});

it('pins the production CPU budget and its README disclosure', () => {
  const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  // Only the root limits table applies in production, not dev.limits or env.*.
  const limits = toml.split(/^\[limits\]\s*$/m)[1]?.split(/^\[/m)[0];
  expect(limits).toBeDefined();
  const cpuMs = Number(limits?.match(/^cpu_ms\s*=\s*(\d+)\s*$/m)?.[1]);
  expect(cpuMs).toBe(300_000);
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  expect(readme).toContain(`limits.cpu_ms = ${cpuMs}`);
  expect(readme).toContain(`(${cpuMs / 1000} s)`);
  for (const text of [toml, readme]) {
    expect(text).toMatch(/P999.*124/);
    expect(text).toMatch(/129\/129/);
    expect(text).toMatch(/0 kills/);
    expect(text).toContain('KERNEL_UNAVAILABLE');
  }
  expect(readme).toMatch(/headersTimeout.*300 s/);
  expect(readme).toMatch(/60.120 s.*proxy|prox.*60.120 s/);
  expect(readme).toMatch(/continues.*CPU|CPU.*continues/);
});

it('uses the deployed compatibility date in every Worker smoke test', () => {
  const source = readFileSync(new URL('./cancel.test.ts', import.meta.url), 'utf8');
  expect(source).not.toMatch(/compatibilityDate:\s*['"]/);
  expect(source).toContain('wrangler.toml');
});

it('counts the initial cross-runtime comparison as responses, flights and refusals', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  expect(readme).toMatch(/127 (?:compared )?responses[\s\S]*109 (?:HTTP 200 )?flight results[\s\S]*18 (?:HTTP 422 )?refusals/);
  expect(readme).not.toContain('127 designs were flown');
});

it('publishes only the custom hostname with the per-key production binding', () => {
  const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  const root = toml.split(/^\[/m)[0]!;
  expect(root).toMatch(/^workers_dev\s*=\s*false$/m);
  expect(root).toMatch(/^preview_urls\s*=\s*false$/m);
  expect(root).toContain('routes = [{ pattern = "api.mmrsim.mountainmanrockets.com", custom_domain = true }]');
  const rate = toml.split(/^\[\[ratelimits\]\]\s*$/m)[1]?.split(/^\[/m)[0];
  expect(rate).toMatch(/^name\s*=\s*"RATE_LIMITER"$/m);
  expect(rate).toMatch(/^namespace_id\s*=\s*"[^"]+"$/m);
  expect(rate).toMatch(/^simple\s*=\s*\{ limit = 20, period = 60 \}$/m);
});
