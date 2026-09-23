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
 *
 * The announcing is done by two ALWAYS-MOUNTED regions beside the bar, not by
 * the bar (audit 2026-09-22). The bar used to be the live region itself, and
 * it rendered null while empty, so the region arrived in the same commit as
 * its first message — the case a screen reader announces least reliably. And
 * collapsed it showed only its lead notice, so a routine note arriving beside
 * another one changed the live text by "+1" and nothing else. The regions say
 * what is NEW, in words, and the collapsed bar leads with the newest notice.
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

// Warn and error carried the same glyph until v0.076 — severity then hung on
// a 1–2px border color alone.
const GLYPH: Record<NoticeSeverity, string> = { info: 'i', warn: '⚠', error: '⛔' };

const LABEL: Record<NoticeSeverity, string> = {
  info: 'Notice', warn: 'Warning', error: 'Error',
};

/** First line only — what the collapsed bar shows. */
const firstLine = (text: string): string => {
  const line = text.split('\n', 1)[0] ?? '';
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
};

/**
 * What makes a notice NEW for the announcer and for "newest first": its words
 * as well as its id. The file note is ONE id ('file-note') whose text is
 * replaced — "Saved “X”", then "Share link copied" — so an id-only key would
 * never hear the second.
 */
const noticeKey = (n: Notice): string => `${n.id}\u0000${n.severity}\u0000${n.text}`;

/**
 * What the announcer says for one notice: routine information as the one line
 * the collapsed bar shows, a problem in full, because a problem is what opens
 * the bar — the same text a sighted user is shown.
 */
const spoken = (n: Notice): string =>
  `${LABEL[n.severity]}: ${n.severity === 'info' ? firstLine(n.text) : n.text}`;

export function NoticeBar({ notices }: { notices: Notice[] }) {
  const [expanded, setExpanded] = useState(false);
  // Track what the user has already been shown — every `id:severity` on the
  // bar — so a warning opens it the first time it appears and does NOT re-open
  // it every render, nor fight the user if they collapse it again.
  const announced = useRef<ReadonlySet<string>>(new Set());

  const worst = notices.reduce<NoticeSeverity>(
    (acc, n) => (RANK[n.severity] > RANK[acc] ? n.severity : acc), 'info');
  const key = notices.map((n) => `${n.id}:${n.severity}`).join('|');
  const textKey = notices.map(noticeKey).join('\u0001');

  /**
   * When each notice on the bar first appeared, as a batch number: notices
   * that arrive together share one, so on the first render the App's own
   * order still decides. Derived during render (React's "adjust state when a
   * prop changes" pattern), not in an effect, so the newest notice leads in
   * the SAME frame it appears rather than one frame after an older one.
   */
  const [age, setAge] = useState<{ textKey: string; batch: ReadonlyMap<string, number>; next: number }>(
    { textKey: '', batch: new Map(), next: 0 });
  if (age.textKey !== textKey) {
    const batch = new Map<string, number>();
    for (const n of notices) {
      const k = noticeKey(n);
      batch.set(k, age.batch.get(k) ?? age.next);
    }
    setAge({ textKey, batch, next: age.next + 1 });
  }

  /**
   * The announcers' text: every notice not on the bar last time, routine ones
   * politely and problems assertively. Set AFTER commit (an effect), so even
   * on the very first render the regions already exist, empty, when their
   * text arrives. `seq` keys the spoken element: the same words said again
   * after they went away are a new event, and replacing the element is a DOM
   * change a screen reader hears where re-setting identical text is not.
   * Nothing new → the last announcement is left in place rather than cleared,
   * which would announce nothing anyway and would wipe it under StrictMode's
   * double-run of this effect.
   */
  const onBar = useRef<ReadonlySet<string>>(new Set());
  const [said, setSaid] = useState({ seq: 0, polite: '', assertive: '' });
  useEffect(() => {
    const before = onBar.current;
    onBar.current = new Set(notices.map(noticeKey));
    const fresh = notices.filter((n) => !before.has(noticeKey(n)));
    if (fresh.length === 0) return;
    const say = (want: (n: Notice) => boolean) => fresh.filter(want).map(spoken).join(' ');
    setSaid((prev) => ({
      seq: prev.seq + 1,
      polite: say((n) => n.severity === 'info'),
      assertive: say((n) => n.severity !== 'info'),
    }));
  }, [textKey, notices]);

  useEffect(() => {
    const seen = announced.current;
    announced.current = new Set(notices.map((n) => `${n.id}:${n.severity}`));
    // Problems open themselves; routine information does not. Only a problem
    // NOT already on the bar counts (audit 2026-09-22): testing "is any
    // problem present" re-opened a bar the user had collapsed over a warning
    // every time a routine notice ("Share link copied") came or went beside it.
    // A notice that escalates under the same id is new information, and opens it.
    if (notices.some((n) => n.severity !== 'info' && !seen.has(`${n.id}:${n.severity}`))) {
      setExpanded(true);
    }
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

  // Show the most serious one when collapsed — an error must never hide behind
  // "Loaded Rocket.ork" — and among equals the NEWEST (audit 2026-09-22): the
  // first of equals was whichever standing notice the App lists first, so the
  // stale-session note hid every "Saved" and "Share link copied" behind it.
  // A notice missing from `age` is this render's newcomer (in the render
  // React throws away for the setAge above); Array.sort is stable, so a tie
  // keeps the App's order. No notices → no lead → no bar.
  const newest = (n: Notice) => age.batch.get(noticeKey(n)) ?? age.next;
  const lead = [...notices].sort((a, b) =>
    RANK[b.severity] - RANK[a.severity] || newest(b) - newest(a))[0];
  const others = notices.length - 1;

  // ONE shape with and without a bar: [bar-or-nothing, polite, alert]. The
  // empty case used to return the announcers' fragment on its own and the busy
  // case `<>{bar}{announcers}</>`, so React matched the polite region's <div>
  // to the bar's by position and rebuilt both regions whenever the bar came or
  // went — creating them in the same commit as their first words, and
  // re-inserting a dismissed error's text as a fresh role="alert" (review of
  // the audit 2026-09-22 branch, measured). An empty slot keeps its position.
  return (
    <>
      {lead && (
        /* A named region, not a live one: the announcers below speak for it,
           and a live bar re-read itself whenever expanding rewrote it. */
        <div
          ref={barRef}
          className={`notice-bar notice-${worst}${expanded ? ' expanded' : ''}`}
          role="region"
          aria-label="Notices"
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
      )}
      <div className="notice-announce sr-only" role="status" aria-live="polite">
        {said.polite && <span key={said.seq}>{said.polite}</span>}
      </div>
      <div className="notice-announce sr-only" role="alert" aria-live="assertive">
        {said.assertive && <span key={said.seq}>{said.assertive}</span>}
      </div>
    </>
  );
}
