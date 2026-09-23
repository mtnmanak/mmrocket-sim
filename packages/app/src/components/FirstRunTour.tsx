import { useCallback, useEffect, useId, useRef, useState } from 'react';

/**
 * First-run tour (batch 2026-08-21b, proposal S3): six anchored tooltips that
 * orient a first-time visitor in ~30 seconds. In-house on purpose — the
 * anchors are our own `data-tour` attributes, so a tour library would buy
 * nothing but bytes. Shown once (its own localStorage flag), replayable from
 * the Guide, and Preferences → Display can turn the auto-show off entirely.
 */

const STORAGE_KEY = 'online-openrocket.tour.v1';
/** Written by Preferences → On: show the tour once more, session or not. */
const REARM = 'rearm';

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
    body: 'The Guide has a quick start and the physics behind the sim — and the Feedback button beside it files bugs or ideas, no account needed. The ⟲ Tour button next door replays this tour any time.',
  },
];

/** Mark the tour seen so it never auto-shows again (finish and skip alike). */
export function markTourDone(): void {
  try { localStorage.setItem(STORAGE_KEY, 'done'); } catch { /* ignore */ }
}

/**
 * Re-arm the tour, so Preferences → First-run tour = "On" actually does
 * something.
 *
 * It writes a marker rather than clearing the flag, because clearing is not
 * enough: `shouldAutoStartTour` also refuses once a session exists, and by the
 * time anyone opens Preferences one always does. An explicit "show it again"
 * has to outrank that — it is a deliberate request, not the heuristic the
 * session check stands in for.
 */
export function clearTourDone(): void {
  try { localStorage.setItem(STORAGE_KEY, REARM); } catch { /* ignore */ }
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
  // The opt-out and an incoming share link win over everything: one is an
  // explicit "no", the other is a visitor who came for a design.
  if (opts.tourOff || opts.hasShare) return false;
  let flag: string | null;
  try {
    flag = localStorage.getItem(STORAGE_KEY);
  } catch {
    return false; // storage broken → never nag on every load
  }
  // An explicit re-arm from Preferences outranks the restored-session check.
  // Without this, "On" was a dead option: a session always exists by the time
  // anyone opens Preferences, so the tour could never be shown again.
  if (flag === REARM) return true;
  if (flag === 'done') return false;
  return !opts.hasSession;
}

const CARD_W = 300;
const GAP = 10; // ring edge → card

interface Anchor {
  rect: DOMRect | null; // null = target absent, card centers itself
}

/** Whether a modal dialog is open anywhere in the page. */
const modalOpen = (): boolean => document.querySelector('[aria-modal="true"]') !== null;

export function FirstRunTour({ onSetTab, onClose }: {
  onSetTab: (tab: WorkspaceTab) => void;
  onClose: () => void;
}) {
  const [idx, setIdx] = useState(0);
  const [anchor, setAnchor] = useState<Anchor>({ rect: null });
  const step = STEPS[idx]!;
  const cardRef = useRef<HTMLDivElement>(null);
  const bodyId = useId();
  // What the step region says: empty on open (focus entering the card reads
  // its name and, through aria-describedby, its body), then each step Next or
  // Back lands on — focus stays on the button, so nothing else would say it.
  const [said, setSaid] = useState('');
  const goTo = (i: number) => {
    const s = STEPS[i]!;
    setIdx(i);
    setSaid(`Step ${i + 1} of ${STEPS.length}: ${s.title}. ${s.body}`);
  };

  const close = useCallback(() => {
    markTourDone();
    onClose();
  }, [onClose]);

  // Seen means SHOWN, not dismissed. The spotlight and scrim are both
  // pointer-events:none, so the whole app stays usable behind the card — a
  // visitor can simply ignore it and close the tab, and the flag was only ever
  // written by an explicit ×/Skip/Done/Escape. That made "it only ever shows
  // once" false for exactly the people most likely to complain about it.
  useEffect(() => { markTourDone(); }, []);

  /**
   * NON-modal (audit 2026-09-22). It was a useDialog — aria-modal, Tab trapped
   * in the card — while the spotlight and scrim are pointer-events:none on
   * purpose, so a mouse could use the whole app and a keyboard or a screen
   * reader could not reach it. What stays from that contract: focus starts in
   * the card, so Next is reachable without a mouse, and goes back where it was
   * when the tour closes; Escape dismisses it while focus is in the card (or
   * nowhere). What goes: the trap, and aria-modal.
   */
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const card = cardRef.current;
    (card?.querySelector<HTMLElement>('button') ?? card)?.focus();
    return () => {
      const active = document.activeElement;
      if (!active || active === document.body || card?.contains(active)) before?.focus?.();
    };
  }, []);

  /**
   * A dialog opened mid-tour (the Guide button is step 6's own anchor) owns the
   * screen: the card, at z-index 120, painted over it. So the tour steps aside
   * while any modal is open — hidden, not closed, so it comes back on the same
   * step — and leaves Escape to that dialog.
   */
  const [covered, setCovered] = useState(modalOpen);
  useEffect(() => {
    const check = () => setCovered(modalOpen());
    check();
    if (typeof MutationObserver === 'undefined') return;
    const mo = new MutationObserver(check);
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-modal'] });
    return () => mo.disconnect();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A modal's own handler stops Escape in the capture phase; the check
      // is for one that does not.
      if (e.key !== 'Escape' || e.defaultPrevented || modalOpen()) return;
      const active = document.activeElement;
      if (active && active !== document.body && !cardRef.current?.contains(active)) return;
      e.preventDefault();
      close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [close]);

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
  // clientWidth, not innerWidth: innerWidth counts the scrollbar gutter, and
  // clamping a fixed card against it pushed the card (and its Next button)
  // under/past the scrollbar on the right-anchored steps.
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  let cardStyle: React.CSSProperties;
  if (anchor.rect) {
    const r = anchor.rect;
    const cardH = 170; // the card's height, near enough to place it by
    const below = r.bottom + GAP + cardH < vh;
    // Vertically clamped too (audit 2026-09-22): only `left` was, so an anchor
    // taller than the room above it (the tree on a short window) or one
    // scrolled out of view put the card, Next button and all, off the top or
    // bottom edge. Better over the anchor than off the screen.
    const onScreen = (v: number) => Math.min(Math.max(8, v), Math.max(8, vh - cardH - 8));
    cardStyle = {
      left: Math.min(Math.max(8, r.left), Math.max(8, vw - CARD_W - 8)),
      ...(below ? { top: onScreen(r.bottom + GAP) } : { bottom: onScreen(vh - r.top + GAP) }),
    };
  } else {
    cardStyle = { left: Math.max(8, (vw - CARD_W) / 2), top: vh * 0.3 };
  }

  return (
    <>
      {/* Spotlight: the ring's huge box-shadow dims everything EXCEPT the
          anchor (the owner, batch 08-21c — the tour must visibly take the stage).
          With no anchor the plain scrim does the dimming. */}
      {covered ? null : anchor.rect ? (
        <div
          className="tour-ring"
          style={{
            left: anchor.rect.left - 5,
            top: anchor.rect.top - 5,
            width: anchor.rect.width + 10,
            height: anchor.rect.height + 10,
          }}
        />
      ) : (
        <div className="tour-scrim" />
      )}
      <div className="tour-card" role="dialog" ref={cardRef} tabIndex={-1} hidden={covered}
        aria-label={`Tour step ${idx + 1} of ${STEPS.length}: ${step.title}`}
        aria-describedby={bodyId} style={cardStyle}>
        <button className="tour-close" onClick={close} aria-label="Close tour">×</button>
        <h3 className="tour-title">{step.title}</h3>
        <p className="tour-body" id={bodyId}>{step.body}</p>
        <div className="tour-footer">
          <button className="tour-skip" onClick={close}>Skip</button>
          <span style={{ flex: 1 }} />
          {idx > 0 && (
            <button className="tour-skip" onClick={() => goTo(idx - 1)}>Back</button>
          )}
          {idx < STEPS.length - 1 ? (
            <button className="tour-next" onClick={() => goTo(idx + 1)}>
              Next ({idx + 1} of {STEPS.length})
            </button>
          ) : (
            <button className="tour-next" onClick={close}>Done</button>
          )}
        </div>
      </div>
      <p className="tour-announce sr-only" aria-live="polite">{said}</p>
    </>
  );
}
