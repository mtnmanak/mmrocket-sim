// @vitest-environment happy-dom
import { act, StrictMode, useEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RocketTree } from '@online-openrocket/engine';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { downloadImage } from '../services/schematicExport.js';
import { Rocket3D } from './Rocket3D.js';

/**
 * The 3D view's image export, MOUNTED (audit 2026-09-22). The R3F canvas cannot
 * run here, so `Canvas` is replaced by a stand-in that renders the wrapper div
 * the real one renders (react-three-fiber 8.18's CanvasImpl spreads its HTML
 * props onto that div) and hands `onCreated` a recording renderer. Everything
 * between the menu pick and the download is the real code.
 *
 *  • The export restored the renderer only AFTER awaiting the encode, so the live
 *    view rendered at up to 8K (~33 Mpx a frame) for the seconds the encode
 *    takes — although snapshotWithHeader had already copied the pixels.
 *  • That restore sat behind a "still mounted?" flag whose effect never re-armed
 *    it, so under StrictMode (`npm run dev`) the flag was false from the first
 *    commit and every export left the view at export size.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Everything the export does to the renderer, in order. */
let log: string[] = [];
/** The recording renderer `onCreated` receives — one per test. */
let r3fState: unknown = null;
const fakeRenderer = () => {
  const canvas = { clientWidth: 800, clientHeight: 400, width: 1600, height: 800 };
  let ratio = 2;
  return {
    scene: {},
    camera: { isPerspectiveCamera: false },
    gl: {
      domElement: canvas,
      getPixelRatio: () => ratio,
      setPixelRatio: (r: number) => { ratio = r; log.push(`ratio ${r}`); },
      setSize: (w: number, h: number) => {
        canvas.width = w * ratio;
        canvas.height = h * ratio;
        log.push(`size ${w}x${h}`);
      },
      render: () => { log.push('render'); },
    },
  };
};

vi.mock('@react-three/fiber', async (importOriginal) => {
  const real = await importOriginal<typeof import('@react-three/fiber')>();
  const Canvas = ({ onCreated, children: _c, camera: _cam, gl: _gl, ...html }: {
    onCreated?: (s: unknown) => void; children?: ReactNode; camera?: unknown; gl?: unknown;
  } & Record<string, unknown>) => {
    useEffect(() => { onCreated?.(r3fState); }, [onCreated]);
    return <div data-r3f="" {...html} />;
  };
  return { ...real, Canvas };
});

let pick: (() => Promise<void>) | null = null;
vi.mock('./ImageExportMenu.js', () => ({
  ImageExportMenu: ({ onPick }: { onPick: (f: string, w: number, o: { fit: boolean }) => unknown }) => {
    pick = () => onPick('png', 7680, { fit: false }) as Promise<void>;
    return null;
  },
}));

let finishEncode: (b: Blob) => void = () => {};
vi.mock('../services/schematicExport.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/schematicExport.js')>();
  return {
    ...real,
    // What the real one does synchronously is COPY the frame (drawImage) —
    // logged here as the moment the pixels are safe — then encode, which is
    // the slow part the test holds open.
    snapshotWithHeader: vi.fn((c: { width: number; height: number }) => {
      log.push(`copy ${c.width}x${c.height}`);
      return new Promise<Blob>((res) => { finishEncode = res; });
    }),
    downloadImage: vi.fn(),
  };
});

const TREE = {
  name: 'Rocket',
  components: [{
    id: 's1', type: 'stage',
    children: [
      { id: 'n1', type: 'nosecone', shape: 'ogive', length: 0.1, aftRadius: 0.012 },
      { id: 'b1', type: 'bodytube', length: 0.3, outerRadius: 0.012 },
    ],
  }],
} as unknown as RocketTree;

const EXPORT = { name: 'Test rocket' } as never;

let host: HTMLDivElement;
let root: Root;
const mount = (strict: boolean) => {
  const view = (
    <PrefsProvider><Rocket3D tree={TREE} info={null} exportData={EXPORT} /></PrefsProvider>
  );
  act(() => root.render(strict ? <StrictMode>{view}</StrictMode> : view));
};

beforeEach(() => {
  log = [];
  pick = null;
  r3fState = fakeRenderer();
  localStorage.clear();
  vi.mocked(downloadImage).mockClear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

/** Starts an 8K export and returns it, the encode still running. */
const startExport = () => {
  let done!: Promise<void>;
  act(() => { done = pick!(); });
  return done;
};

describe('the 3D image export', () => {
  it('puts the renderer back BEFORE the encode, not after it', async () => {
    mount(false);
    const done = startExport();
    // 7680 x 3840 at ratio 1, copied, and already back to 800 x 400 at ratio 2
    // while the encode is still running.
    expect(log).toEqual([
      'ratio 1', 'size 7680x3840', 'render', 'copy 7680x3840',
      'ratio 2', 'size 800x400', 'render',
    ]);
    await act(async () => { finishEncode(new Blob(['x'])); await done; });
    // Nothing more touches the renderer once the pixels are out.
    expect(log).toHaveLength(7);
    expect(downloadImage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(downloadImage).mock.calls[0]![1]).toBe('Test_rocket-3d.png');
  });

  it('restores the renderer under StrictMode too (npm run dev)', async () => {
    mount(true);
    const done = startExport();
    await act(async () => { finishEncode(new Blob(['x'])); await done; });
    expect(log.slice(-3)).toEqual(['ratio 2', 'size 800x400', 'render']);
    expect(downloadImage).toHaveBeenCalledTimes(1);
  });

  it('touches no renderer after the view is gone mid-encode', async () => {
    mount(false);
    const done = startExport();
    const before = log.length;
    act(() => root.unmount());
    await act(async () => { finishEncode(new Blob(['x'])); await done; });
    expect(log).toHaveLength(before);
    root = createRoot(host); // afterEach unmounts again
  });
});
