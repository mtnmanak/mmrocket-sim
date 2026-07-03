#!/usr/bin/env node
/**
 * fetch-component-presets.mjs
 *
 * Downloads the OpenRocket component database (.orc files) from
 * github.com/openrocket/openrocket-database (orc/ directory, default branch;
 * the repo "openrocket/components" does not exist -- openrocket-database is
 * the canonical source of the .orc preset files),
 * parses each OpenRocketComponent XML file with a small tolerant parser,
 * converts every dimensional/mass/density value to SI, and writes the
 * bundled preset database to packages/app/src/data/presets.json.
 *
 * Plain Node ESM, no dependencies (uses global fetch, Node >= 18).
 *
 * Usage: node packages/app/scripts/fetch-component-presets.mjs
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, '..', 'src', 'data', 'presets.json');

const API_URL = 'https://api.github.com/repos/openrocket/openrocket-database/contents/orc';

// ---------------------------------------------------------------------------
// Unit conversion tables (everything -> SI)
// ---------------------------------------------------------------------------

const LENGTH_UNITS = {
  m: 1,
  meter: 1,
  meters: 1,
  cm: 0.01,
  mm: 0.001,
  in: 0.0254,
  inch: 0.0254,
  'in/64': 0.0254 / 64,
  ft: 0.3048,
};

const MASS_UNITS = {
  kg: 1,
  g: 0.001,
  oz: 0.028349523125,
  lb: 0.45359237,
};

// Density conversion factors, keyed by material type then unit string.
const DENSITY_UNITS = {
  BULK: {
    'kg/m3': 1,
    'kg/m^3': 1,
    'g/cm3': 1000,
    'g/cm^3': 1000,
    'lb/ft3': 0.45359237 / Math.pow(0.3048, 3), // 16.01846...
    'lb/ft^3': 0.45359237 / Math.pow(0.3048, 3),
    'oz/in3': 0.028349523125 / Math.pow(0.0254, 3), // 1729.99...
    'oz/in^3': 0.028349523125 / Math.pow(0.0254, 3),
  },
  SURFACE: {
    'kg/m2': 1,
    'kg/m^2': 1,
    'g/cm2': 10,
    'g/cm^2': 10,
    'g/m2': 0.001,
    'g/m^2': 0.001,
    'oz/in2': 0.028349523125 / Math.pow(0.0254, 2),
    'oz/in^2': 0.028349523125 / Math.pow(0.0254, 2),
    'oz/ft2': 0.028349523125 / Math.pow(0.3048, 2),
    'oz/ft^2': 0.028349523125 / Math.pow(0.3048, 2),
    'lb/ft2': 0.45359237 / Math.pow(0.3048, 2),
    'lb/ft^2': 0.45359237 / Math.pow(0.3048, 2),
  },
  LINE: {
    'kg/m': 1,
    'g/m': 0.001,
    'g/cm': 0.1,
    'oz/in': 0.028349523125 / 0.0254,
    'oz/ft': 0.028349523125 / 0.3048,
    'lb/ft': 0.45359237 / 0.3048,
  },
};

// Component child elements that are lengths (converted with LENGTH_UNITS
// when a Unit attribute is present; unitless values are assumed SI already).
const LENGTH_FIELDS = new Set([
  'InsideDiameter', 'OutsideDiameter', 'Length', 'Diameter', 'Thickness',
  'AftOuterDiameter', 'AftShoulderDiameter', 'AftShoulderLength',
  'ForeOuterDiameter', 'ForeShoulderDiameter', 'ForeShoulderLength',
  // Names actually used in the openrocket-database .orc files:
  'AftOutsideDiameter', 'ForeOutsideDiameter', 'ShoulderDiameter', 'ShoulderLength',
  'Width', 'LineLength', 'Height', 'BaseHeight', 'FlangeHeight',
  'ScrewHeight', 'ScrewMass', // ScrewMass handled as mass below; kept out of lengths at runtime
]);
LENGTH_FIELDS.delete('ScrewMass');

const MASS_FIELDS = new Set(['Mass', 'ScrewMass', 'NutMass']);

// Integer / plain-number fields (no unit conversion).
const COUNT_FIELDS = new Set(['Sides', 'LineCount', 'DragCoefficient', 'CD']);

// String fields.
const STRING_FIELDS = new Set(['Shape', 'FinishMaterial']);

// Boolean fields.
const BOOL_FIELDS = new Set(['Filled']);

// Metadata fields handled specially.
const META_FIELDS = new Set([
  'Manufacturer', 'PartNumber', 'Description', 'Material', 'LineMaterial', 'Mass',
]);

// ---------------------------------------------------------------------------
// Tiny tolerant XML helpers
// ---------------------------------------------------------------------------

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function stripComments(xml) {
  return xml.replace(/<!--[\s\S]*?-->/g, '');
}

/** Parse an attribute string like ` Unit="mm" Type="BULK"` into an object. */
function parseAttrs(attrString) {
  const attrs = {};
  const re = /([\w:-]+)\s*=\s*"([^"]*)"|([\w:-]+)\s*=\s*'([^']*)'/g;
  let m;
  while ((m = re.exec(attrString)) !== null) {
    if (m[1] !== undefined) attrs[m[1]] = decodeEntities(m[2]);
    else attrs[m[3]] = decodeEntities(m[4]);
  }
  return attrs;
}

/**
 * Extract the inner content of the first <tag>...</tag> in xml
 * (case-insensitive). Returns null if not found.
 */
function extractBlock(xml, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}\\s*>`, 'i');
  const m = re.exec(xml);
  return m ? m[1] : null;
}

/**
 * Iterate direct flat child elements of a block. The .orc format never nests
 * an element inside another element of the same tag name, so a non-greedy
 * open..close match is safe. Also matches self-closing elements.
 * Returns [{ tag, attrs, text }].
 */
function childElements(block) {
  const out = [];
  const re = /<([A-Za-z][\w:-]*)((?:\s[^>]*?)?)\/>|<([A-Za-z][\w:-]*)((?:\s[^>]*?)?)>([\s\S]*?)<\/\3\s*>/g;
  let m;
  while ((m = re.exec(block)) !== null) {
    if (m[1] !== undefined) {
      out.push({ tag: m[1], attrs: parseAttrs(m[2] || ''), text: '' });
    } else {
      out.push({ tag: m[3], attrs: parseAttrs(m[4] || ''), text: decodeEntities(m[5].trim()) });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Value conversion
// ---------------------------------------------------------------------------

function convertLength(value, unit, context) {
  if (!unit) return value; // no Unit attribute => already SI (meters)
  const f = LENGTH_UNITS[unit.trim()];
  if (f === undefined) throw new Error(`unknown length unit "${unit}" (${context})`);
  return value * f;
}

function convertMass(value, unit, context) {
  if (!unit) return value; // already kg
  const f = MASS_UNITS[unit.trim().toLowerCase()];
  if (f === undefined) throw new Error(`unknown mass unit "${unit}" (${context})`);
  return value * f;
}

function convertDensity(value, unitsOfMeasure, type, context) {
  const table = DENSITY_UNITS[type];
  if (!table) throw new Error(`unknown material type "${type}" (${context})`);
  if (!unitsOfMeasure) return value; // already SI
  const f = table[unitsOfMeasure.trim().toLowerCase().replace(/\s+/g, '')];
  if (f === undefined) {
    throw new Error(`unknown density unit "${unitsOfMeasure}" for ${type} (${context})`);
  }
  return value * f;
}

function camel(tag) {
  return tag.charAt(0).toLowerCase() + tag.slice(1);
}

function round(v) {
  // Trim float noise from unit conversion without losing real precision.
  return Number.parseFloat(v.toPrecision(12));
}

// ---------------------------------------------------------------------------
// .orc file parsing
// ---------------------------------------------------------------------------

/**
 * Parse the <Materials> section of one .orc file into a Map of
 * name -> { TYPE -> density(SI) }. Appends any problems to `warnings`.
 */
function parseMaterials(xml, fileName, warnings) {
  const materials = new Map();
  const materialsBlock = extractBlock(xml, 'Materials');
  if (materialsBlock) {
    const matRe = /<Material((?:\s[^>]*?)?)>([\s\S]*?)<\/Material\s*>/gi;
    let m;
    while ((m = matRe.exec(materialsBlock)) !== null) {
      const attrs = parseAttrs(m[1] || '');
      const kids = childElements(m[2]);
      const get = (t) => kids.find((k) => k.tag.toLowerCase() === t.toLowerCase());
      try {
        const name = get('Name')?.text;
        const densEl = get('Density');
        const type = (get('Type')?.text || '').toUpperCase();
        if (!name || !densEl || !type) throw new Error('missing Name/Density/Type');
        const raw = Number.parseFloat(densEl.text);
        if (!Number.isFinite(raw)) throw new Error(`bad density "${densEl.text}"`);
        const uom = densEl.attrs.UnitsOfMeasure || attrs.UnitsOfMeasure;
        const density = round(convertDensity(raw, uom, type, `material "${name}" in ${fileName}`));
        if (!materials.has(name)) materials.set(name, {});
        materials.get(name)[type] = density;
      } catch (err) {
        warnings.push(`${fileName}: skipped material: ${err.message}`);
      }
    }
  }
  return materials;
}

/**
 * Parse the <Components> section of one .orc file.
 * Material densities are resolved from the file's own <Materials> first,
 * falling back to `globalMaterials` (materials pooled from all files, e.g.
 * generic_materials.orc). Returns { presets, skippedComponents, warnings }.
 */
function parseOrc(xml, fileName, globalMaterials) {
  const warnings = [];
  const presets = [];
  let skippedComponents = 0;

  const materials = parseMaterials(xml, fileName, warnings);
  const lookupDensity = (name, type) =>
    materials.get(name)?.[type] ?? globalMaterials.get(name)?.[type];

  // --- Components section ---
  const componentsBlock = extractBlock(xml, 'Components');
  if (componentsBlock === null) {
    warnings.push(`${fileName}: no <Components> section found`);
    return { presets, skippedComponents, warnings };
  }

  // Top-level children of <Components> are the presets themselves.
  const compRe = /<([A-Za-z][\w:-]*)((?:\s[^>]*?)?)>([\s\S]*?)<\/\1\s*>/g;
  let cm;
  while ((cm = compRe.exec(componentsBlock)) !== null) {
    const kind = cm[1];
    const body = cm[3];
    try {
      const preset = { kind, manufacturer: '', partNo: '', description: '' };
      const dims = {};
      let material = null;
      let lineMaterial = null;

      for (const el of childElements(body)) {
        const tag = el.tag;
        const unit = el.attrs.Unit;
        const ctx = `${kind} in ${fileName}`;

        if (tag === 'Manufacturer') preset.manufacturer = el.text;
        else if (tag === 'PartNumber') preset.partNo = el.text;
        else if (tag === 'Description') preset.description = el.text;
        else if (tag === 'Material' || tag === 'LineMaterial') {
          const type = (el.attrs.Type || 'BULK').toUpperCase();
          const name = el.text;
          const density = lookupDensity(name, type);
          const mat = { name, type };
          if (density !== undefined) mat.density = density;
          else warnings.push(`${fileName}: ${kind} "${preset.partNo || name}": material "${name}" (${type}) not in <Materials>; density omitted`);
          if (tag === 'Material') material = mat;
          else lineMaterial = mat;
        } else if (MASS_FIELDS.has(tag)) {
          const v = Number.parseFloat(el.text);
          if (!Number.isFinite(v)) throw new Error(`bad ${tag} "${el.text}"`);
          dims[camel(tag)] = round(convertMass(v, unit, ctx));
        } else if (BOOL_FIELDS.has(tag)) {
          dims[camel(tag)] = /^true$/i.test(el.text);
        } else if (STRING_FIELDS.has(tag)) {
          dims[camel(tag)] = el.text;
        } else if (COUNT_FIELDS.has(tag)) {
          const v = Number.parseFloat(el.text);
          if (!Number.isFinite(v)) throw new Error(`bad ${tag} "${el.text}"`);
          dims[camel(tag)] = v;
        } else if (LENGTH_FIELDS.has(tag)) {
          const v = Number.parseFloat(el.text);
          if (!Number.isFinite(v)) throw new Error(`bad ${tag} "${el.text}"`);
          dims[camel(tag)] = round(convertLength(v, unit, ctx));
        } else {
          // Unknown field: keep it rather than lose data. Numbers with a
          // Unit attribute are treated as lengths; bare numbers/strings pass
          // through; booleans are parsed.
          const num = Number.parseFloat(el.text);
          if (/^(true|false)$/i.test(el.text)) {
            dims[camel(tag)] = /^true$/i.test(el.text);
          } else if (Number.isFinite(num) && /^[\s+-.\d eE]+$/.test(el.text)) {
            dims[camel(tag)] = unit ? round(convertLength(num, unit, ctx)) : num;
          } else {
            dims[camel(tag)] = el.text;
          }
          warnings.push(`${fileName}: ${kind}: unrecognized field <${tag}> kept as-is`);
        }
      }

      if (material) preset.material = material;
      const { mass, ...rest } = dims;
      if (mass !== undefined) preset.mass = mass;
      Object.assign(preset, rest);
      if (lineMaterial) preset.lineMaterial = lineMaterial;
      presets.push(preset);
    } catch (err) {
      skippedComponents++;
      warnings.push(`${fileName}: SKIPPED ${kind}: ${err.message}`);
    }
  }

  return { presets, skippedComponents, warnings };
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

async function fetchWithRetry(url, opts = {}, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'online-openrocket-preset-fetcher', ...opts.headers },
      });
      if (res.status === 403 || res.status === 429) {
        const reset = res.headers.get('x-ratelimit-reset');
        const retryAfter = res.headers.get('retry-after');
        let waitMs = 10_000 * (i + 1);
        if (retryAfter) waitMs = Number(retryAfter) * 1000;
        else if (reset) waitMs = Math.max(0, Number(reset) * 1000 - Date.now()) + 1000;
        waitMs = Math.min(waitMs, 90_000);
        console.warn(`  rate-limited (${res.status}) on ${url}; waiting ${Math.round(waitMs / 1000)}s...`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return res;
    } catch (err) {
      lastErr = err;
      const waitMs = 2000 * (i + 1);
      console.warn(`  fetch failed (${err.message}); retrying in ${waitMs / 1000}s...`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr ?? new Error(`failed to fetch ${url}`);
}

async function main() {
  console.log(`Listing ${API_URL} ...`);
  const listing = await (await fetchWithRetry(API_URL)).json();
  if (!Array.isArray(listing)) {
    throw new Error(`unexpected GitHub API response: ${JSON.stringify(listing).slice(0, 200)}`);
  }
  const orcFiles = listing.filter((f) => f.type === 'file' && /\.orc$/i.test(f.name));
  console.log(`Found ${orcFiles.length} .orc files.`);

  const allPresets = [];
  const allWarnings = [];
  let skippedFiles = 0;
  let skippedComponents = 0;

  // Pass 1: fetch everything and pool all <Materials> definitions so a file
  // can reference a material defined elsewhere (e.g. generic_materials.orc).
  const fetched = [];
  const globalMaterials = new Map();
  for (const file of orcFiles) {
    process.stdout.write(`  fetching ${file.name} ... `);
    try {
      const res = await fetchWithRetry(file.download_url);
      const xml = stripComments(await res.text());
      fetched.push({ name: file.name, xml });
      // (warnings from this pass are discarded; pass 2 re-parses and reports)
      for (const [name, byType] of parseMaterials(xml, file.name, [])) {
        const existing = globalMaterials.get(name) || {};
        globalMaterials.set(name, { ...byType, ...existing }); // first definition wins
      }
      console.log('ok');
    } catch (err) {
      skippedFiles++;
      console.log(`FAILED: ${err.message}`);
      allWarnings.push(`${file.name}: FILE SKIPPED: ${err.message}`);
    }
  }

  // Pass 2: parse components.
  for (const { name, xml } of fetched) {
    const { presets, skippedComponents: sk, warnings } = parseOrc(xml, name, globalMaterials);
    allPresets.push(...presets);
    skippedComponents += sk;
    allWarnings.push(...warnings);
    console.log(`  ${name}: ${presets.length} presets${sk ? ` (${sk} skipped)` : ''}`);
  }

  allPresets.sort(
    (a, b) =>
      a.kind.localeCompare(b.kind) ||
      a.manufacturer.localeCompare(b.manufacturer) ||
      a.partNo.localeCompare(b.partNo),
  );

  const out = {
    generated: new Date().toISOString().slice(0, 10),
    source: 'github.com/openrocket/openrocket-database',
    count: allPresets.length,
    presets: allPresets,
  };

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(out, null, 1) + '\n');
  console.log(`\nWrote ${OUT_PATH} (${allPresets.length} presets)`);

  // ------- report -------
  const byKind = {};
  const byMfr = {};
  for (const p of allPresets) {
    byKind[p.kind] = (byKind[p.kind] || 0) + 1;
    byMfr[p.manufacturer] = (byMfr[p.manufacturer] || 0) + 1;
  }
  console.log('\nPer kind:');
  for (const [k, n] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${n}`);
  }
  console.log('\nTop 10 manufacturers:');
  for (const [k, n] of Object.entries(byMfr).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  ${k}: ${n}`);
  }

  const btOD = allPresets
    .filter((p) => p.kind === 'BodyTube' && typeof p.outsideDiameter === 'number')
    .map((p) => p.outsideDiameter);
  const ncLen = allPresets
    .filter((p) => p.kind === 'NoseCone' && typeof p.length === 'number')
    .map((p) => p.length);
  console.log(`\nSanity: BodyTube outsideDiameter min=${Math.min(...btOD)} max=${Math.max(...btOD)} m (n=${btOD.length})`);
  console.log(`Sanity: NoseCone length min=${Math.min(...ncLen)} max=${Math.max(...ncLen)} m (n=${ncLen.length})`);

  console.log('\nExample BodyTube:');
  console.log(JSON.stringify(allPresets.find((p) => p.kind === 'BodyTube'), null, 2));
  console.log('\nExample NoseCone:');
  console.log(JSON.stringify(allPresets.find((p) => p.kind === 'NoseCone'), null, 2));

  const unrecognized = allWarnings.filter((w) => w.includes('unrecognized field'));
  const unrecognizedTags = [...new Set(unrecognized.map((w) => /<(\w+)>/.exec(w)?.[1]))];
  console.log(`\nSkipped files: ${skippedFiles}; skipped components: ${skippedComponents}`);
  console.log(`Warnings: ${allWarnings.length} (${unrecognized.length} unrecognized-field, tags: ${unrecognizedTags.join(', ') || 'none'})`);
  const nonUnrec = allWarnings.filter((w) => !w.includes('unrecognized field'));
  if (nonUnrec.length) {
    console.log('Non-trivial warnings (first 30):');
    for (const w of nonUnrec.slice(0, 30)) console.log(`  - ${w}`);
    if (nonUnrec.length > 30) console.log(`  ... and ${nonUnrec.length - 30} more`);
  }

  const totalAttempted = allPresets.length + skippedComponents;
  const skipPct = totalAttempted ? (100 * skippedComponents) / totalAttempted : 0;
  if (skippedFiles > 0 || skipPct > 5) {
    console.error(`\nWARNING: skip rate too high (${skipPct.toFixed(1)}% components, ${skippedFiles} files) — investigate.`);
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
