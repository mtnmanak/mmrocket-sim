import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * First-run tour (batch 2026-08-21b, proposal S3): six anchored tooltips that
 * orient a first-time visitor in ~30 seconds. In-house on purpose — the
 * anchors are our own `data-tour` attributes, so a tour library would buy
 * nothing but bytes. Shown once (its own localStorage flag), replayable from
 * the Guide, and Preferences → Display can turn the auto-show off entirely.
 */

const STORAGE_KEY = 'online-openrocket.tour.v1';

type WorkspaceTab = 'design' | 'motors' | 'results';

interface TourStep {
  /** data-tour value of the element the card anchors to. */
  target: string;
  /** Tab that must be active for the target to exist in the DOM. */
  tab?: WorkspaceTab;
  title: string;
  body: string;
}

const STEPS: TourStep[] = [
  {
    target: 'tree', tab: 'design', title: 'Build here',
    body: 'Every part of the rocket lives in this tree. Add and nest components — the drawing updates live.',
  },
  {
    target: 'canvas', tab: 'design', title: 'Check the drawing',
    body: 'Drag parts to reposition them, scroll to zoom. The callouts flag CG, CP, and the stability margin.',
  },
  {
    target: 'motors-tab', tab: 'motors', title: 'Load a motor',
    body: 'Pick a motor for each mount and set the launch conditions in this workspace.',
  },
  {
    target: 'launch', title: 'Fly it',
    body: 'Launch runs the full flight simulation — it works from any tab.',
  },
  {
    target: 'results-panel', tab: 'results', title: 'Read the flight',
    body: 'Flights land here: charts, key numbers, saved runs, CSV export.',
  },
  {
    target: 'guide', tab: 'design', title: 'When you need more',
    body: 'The Guide has a quick start and the physics behind the sim — and the 🐞 button beside it files bugs or ideas, no account needed. Replay this tour from the Guide any time.',
  },
];

/** Mark the tour seen so it never auto-shows again (finish and skip alike). */
export function markTourDone(): void {
  try { localStorage.setItem(STORAGE_KEY, 'done'); } catch { /* ignore */ }
}

/**
 * Whether to auto-start the tour on this load. Pure so it's testable: the
 * tour is for genuinely new visitors, so a restored session (they've used the
 * tool before) or an incoming share link (they came for a design, don't stand
 * in front of it) suppresses it, as does the Preferences opt-out.
 */
export function shouldAutoStartTour(opts: {
  tourOff: boolean;
  hasShare: boolean;
  hasSession: boolean;
}): boolean {
  if (opts.tourOff || opts.hasShare || opts.hasSession) return false;
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'done';
  } catch {
    return false; // storage broken → never nag on every load
  }
}

const CARD_W = 300;
const GAP = 10; // ring edge → card

interface Anchor {
  rect: DOMRect | null; // null = target absent, card centers itself
}

export function FirstRunTour({ onSetTab, onClose }: {
  onSetTab: (tab: WorkspaceTab) => void;
  onClose: () => void;
}) {
  const [idx, setIdx] = useState(0);
  const [anchor, setAnchor] = useState<Anchor>({ rect: null });
  const step = STEPS[idx]!;

  const close = useCallback(() => {
    markTourDone();
    onClose();
  }, [onClose]);

  // Keep the target's tab active. Runs before measuring (same commit), so the
  // measurement effect below sees the right DOM one frame later.
  useEffect(() => {
    if (step.tab) onSetTab(step.tab);
  }, [step, onSetTab]);

  // Measure the anchor; re-measure on resize/scroll (capture: the workspace
  // scrolls in nested containers). rAF gives the tab switch a frame to render.
  useEffect(() => {
    let raf = 0;
    const measure = () => {
      const el = document.querySelector(`[data-tour="${step.target}"]`);
      setAnchor({ rect: el ? el.getBoundingClientRect() : null });
    };
    raf = requestAnimationFrame(measure);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [step]);

  // Card below the anchor when there's room, above otherwise, clamped to the
  // viewport; no anchor → centered (a missing target must never lose the tour).
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let cardStyle: React.CSSProperties;
  if (anchor.rect) {
    const r = anchor.rect;
    const below = r.bottom + GAP + 170 < vh;
    cardStyle = {
      left: Math.min(Math.max(8, r.left), Math.max(8, vw - CARD_W - 8)),
      ...(below ? { top: r.bottom + GAP } : { bottom: vh - r.top + GAP }),
    };
  } else {
    cardStyle = { left: Math.max(8, (vw - CARD_W) / 2), top: vh * 0.3 };
  }

  return (
    <>
      {anchor.rect && (
        <div
          className="tour-ring"
          style={{
            left: anchor.rect.left - 5,
            top: anchor.rect.top - 5,
            width: anchor.rect.width + 10,
            height: anchor.rect.height + 10,
          }}
        />
      )}
      <div className="tour-card" role="dialog" aria-label={`Tour step ${idx + 1} of ${STEPS.length}: ${step.title}`} style={cardStyle}>
        <button className="tour-close" onClick={close} aria-label="Close tour">×</button>
        <h3 className="tour-title">{step.title}</h3>
        <p className="tour-body">{step.body}</p>
        <div className="tour-footer">
          <button className="tour-skip" onClick={close}>Skip</button>
          <span style={{ flex: 1 }} />
          {idx > 0 && (
            <button className="tour-skip" onClick={() => setIdx(idx - 1)}>Back</button>
          )}
          {idx < STEPS.length - 1 ? (
            <button className="tour-next" onClick={() => setIdx(idx + 1)}>
              Next ({idx + 1} of {STEPS.length})
            </button>
          ) : (
            <button className="tour-next" onClick={close}>Done</button>
          )}
        </div>
      </div>
    </>
  );
}
