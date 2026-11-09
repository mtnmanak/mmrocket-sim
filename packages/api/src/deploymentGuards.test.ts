import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

function isolatedPinnedWorkflow(text: string): boolean {
  const source = text.replace(/\r\n/g, '\n').replace(/^\s*#[^\n]*/gm, '');
  const uses = [...source.matchAll(/\buses:\s*(\S+)/g)].map(match => match[1]!);
  if (!uses.length || !uses.every(action => action.startsWith('./') || /^[\w-]+\/[\w-]+@[a-f0-9]{40}$/.test(action))) return false;
  const secretReference = /\bsecrets\s*(?:\.|\[)/;
  // Workflow/job keys are unordered. Bound each value by the next peer key.
  const properties = (block: string, indent = 4) => {
    const keys = [...block.matchAll(new RegExp(`^ {${indent}}([\\w-]+):`, 'gm'))];
    return keys.map((key, i) => ({ name: key[1], text: block.slice(key.index, keys[i + 1]?.index) }));
  };
  const root = properties(source, 0);
  const jobs = properties(root.find(field => field.name === 'jobs')?.text ?? '', 2);
  const job = (name: string) => jobs.find(field => field.name === name)?.text ?? '';
  if (['build', 'deploy', 'delete'].some(name => !/^ {4}runs-on: ubuntu-24\.04(?:\s*#.*)?$/m.test(job(name)))) return false;
  if (secretReference.test(job('build')) || /^ {4}environment:/m.test(job('build'))) return false;
  // Job/global env could expose secrets to npm before step-level checks apply.
  for (const name of ['deploy', 'delete']) {
    const fields = properties(job(name));
    if (fields.some(field => field.name !== 'steps' && secretReference.test(field.text))) return false;
    const steps = (fields.find(field => field.name === 'steps')?.text ?? '').split(/^ {6}- /m).slice(1);
    if (!steps.some(step => /run: npm install\b/.test(step))) return false;
    if (steps.some(step => /run: npm (?:install|ci)\b/.test(step) && secretReference.test(step))) return false;
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

/** Read the active block for each job, excluding comments and normalizing line endings. */
function productionGuards(workflow: string): boolean {
  const source = workflow.replace(/\r\n/g, '\n').replace(/^\s*#[^\n]*/gm, '');
  return ['build', 'test', 'deploy', 'delete'].every(job => {
    const block = source.split(`\n  ${job}:`)[1]?.split(/\n {2}[a-z][\w-]*:/)[0] ?? '';
    const gate = job === 'delete' ? 'delete' : 'deploy';
    const condition = block.match(/^ {4}if: (.*)$/m)?.[1];
    if (job === 'test' && /^ {4}uses:/m.test(block)) {
      return condition === `inputs.action == '${gate}' && github.ref == 'refs/heads/main'`;
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
    const source = text.replace(/\r\n/g, '\n').replace(/^\s*#[^\n]*/gm, '');
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
