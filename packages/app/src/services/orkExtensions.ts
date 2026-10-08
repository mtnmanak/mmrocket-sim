import type { RocketTree } from '@online-openrocket/engine';
import { parseXml, type XmlElement } from './xmlParse.js';

/** Separate from the inflated-file cap: retained opaque payload survives autosave.
 * Count UTF-8 bytes across ALL simulations, not characters or per-extension sizes. */
export const MAX_SIMULATION_EXTENSION_BYTES = 1024 * 1024;
const SIZE_REFUSAL = 'Simulation extension XML exceeds the limit of 1,048,576 bytes total. '
  + 'The file was not opened or saved. Reduce the extensions in desktop OpenRocket and try again.';

interface ExtensionSimulation {
  /** File configuration id only; never an editor component id. */
  configId: string | null;
  /** The configuration-less import's first simulation and same-id siblings follow the minted default. */
  defaultSimulation?: true;
  name: string | null;
  xml: string[];
}
type ExtensionTree = RocketTree & { orkSimulationExtensions?: ExtensionSimulation[] };

export function hasSimulationExtensions(tree: RocketTree, configId?: string): boolean {
  return !!(tree as ExtensionTree).orkSimulationExtensions?.some(g =>
    g.xml.length && (configId === undefined || g.configId === configId));
}

function addBytes(total: number, xml: string): number {
  // Check length before encoding, so a hostile string cannot force a huge allocation.
  if (xml.length > MAX_SIMULATION_EXTENSION_BYTES) throw new Error(SIZE_REFUSAL);
  total += new TextEncoder().encode(xml).byteLength;
  if (total > MAX_SIMULATION_EXTENSION_BYTES) throw new Error(SIZE_REFUSAL);
  return total;
}

/** Lexical offsets only; parseXml remains the well-formedness authority. A DOM
 * serializer would normalize CRLF, quotes, entities and CDATA. Skip comments,
 * CDATA and processing instructions, and respect quoted > in start tags.
 * Iterative even for deeply nested untrusted input; never interpret payload. */
export function extensionXmlBySimulation(xml: string): string[][] {
  const result: string[][] = [];
  const stack: string[] = [];
  let simulation: string[] | undefined;
  let extensionStart = -1;
  let extensionDepth = -1;
  let total = 0;
  let i = 0;
  while ((i = xml.indexOf('<', i)) !== -1) {
    const start = i;
    const terminator = xml.startsWith('<!--', i) ? '-->'
      : xml.startsWith('<![CDATA[', i) ? ']]>' : xml.startsWith('<?', i) ? '?>' : null;
    if (terminator) {
      const end = xml.indexOf(terminator, i + 2);
      if (end < 0) break; // The XML parser will refuse the malformed input.
      i = end + terminator.length;
      continue;
    }
    let quote = '';
    for (++i; i < xml.length; i++) {
      const ch = xml[i]!;
      if (quote) { if (ch === quote) quote = ''; }
      else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '>') break;
    }
    if (i === xml.length) break;
    const end = ++i;
    const token = xml.slice(start, end);
    const match = /^<\/?([^\s/>]+)/.exec(token);
    if (!match || token.startsWith('<!')) continue;
    const tag = match[1]!;
    const closing = token.startsWith('</');
    const selfClosing = /\/\s*>$/.test(token);
    if (!closing) {
      if (tag === 'simulation' && stack.length === 2 && stack[0] === 'openrocket' && stack[1] === 'simulations') {
        simulation = [];
        result.push(simulation);
      }
      // Keep the outermost block if an unknown extension itself nests one.
      // This also finds extensions inside unknown wrappers under a simulation.
      if (simulation && tag === 'extension' && extensionStart < 0) {
        extensionStart = start;
        extensionDepth = stack.length;
      }
      if (!selfClosing) stack.push(tag);
    } else stack.pop();
    if ((closing || selfClosing) && extensionStart >= 0 && stack.length === extensionDepth) {
      const raw = xml.slice(extensionStart, end);
      total = addBytes(total, raw);
      simulation!.push(raw);
      extensionStart = -1;
    }
    if ((closing || selfClosing) && tag === 'simulation' && stack.length === 2) simulation = undefined;
  }
  return result;
}

export function preserveSimulationExtensions(
  tree: RocketTree, raw: string[][], sims: XmlElement[], chosenConfigId: string | null,
  hasConfigurations: boolean, notes: string[],
): RocketTree {
  const extensions = sims.flatMap(s => Array.from(s.querySelectorAll('extension')));
  if (!extensions.length) return tree;
  const kinds = new Set<string>();
  let enabled = 0;
  for (const ext of extensions) {
    const id = ext.getAttribute('extensionid') ?? '';
    const normalized = id.replace(/^net\.sf\.openrocket\./, 'info.openrocket.core.');
    if (normalized === 'info.openrocket.core.simulation.extension.impl.ScriptingExtension') {
      // ConfigHandler's later entries replace earlier entries of the same key.
      const entries = Array.from(ext.querySelectorAll(':scope > entry')).reverse();
      const languageEntry = entries.find(e => e.getAttribute('key') === 'language');
      const language = languageEntry?.getAttribute('type') === 'string'
        ? languageEntry.textContent?.trim() || 'JavaScript' : 'JavaScript';
      kinds.add(`${language.slice(0, 100)} script`);
      const enabledEntry = entries.find(e => e.getAttribute('key') === 'enabled');
      if (enabledEntry?.getAttribute('type') === 'boolean'
        && enabledEntry.textContent?.trim().toLowerCase() === 'true') enabled++;
    } else if (normalized === 'info.openrocket.core.simulation.extension.impl.JavaCode') kinds.add('Java code');
    else if (normalized === 'info.openrocket.core.simulation.extension.example.AirStart') kinds.add('Air-start');
    else kinds.add(id ? id.slice(0, 160) : 'unknown extension');
  }
  notes.push(`This file contains ${extensions.length} simulation extension${extensions.length === 1 ? '' : 's'} `
    + `(${[...kinds].join(', ')}): the app keeps them when you save as .ork but does not run them; flights here run without them.`
    + (enabled ? ` ${enabled} script${enabled === 1 ? ' is' : 's are'} enabled in the file: desktop OpenRocket would run `
      + `them if trusted on that computer; the app's numbers may differ.` : ''));
  const firstId = sims[0]?.querySelector(':scope > conditions > configid')?.textContent || null;
  const groups = sims.map((sim, i): ExtensionSimulation => ({
    configId: sim.querySelector(':scope > conditions > configid')?.textContent || chosenConfigId,
    ...(!hasConfigurations && (sim.querySelector(':scope > conditions > configid')?.textContent || null) === firstId
      ? { defaultSimulation: true } : {}),
    name: sim.querySelector(':scope > name')?.textContent ?? null,
    xml: raw[i] ?? [],
  }));
  // Retain non-extension siblings sharing an id as separate simulations too:
  // attaching a scripted run to a previously plain run changes desktop physics.
  const owners = new Set(groups.filter(g => g.xml.length).map(g => g.configId));
  return { ...tree, orkSimulationExtensions: groups.filter(g => owners.has(g.configId)) } as ExtensionTree;
}

/** Revalidate raw XML from autosave before inserting it into an output file.
 * A corrupt session must never turn a stored string into arbitrary sibling XML. */
export function preservedSimulationExtensions(tree: RocketTree): readonly ExtensionSimulation[] {
  const groups = (tree as ExtensionTree).orkSimulationExtensions;
  if (groups === undefined) return [];
  if (!Array.isArray(groups)) throw new Error('Stored simulation extensions are invalid; the file was not saved.');
  let total = 0;
  for (const group of groups) {
    if (!group || (group.configId !== null && typeof group.configId !== 'string')
      || (group.name !== null && typeof group.name !== 'string') || !Array.isArray(group.xml)
      || (group.defaultSimulation !== undefined && group.defaultSimulation !== true)) {
      throw new Error('Stored simulation extensions are invalid; the file was not saved.');
    }
    for (const raw of group.xml) {
      if (typeof raw !== 'string') throw new Error('Stored simulation extensions are invalid; the file was not saved.');
      total = addBytes(total, raw);
      const wrapped = `<openrocket><simulations><simulation>${raw}</simulation></simulations></openrocket>`;
      const slices = extensionXmlBySimulation(wrapped);
      if (slices.length !== 1 || slices[0]?.length !== 1 || slices[0][0] !== raw) {
        throw new Error('Stored simulation extension XML is invalid; the file was not saved.');
      }
      parseXml(raw, 'Stored simulation extension XML is invalid; the file was not saved.');
    }
  }
  return groups;
}

export function simulationExtensionLossNotes(tree: RocketTree, format: '.rkt' | '.CDX1'): string[] {
  return preservedSimulationExtensions(tree).some(g => g.xml.length)
    ? [`Simulation extensions are not carried in ${format}. Save a .ork file to keep them for desktop OpenRocket.`] : [];
}
