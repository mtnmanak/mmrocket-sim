import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * A boundary round ONE panel — the flight report, the plots, the drag chart,
 * the run history (audit 2026-09-22).
 *
 * Those panels render stored and computed data, so they are where a
 * data-dependent throw lives (the v0.105 Max-Mach crash was one), and without a
 * boundary such a throw unmounted the whole app. Caught here, the panel says
 * what failed and everything else — the design, the other panels, the run
 * table where a bad run can be deleted — keeps working.
 *
 * `resetKey` re-arms it: when the data the panel draws changes (another run
 * selected, a new flight), the next render tries again. "Try again" does the
 * same by hand.
 */
export class PanelBoundary extends Component<
  { children: ReactNode; /** Sentence subject: "The flight plots". */ what: string; resetKey?: unknown },
  { error: string | null; key: unknown }
> {
  override state = { error: null as string | null, key: this.props.resetKey };

  static getDerivedStateFromError(err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  }

  static getDerivedStateFromProps(
    props: { resetKey?: unknown }, state: { error: string | null; key: unknown },
  ) {
    return props.resetKey === state.key ? null : { error: null, key: props.resetKey };
  }

  override componentDidCatch(err: Error, info: ErrorInfo) {
    console.error(`${this.props.what} failed to draw:`, err, info.componentStack);
  }

  override render() {
    if (this.state.error === null) return this.props.children;
    return (
      <div className="panel hero-fallback" role="alert">
        <p>
          <strong>{this.props.what} could not be drawn.</strong> Nothing else is affected: the
          design and the rest of the page still work.
        </p>
        <p className="hero-fallback-detail">{this.state.error}</p>
        <button className="file-btn" onClick={() => this.setState({ error: null })}>↻ Try again</button>
      </div>
    );
  }
}
