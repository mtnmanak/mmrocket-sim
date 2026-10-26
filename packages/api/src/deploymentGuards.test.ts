import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('requires checks of the checked-out SHA before uploading the Worker', () => {
  const workflow = readFileSync(new URL('../../../.github/workflows/api-deploy.yml', import.meta.url), 'utf8');
  const build = workflow.slice(workflow.indexOf('\n  build:'), workflow.indexOf('\n  deploy:'));
  const upload = build.indexOf('uses: actions/upload-artifact@');
  for (const command of ['npm run typecheck', 'npm run lint -- --max-warnings 0', 'npm test']) {
    const check = build.indexOf(`- run: ${command}\n`);
    expect(check, command).toBeGreaterThan(0);
    expect(check, command).toBeLessThan(upload);
  }
  expect(build).not.toMatch(/continue-on-error|if:.*always\(/);
  expect(workflow.slice(workflow.indexOf('\n  deploy:'))).toMatch(/needs: build/);
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
});

it('counts the initial cross-runtime comparison as responses, flights and refusals', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  expect(readme).toMatch(/127 (?:compared )?responses[\s\S]*109 (?:HTTP 200 )?flight results[\s\S]*18 (?:HTTP 422 )?refusals/);
  expect(readme).not.toContain('127 designs were flown');
});
