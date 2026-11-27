// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'postcss';
import { BROWSER_REQUIREMENTS, supportsBrowserRuntime } from './browserSupport.js';

afterEach(() => { vi.doUnmock('../main.js'); vi.doUnmock('./browserSupport.js'); vi.resetModules(); document.body.innerHTML = ''; });

it.each([false, true])('evaluates the app only when its runtime APIs are supported: %s', async supported => {
  vi.resetModules();
  const evaluated = vi.fn();
  vi.doMock('../main.js', () => { evaluated(); return {}; });
  vi.doMock('./browserSupport.js', () => ({ BROWSER_REQUIREMENTS, supportsBrowserRuntime: () => supported }));
  document.body.innerHTML = '<div id="root"></div>';
  await import('../bootstrap.js');
  if (supported) await vi.waitFor(() => expect(evaluated).toHaveBeenCalledOnce());
  else {
    expect(evaluated).not.toHaveBeenCalled();
    expect(document.getElementById('root')?.textContent).toBe(BROWSER_REQUIREMENTS);
    const message = document.querySelector('#root p') as HTMLElement;
    expect(message.getAttribute('role')).toBe('alert');
    expect(message.style.color).toBe('#03254f');
    expect(message.style.backgroundColor).toBe('#f6faff');
  }
});

it('accepts the complete runtime and refuses each missing API before app evaluation', () => {
  expect(supportsBrowserRuntime()).toBe(true);
  for (const [object, key] of [[Object, 'hasOwn'], [Array.prototype, 'at'], [globalThis, 'structuredClone'], [globalThis.crypto, 'randomUUID'], [globalThis, 'crypto']] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    const restore = () => {
      if (descriptor) Object.defineProperty(object, key, descriptor);
      else Reflect.deleteProperty(object, key);
    };
    try {
      Object.defineProperty(object, key, { configurable: true, value: undefined });
      // Restore the API before invoking the test framework.
      const supported = supportsBrowserRuntime();
      restore();
      expect(supported).toBe(false);
    } finally { restore(); }
  }
});
it('keeps the declared build and guide floor together and gates the entry import', () => {
  const config = readFileSync(resolve(import.meta.dirname, '../../vite.config.ts'), 'utf8');
  for (const target of ['edge98', 'firefox95', 'chrome98', 'safari15.4']) expect(config).toContain(`'${target}'`);
  const entry = readFileSync(resolve(import.meta.dirname, '../bootstrap.ts'), 'utf8');
  expect(entry).toContain("if (supportsBrowserRuntime()) {\n  void import('./main.js');");
  expect(entry).not.toContain("from './main");
  const guide = readFileSync(resolve(import.meta.dirname, '../../user-guide.md'), 'utf8');
  expect(guide).toContain(BROWSER_REQUIREMENTS.split('. Update')[0]);
});

function supportedCss(has: boolean, colorMix: boolean) {
  const css = parse(readFileSync(resolve(import.meta.dirname, '../styles.css'), 'utf8'));
  // Model unsupported selectors/declarations. Browser rendering is checked by the orchestrator.
  css.walkAtRules('supports', rule => {
    const supported = rule.params.includes('selector(') ? has : colorMix;
    if (rule.params.startsWith('not ') ? supported : !supported) rule.remove();
  });
  if (!has) css.walkRules(rule => { if (rule.selector.includes(':has(')) rule.remove(); });
  css.walkDecls(decl => {
    // var() can defer rejection until computed-value time, when the browser
    // does not return to an earlier declaration of this property.
    if (!colorMix && decl.value.includes('color-mix(')) decl.parent?.walkDecls(decl.prop, same => { same.remove(); });
  });
  const declarations = (selector: string) => {
    const result: Record<string, string> = {};
    css.walkRules(rule => {
      if (rule.selectors.includes(selector)) rule.walkDecls(decl => { result[decl.prop] = decl.value; });
    });
    return result;
  };
  return { css, declarations };
}

it('keeps modern compact aero visibility conditional on a badge', () => {
  const { declarations } = supportedCss(true, true);
  expect(declarations('.workspace-bar-compact:not(.workspace-bar-expanded) .vitals-item').display).toBe('none');
  expect(declarations('.workspace-bar-compact:not(.workspace-bar-expanded) .vitals-item-aero').display).toBeUndefined();
  expect(declarations('.workspace-bar-compact:not(.workspace-bar-expanded) .vitals-item-aero:has(.vitals-aero-compact)').display).toBe('block');
});

it('keeps search, selection, keyboard focus and dismissible text cues without color-mix or :has', () => {
  const { declarations } = supportedCss(false, false);
  expect(declarations('.guide-content mark')['--mark-bg']).toBe('var(--selected)');
  expect(declarations('.guide-content mark')['text-decoration']).toBe('underline');
  expect(declarations('label.file-btn').position).toBe('relative');
  expect(declarations('label.file-btn:focus-within').outline).toContain('var(--focus)');
  // Twelve percent accent fill leaves the traces visible under the zoom box.
  expect(declarations('.viz-root .chart-panel .u-select').background).toBe('rgba(173, 60, 0, 0.12)');
  expect(declarations(".viz-root[data-theme='dark'] .chart-panel .u-select").background).toBe('rgba(255, 101, 9, 0.12)');
  expect(declarations('.viz-root .stats-chip').background).toBe('var(--mmr-c-navy)');
  expect(declarations('.viz-root .hero-mounts').background).toBe('var(--mmr-c-navy)');
  expect(declarations('.viz-root .numfield input.num-invalid')['box-shadow']).toContain('var(--status-serious)');
  expect(declarations('.workspace-bar-compact:not(.workspace-bar-expanded) .vitals-item-aero').display).toBe('block');
  expect(declarations('.message-tier.message-tier.file-note')['padding-right']).toBe('28px');
  for (const selector of ['.viz-root .override-inert', '.viz-root .fly-stale']) {
    expect(declarations(selector).border, selector).toBe('1px solid var(--status-warn)');
  }
});

it('keeps Results launch guidance and the flight bundle width without :has', () => {
  const { css, declarations } = supportedCss(false, true);
  document.body.innerHTML = '<div class="workspace"><div class="workspace-bar workspace-bar-compact"></div><main class="results-column"><span class="results-full-launch-help"></span><span class="results-compact-launch-help"></span></main></div>';
  const help = (name: string) => {
    const element = document.querySelector(`.results-${name}-launch-help`)!;
    let display = 'inline';
    css.walkRules(rule => {
      if (element.matches(rule.selector)) rule.walkDecls('display', decl => { display = decl.value; });
    });
    return display;
  };
  expect(help('full')).toBe('none');
  expect(help('compact')).toBe('inline');
  document.querySelector('.workspace-bar')!.classList.add('workspace-bar-expanded');
  expect(help('full')).toBe('inline');
  expect(help('compact')).toBe('none');
  document.querySelector('.workspace-bar')!.className = 'workspace-bar';
  expect(help('full')).toBe('inline');
  expect(help('compact')).toBe('none');
  expect(declarations('.modal-card.flight-bundle-dialog')['max-width']).toBe('760px');
  expect(declarations('.modal-card.flight-bundle-dialog').width).toBe('min(760px, 100%)');
});
