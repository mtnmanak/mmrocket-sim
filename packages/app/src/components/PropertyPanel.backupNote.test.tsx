// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { PropertyPanel } from './PropertyPanel.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { CUSTOM_PRESETS_BACKED_UP } from '../services/presets.js';

vi.mock('./SaveMyPartDialog.js', () => ({ SaveMyPartDialog: ({ onSaved }: { onSaved: (name: string, note?: string) => void }) =>
  <button onClick={() => onSaved('My parts Test', CUSTOM_PRESETS_BACKED_UP)}>Finish save</button> }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('shows the saved My part recovery note as a Caution', () => {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const node = { id: 'tube', type: 'bodytube' as const, length: 0.2, outerRadius: 0.02 };
  try {
    act(() => root.render(<PrefsProvider><PropertyPanel node={node} tree={{ name: 'Test', components: [node] }} onPatch={() => {}} /></PrefsProvider>));
    const click = (text: string) => act(() => [...host.querySelectorAll('button')].find(b => b.textContent?.includes(text))!.click());
    click('Save as My part'); click('Finish save');
    expect([...host.querySelectorAll('[role="status"] .message-caution')].some(note => note.textContent?.includes(CUSTOM_PRESETS_BACKED_UP))).toBe(true);
  } finally { act(() => root.unmount()); host.remove(); }
});
