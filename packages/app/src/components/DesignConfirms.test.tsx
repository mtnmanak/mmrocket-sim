// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DesignConfirms } from './DesignConfirms.js';
import type { SaveOutcome } from '../services/saveFile.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

it.each(['pending', 'cancel', 'escape', 'discard', 'replace', 'unmount'])(
  'S3c-1 continues a deferred save only for the live prompt: %s', async action => {
    let resolve!: (outcome: SaveOutcome) => void;
    const save = new Promise<SaveOutcome>(done => { resolve = done; });
    const open = vi.fn(async () => {});
    const file = { name: 'next.ork' } as File;
    let replace!: () => void;
    function Harness() {
      const [pending, setPending] = useState<File | null>(file);
      replace = () => setPending({ name: 'replacement.ork' } as File);
      return <DesignConfirms tree={{ name: 'Current', components: [] }}
        lossDialog={null} setLossDialog={() => {}} saveLossy={() => {}}
        confirmNew={false} setConfirmNew={() => {}} replaceLoss={null} startNewDesign={() => {}}
        onSaveOrk={() => save} pendingOpen={pending} setPendingOpen={setPending} onOpenOrk={open}
        shareOffer={null} setShareOffer={() => {}} applyImported={async () => {}}
        shroudPrompt={null} setShroudPrompt={() => {}} hasOpenMotorQuestion={false} onConvertShrouds={() => {}} />;
    }
    const click = (text: string) => act(() => {
      [...host.querySelectorAll('button')].find(b => b.textContent?.includes(text))!.click();
    });
    act(() => root.render(<Harness />));
    click('Save .ork, then open');
    if (action === 'cancel') click('Cancel');
    if (action === 'escape') act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    if (action === 'discard') click('Open without saving');
    if (action === 'replace') act(replace);
    if (action === 'unmount') act(() => root.render(null));
    await act(async () => { resolve({ kind: 'saved', name: 'current.ork' }); await save; });
    expect(open).toHaveBeenCalledTimes(action === 'pending' || action === 'discard' ? 1 : 0);
    if (action === 'pending' || action === 'discard') expect(open).toHaveBeenCalledWith(file);
  });
