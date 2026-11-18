import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { FlightSeries } from '@online-openrocket/engine';
import { LIGHT_PALETTE } from './chartTheme.js';
import { STABILITY_DIAGNOSTIC_KEYS, STABILITY_DIAGNOSTIC_PANELS, seriesCatalog, usableSeries, withStabilityDiagnostics, withStabilityPercent } from './flightChartModel.js';
import { IMPERIAL_UNITS } from './prefs/units.js';
import { exportColumnCatalog } from './services/flightDataCsv.js';
import { stabilityTerms } from './tree/glossaryTerms.js';

const expectedKeys = ['ωn', 'Ccm', 'Cn', 'CNα', 'Cθ', 'Cζθ', 'dθ'] as const;

describe('N052 diagnostic display gates', () => {
  it.each(['RECOVERY_DEVICE_DEPLOYMENT', 'TUMBLE'])('gates guide → flight → %s without changing the recording', type => {
    const source = {
      time: [0, 1, 2, 3, 4, 5, 6],
      Cn: [null, null, 0.1, 0.2, 0.3, 99, 99],
      'ωn': [0, 0, 8, null, 0, 99, 99],
      'CNα': [null, null, 3, 2, 1, 99, 99],
      Ccm: [0, 0, 0.8, -0.2, 0, 99, 99],
      'Cθ': [null, null, -0.1, 0.2, 0, 99, 99],
      'Cζθ': [null, null, 0.01, -0.02, 0, 99, 99],
      'dθ': [0, 0, 0.2, -0.3, 0, 99, 99],
      cpLocation: [null, null, 1, 0.5, 0.8, 0, 0],
      stability: [null, null, 1, -1, 0, -8, -8],
      cgLocation: [0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8],
      activeLength: Array(7).fill(2),
    } as unknown as FlightSeries;
    const original = structuredClone(source);
    const events = [{ type, time: 5 }, { type: 'TUMBLE', time: 6 }];
    const displayed = withStabilityDiagnostics(withStabilityPercent(source, events), events);
    expect(displayed['ωn']).toEqual([null, null, 8, null, 0, null, null]);
    expect(displayed['CNα']).toEqual([null, null, 3, 2, 1, null, null]);
    expect(displayed.Ccm).toEqual([null, null, 0.8, -0.2, 0, null, null]);
    for (const key of expectedKeys) {
      expect(displayed[key]!.slice(0, 2)).toEqual([null, null]);
      expect(displayed[key]!.slice(2, 5)).toEqual(source[key]!.slice(2, 5));
      expect(displayed[key]!.slice(5)).toEqual([null, null]);
    }
    expect(displayed.stabilityPercent!.slice(5)).toEqual([null, null]);
    expect(displayed.stability).toEqual([null, null, 1, -1, 0, null, null]);
    expect(displayed.cpLocation).toEqual([null, null, 1, 0.5, 0.8, null, null]);
    expect(displayed.cgLocation).toBe(source.cgLocation);
    expect(source).toEqual(original);
  });

  it('keeps summary-only recordings absent and rejects unpaired or nonfinite samples', () => {
    const summary = { time: [0, 1], altitude: [0, 1] } as FlightSeries;
    const displayed = withStabilityDiagnostics(summary);
    for (const key of expectedKeys) {
      expect(displayed[key]).toBeUndefined();
      expect(usableSeries(displayed, [key])).toBe(false);
    }
    const full = { time: [0, NaN, 2, 3], Cn: [0, 0, Infinity, 0], 'ωn': [Infinity, 1, 2, 3] } as unknown as FlightSeries;
    expect(withStabilityDiagnostics(full)['ωn']).toEqual([null, null, null, 3]);
  });

  it('matches the export titles and fixed units under imperial preferences', () => {
    const catalog = seriesCatalog({ units: IMPERIAL_UNITS }, LIGHT_PALETTE);
    for (const key of expectedKeys) {
      const def = catalog.find(d => d.key === key)!;
      const column = exportColumnCatalog().find(c => c.key === key)!;
      expect(def.title).toBe(key === 'CNα' ? `${column.name} (CNα)` : column.name);
      expect(def.unit).toBe(column.si);
      expect(def.quantity).toBeUndefined();
    }
    expect(catalog.find(d => d.key === 'ωn')!.unit).toBe('rad/s');
    expect(catalog.find(d => d.key === 'dθ')!.unit).toBe('rad/s');
    for (const [key, title, unit] of [
      ['CNα', 'Normal force slope (CNα)', '/rad'],
      ['Ccm', 'Corrective moment coefficient', 'N·m/rad'],
    ]) {
      const def = catalog.find(d => d.key === key)!;
      expect(def.title).toBe(title);
      expect(def.unit).toBe(unit);
      expect(def.f).toBeUndefined();
      expect(def.toSI).toBeUndefined();
    }
    expect(STABILITY_DIAGNOSTIC_PANELS).toEqual(['stability', 'ωn', 'rollPitchRatio', 'Ccm', 'aoa', 'dθ', 'Cn', 'CNα', 'Cθ', 'Cζθ']);
    expect(STABILITY_DIAGNOSTIC_KEYS).toEqual(expectedKeys);
  });

  it('links each explanation to an existing guide glossary definition', () => {
    const guide = readFileSync(new URL('../user-guide.md', import.meta.url), 'utf8');
    const titles = [...guide.matchAll(/^\*\*([^*]+)\*\* —/gm)].map(m => m[1]!);
    const slugs = titles.map(t => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
    for (const term of Object.values(stabilityTerms)) expect(slugs).toContain(term);
    expect(guide).toContain('### Stability diagnostics');
  });

  it('qualifies corrective stiffness in the guide subsection, glossary and symbols table', () => {
    const guide = readFileSync(new URL('../user-guide.md', import.meta.url), 'utf8');
    const entries = [
      guide.split('**Corrective moment coefficient (Ccm)** is ')[1]!.split('\n\n')[0]!,
      guide.split('**Corrective moment coefficient (Ccm)** — ')[1]!.split('\n\n')[0]!,
      guide.split('| `Ccm` | ')[1]!.split('\n')[0]!,
    ];
    for (const text of entries) {
      expect(text).toContain('signed corrective stiffness');
      expect(text).toContain('the restoring moment per radian of angle of attack at small angles');
      expect(text).toContain('At large angles of attack it is a stiffness estimate, not the moment the rocket actually feels');
      expect(text).toContain('dynamic pressure × reference area × CNα × (CP − CG distance)');
      expect(text).toMatch(/ωn² (equals Ccm divided by the pitch moment of inertia|= Ccm \/ Il)/);
    }
  });

  it('distinguishes the flight slope conditions from the zero-angle static sweep everywhere', () => {
    const guide = readFileSync(new URL('../user-guide.md', import.meta.url), 'utf8');
    const entries = [
      guide.split('**Normal force slope (CNα)** describes ')[1]!.split('\n\n')[0]!,
      guide.split('**CNα (normal-force slope)** — ')[1]!.split('\n\n')[0]!,
      guide.split('| `Cn`, `CNα` | ')[1]!.split('\n')[0]!,
    ];
    for (const text of entries) {
      expect(text).toContain("each instant's Mach, angle of attack and roll orientation");
      expect(text).toContain('zero-angle value against Mach in its roll plane');
    }
    expect(guide).not.toContain('the same quantity for the design without a flight');
  });

  it('documents the raw diagnostic guide and descent sentinels separately from the charts', () => {
    const guide = readFileSync(new URL('../user-guide.md', import.meta.url), 'utf8');
    const slope = guide.split('**CNα (normal-force slope)** — ')[1]!.split('\n\n')[0]!;
    const moment = guide.split('**Corrective moment coefficient (Ccm)** — ')[1]!.split('\n\n')[0]!;
    const frequency = guide.split('**Pitch natural frequency (ωn)** — ')[1]!.split('\n\n')[0]!;
    const slopeRow = guide.split('| `Cn`, `CNα` | ')[1]!.split('\n')[0]!;
    const momentRow = guide.split('| `Ccm` | ')[1]!.split('\n')[0]!;
    const frequencyRow = guide.split('| `ωn` | ')[1]!.split('\n')[0]!;
    for (const text of [slope, slopeRow]) {
      expect(text).toContain('raw downloads carry CNα = 0 after deployment or tumble');
      expect(text).toContain('blank on the launch guide');
    }
    for (const text of [moment, momentRow, frequency, frequencyRow]) {
      expect(text).toContain('raw downloads leave Ccm and ωn blank after deployment or tumble');
      expect(text).toContain('launch-guide zero');
    }
    expect(guide).toContain('After deployment or tumble, raw downloads carry CNα = 0 and leave Ccm and ωn blank');
    expect(guide).not.toContain('raw CNα and Ccm can retain descent-model artefacts');
    expect(guide).not.toContain('subsequent recordings');
  });

  it('documents the nose-tip damping cap and uses desktop OR in added copy', () => {
    const guide = readFileSync(new URL('../user-guide.md', import.meta.url), 'utf8');
    const diagnostics = guide.split('### Stability diagnostics')[1]!.split('**Saved plots**')[0]!;
    const damping = guide.split('**Pitch damping coefficient** —')[1]!.split('\n\n')[0]!;
    for (const text of [diagnostics, damping]) {
      expect(text).toContain('aerodynamic pitch moment about the nose tip');
      expect(text).toContain("desktop OR 24.12's model");
      expect(text).not.toContain('OpenRocket');
    }
    const margin = guide.split('**Stability margin / static margin** —')[1]!.split('\n\n')[0]!;
    expect(margin).toContain('blank after deployment or tumble');
  });
});
