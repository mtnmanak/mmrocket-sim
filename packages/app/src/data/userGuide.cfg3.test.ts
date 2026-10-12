import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GUIDE_SECTIONS } from './userGuide.js';

/**
 * CFG-3 review, findings 5 and 6: guide passages that described the Design
 * fields CFG-3 moved, and the vitals strip's "Working settings" by a rule the
 * code did not follow. Each check reads the markdown AND the shipped module
 * (a stale regeneration fails too), against the words the components render.
 */
const here = dirname(fileURLToPath(import.meta.url));
const markdown = readFileSync(join(here, '../../user-guide.md'), 'utf8');
const shipped = GUIDE_SECTIONS.map((s) => s.html).join('\n');
const source = (file: string) => readFileSync(join(here, '..', file), 'utf8');

describe('the user guide after CFG-3', () => {
  it('names the separation trigger by the label its row shows', () => {
    // ConfigPartEditors labels the stage row's trigger "Separate at".
    expect(source('components/ConfigPartEditors.tsx')).toContain("recovery ? 'Deploy at' : 'Separate at'");
    expect(source('components/ConfigPartEditors.tsx')).not.toContain('Separate at (lower stages)');
    for (const text of [markdown, shipped]) expect(text).not.toContain('Separate at (lower stages)');
  });

  it('gives no deployment altitude as a property-panel "default: N" example', () => {
    // Deploy altitude left the property panel (CFG-SPEC A4); its row editor
    // always shows a number.
    for (const text of [markdown, shipped]) expect(text).not.toContain('a deployment altitude of 200 m');
    const blank = markdown.split('\n').find((l) => l.startsWith('**A blank field.**'))!;
    expect(blank).toContain('a fin count of 3 on a fin set saved without one');
  });

  it("ties the strip's Working settings to the chooser's own option, in both strip passages", () => {
    expect(source('components/ConfigPanel.tsx')).toContain('Working settings (not saved)</option>');
    const intro = markdown.split('\n').find((l) => l.startsWith('The app is organized into **three workspaces**'))!;
    const row = markdown.split('\n').find((l) => l.startsWith('| Vitals strip |'))!;
    for (const passage of [intro, row]) {
      expect(passage).toContain('*Working settings* whenever the **Flight configuration** chooser');
      expect(passage).toContain('shows *Working settings (not saved)*');
      expect(passage).not.toContain('Working settings* for motors loaded outside');
    }
    expect(shipped).not.toContain('Working settings</em> for motors loaded outside');
  });
});
