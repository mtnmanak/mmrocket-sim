import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * A boundary round the 3D tab, and nothing else.
 *
 * WHAT IT CATCHES. three's WebGLRenderer constructor throws "Error creating
 * WebGL context." when the browser will not hand out a context — hardware
 * acceleration off, a blocklisted driver, some remote-desktop sessions.
 * react-three-fiber builds that renderer inside `<Canvas>`'s layout effect, so
 * the throw lands in the commit phase, where React walks up to the nearest
 * boundary. Until this file the app had exactly ONE boundary, round the site
 * nav band — and with none above here React unmounts the whole tree: clicking
 * 3D on such a machine took the rocket designer down with it. The same
 * boundary also covers a lazy chunk that fails to download (the `<Suspense>`
 * inside only covers the download SUCCEEDING) and any throw out of the scene
 * graph, which R3F's own inner boundary deliberately re-throws.
 *
 * WHAT IT DOES NOT CATCH, and must not be described as if it does: a WebGL
 * CONTEXT LOSS after the view is already up. three registers its own
 * `webglcontextlost` handler and calls `preventDefault()` — nothing is thrown,
 * so no boundary can fire, and the canvas holds its last frame until the
 * context comes back.
 *
 * It re-arms itself. `.hero-view` renders the 2D schematic, this, or the aft
 * view in the same child slot, so leaving the 3D tab changes the element TYPE
 * there and React unmounts this instance; coming back mounts a fresh one.
 * That is why there is no reset key — one would be dead code.
 */
export class View3DBoundary extends Component<
  { children: ReactNode; onBack: () => void },
  { failed: boolean; detail: string }
> {
  override state = { failed: false, detail: '' };

  static getDerivedStateFromError(err: unknown) {
    return { failed: true, detail: err instanceof Error ? err.message : String(err) };
  }

  override componentDidCatch(err: Error, info: ErrorInfo) {
    // Logged, not swallowed the way the nav band's is: this is a panel the
    // user asked for, and the message is the first thing a bug report needs.
    console.error('3D view failed to start:', err, info.componentStack);
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="hero-fallback" role="status">
        <p>
          <strong>The 3D view could not start.</strong> This browser would not give the app a 3D
          drawing surface. That is usually hardware acceleration switched off, a graphics driver
          the browser has blocked, or a remote-desktop session.
        </p>
        <p>
          Nothing else is affected — the 2D and Aft views draw the same rocket from the same data,
          and every number on the page is unchanged.
        </p>
        {this.state.detail && <p className="hero-fallback-detail">{this.state.detail}</p>}
        <button className="file-btn" onClick={this.props.onBack}>← Back to the 2D view</button>
      </div>
    );
  }
}
