// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { useFlightHandleHold } from './useFlightHandleHold.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it('S2-g9 keeps an explicit shared-handle ref and reflects flight readiness', () => {
  const host = document.createElement('div'), root = createRoot(host);
  let hold!: ReturnType<typeof useFlightHandleHold>;
  function Probe({ busy }: { busy: boolean }) { hold = useFlightHandleHold(busy); return null; }
  try {
    act(() => root.render(<Probe busy={false} />));
    const first = hold;
    hold.current = true;
    act(() => root.render(<Probe busy={true} />));
    expect(hold).toBe(first); expect(hold.current).toBe(true);
    act(() => root.render(<Probe busy={false} />));
    expect(hold.current).toBe(false);
  } finally { act(() => root.unmount()); }
});
