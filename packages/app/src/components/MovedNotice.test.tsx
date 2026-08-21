// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MovedNotice } from './MovedNotice.js';

/**
 * There is no @testing-library in this workspace and adding a dependency was
 * out of scope (see SiteBand.test.tsx), so this renders through react-dom's
 * own root API with React's `act` and reads the DOM directly.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('MovedNotice', () => {
  it('renders the move alert with the new address on the retired host', () => {
    act(() => root.render(<MovedNotice hostname="openrocket.mountainmanrockets.com" />));
    const alert = host.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain('mmrsim.mountainmanrockets.com');
    expect(alert!.textContent!.toLowerCase()).toContain('export');
  });

  it('renders nothing on the canonical host', () => {
    act(() => root.render(<MovedNotice hostname="mmrsim.mountainmanrockets.com" />));
    expect(host.firstChild).toBeNull();
  });
});
