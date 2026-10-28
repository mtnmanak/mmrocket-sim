import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Live regions are ALWAYS MOUNTED (audit 2026-09-22): "a region inserted with
 * its text already in place is announced unreliably, so the containers exist
 * before their first message." The element carrying role="alert"/"status"/
 * "log" or aria-live is rendered on every render and the message is its
 * conditional child — never the other way round.
 *
 * This scan finds the other way round: a live element that is itself the
 * right-hand side of `&&` (pattern `and`) or an arm of `? :` (pattern
 * `ternary`), with any comments in between — the sweep patterns of the
 * live-region lane — and a live element inside a CONTAINER that mounts that
 * way (pattern `nested`): `{open && <Modal>…<p role="alert">…}`, or
 * `{built && (() => { … return <div>…<div role="alert">… })()}`. The first two
 * are regexes; `nested` walks the TypeScript AST up from each live tag through
 * JSX elements, fragments, `{…}`, parentheses, the bodies of immediately
 * invoked functions and `.map` callbacks, and stops at any other function — a
 * component boundary. Every non-test .tsx under src is scanned. A component
 * rendered conditionally from ANOTHER file is still invisible to it.
 */
const COMMENTS = String.raw`(?:\s*(?:\{/\*[\s\S]*?\*/\}|//[^\n]*))*`;
const LIVE_TAG = String.raw`\s*<[^>]*(?:role="(?:alert|status|log)"|aria-live=)`;
const PATTERNS = {
  and: new RegExp(String.raw`&&\s*\(?` + COMMENTS + LIVE_TAG, 'g'),
  ternary: new RegExp(String.raw`[?:]\s*\(?` + COMMENTS + LIVE_TAG, 'g'),
} as const;
type Pattern = keyof typeof PATTERNS | 'nested';

const TAB = 'A workspace tab panel mounts with its content when the user opens the tab, so a message already due is '
  + 'there on arrival (the "container opens with it" case, out of scope in cloud lane 21). Inside the tab the region '
  + 'is always mounted';

/**
 * Matches that are correct as they stand. `snippet` is text the match must
 * contain, so an entry names one site without depending on line numbers.
 */
const ALLOWED: { file: string; pattern: Pattern; snippet: string; reason: string }[] = [
  {
    file: 'components/MotorPadMass.tsx', pattern: 'ternary',
    snippet: '{live ? line : <Note as="p" role="status"',
    reason: 'PadMassLine: both arms render a <p role="status"> in the same position, so React keeps the one node '
      + 'and only its text changes; the empty arm is the region waiting for its first message.',
  },
  // The workspace tabs. Keeping a hidden tab's panel mounted is a layout and
  // state change of its own, not this scan's to make.
  ...[
    "{tab === 'design' && ( … <div key={tier} className={`design-notes-${tier}`}",
    "{tab === 'design' && ( … <div className=\"rail-fit-alert\"",
  ].map((snippet) => ({ file: 'App.tsx', pattern: 'nested' as const, snippet,
    reason: TAB + ', a failed build included.' })),
  ...[
    "{tab === 'motors' && ( … <div className=\"zero-delay-recovery\"",
    "{tab === 'motors' && ( … <div className=\"unmatched-pad-mass-status\"",
    "{tab === 'results' && ( … <div role=\"alert\" className={machWarning ? 'mach-warn-alert'",
    "{tab === 'results' && ( … <div role=\"status\" className={!inspectedSummary && lastRun",
    "{tab === 'results' && ( … <div role=\"alert\" className={runsQuotaWarn ? 'runs-quota-alert'",
  ].map((snippet) => ({ file: 'App.tsx', pattern: 'nested' as const, snippet, reason: TAB + '.' })),
  {
    file: 'components/FlightCharts.tsx', pattern: 'nested',
    snippet: '{onFullSeries && ( … <span className="download-caption" id="flight-data-stale" role="status">',
    reason: 'App always passes onFullSeries (a useCallback), so the block mounts with the plots. The caption is never '
      + 'empty: it is the export line, and what it announces is its change to "Not available …" and back.',
  },
  {
    file: 'components/FlightCharts.tsx', pattern: 'nested',
    snippet: "{comparison === 'custom' && <div className=\"comparison-controls\"> … <div role=\"alert\" className={plotError ? 'plot-series-alert'",
    reason: 'Its error answers "Load all plot series", a button in this same row, so the first one lands in a region '
      + 'already there. plotError outlives a change of comparison, so choosing Custom again brings the row back '
      + 'with the earlier error in it: accepted for now, an owner question of cloud lane 21.',
  },
  {
    file: 'components/MyMaterialsDialog.tsx', pattern: 'nested',
    snippet: '{deleting && <Modal label={`Delete ${deleting.kind} material ${deleting.name}?`}',
    reason: "Delete clears the message in the click that opens this modal (setMessage(''); setDeleting(m)), so the "
      + 'region mounts empty and the result of Delete material lands in it.',
  },
  {
    file: 'components/PropertyPanel.tsx', pattern: 'nested',
    snippet: '{(linked || detachNote) && ( … <div role="status" className={detachNote ? undefined : \'sr-only\'}>',
    reason: 'Mounted while the part is linked; Detach unlinks it and sets the note in one click, and the note then '
      + 'holds the block mounted, so the sentence lands in the region that was already there.',
  },
  {
    file: 'components/PropertyPanel.tsx', pattern: 'nested',
    snippet: '{PRINTABLE.has(node.type) && ( … <div className="part-export-alert" role="alert">',
    reason: 'The block depends only on the part type, and App keys the panel by component, so it mounts with the '
      + 'panel; the export note is scoped to node.id and set only by a printable part\'s export, so it starts empty.',
  },
  {
    file: 'components/ScaleDialog.tsx', pattern: 'nested',
    snippet: '{baseD <= 0 ? ( … <div className="scale-fin-alert" role="alert">',
    reason: 'baseD is measured on the tree the dialog opened with, so the branch mounts with the dialog and never '
      + 'flips while it is open; a fin problem at the opening factor is part of a dialog that takes focus on open.',
  },
  {
    file: 'components/TreeSchematic.tsx', pattern: 'nested',
    snippet: '{measuring && caliper && <> … <span data-caliper-readout="" role="status">',
    reason: 'A caliper starts with no points (points: []), so the readout mounts empty; its reading appears when the '
      + 'second point is placed.',
  },
];

const src = dirname(fileURLToPath(import.meta.url));
const sources = (readdirSync(src, { recursive: true, encoding: 'utf8' }) as string[])
  .filter((f) => f.endsWith('.tsx') && !/\.test\.tsx$/.test(f))
  .map((f) => f.split('\\').join('/'))
  .sort();

/** A match, with `text` running from the start of its first line to its end. */
interface Hit { file: string; pattern: Pattern; text: string }

const LIVE_ROLE = /^(?:alert|status|log)$/;
/** role="alert"|"status"|"log", any role={…}, or any aria-live. */
function isLive(attrs: ts.JsxAttributes): boolean {
  return attrs.properties.some((a) => {
    if (!ts.isJsxAttribute(a)) return false;
    const name = a.name.getText();
    if (name === 'aria-live') return true;
    if (name !== 'role' || !a.initializer) return false;
    return ts.isStringLiteral(a.initializer) ? LIVE_ROLE.test(a.initializer.text) : true;
  });
}

/** `fn` (through parentheses) is the callee of a call: `(() => …)()`. */
function invoked(fn: ts.Node): ts.CallExpression | null {
  let at: ts.Node = fn;
  while (ts.isParenthesizedExpression(at.parent)) at = at.parent;
  return ts.isCallExpression(at.parent) && at.parent.expression === at ? at.parent : null;
}
/** `fn` is the callback of a `.map(…)`, which runs in the render that holds it. */
function mapped(fn: ts.Node): ts.CallExpression | null {
  const call = fn.parent;
  return ts.isCallExpression(call) && call.arguments[0] === fn && ts.isPropertyAccessExpression(call.expression)
    && call.expression.name.text === 'map' ? call : null;
}

/**
 * The `&&` or `? :` that mounts a container of `live` (a JSX element), or null.
 * `live` itself as the operand is the regexes' form, not this one.
 */
function conditionalContainer(live: ts.Node): ts.Node | null {
  let node: ts.Node = live;
  let nested = false;
  for (;;) {
    const parent = node.parent;
    if (!parent) return null;
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      && parent.right === node) return nested ? parent : null;
    if (ts.isConditionalExpression(parent) && (parent.whenTrue === node || parent.whenFalse === node)) {
      return nested ? parent : null;
    }
    if (ts.isJsxElement(parent) || ts.isJsxFragment(parent)) {
      nested = true;
      node = parent;
    } else if (ts.isParenthesizedExpression(parent) || ts.isJsxExpression(parent)) {
      node = parent;
    } else if (ts.isReturnStatement(parent) || (ts.isArrowFunction(parent) && parent.body === node)) {
      // Up to the function this returns from; only one called where it stands goes on.
      let fn: ts.Node = parent;
      while (!ts.isFunctionLike(fn)) fn = fn.parent;
      const call = invoked(fn) ?? mapped(fn);
      if (!call) return null;
      nested = true;
      node = call;
    } else {
      return null;
    }
  }
}

/** Text of the line holding `pos`, trimmed. */
const lineAt = (text: string, pos: number) => text.slice(text.lastIndexOf('\n', pos - 1) + 1, (text.indexOf('\n', pos) + 1 || text.length + 1) - 1).trim();

/** Every match of each pattern in `text`, as found in `file`. */
function liveRegionHits(file: string, text: string): Hit[] {
  const hits: Hit[] = [];
  for (const pattern of Object.keys(PATTERNS) as (keyof typeof PATTERNS)[]) {
    for (const m of text.matchAll(PATTERNS[pattern])) {
      const lineStart = text.lastIndexOf('\n', m.index) + 1;
      hits.push({ file, pattern, text: text.slice(lineStart, m.index + m[0].length) });
    }
  }
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const visit = (node: ts.Node) => {
    const tag = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : null;
    if (tag && isLive(tag.attributes)) {
      const container = conditionalContainer(node);
      // The `&&` / `? :` line, then the live tag: an allow-list snippet can name either.
      if (container) {
        hits.push({ file, pattern: 'nested', text: `${lineAt(text, container.getStart(ast))} … ${tag.getText(ast)}` });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return hits;
}

const allowedFor = (hit: Hit) => ALLOWED.find((a) => a.file === hit.file && a.pattern === hit.pattern && hit.text.includes(a.snippet));

describe('live regions mount before their message (source scan)', () => {
  const hits = sources.flatMap((f) => liveRegionHits(f, readFileSync(join(src, f), 'utf8')));

  it('scans the app sources', () => {
    expect(sources.length).toBeGreaterThan(50);
    expect(sources).toContain('App.tsx');
    expect(sources).toContain('components/MotorPadMass.tsx');
  });

  it('finds no live element mounted together with its message', () => {
    const unexpected = hits.filter((h) => !allowedFor(h))
      .map((h) => `${h.file} (${h.pattern}): ${h.text.replace(/\s+/g, ' ').slice(0, 200)}`);
    expect(unexpected).toEqual([]);
  });

  it('every allow-list entry still matches (a stale entry fails)', () => {
    const stale = ALLOWED.filter((a) => !hits.some((h) => allowedFor(h) === a)).map((a) => `${a.file}: ${a.snippet}`);
    expect(stale).toEqual([]);
  });

  it.each([
    ['components/FlightCharts.tsx', "{comparison === 'custom' && <div className=\"comparison-controls\">", 'alert'],
    ['components/PropertyPanel.tsx', '{(linked || detachNote) && (\n<div>', 'status'],
  ])('does not allow unrelated live regions in %s containers', (file, opening, role) => {
    for (const attrs of ['', ' className="unrelated-region"']) {
      const closing = file.includes('FlightCharts') ? '</div>}' : '</div>)}';
      const form = `const f = () => <>${opening}\n<div role="${role}"${attrs}>{message}</div>\n${closing}</>;`;
      const found = liveRegionHits(file, form);
      expect(found).toHaveLength(1);
      expect(allowedFor(found[0]!)).toBeUndefined();
    }
  });

  it('the patterns see the forms the sweep found, comments included', () => {
    const forms = [
      '{error && <p role="alert">{error}</p>}',
      '{failed && (\n  // a comment\n  <Note tier="danger" className="x" role="alert">Failed</Note>\n)}',
      '{failed && (\n  {/* a comment */}\n  <div aria-live="polite">Failed</div>\n)}',
      '{busy ? <p role="status">Busy</p> : null}',
      '{ok ? null : <p role="log">Lost</p>}',
      // Nested: a dialog that mounts with its warning, and a block built inside an IIFE.
      '{armed && (\n  <Modal label="Run?" onClose={close}>\n    <h2>Run?</h2>\n    <p role="alert">{warning}</p>\n  </Modal>\n)}',
      '{built && (() => {\n  const rest = built.notes;\n  return <div id="notes">\n    <div role="alert">{rest}</div>\n  </div>;\n})()}',
      '{open ? <section><>{rows.map(r => <p key={r} role={r ? "status" : undefined}>{r}</p>)}</></section> : null}',
    ];
    const count = (form: string) => liveRegionHits('form.tsx', `const f = () => <>${form}</>;`).length;
    expect(forms.map(count)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    // The fixed form, an always-mounted region whose class toggles, and a live
    // tag behind a component boundary (a named component, or a callback that
    // is not run where it stands) do not match.
    expect(count('<div role="alert">{error && <p>{error}</p>}</div>')).toBe(0);
    expect(count('<p role="status" className={notice ? undefined : \'sr-only\'}>{notice}</p>')).toBe(0);
    expect(count('<div id="notes">{(() => <div role="alert">{error && <p>{error}</p>}</div>)()}</div>')).toBe(0);
    expect(liveRegionHits('ok.tsx', 'function Panel() { return <div><p role="alert" /></div>; }\n'
      + 'const f = () => <>{open && <Panel />}{open && <button onClick={() => <p role="status" />} />}</>;')).toEqual([]);
  });
});
