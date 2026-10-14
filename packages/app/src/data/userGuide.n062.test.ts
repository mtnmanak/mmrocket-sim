import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GUIDE_SECTIONS } from './userGuide.js';

/**
 * N062 review: the guide states what the drawn and printed fin section does
 * in the cases the review found — the markdown AND the shipped module (a stale
 * regeneration fails too). Markup is stripped, so the checks read the words.
 */
const here = dirname(fileURLToPath(import.meta.url));
const plain = (text: string): string => text.replace(/<[^>]+>/g, '').replace(/\*\*/g, '').replace(/\s+/g, ' ');
const markdown = plain(readFileSync(join(here, '../../user-guide.md'), 'utf8'));
const shipped = plain(GUIDE_SECTIONS.map((s) => s.html).join('\n'));

describe('the user guide on drawn and printed fin sections (N062 review)', () => {
  it('says overlapping Hexagonal chamfers still meet at the full thickness, aero fractions unchanged', () => {
    for (const text of [markdown, shipped]) {
      // The trigger is a1 + a2 > 1, both fractions of the MEAN AERODYNAMIC
      // chord (finSection.ts) — not of the root chord (N062 round-2 review).
      expect(text).toContain("Hexagonal chamfers that together run longer than the fin's mean aerodynamic chord are drawn shortened in proportion so they still meet at the full thickness");
      expect(text).not.toContain('together run longer than the chord are drawn');
      expect(text).toContain("the drag model's own chamfer fractions are unchanged");
    }
  });

  it('says the section never reads the root edge, and that a seat can make a hook', () => {
    for (const text of [markdown, shipped]) {
      expect(text).toContain("leading and trailing edges at that height, never from its root edge");
      expect(text).toContain('a desktop OR fin whose last point is stored on the body');
      expect(text).toContain('as you drew it or as it sits on the body');
      expect(text).not.toContain('The thickness at each point comes from the fin\'s own outline, so a root seated down a boat tail keeps the section its outline gives it.');
    }
  });

  it('says a named Supersonic airfoil is drawn only on an Airfoil (pointed) fin, and flown without being drawn otherwise', () => {
    for (const text of [markdown, shipped]) {
      expect(text).toContain('draw the Cross section you pick — a plain Airfoil (pointed) as a symmetric NACA 4-digit section, and a named Supersonic airfoil only on an Airfoil (pointed) fin');
      expect(text).toContain('the flight under those four models uses the named section while the drawing does not');
      expect(text).not.toContain('draw the section you pick');
    }
  });

  it('says thin stock prints flat, a tab only when there is one, and a refused outline gives no STL', () => {
    for (const text of [markdown, shipped]) {
      expect(text).toContain('or stock no thicker than 0.4 mm — prints as the flat prism');
      expect(text).toContain('An outline that crosses itself or encloses no area gives no STL at all');
      expect(text).not.toContain('(the full thickness, if the stock is thinner)');
      expect(text).toContain('A fin set prints as ONE fin, with its tab when it has one');
    }
  });

  // N062 round-2 review: what does NOT change a flight is the drawing and the
  // gloss — fillets still add mass, and the cross-section and finish still
  // change drag and weight as before.
  it('says drawing the fillets changes no flight number while their mass is counted, and that they fit the fin', () => {
    for (const text of [markdown, shipped]) {
      expect(text).toContain('They are drawn for any cross-section; drawing them changes no flight number (their mass is counted as above).');
      expect(text).toContain("lower wherever the fin itself stands lower than that radius, so it tapers to nothing at the root's corners");
      expect(text).not.toContain('They are drawn for any cross-section and do not change the flight.');
    }
  });

  it("says the 3D view's drawing and gloss are appearance only, not the section, fillets or finish", () => {
    for (const text of [markdown, shipped]) {
      expect(text).toContain('The drawing and the gloss are appearance only: the cross-section and the finish still change drag, and the cross-section and any fillets still change weight, as before.');
      expect(text).not.toContain('Neither changes a flight.');
    }
  });
});

// N062 round-3 review: the Fins paragraph and the STL glossary row said every
// Rounded or Airfoil fin prints its section. The print falls back to the flat
// prism for a W/hook outline (as drawn or as seated), a step in the leading or
// trailing edge, and stock no thicker than the 0.4 mm printable edge.
describe('the user guide names every flat-print fallback where it says a shaped fin prints its section (N062 round 3)', () => {
  it('the Fins paragraph: a step or thin stock prints flat, while the view still shapes a stepped fin', () => {
    for (const text of [markdown, shipped]) {
      expect(text).toContain('The 🖨 STL also prints the flat prism for a fin with a step in its leading or trailing edge, or with stock no thicker than its printable 0.4 mm edge, though the view still shapes a stepped fin');
      expect(text).toMatch(/see \.stl under \*?File formats\*?\)/);
    }
  });

  it('the STL glossary row: the cross-section except for the three fallbacks', () => {
    for (const text of [markdown, shipped]) {
      expect(text).toContain('or its cross-section, sharp edges thickened to 0.4 mm and any tab flat, for Rounded or Airfoil — except an outline with more than one chord at some height (a W or hook, as drawn or as seated on the body), a step in its leading or trailing edge, or stock no thicker than 0.4 mm, which prints as the flat prism, as the note under the button says.');
      expect(text).not.toContain('any tab flat, for Rounded or Airfoil. With a printer');
    }
  });
});

// N062 round-4 review: the .dxf row said, unqualified, that the per-part STL
// carries the cross-section; and the fillet sentences said every drawn fillet
// meets the body, which a trapezoidal or elliptical root on a transition (still
// drawn straight at the leading edge's radius) does not — those now draw none.
describe('the user guide qualifies the .dxf row and says where fillets are drawn (N062 round 4)', () => {
  it('the .dxf row: the print carries the cross-section where it can, never the cant', () => {
    for (const text of [markdown, shipped]) {
      expect(text).toContain("the per-part STL for printing carries a Rounded or Airfoil fin's cross-section where it can (see the .stl row), but never the cant.");
      expect(text).not.toContain('the per-part STL for printing carries the cross-section but not the cant');
    }
  });

  it('the Fins paragraph: fillets where the root sits on the body, none on a trapezoidal or elliptical fin on a transition', () => {
    for (const text of [markdown, shipped]) {
      expect(text).toContain("Fillets appear where the fin's root sits on the body: on a body tube, and for a freeform fin on a transition or boat tail too, following its seated root. Trapezoidal and elliptical fins on a transition are still drawn with a straight root at the leading edge's radius and no fillet.");
      expect(text).not.toContain("meeting the fin's side and the body, and following a root seated on a transition or boat tail");
    }
  });

  it('the Root fillet glossary entry says the same', () => {
    for (const text of [markdown, shipped]) {
      expect(text).toContain('draw it along both sides of each fin root that sits on the body — not on a trapezoidal or elliptical fin on a transition, whose root is still drawn straight');
    }
  });
});
