// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { RocketTree } from '@online-openrocket/engine';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { DEFAULT_CONDITIONS } from './LaunchPanel.js';
import { FlyScreen } from './FlyScreen.js';

/**
 * The Fly screen's nose-up drawing is a picture, and must not cost a keyboard
 * user a tab stop per part (audit 2026-09-22). It passed TreeSchematic a no-op
 * `onSelect`, which is all the schematic needs to make every drawn part a
 * focusable "Select …" button — inside an svg that is role="img", so a screen
 * reader never heard them, while Tab stepped through each one before reaching
 * the flight numbers: 7 on this nose + tube + 3-fin + inner tube + parachute
 * rocket. (FlyScreen.test.tsx holds the screen's own content.)
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TREE = {
  name: 'Field Bird',
  components: [{
    id: 's1', type: 'stage',
    children: [
      { id: 'n1', type: 'nosecone', shape: 'ogive', length: 0.1, aftRadius: 0.012 },
      {
        id: 'b1', type: 'bodytube', length: 0.3, outerRadius: 0.012,
        children: [
          { id: 'f1', type: 'trapezoidfinset', finCount: 3, rootChord: 0.05, tipChord: 0.03, sweep: 0.02, height: 0.03 },
          { id: 'mt', type: 'innertube', length: 0.07, outerRadius: 0.009, position: { method: 'bottom', offset: 0 } },
          { id: 'pc', type: 'parachute', packedLength: 0.03, packedRadius: 0.008, position: { method: 'top', offset: 0.02 } },
        ],
      },
    ],
  }],
} as unknown as RocketTree;

describe('FlyScreen — the drawing', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    localStorage.clear();
  });

  it('is an image with no tab stops inside it', () => {
    act(() => root.render(
      <PrefsProvider>
        <FlyScreen tree={TREE} info={null} run={null} motorLabel={null}
          launch={DEFAULT_CONDITIONS} onLaunchChange={() => {}} onLaunch={() => {}}
          simulating={false} canLaunch={false} onChangeMotor={() => {}}
          onCompare={() => {}} canCompare={false} />
      </PrefsProvider>,
    ));
    const svg = host.querySelector('.fly-view svg')!;
    expect(svg.getAttribute('role')).toBe('img');
    // The parts ARE drawn — the test would pass vacuously on an empty picture.
    expect(svg.querySelectorAll('polygon').length).toBeGreaterThanOrEqual(3);
    expect(svg.querySelectorAll('[tabindex]')).toHaveLength(0);
    expect(svg.querySelectorAll('[role="button"]')).toHaveLength(0);
  });
});
