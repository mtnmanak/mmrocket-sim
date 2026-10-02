// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { checkFileLongitude } from '../services/longitudeCheck.js';
import { LaunchPanel, DEFAULT_CONDITIONS, type LaunchConditions } from './LaunchPanel.js';
import type { LongitudeReview } from './LongitudeCheck.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const evidence = checkFileLongitude({ latitudeDeg: 26.380273, longitudeDeg: 80.126879 }, [
  { latitudeDeg: 28.1, longitudeDeg: -80.63 },
])!;
let host: HTMLDivElement;
let root: Root;
let value: LaunchConditions = { ...DEFAULT_CONDITIONS, ...evidence.opened };
let review: LongitudeReview | null;
function render() {
  act(() => root.render(<PrefsProvider><LaunchPanel value={value} onChange={(v) => { value = v; }}
    longitudeReview={review} onLongitudeReview={(r) => { review = r; }} onLaunch={() => {}}
    simulating={false} canLaunch={false} /></PrefsProvider>));
}
function click(text: string) {
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent === text);
  expect(button).toBeTruthy();
  act(() => button!.click());
  render();
}
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  value = { ...DEFAULT_CONDITIONS, ...evidence.opened };
  review = { evidence, applied: false };
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('Launch panel file longitude row', () => {
  it('makes no write on render and does not ask again after Keep and re-render', () => {
    render();
    expect(host.textContent).toContain('Longitude 80.126879° E — this file’s other simulations put the site 80.63° W.');
    expect(value.longitudeDeg).toBe(80.126879);
    click('Keep east');
    render();
    expect(host.textContent).not.toContain('Use -80.126879');
    expect(value.longitudeDeg).toBe(80.126879);
    value = { ...value, windAverage: 12 };
    render();
    expect(host.textContent).not.toContain('Keep east');
  });

  it('changes exactly one sign at full precision and puts it back', () => {
    render();
    const original = { ...value };
    click('Use -80.126879');
    expect(value).toEqual({ ...original, longitudeDeg: -80.126879 });
    expect(host.textContent).toContain('Set to -80.126879 (the file said +80.126879)');
    click('Put it back');
    expect(value).toEqual(original);
    expect(host.textContent).toContain('Keep east');
  });

  it('hides the offer or receipt when Longitude no longer holds the value it describes', () => {
    render();
    value = { ...value, longitudeDeg: 79 };
    render();
    expect(host.textContent).not.toContain('Keep east');
    value = { ...value, longitudeDeg: 80.126879 };
    render();
    click('Use -80.126879');
    value = { ...value, longitudeDeg: -79 };
    render();
    expect(host.textContent).not.toContain('Put it back');
  });

  it('clears the receipt on a new open and permits a new file to supply fresh evidence', () => {
    render();
    click('Use -80.126879');
    review = null;
    render();
    expect(host.textContent).not.toContain('Put it back');
    value = { ...value, ...evidence.opened };
    review = { evidence, applied: false };
    render();
    expect(host.textContent).toContain('Use -80.126879');
  });
});
