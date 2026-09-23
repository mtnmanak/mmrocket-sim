// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PanelBoundary } from './PanelBoundary.js';

/**
 * One panel's boundary (audit 2026-09-22): a throw in the report, the plots,
 * the drag chart or the run table stays in that panel.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let explode: boolean;

const Chart = ({ label }: { label: string }) => {
  if (explode) throw new Error(`no series for ${label}`);
  return <p>{label} drawn</p>;
};

const view = (key: unknown) => (
  <div>
    <PanelBoundary what="The flight plots" resetKey={key}><Chart label="run A" /></PanelBoundary>
    <p>the run table</p>
  </div>
);

beforeEach(() => {
  explode = false;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('PanelBoundary', () => {
  it('a throw is contained to its panel, which says what failed and why', () => {
    explode = true;
    act(() => root.render(view(1)));
    expect(host.querySelector('[role="alert"]')!.textContent)
      .toContain('The flight plots could not be drawn.');
    expect(host.textContent).toContain('no series for run A');
    expect(host.textContent).toContain('the run table');
  });

  it('tries again when the data it draws changes', () => {
    explode = true;
    act(() => root.render(view(1)));
    explode = false;
    act(() => root.render(view(1)));
    expect(host.textContent).toContain('could not be drawn'); // same data: still the fallback
    act(() => root.render(view(2)));
    expect(host.textContent).toContain('run A drawn');
  });

  it('and on "Try again"', () => {
    explode = true;
    act(() => root.render(view(1)));
    explode = false;
    act(() => {
      [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Try again'))!.click();
    });
    expect(host.textContent).toContain('run A drawn');
  });
});
