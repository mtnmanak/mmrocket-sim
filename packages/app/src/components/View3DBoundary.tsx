import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Whether an error is a lazy chunk that could not be DOWNLOADED, in each
 * engine's own words: Chrome "Failed to fetch dynamically imported module",
 * Firefox "error loading dynamically imported module", Safari "Importing a
 * module script failed", Vite's preload helper "Unable to preload CSS", and a
 * `ChunkLoadError` by name. Only a real Error counts.
 *
 * Safari has a second wording, for the commoner of the two causes. A chunk a
 * newer deploy replaced is not a 404 on this host: Cloudflare Pages answers
 * any unknown path with index.html, 200 text/html (measured on the live site
 * 2026-09-23), and Safari — every iPhone and iPad browser with it — rejects
 * the import with "'text/html' is not a valid JavaScript MIME type." (WebKit
 * since July 2026 adds " for module script '<url>'", which this matches too;
 * both measured in Playwright's WebKit by the late claim check). Missed,
 * that case showed "could not be shown" with no reload button, where a reload
 * is the only cure (claim check of the v0.141 notes).
 */
export function isChunkLoadError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'ChunkLoadError') return true;
  return /dynamically imported module|Importing a module script failed|is not a valid JavaScript MIME type|Unable to preload CSS/i
    .test(err.message);
}

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
 * A FAILED DOWNLOAD IS TOLD APART (audit 2026-09-22). It used to get the
 * WebGL message, blaming the graphics hardware for a dropped connection or a
 * chunk a newer deploy had replaced — and it offered no way out that could
 * work: React.lazy keeps the rejected import, so every later mount of the 3D
 * view throws the same error until the page is reloaded. That case says what
 * happened and offers the reload (`isChunkLoadError`).
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
 * That is why there is no reset key — one would be dead code. (Re-arming does
 * not help a failed download, for the React.lazy reason above.)
 */
export class View3DBoundary extends Component<
  { children: ReactNode; onBack: () => void },
  { failed: boolean; detail: string; download: boolean }
> {
  override state = { failed: false, detail: '', download: false };

  static getDerivedStateFromError(err: unknown) {
    return {
      failed: true,
      detail: err instanceof Error ? err.message : String(err),
      download: isChunkLoadError(err),
    };
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
        {this.state.download ? (
          <>
            <p>
              <strong>The 3D view could not be downloaded.</strong> Its code is a separate file,
              fetched the first time the 3D tab opens, and this page could not get it — the
              connection may have dropped, or the app may have been updated since this page
              loaded. It is not your graphics hardware.
            </p>
            <p>
              Reloading the page downloads it again; the design is restored from this
              browser&rsquo;s autosave, as on any reload. Nothing else is affected — the 2D and Aft
              views draw the same rocket from the same data, and every number on the page is
              unchanged.
            </p>
          </>
        ) : (
          <>
            <p>
              <strong>The 3D view could not start.</strong> This browser would not give the app a 3D
              drawing surface. That is usually hardware acceleration switched off, a graphics driver
              the browser has blocked, or a remote-desktop session.
            </p>
            <p>
              Nothing else is affected — the 2D and Aft views draw the same rocket from the same data,
              and every number on the page is unchanged.
            </p>
          </>
        )}
        {this.state.detail && <p className="hero-fallback-detail">{this.state.detail}</p>}
        {this.state.download && (
          <button className="file-btn" onClick={() => window.location.reload()}>↻ Reload the page</button>
        )}
        <button className="file-btn" onClick={this.props.onBack}>← Back to the 2D view</button>
      </div>
    );
  }
}
