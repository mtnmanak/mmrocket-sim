import { Component, type ErrorInfo, type ReactNode } from 'react';
import { autosavedDesignFile } from '../services/autosaveBackup.js';
import { saveFile } from '../services/saveFile.js';
import { discardSession } from '../services/session.js';

/** The persisted workspace tab (App's own key): a crash tied to one tab re-opens on it. */
const WORKSPACE_KEY = 'online-openrocket.workspace.v1';

/**
 * THE ROOT ERROR BOUNDARY (audit 2026-09-22).
 *
 * Until this, the only boundaries wrapped the site band and the 3D view, so a
 * throw anywhere else unmounted the whole app and main.tsx's `error` handler
 * painted a bare message into the empty root. The class has shipped twice (the
 * v0.105 Max-Mach crash, the v0.136 3D crash that took the workspace down),
 * and a DATA-dependent throw is worse than a blank page: the autosave restores
 * the same design into the same persisted tab on every reload, so the app
 * crashes again before anything can be done — and the one escape users had,
 * clearing the site's data, also destroyed their run history and imported
 * motors.
 *
 * So this panel offers, in order: download the autosaved design (an .ork, or
 * the raw autosave when the design cannot be written — services/
 * autosaveBackup.ts), then start fresh, which clears ONLY the autosaved design
 * and the remembered tab and reloads. Runs, imported motors, custom presets
 * and preferences are left alone. It asks before discarding, because the
 * autosave is the only copy of unsaved work.
 *
 * It sits outside PrefsProvider and needs nothing from it, so a throw in the
 * preferences layer is caught too. Section boundaries inside App
 * (PanelBoundary) keep a failing panel from reaching this one at all.
 */
export class AppBoundary extends Component<
  { children: ReactNode; /** Injected by tests; the page reload otherwise. */ onReload?: () => void },
  { error: string | null; note: string | null; confirming: boolean }
> {
  override state = { error: null as string | null, note: null as string | null, confirming: false };

  static getDerivedStateFromError(err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  }

  override componentDidCatch(err: Error, info: ErrorInfo) {
    // Logged in full: the component stack is what a bug report needs.
    console.error('The app stopped on an error:', err, info.componentStack);
  }

  private download = async () => {
    const file = autosavedDesignFile();
    if (!file) {
      this.setState({ note: 'There is no autosaved design in this browser to download.' });
      return;
    }
    const out = await saveFile(file.data, {
      suggestedName: file.name, mime: file.mime, extensions: [file.extension], description: file.description,
    });
    if (out.kind === 'cancelled') return;
    const where = out.kind === 'saved' ? `Saved “${out.name}”.` : `Saved “${out.name}” to your browser's download folder.`;
    this.setState({
      note: file.ork
        ? `${where} Open it with Open… once the app is running again.`
        : `${where} The design could not be written as an .ork, so this is the autosave exactly as`
          + ' the browser holds it — keep it, and attach it to a bug report.',
    });
  };

  private startFresh = () => {
    discardSession();
    try { localStorage.removeItem(WORKSPACE_KEY); } catch { /* blocked storage: the reload shows it */ }
    (this.props.onReload ?? (() => window.location.reload()))();
  };

  override render() {
    if (this.state.error === null) return this.props.children;
    return (
      <div className="panel hero-fallback" role="alert" style={{ margin: '24px auto' }}>
        <h2>Something went wrong</h2>
        <p>
          The app hit an error it could not draw past, so it stopped. Your design is still in this
          browser&rsquo;s autosave: download it first, then start fresh.
        </p>
        <p className="hero-fallback-detail">{this.state.error}</p>
        <button className="file-btn" onClick={() => { void this.download(); }}>
          ⬇ Download the autosaved design
        </button>
        {this.state.note && <p role="status">{this.state.note}</p>}
        {this.state.confirming ? (
          <>
            <p>
              Starting fresh deletes the autosaved design from this browser and opens a new one.
              Saved runs, imported motors, custom presets and preferences are kept.
            </p>
            <button className="file-btn modal-danger" onClick={this.startFresh}>
              Delete the autosave and start fresh
            </button>
            <button className="file-btn" onClick={() => this.setState({ confirming: false })}>Cancel</button>
          </>
        ) : (
          <button className="file-btn" onClick={() => this.setState({ confirming: true })}>
            Start fresh…
          </button>
        )}
      </div>
    );
  }
}
