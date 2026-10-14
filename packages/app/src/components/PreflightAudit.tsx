import type { PreflightAuditResult } from '../services/preflightAudit.js';
import { usePrefs } from '../prefs/PrefsContext.js';
import { fmtSi } from '../prefs/units.js';
import { Note } from './Note.js';

export function PreflightAudit({ result, onSelectPart }: {
  result: PreflightAuditResult; onSelectPart: (id: string) => void;
}) {
  const { prefs } = usePrefs();
  const mass = (kg: number) => `${fmtSi('mass', prefs.units.mass, kg)} ${prefs.units.mass}`;
  return <section className="preflight-audit" aria-labelledby="preflight-heading">
    <h3 id="preflight-heading">Preflight design check</h3>
    <p>Advice only. This check changes nothing and does not block Launch. It checks a few design settings; it does not establish flight safety.</p>
    {result.findings.length ? <ul className="preflight-findings">
      {result.findings.map(finding => <li key={finding.id}>
        <Note tier={finding.tier} className="file-note">
          <strong>{finding.part.name}</strong>: {finding.reason}
          {finding.mass && <> Override: {mass(finding.mass.overrideKg)}; computed: {mass(finding.mass.computedKg)}.</>}
          {' '}{finding.target === 'design-notes'
            ? <a className="file-btn preflight-select" href="#design-notes">View Design notes</a>
            : <button type="button" className="file-btn preflight-select" onClick={() => onSelectPart(finding.part.id)}>
              {finding.target === 'mass-note' ? 'View mass note for' : 'Select'} “{finding.part.name}”
            </button>}
        </Note>
      </li>)}
    </ul> : <p>No findings from these checks.</p>}
    {result.uncheckedMassParts.length > 0 && <Note tier="information" as="p">
      Computed mass unavailable — the app could not compare {result.uncheckedMassParts.map(p => p.name).join(', ')}.
    </Note>}
    {result.unknownMaterialCount > 0 && <Note tier="information" as="p">
      {result.unknownMaterialCount} material {result.unknownMaterialCount === 1 ? 'density has' : 'densities have'} no known family; the app did not check {result.unknownMaterialCount === 1 ? 'it' : 'them'}.
    </Note>}
    <details className="preflight-limits">
      <summary>What this check covers</summary>
      <p>Own mass overrides below one tenth or above ten times computed mass, with a difference of at least 1 g;
        whole-airframe mass without a matching CG; nested mass overrides; and links to existing notes for covered mass overrides.
        Assembly replacements are not compared to shell mass.</p>
      <p>For a named material in the app’s material list, the density screening range runs from one tenth of its
        family’s lowest listed density to ten times its highest, using the part’s bulk, surface or line units.
        Custom or unnamed materials are not checked.</p>
      <p>Recovery checks find no parachute or streamer in the design, or a device set to Never in the active flight settings.
        They do not check whether electronics, an ejection charge, every separated stage, or a real recovery system will work.</p>
    </details>
  </section>;
}
