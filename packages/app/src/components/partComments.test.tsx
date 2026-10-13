// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { PropertyPanel } from './PropertyPanel.js';
import { ComponentTree } from './ComponentTree.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import type { RocketTree } from '@online-openrocket/engine';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it('edits and clears multiline comments and gives the tree a text marker with an accessible name', async () => {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const tree: RocketTree = { components: [{ type: 'stage', id: 's', name: 'Stage', comment: 'Measured\nagain' }] };
  const onPatch = vi.fn();
  try {
    await act(async () => root.render(<PrefsProvider><PropertyPanel node={tree.components[0]!} tree={tree} onPatch={onPatch} /></PrefsProvider>));
    const textarea = host.querySelector<HTMLTextAreaElement>('[aria-label="Part comment"]')!;
    expect(textarea.value).toBe('Measured\nagain');
    expect(host.querySelector(`label[for="${textarea.id}"]`)?.textContent).toBe('Comment');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Unicode 钛\n<&>');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(onPatch).toHaveBeenLastCalledWith({ comment: 'Unicode 钛\n<&>' });
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(onPatch).toHaveBeenLastCalledWith({ comment: undefined });
    const noop = () => {};
    await act(async () => root.render(<ComponentTree tree={tree} selectedId="s" clipboard={null} onSelect={noop}
      onMove={noop} onDelete={noop} onDuplicate={noop} onAdd={noop} onAddStage={noop} onCopy={noop} onCut={noop} onPaste={noop} />));
    const badge = [...host.querySelectorAll('.tree-badge')].find(e => e.textContent === 'note')!;
    expect(badge).toBeDefined();
    expect(badge.closest('[role="treeitem"]')?.getAttribute('aria-labelledby')).toContain(badge.id);
  } finally { await act(async () => root.unmount()); host.remove(); }
});
