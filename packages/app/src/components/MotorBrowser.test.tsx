// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { MotorBrowser } from './MotorBrowser.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';

/**
 * The motor database's sortable column headers.
 *
 * They carried `role="button"` alongside `aria-sort`. `aria-sort` is defined
 * only on a columnheader, so the role override made the attribute on that very
 * element inert — a screen reader said "Impulse (Ns), button" and never "sorted
 * descending", and got no feedback at all when the sort changed. Worse, with
 * all six headers no longer columnheaders the 400 data rows below lost their
 * column association, so arrowing through them stopped announcing which column
 * a cell was in.
 *
 * The fix keeps the tab stop and the Enter/Space handler and drops only the
 * role — the rule clickable.ts already states for the rest of the app.
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('MotorBrowser — sortable headers stay column headers', () => {
  let host: HTMLDivElement;
  let root: Root;

  const headers = () => Array.from(host.querySelectorAll('thead th'));
  const impulse = () => headers()
    .find((th) => (th.textContent ?? '').includes('Impulse'))!;

  beforeEach(() => {
    localStorage.clear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(
      <PrefsProvider>
        <MotorBrowser mountDiameterMm={24} maxMotorLengthM={null}
          onSelect={() => {}} onClose={() => {}} />
      </PrefsProvider>,
    ));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    localStorage.clear();
  });

  it('sets no role, so the implicit columnheader survives', () => {
    expect(headers().length).toBe(6);
    for (const th of headers()) expect(th.getAttribute('role')).toBe(null);
  });

  it('keeps the tab stop that made sorting reachable in the first place', () => {
    for (const th of headers()) expect(th.getAttribute('tabindex')).toBe('0');
  });

  it('still sorts on Enter, and aria-sort now means something', () => {
    // Default sort is by impulse; activating its header flips the direction.
    const before = impulse().getAttribute('aria-sort');
    expect(before).not.toBeNull();
    act(() => {
      impulse().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(impulse().getAttribute('aria-sort')).not.toBe(before);
  });

  it('marks exactly one column as sorted', () => {
    expect(headers().filter((th) => th.hasAttribute('aria-sort')).length).toBe(1);
  });
});

// ---------------------------------------------------------------- harness
//
// Audit 2026-09-22 (row 478): the four tests above were the whole of this
// file's coverage — nothing drove a pick, a load, an import or the catalogue
// check. The blocks below do, through the real component and the real shipped
// catalogue, the way a user does: search, click a row, press Load.

const FILTERS_KEY = 'online-openrocket.motor-filters.v1';

interface Harness {
  host: HTMLDivElement;
  root: Root;
  selected: { label: string; ejectionDelay: number }[];
}

function openBrowser(props: { mountDiameterMm: number; filters?: Record<string, unknown> }): Harness {
  if (props.filters) localStorage.setItem(FILTERS_KEY, JSON.stringify(props.filters));
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const selected: Harness['selected'] = [];
  act(() => root.render(
    <PrefsProvider>
      <MotorBrowser mountDiameterMm={props.mountDiameterMm} maxMotorLengthM={null}
        onSelect={(label, spec) => selected.push({ label, ejectionDelay: spec.ejectionDelay })}
        onClose={() => {}} />
    </PrefsProvider>,
  ));
  return { host, root, selected };
}

function closeBrowser(h: Harness): void {
  act(() => h.root.unmount());
  h.host.remove();
  localStorage.clear();
}

/** Native setter + input event — how React sees a real keystroke. */
function typeInto(el: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const search = (h: Harness, text: string) =>
  typeInto(h.host.querySelector<HTMLInputElement>('input[type="search"]')!, text);
const bodyRows = (h: Harness) => Array.from(h.host.querySelectorAll<HTMLTableRowElement>('tbody tr'));
const rowFor = (h: Harness, mfr: string, designation: string) => bodyRows(h).find((tr) =>
  tr.cells[1]?.textContent === mfr && (tr.cells[0]?.textContent ?? '').replace(/OOP$/, '').trim() === designation);
const delaySelect = (h: Harness) => h.host.querySelector<HTMLSelectElement>('.motor-load-row select');
const click = (el: Element) => act(() => { (el as HTMLElement).click(); });
/** Lets pending promises (a lazy JSON chunk, a file read) settle inside act. */
const settle = async (ms = 0) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };
const loadButton = (h: Harness) => Array.from(h.host.querySelectorAll('button'))
  .find((b) => /Load motor|Loading/.test(b.textContent ?? ''));

/** Drops files onto the "Import .eng/.rse" input, the way the picker hands them over. */
async function importFiles(h: Harness, files: { name: string; text: string }[]): Promise<void> {
  const input = h.host.querySelector<HTMLInputElement>('input[type="file"][accept=".eng,.rse,.txt"]')!;
  const list = files.map((f) => new File([f.text], f.name));
  Object.defineProperty(input, 'files', { value: list, configurable: true });
  act(() => { input.dispatchEvent(new Event('change', { bubbles: true })); });
  for (let i = 0; i < 20; i++) await settle(5);
}

/**
 * `vi.spyOn(localStorage, 'setItem')`, and `unspy` to take it off. Since
 * vitest 3.2 a spy on an INHERITED method is restored by deleting the
 * instance's property, and happy-dom's Storage proxy refuses that delete (its
 * deleteProperty trap removes stored items only), so `vi.restoreAllMocks()`
 * left the throwing setItem on localStorage for the rest of this file (AUDIT
 * row 528, vitest 2 -> 5). `unspy` puts happy-dom's own bound copy back
 * through the proxy's defineProperty trap, the way the spy went on; it also
 * runs when the test ends, so a failing test cannot leave it behind.
 */
function spyOnSetItem() {
  const own = localStorage.setItem;
  const unspy = () => {
    Object.defineProperty(localStorage, 'setItem', {
      ...Object.getOwnPropertyDescriptor(Object.getPrototypeOf(localStorage), 'setItem'), value: own,
    });
  };
  onTestFinished(unspy);
  return { spy: vi.spyOn(window.localStorage, 'setItem'), unspy };
}

const ENG_K550 = `; AeroTech K550W
K550W 54 410 0-6-10 0.919744 1.48736 AT
   0.065 604.264
   1.86 682.197
   3.38 449.371
   3.4 0.0
`;

describe('MotorBrowser — the delay a fresh pick starts at (audit 2026-09-22)', () => {
  let h: Harness;
  afterEach(() => closeBrowser(h));

  it('a motor that lists no usable delay starts on Auto, not on a made-up 0 s', () => {
    // KBA G135R's catalogue delay field is "M" — nothing a number can be read from.
    h = openBrowser({ mountDiameterMm: 29, filters: { includeOOP: true } });
    search(h, 'G135');
    click(rowFor(h, 'KBA', 'G135R')!);
    expect(delaySelect(h)!.value).toBe('auto');
  });

  it('an ordinary motor still starts on its longest prescribed delay', () => {
    h = openBrowser({ mountDiameterMm: 18 });
    search(h, 'C6');
    click(rowFor(h, 'Estes', 'C6')!);
    expect(delaySelect(h)!.value).toBe('7');
  });
});

describe('MotorBrowser — a motor refused on its catalogue weight but not its file (audit 2026-09-22)', () => {
  let h: Harness;
  afterEach(() => closeBrowser(h));

  it('Estes 1/2A6 — no catalogue weight, good bundled file — is pickable and loads', async () => {
    h = openBrowser({ mountDiameterMm: 18 });
    search(h, '1/2A6');
    // The bundle chunk behind fileMassed is 840 kB of JSON; wait for it.
    for (let i = 0; i < 100 && rowFor(h, 'Estes', '1/2A6')!.hasAttribute('aria-disabled'); i++) await settle(50);
    const row = rowFor(h, 'Estes', '1/2A6')!;
    expect(row.getAttribute('aria-disabled')).toBeNull();
    click(row);
    click(loadButton(h)!);
    for (let i = 0; i < 20 && h.selected.length === 0; i++) await settle(10);
    expect(h.selected.map((s) => s.label)).toEqual(['1/2A6-2']);
  });

  it('a motor with no weight anywhere stays locked', async () => {
    // KBA K1000S carries no catalogue weight and has no bundled file at all.
    h = openBrowser({ mountDiameterMm: 54, filters: { includeOOP: true } });
    search(h, 'K1000S');
    await settle(500);
    const row = rowFor(h, 'KBA', 'K1000S');
    expect(row, 'KBA K1000S has left the catalogue').toBeTruthy();
    expect(row!.getAttribute('aria-disabled')).toBe('true');
  });
});

describe('MotorBrowser — importing EX motors (audit 2026-09-22)', () => {
  let h: Harness;
  afterEach(() => { vi.restoreAllMocks(); closeBrowser(h); });

  it('imports, says the motors survive reloads, and lists them under EX', async () => {
    h = openBrowser({ mountDiameterMm: 54 });
    await importFiles(h, [{ name: 'k550.eng', text: ENG_K550 }]);
    expect(h.host.textContent).toMatch(/Imported 1 EX motor \(K550W\).*survive reloads/);
    expect(rowFor(h, 'EX', 'K550W')).toBeTruthy();
  });

  it('on a full storage says the motors are NOT saved — and they still load this session', async () => {
    h = openBrowser({ mountDiameterMm: 54 });
    const real = Storage.prototype.setItem;
    const { spy, unspy } = spyOnSetItem();
    spy.mockImplementation(function (this: Storage, k: string, v: string) {
      if (k === 'online-openrocket.ex-motors.v1') throw new DOMException('full', 'QuotaExceededError');
      return real.call(this, k, v);
    });
    await importFiles(h, [{ name: 'k550.eng', text: ENG_K550 }]);
    const text = h.host.textContent ?? '';
    expect(text).toMatch(/NOT saved/);
    expect(text).not.toMatch(/survive reloads/);
    click(rowFor(h, 'EX', 'K550W')!);
    click(loadButton(h)!);
    for (let i = 0; i < 20 && h.selected.length === 0; i++) await settle(10);
    expect(h.selected.map((s) => s.label)).toEqual(['K550W-10']);
    // Leave no session-only library behind for the next test.
    vi.restoreAllMocks();
    unspy();
    const { deleteExMotor } = await import('../services/exMotors.js');
    deleteExMotor('none');
  });
});

describe('MotorBrowser — what an import says about the motors it took (audit 2026-09-22)', () => {
  let h: Harness;
  afterEach(() => closeBrowser(h));

  it('names a refused .rse nozzle exit in the import notice', async () => {
    h = openBrowser({ mountDiameterMm: 29 });
    await importFiles(h, [{ name: 'inches.rse', text: `<engine-database><engine-list>
      <engine mfg="Home" code="H99X" dia="29." len="200." initWt="300." propWt="150." delays="6" exitDia="0.5">
        <data><eng-data t="0" f="0"/><eng-data t="0.5" f="120"/><eng-data t="1.5" f="0"/></data>
      </engine></engine-list></engine-database>` }]);
    expect(h.host.textContent).toMatch(/Imported 1 EX motor \(H99X\)/);
    expect(h.host.textContent).toMatch(/inches\.rse: H99X: its nozzle exit, exitDia 0\.5 .*was not used/);
  });

  it('names twins kept side by side, motors skipped for impossible masses, and replacements', async () => {
    h = openBrowser({ mountDiameterMm: 54 });
    const twin = (delay: string) => `K475WW 54 403 ${delay} 0.7286 1.4925 AMW\n0.05 600\n1.5 500\n1.6 0\n`;
    const heavy = 'K700RT 54 400 P 0.90135 0.17535 AMW\n0.05 700\n1.2 0\n';
    await importFiles(h, [{ name: 'rasp.eng', text: `${twin('0')}${twin('100')}${heavy}` }]);
    const text = h.host.textContent ?? '';
    expect(text).toMatch(/Imported 2 EX motors/);
    expect(text).toMatch(/K475WW: listed more than once with different data/);
    expect(text).toMatch(/rasp\.eng: skipped 1 motor with impossible masses — K700RT: more propellant/);
    await importFiles(h, [{ name: 'rasp.eng', text: twin('0') }]);
    expect(h.host.textContent).toMatch(/1 replaced the library's earlier motor of the same maker and name \(K475WW\)/);
  });
});


describe('MotorBrowser — the "Check thrustcurve.org" button (audit 2026-09-22)', () => {
  let h: Harness;
  afterEach(async () => {
    vi.unstubAllGlobals();
    closeBrowser(h);
    const { discardCatalogueOverlay } = await import('../services/catalogueOverlay.js');
    discardCatalogueOverlay();
  });

  /** A thrustcurve.org stand-in: metadata, then one search page per maker, from `live`. */
  const stubThrustcurve = async (live: (m: { manufacturerAbbrev: string }) => boolean) => {
    const { MOTOR_DB } = await import('../services/motorDb.js');
    const rows = MOTOR_DB.filter(live);
    const makers = [...new Set(rows.map((m) => m.manufacturerAbbrev))];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = new URL(url);
      const body = u.pathname.endsWith('/metadata.json')
        ? { manufacturers: makers.map((abbrev) => ({ abbrev })), impulseClasses: [] }
        : { results: rows.filter((m) => m.manufacturerAbbrev === u.searchParams.get('manufacturer')) };
      return { ok: true, status: 200, json: async () => body } as unknown as Response;
    }));
  };
  const checkButton = (h: Harness) => h.host.querySelector<HTMLButtonElement>('button[aria-label="Check thrustcurve.org for newer motors"]')!;

  it('reports the diff in a status region, and names a maker that came back empty', async () => {
    await stubThrustcurve((m) => m.manufacturerAbbrev !== 'Klima');
    h = openBrowser({ mountDiameterMm: 29 });
    click(checkButton(h));
    for (let i = 0; i < 50 && !h.host.querySelector('.file-note[role="status"]'); i++) await settle(10);
    const note = h.host.querySelector('.file-note[role="status"]')!;
    expect(note.textContent).toMatch(/0 new, 0 changed, 0 no longer listed/);
    expect(note.textContent).toMatch(/returned no motors at all for Klima/);
  });

  it('reports a failed check as an alert and installs nothing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response));
    h = openBrowser({ mountDiameterMm: 29 });
    click(checkButton(h));
    for (let i = 0; i < 50 && !/Could not check/.test(h.host.textContent ?? ''); i++) await settle(10);
    expect(h.host.querySelector('[role="alert"]')!.textContent).toMatch(/Could not check thrustcurve\.org: .*HTTP 503/);
    const { getCatalogueOverlay } = await import('../services/motorDb.js');
    expect(getCatalogueOverlay()).toBeNull();
  });
});

describe('MotorBrowser — filters that persist where they cannot be seen (audit 2026-09-22)', () => {
  let h: Harness;
  afterEach(() => closeBrowser(h));

  const allFilters = (h: Harness) => Array.from(h.host.querySelectorAll('button'))
    .find((b) => /All filters/.test(b.textContent ?? ''))!;
  const stored = () => JSON.parse(localStorage.getItem(FILTERS_KEY)!) as Record<string, unknown>;

  it('counts a folded propellant chip and window on the "All filters" button, and clears them', () => {
    h = openBrowser({ mountDiameterMm: 29, filters: { propellants: ['Blue Thunder'], burnMax: 1, showAll: false } });
    const narrowed = bodyRows(h).length;
    expect(allFilters(h).textContent).toMatch(/All filters · 2 hidden/);
    const clear = h.host.querySelector<HTMLButtonElement>('button[aria-label="Clear the 2 hidden filters"]')!;
    click(clear);
    expect(allFilters(h).textContent).not.toMatch(/hidden/);
    expect(bodyRows(h).length).toBeGreaterThan(narrowed);
    expect(stored()['propellants']).toEqual([]);
    expect(stored()['burnMax']).toBeNull();
  });

  it('shows no count while the row is open — the chips are on screen then', () => {
    h = openBrowser({ mountDiameterMm: 29, filters: { propellants: ['Blue Thunder'], showAll: true } });
    expect(allFilters(h).textContent).not.toMatch(/hidden/);
  });

  it('does not apply a maker chip this mount does not offer', () => {
    // Loki makes nothing that fits 18 mm, so its chip is not drawn here — and
    // must not filter the table down to "No motors match".
    h = openBrowser({ mountDiameterMm: 18, filters: { manufacturers: ['Loki'], impulse: ['M'] } });
    expect(h.host.textContent).not.toMatch(/No motors match/);
    expect(bodyRows(h).length).toBeGreaterThan(20);
    expect(stored()['manufacturers']).toEqual(['Loki']); // kept for a mount that offers it
  });

  it('an import clears every filter that would hide the motor it just added', async () => {
    h = openBrowser({ mountDiameterMm: 54, filters: {
      manufacturers: ['AeroTech'], impulse: ['H'], propellants: ['Blue Thunder'], impulseMax: 100, showAll: false,
    } });
    await importFiles(h, [{ name: 'k550.eng', text: ENG_K550 }]);
    expect(rowFor(h, 'EX', 'K550W')).toBeTruthy();
    expect(stored()).toMatchObject({ manufacturers: [], impulse: [], propellants: [], impulseMax: null });
  });
});

describe('MotorBrowser — the import buttons are keyboard-reachable (audit 2026-09-22)', () => {
  let h: Harness;
  afterEach(() => closeBrowser(h));

  it('keeps both file inputs in the Tab order, each with a name', () => {
    // Importing an .eng/.rse is the ONLY way to fly an EX motor; display:none
    // put both inputs out of reach of the keyboard.
    h = openBrowser({ mountDiameterMm: 29 });
    const inputs = Array.from(h.host.querySelectorAll<HTMLInputElement>('input[type="file"]'));
    expect(inputs).toHaveLength(2);
    for (const input of inputs) {
      expect(input.style.display).not.toBe('none');
      expect(input.classList.contains('file-btn-input')).toBe(true);
      expect(input.tabIndex).not.toBe(-1);
      expect(input.getAttribute('aria-label')).toMatch(/Import/);
    }
  });
});

describe('MotorBrowser — filter chips say whether they are on (audit 2026-09-22)', () => {
  let h: Harness;
  afterEach(() => closeBrowser(h));

  const chip = (h: Harness, group: string, label: RegExp) =>
    Array.from(h.host.querySelectorAll<HTMLButtonElement>(`[role="group"][aria-label="${group}"] button`))
      .find((b) => label.test(b.textContent ?? ''))!;

  it('every chip is a toggle with aria-pressed, and an on chip carries a ✓ as well as its colour', () => {
    h = openBrowser({ mountDiameterMm: 29, filters: { impulse: ['G'] } });
    for (const g of ['Manufacturers', 'Diameter classes', 'Impulse classes']) {
      const chips = Array.from(h.host.querySelectorAll(`[role="group"][aria-label="${g}"] button.series-chip`));
      expect(chips.length, g).toBeGreaterThan(0);
      for (const c of chips) expect(['true', 'false']).toContain(c.getAttribute('aria-pressed'));
    }
    // The persisted G reads as pressed, with its ✓; H does not.
    expect(chip(h, 'Impulse classes', /^✓ G/).getAttribute('aria-pressed')).toBe('true');
    const hChip = chip(h, 'Impulse classes', /^H /);
    expect(hChip.getAttribute('aria-pressed')).toBe('false');
    click(hChip);
    expect(chip(h, 'Impulse classes', /H /).getAttribute('aria-pressed')).toBe('true');
    expect(chip(h, 'Impulse classes', /H /).textContent).toMatch(/^✓ H/);
    // The ✓ is for the eye only; the reader hears "pressed".
    expect(chip(h, 'Impulse classes', /H /).querySelector('[aria-hidden="true"]')!.textContent).toBe('✓ ');
  });
});

describe('MotorBrowser — load and import results reach a screen reader (audit 2026-09-22)', () => {
  let h: Harness;
  afterEach(() => { vi.unstubAllGlobals(); closeBrowser(h); });

  it('has its status and alert regions in place before any message', () => {
    // A live region inserted with its text already in it is announced unreliably.
    h = openBrowser({ mountDiameterMm: 54 });
    const regions = h.host.querySelectorAll('.motor-browser > [role="status"], .motor-browser > [role="alert"]');
    expect(Array.from(regions).map((r) => [r.getAttribute('role'), r.textContent])).toEqual([['status', ''], ['alert', '']]);
  });

  it('a Load that fails offline lands in the alert region', async () => {
    // Estes G80 has catalogue masses but no bundled curve, so it needs the network.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    h = openBrowser({ mountDiameterMm: 29, filters: { includeOOP: true } });
    search(h, 'G80');
    click(rowFor(h, 'Estes', 'G80')!);
    click(loadButton(h)!);
    for (let i = 0; i < 50 && !(h.host.querySelector('.motor-browser > [role="alert"]')!.textContent); i++) await settle(10);
    expect(h.host.querySelector('.motor-browser > [role="alert"]')!.textContent).toMatch(/Failed to fetch/);
    expect(h.selected).toEqual([]);
  });

  it('an import result lands in the status region', async () => {
    h = openBrowser({ mountDiameterMm: 54 });
    await importFiles(h, [{ name: 'k550.eng', text: ENG_K550 }]);
    expect(h.host.querySelector('.motor-browser > [role="status"]')!.textContent).toMatch(/Imported 1 EX motor/);
  });
});

describe('MotorBrowser — the table is ONE tab stop, walked with the arrows (audit 2026-09-22)', () => {
  let h: Harness;
  afterEach(() => closeBrowser(h));

  const key = (el: Element, k: string) => act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  });
  const stops = (h: Harness) => bodyRows(h).filter((tr) => tr.tabIndex === 0);

  it('makes exactly one row tabbable, where every row used to be', () => {
    // 29 mm offers hundreds of rows; each was a Tab press before Load.
    h = openBrowser({ mountDiameterMm: 29 });
    expect(bodyRows(h).length).toBeGreaterThan(100);
    expect(stops(h)).toEqual([bodyRows(h)[0]]);
    expect(bodyRows(h).slice(1).every((tr) => tr.tabIndex === -1)).toBe(true);
  });

  it('moves focus — and the tab stop — with ArrowDown/Up, Home and End, without picking', () => {
    h = openBrowser({ mountDiameterMm: 29 });
    const rows = bodyRows(h);
    act(() => rows[0]!.focus());
    key(rows[0]!, 'ArrowDown');
    expect(document.activeElement).toBe(bodyRows(h)[1]);
    expect(stops(h)).toEqual([bodyRows(h)[1]]);
    key(bodyRows(h)[1]!, 'End');
    expect(document.activeElement).toBe(bodyRows(h).at(-1));
    key(bodyRows(h).at(-1)!, 'ArrowDown'); // stays at the end
    expect(document.activeElement).toBe(bodyRows(h).at(-1));
    key(bodyRows(h).at(-1)!, 'Home');
    expect(document.activeElement).toBe(bodyRows(h)[0]);
    key(bodyRows(h)[0]!, 'ArrowUp'); // stays at the top
    expect(document.activeElement).toBe(bodyRows(h)[0]);
    expect(h.host.querySelector('.motor-row-picked')).toBeNull(); // passing over is not picking
  });

  it('still picks on Enter, and the picked row keeps the tab stop', () => {
    h = openBrowser({ mountDiameterMm: 18 });
    search(h, 'C6');
    const row = rowFor(h, 'Estes', 'C6')!;
    key(row, 'Enter');
    expect(h.host.querySelector('.motor-load-row')!.textContent).toMatch(/Estes C6/);
    expect(stops(h)).toEqual([rowFor(h, 'Estes', 'C6')]);
  });
});

describe('MotorBrowser — two earlier fixes with no test until now (audit 2026-09-22)', () => {
  let h: Harness;
  afterEach(() => { vi.unstubAllGlobals(); if (h.host.isConnected) closeBrowser(h); });

  it('a Load still downloading when the dialog closes never loads the motor', async () => {
    // Estes G80 has no bundled curve, so its load waits on the network. The
    // answer arrives AFTER the dialog is gone, and ignores the abort — the case
    // the post-fetch `signal.aborted` check exists for.
    let answered = false;
    const spy = vi.fn(() => new Promise((resolve) => setTimeout(() => {
      answered = true;
      resolve({
        ok: true, status: 200,
        json: async () => ({ results: [{ format: 'RASP', samples: [{ time: 0.1, thrust: 80 }, { time: 1.5, thrust: 0 }] }] }),
      } as unknown as Response);
    }, 30)));
    vi.stubGlobal('fetch', spy);
    h = openBrowser({ mountDiameterMm: 29, filters: { includeOOP: true } });
    search(h, 'G80');
    click(rowFor(h, 'Estes', 'G80')!);
    click(loadButton(h)!);
    closeBrowser(h);
    // Wait out the whole download (the bundle lookup comes first), then some.
    for (let i = 0; i < 300 && !answered; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(answered).toBe(true);
    expect(h.selected).toEqual([]);
  });

  it('a negative or partial window bound is not persisted as a bound no motor meets (windowBound)', () => {
    h = openBrowser({ mountDiameterMm: 29, filters: { showAll: true } });
    const before = bodyRows(h).length;
    typeInto(h.host.querySelector<HTMLInputElement>('input[aria-label="Longest burn time, seconds"]')!, '-5');
    typeInto(h.host.querySelector<HTMLInputElement>('input[aria-label="Smallest total impulse, newton-seconds"]')!, '1e');
    const stored = JSON.parse(localStorage.getItem(FILTERS_KEY)!) as Record<string, unknown>;
    expect(stored['burnMax']).toBeNull();
    expect(stored['impulseMin']).toBeNull();
    expect(bodyRows(h).length).toBe(before);
    expect(h.host.textContent).not.toMatch(/No motors match/);
  });
});
