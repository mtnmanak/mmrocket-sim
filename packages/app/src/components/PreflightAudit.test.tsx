// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { findNode } from '../tree/treeModel.js';
import { preflightAudit } from '../services/preflightAudit.js';
import { PreflightAudit } from './PreflightAudit.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('PreflightAudit part navigation', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  it.each([
    [{ type: 'bodytube', id: 'bad', name: 'Light tube', overrideMass: 0.001 }, {}, 'bad', 'caution'],
    [{ type: 'bodytube', id: 'bad', name: 'Material tube', density: 10000, materialName: 'Balsa' }, {}, 'bad', 'caution'],
    [{ type: 'bodytube', id: 'bad', children: [{ type: 'parachute', id: 'never', name: 'Main', deployEvent: 'never' }] }, {}, 'never', 'danger'],
    [{ type: 'bodytube', id: 'bad' }, { overrideMass: 2, overrideSubcomponentsMass: true }, 'stage', 'caution'],
    [{ type: 'bodytube', id: 'bad', overrideMass: 0.1, overrideSubcomponentsMass: true,
      children: [{ type: 'masscomponent', id: 'child', name: 'Payload', overrideMass: 0.01 }] }, {}, 'child', 'information'],
    [{ type: 'bodytube', id: 'bad', overrideMass: 0.1,
      children: [{ type: 'masscomponent', id: 'child', name: 'Payload', overrideMass: 0.01 }] }, {}, 'bad', 'information'],
  ])('selects the part named by each check without editing the design', (body, stage, expectedId, tier) => {
    const tree: RocketTree = { components: [{ type: 'stage', id: 'stage', name: 'Airframe', ...stage,
      children: [body as ComponentNode, { type: 'bodytube', id: 'bay', children: [
        { type: 'streamer', id: 'streamer', deployEvent: 'apogee' },
      ] }] }] };
    const before = structuredClone(tree);
    let selected: ComponentNode | null = null;
    const select = vi.fn((id: string) => { selected = findNode(tree, id); });
    const result = preflightAudit(tree, { bad: 0.1 });
    act(() => root.render(<PreflightAudit result={result} onSelectPart={select} />));
    const button = host.querySelector<HTMLButtonElement>('button')!;
    expect(button.type).toBe('button');
    expect(button.disabled).toBe(false);
    button.focus(); expect(document.activeElement).toBe(button);
    act(() => button.click());
    expect(select).toHaveBeenCalledExactlyOnceWith(expectedId);
    expect(selected).toBe(findNode(tree, expectedId));
    expect(tree).toEqual(before);
    if (tier !== 'information') {
      expect(host.querySelector(`.message-${tier}`)?.textContent).toContain(tier === 'danger' ? 'Danger:' : 'Caution:');
    }
    expect(host.textContent).toContain('Advice only');
    expect(host.textContent).toContain('does not block Launch');
  });

  it('selects the stage for a design with no recovery', () => {
    const select = vi.fn();
    const result = preflightAudit({ components: [{ type: 'stage', id: 's', name: 'Airframe' }] }, {});
    act(() => root.render(<PreflightAudit result={result} onSelectPart={select} />));
    act(() => host.querySelector<HTMLButtonElement>('button')!.click());
    expect(select).toHaveBeenCalledExactlyOnceWith('s');
    expect(host.textContent).toContain('Danger:');
  });

  it('links an existing warning and gives an honest empty/unknown state', () => {
    const tree: RocketTree = { components: [{ type: 'stage', id: 's' }] };
    act(() => root.render(<PreflightAudit result={preflightAudit(tree, {}, ['[Warning.NO_RECOVERY_DEVICE]'])} onSelectPart={vi.fn()} />));
    expect(host.querySelector('a')?.getAttribute('href')).toBe('#design-notes');
    expect(host.querySelector('.message-danger')).toBeNull();
    const unknown: RocketTree = { components: [{ type: 'bodytube', id: 'b', name: 'Tube', density: 1000,
      overrideMass: 2, children: [{ type: 'parachute', id: 'p' }] }] };
    act(() => root.render(<PreflightAudit result={preflightAudit(unknown, {})} onSelectPart={vi.fn()} />));
    expect(host.textContent).toContain('No findings from these checks');
    expect(host.textContent).toContain('Computed mass unavailable');
    expect(host.textContent).toContain('1 material density');
    expect(host.textContent).not.toMatch(/safe to fly|passed|certif/i);
  });
});
