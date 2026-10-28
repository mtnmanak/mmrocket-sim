// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { useAfterMount } from './useAfterMount.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * hooks/useAfterMount.ts: a region gated on it mounts empty, and its message
 * arrives in a commit of its own (owner ruling, row 113 (b)).
 */
describe('useAfterMount', () => {
  it('is false on the first render and true from the next commit on', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const seen: boolean[] = [];
    function Probe({ n }: { n: number }) {
      const afterMount = useAfterMount();
      seen.push(afterMount);
      return <div role="alert">{afterMount && <p>Message {n}</p>}</div>;
    }
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((list) => { records.push(...list); });
    observer.observe(host, { childList: true, subtree: true });
    act(() => root.render(<Probe n={1} />));
    records.push(...observer.takeRecords());
    expect(seen).toEqual([false, true]);
    // The region went in empty; the message went into it afterwards.
    const region = host.querySelector('[role="alert"]')!;
    const message = region.querySelector('p')!;
    expect(records.some((r) => r.target === host && [...r.addedNodes].includes(region))).toBe(true);
    expect(records.some((r) => r.target === region && [...r.addedNodes].includes(message))).toBe(true);
    // Later renders stay true.
    act(() => root.render(<Probe n={2} />));
    expect(seen).toEqual([false, true, true]);
    expect(host.querySelector('[role="alert"]')).toBe(region);
    observer.disconnect();
    act(() => root.unmount());
    host.remove();
  });
});
