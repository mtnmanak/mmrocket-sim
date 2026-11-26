// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DesignConfirms } from './DesignConfirms.js';
import { Modal } from './Modal.js';
import type { SaveOutcome } from '../services/saveFile.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

it.each(['New', 'Open', 'link', 'Examples', 'Recent', 'Scale', 'bundle', 'unlisted dialog'].flatMap(door => ['motor', 'shroud', 'replacement'].map(kind => ({ door, kind }))))(
  'AS2 defers a late $kind question until the $door confirmation closes', ({ door, kind }) => {
    const chooser = !['New', 'Open', 'link'].includes(door);
    const show = (confirming: boolean, completed: boolean) => <>
      {confirming && chooser && <Modal label={door} onClose={() => {}}><button>Close chooser</button></Modal>}
      <DesignConfirms tree={{ name: 'Current', components: [] }}
      preservedAutosave={completed && kind === 'replacement' ? { unreadable: true, action: 'opens Next.ork', downloadError: null,
        onDownload: () => {}, onContinue: () => {}, onCancel: () => {} } : null}
      lossDialog={null} setLossDialog={() => {}} saveLossy={() => {}}
      confirmNew={confirming && door === 'New'} setConfirmNew={() => {}} replaceLoss={null} startNewDesign={() => {}}
      onSaveOrk={async () => ({ kind: 'cancelled' })}
      pendingOpen={confirming && door === 'Open' ? new File([], 'Next.ork') : null}
      setPendingOpen={() => {}} onOpenOrk={async () => {}}
      shareOffer={confirming && door === 'link' ? { name: 'Linked', tree: { components: [] }, motors: {}, notes: [] } : null}
      setShareOffer={() => {}} applyImported={async () => {}}
      shroudPrompt={completed && kind === 'shroud' ? [{ id: 'shroud', name: 'Camera shroud' }] : null}
      setShroudPrompt={() => {}} hasOpenMotorQuestion={completed && kind === 'motor'} onConvertShrouds={() => {}}>
      {completed && kind === 'motor' && <Modal label="Choose motors for this file" onClose={() => {}}><button>Keep motors</button></Modal>}
    </DesignConfirms></>;
    act(() => root.render(show(true, false)));
    const visible = host.querySelector('[role="dialog"]')!;
    const focused = document.activeElement;
    act(() => root.render(show(true, true)));
    expect(host.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(host.querySelector('[role="dialog"]')).toBe(visible);
    expect(document.activeElement).toBe(focused);
    act(() => root.render(show(false, true)));
    expect(host.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(host.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe(kind === 'motor'
      ? 'Choose motors for this file' : kind === 'shroud' ? 'Convert camera shrouds' : 'Replace the autosaved design');
    expect(host.querySelector('[role="dialog"]')?.contains(document.activeElement)).toBe(true);
  });

it.each(['motor', 'shroud'])('AS2 keeps an existing %s question ahead of a late link offer', kind => {
  const show = (existing: boolean, linked: boolean) => <DesignConfirms tree={{ name: 'Current', components: [] }}
    lossDialog={null} setLossDialog={() => {}} saveLossy={() => {}}
    confirmNew={false} setConfirmNew={() => {}} replaceLoss={null} startNewDesign={() => {}}
    onSaveOrk={async () => ({ kind: 'cancelled' })} pendingOpen={null}
    setPendingOpen={() => {}} onOpenOrk={async () => {}}
    shareOffer={linked ? { name: 'Linked', tree: { components: [] }, motors: {}, notes: [] } : null}
    setShareOffer={() => {}} applyImported={async () => {}}
    shroudPrompt={existing && kind === 'shroud' ? [{ id: 'shroud', name: 'Camera shroud' }] : null}
    setShroudPrompt={() => {}} hasOpenMotorQuestion={existing && kind === 'motor'} onConvertShrouds={() => {}}>
    {existing && kind === 'motor' && <Modal label="Choose motors for this file" onClose={() => {}}><button>Keep motors</button></Modal>}
  </DesignConfirms>;
  act(() => root.render(show(true, false)));
  const visible = host.querySelector('[role="dialog"]')!;
  const focused = document.activeElement;
  act(() => root.render(show(true, true)));
  expect(host.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  expect(host.querySelector('[role="dialog"]')).toBe(visible);
  expect(document.activeElement).toBe(focused);
  act(() => root.render(show(false, true)));
  expect(host.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  expect(host.querySelector('[aria-label="Open design from link"]')?.contains(document.activeElement)).toBe(true);
});

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
