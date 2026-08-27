import { useEffect, useRef, useState } from 'react';

/**
 * The app's transient-message strip (issues-2026-08-23a.md, Big Dog via TRF).
 *
 * It replaces the `.file-note` block that sat between the workspace tabs and
 * the tab panel. Two things were wrong with that block and both are structural:
 *
 *  - It was BIG and it was in the way. An imported file's note is one sentence
 *    per honesty item plus one per motor mount, joined with newlines into a
 *    `white-space: pre-line` box with no max height, so a staged multi-config
 *    file produced a ten-line slab across the top of the workspace. On desktop
 *    the Design tab's hero canvas has a fixed height that did not budget for
 *    it, so the note did not shrink the drawing — it shoved it below the fold.
 *    (Since v0.074 the bar publishes its measured height as `--notice-h`, and
 *    the canvas and the footer band both budget for it — see the effect below.)
 *
 *  - Everything used the same tan box: import trivia, "share link copied",
 *    export failures, and HIGH-priority flight-safety warnings alike. There was
 *    no severity, so nothing could be made quieter without making errors
 *    quieter too.
 *
 * So: one line at the bottom of the window, out of the workspace entirely,
 * carrying a severity. Routine information stays collapsed and announces
 * politely; a warning or an error opens itself and announces assertively.
 */

export type NoticeSeverity = 'info' | 'warn' | 'error';

export interface Notice {
  /** Stable within a kind, so re-notifying the same thing does not re-open the bar. */
  id: string;
  severity: NoticeSeverity;
  text: string;
  /** Present when the user is allowed to dismiss this one. */
  onDismiss?: () => void;
}

const RANK: Record<NoticeSeverity, number> = { info: 0, warn: 1, error: 2 };

const GLYPH: Record<NoticeSeverity, string> = { info: 'i', warn: '⚠', error: '⚠' };

const LABEL: Record<NoticeSeverity, string> = {
  info: 'Notice', warn: 'Warning', error: 'Error',
};

/** First line only — what the collapsed bar shows. */
const firstLine = (text: string): string => {
  const line = text.split('\n', 1)[0] ?? '';
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
};

export function NoticeBar({ notices }: { notices: Notice[] }) {
  const [expanded, setExpanded] = useState(false);
  // Track what the user has already been shown, so a warning opens the bar the
  // first time it appears and does NOT re-open it every render, nor fight the
  // user if they collapse it again.
  const announced = useRef('');

  const worst = notices.reduce<NoticeSeverity>(
    (acc, n) => (RANK[n.severity] > RANK[acc] ? n.severity : acc), 'info');
  const key = notices.map((n) => `${n.id}:${n.severity}`).join('|');

  useEffect(() => {
    if (key === announced.current) return;
    announced.current = key;
    // Problems open themselves; routine information does not.
    if (notices.some((n) => n.severity !== 'info')) setExpanded(true);
  }, [key, notices]);

  useEffect(() => {
    document.body.classList.toggle('has-notice', notices.length > 0);
    return () => document.body.classList.remove('has-notice');
  }, [notices.length]);

  // Publish the bar's LIVE height as --notice-h so everything that would
  // otherwise end up underneath it (the footer band, the Design tab's hero
  // canvas) can budget for it. A static reserve cannot do this job: the bar
  // is `position: fixed`, and expanded it may grow to 40vh. Measured rather
  // than assumed, and re-measured on every resize — a long notice reflows to
  // two lines when the window narrows.
  const barRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = barRef.current;
    const clear = () => document.documentElement.style.removeProperty('--notice-h');
    if (!el) { clear(); return; }
    const publish = () => {
      const h = el.offsetHeight;
      // happy-dom (and any pre-layout frame) reports 0 — leave the property
      // unset there so the stylesheet's own 0px default governs, rather than
      // writing a "0px" that looks measured.
      if (h > 0) document.documentElement.style.setProperty('--notice-h', `${h}px`);
      else clear();
    };
    publish();
    if (typeof ResizeObserver === 'undefined') return clear;
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => { ro.disconnect(); clear(); };
  }, [key, expanded, notices.length]);

  if (notices.length === 0) return null;

  // Show the most serious one when collapsed — an error must never hide behind
  // "Loaded Rocket.ork".
  const lead = [...notices].sort((a, b) => RANK[b.severity] - RANK[a.severity])[0]!;
  const others = notices.length - 1;

  return (
    <div
      ref={barRef}
      className={`notice-bar notice-${worst}${expanded ? ' expanded' : ''}`}
      role={worst === 'info' ? 'status' : 'alert'}
      aria-live={worst === 'info' ? 'polite' : 'assertive'}
    >
      {expanded ? (
        <ul className="notice-list">
          {notices.map((n) => (
            <li key={n.id} className={`notice-item notice-${n.severity}`}>
              <span className="notice-glyph" aria-hidden="true">{GLYPH[n.severity]}</span>
              <span className="notice-text">
                <span className="sr-only">{`${LABEL[n.severity]}: `}</span>
                {n.text}
              </span>
              {n.onDismiss && (
                <button
                  className="notice-dismiss"
                  onClick={n.onDismiss}
                  aria-label={`Dismiss: ${firstLine(n.text)}`}
                >×</button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <div className={`notice-item notice-${lead.severity}`}>
          <span className="notice-glyph" aria-hidden="true">{GLYPH[lead.severity]}</span>
          <span className="notice-text notice-oneline">
            <span className="sr-only">{`${LABEL[lead.severity]}: `}</span>
            {firstLine(lead.text)}
          </span>
          {others > 0 && <span className="notice-count">{`+${others}`}</span>}
        </div>
      )}
      <button
        className="notice-toggle"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-label={expanded ? 'Collapse notices' : `Show ${notices.length} notice${notices.length === 1 ? '' : 's'} in full`}
      >{expanded ? '⌄' : '⌃'}</button>
    </div>
  );
}
