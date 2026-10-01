// @vitest-environment happy-dom
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { WeatherCredit } from './WeatherCredit.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it.each([false, true])('credits Open-Meteo under CC BY 4.0, and GeoNames for a searched place (geoNames: %s)', (geoNames) => {
  const host = document.createElement('div'); const root = createRoot(host);
  try {
    act(() => root.render(<p><WeatherCredit geoNames={geoNames} /></p>));
    const external = ['_blank', 'noopener noreferrer'];
    expect([...host.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href'), a.target, a.rel])).toEqual([
      ['Weather data by Open-Meteo.com', 'https://open-meteo.com/', ...external],
      ['CC BY 4.0', 'https://creativecommons.org/licenses/by/4.0/', ...external],
      ...(geoNames ? [['GeoNames', 'https://www.geonames.org/', ...external]] : []),
    ]);
    expect(host.textContent).toBe(`Weather data by Open-Meteo.com · CC BY 4.0${geoNames ? ' · Place search: GeoNames' : ''}`);
  } finally { act(() => root.unmount()); }
});

/**
 * The credit is written ONCE (audit 2026-09-30). Four hand-copied credit lines
 * had drifted apart, and the winds-aloft details' copy had lost GeoNames. A
 * module that renders WEATHER_CREDIT itself is a fifth copy.
 */
it('is the only module that renders the credit', () => {
  const src = join(dirname(fileURLToPath(import.meta.url)), '..');
  const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
  const users = files(src).filter((f) => /\bWEATHER_CREDIT\b/.test(readFileSync(f, 'utf8')))
    .map((f) => relative(src, f).replace(/\\/g, '/')).sort();
  expect(users).toEqual(['components/WeatherCredit.tsx', 'services/weatherSnapshot.ts']);
});
