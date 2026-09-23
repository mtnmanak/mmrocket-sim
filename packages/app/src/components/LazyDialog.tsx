import { Component, Suspense, type ErrorInfo, type ReactNode } from 'react';
import { useBackdropClose, useDialog } from './useDialog.js';
import { isChunkLoadError } from './View3DBoundary.js';

/**
 * The frame round a dialog whose code App.tsx lazy-loads — the user guide and
 * the changelog (audit 2026-09-22, row 510). Their text was ~730 KB of source
 * at v0.140 riding in the entry chunk, which every visit must load and parse
 * before the app draws — from the network the first time, from the service
 * worker's cache after that — for two dialogs most visits never open. Now each
 * is a chunk of its own, which the page loads the first time it opens. The
 * service worker still precaches both with the rest of the build, so a first
 * visit downloads the same bytes as before and the dialogs work offline; what
 * moved is when the page reads them, not whether the browser fetches them
 * (the entry chunk the app waits for was 712 KB smaller at v0.140).
 *
 * Two things a static import never had to handle, and this does:
 *
 *  - THE LOAD TAKES TIME: a moment even from the service worker's cache, a
 *    download on a first visit that opens a dialog before the worker has
 *    cached it. While it runs, a stand-in dialog with the same name, in the
 *    real one's box, holds the place: it takes focus, answers Escape, traps
 *    Tab and holds the design's undo binding, exactly as the real one will
 *    (useDialog). When the real dialog arrives the stand-in unmounts first —
 *    React runs the removed tree's effect cleanups before the new tree's
 *    effects — so its cleanup hands focus back to the button that opened it,
 *    and the real dialog's own useDialog then records that button and moves
 *    focus inside. Close returns focus to the opener as it always did.
 *  - THE DOWNLOAD CAN FAIL — a dropped connection, or a chunk a newer deploy
 *    replaced. With no boundary here that throw would reach AppBoundary and
 *    take the whole app down for a help text. Caught here, it says what happened,
 *    in a dialog that closes like any other, and offers the reload that is
 *    the only cure: React.lazy keeps the rejected import, so every later open
 *    fails the same way until the page reloads (View3DBoundary's reasoning).
 *
 * `label` is the real dialog's own aria-label ("User guide", "Changelog"), so
 * the stand-ins are announced by the same name and their ✕ reads "Close user
 * guide", as the real one does. `className` is the real dialog's own box
 * ("guide-dialog panel", "prefs-dialog panel"), so the stand-in is as wide as
 * what replaces it: in the preferences box the guide painted 520 px wide and
 * then jumped to its own 960 (from review).
 */
export function LazyDialog({ label, className, onClose, children }: {
  label: string;
  className: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <LazyDialogBoundary label={label} className={className} onClose={onClose}>
      <Suspense fallback={(
        <DialogStandIn label={label} className={className} onClose={onClose} busy>
          <p role="status">Loading the {label.toLowerCase()}…</p>
        </DialogStandIn>
      )}>
        {children}
      </Suspense>
    </LazyDialogBoundary>
  );
}

/** A plain dialog with the real one's name, box, focus handling and ✕ Close. */
function DialogStandIn({ label, className, onClose, busy, children }: {
  label: string;
  className: string;
  onClose: () => void;
  busy?: boolean;
  children: ReactNode;
}) {
  const dialogRef = useDialog(onClose);
  const backdrop = useBackdropClose(onClose);
  return (
    <div className="prefs-overlay" role="presentation" {...backdrop}>
      <div className={className} role="dialog" aria-modal="true" aria-label={label}
        aria-busy={busy || undefined}
        ref={dialogRef} tabIndex={-1}
        onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <h2 style={{ flex: 1 }}>{label}</h2>
          <button className="file-btn" onClick={onClose} aria-label={`Close ${label.toLowerCase()}`}>✕ Close</button>
        </div>
        {children}
      </div>
    </div>
  );
}

class LazyDialogBoundary extends Component<
  { children: ReactNode; label: string; className: string; onClose: () => void },
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
    console.error(`${this.props.label} failed to open:`, err, info.componentStack);
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    const { label, className, onClose } = this.props;
    return (
      <DialogStandIn label={label} className={className} onClose={onClose}>
        {this.state.download ? (
          <>
            <p>
              <strong>The {label.toLowerCase()} could not be downloaded.</strong> It is a separate
              file, fetched the first time it opens, and this page could not get it — the connection
              may have dropped, or the app may have been updated since this page loaded.
            </p>
            <p>
              Reloading the page downloads it again; the design is restored from this
              browser&rsquo;s autosave, as on any reload. Nothing else is affected.
            </p>
          </>
        ) : (
          <p>
            <strong>The {label.toLowerCase()} could not be shown.</strong> Nothing else is
            affected: the design and the rest of the page still work.
          </p>
        )}
        {this.state.detail && <p className="hero-fallback-detail">{this.state.detail}</p>}
        {this.state.download && (
          <button className="file-btn" onClick={() => window.location.reload()}>↻ Reload the page</button>
        )}
      </DialogStandIn>
    );
  }
}
