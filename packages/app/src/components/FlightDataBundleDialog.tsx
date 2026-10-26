import { useMemo, useRef, useState } from 'react';
import { strFromU8, zipSync } from 'fflate';
import { Modal } from './Modal.js';
import { Note } from './Note.js';
import { WeatherCredit } from './WeatherCredit.js';
import { formatRunLabel, describeRunChanges } from '../services/simReport.js';
import { flightDataBundleContents, flightDataBundleFiles, flightDataBundleLongitudeComparison, flightDataBundleWeatherCredit, type FlightDataBundleInput } from '../services/flightDataBundle.js';
import { readDecimal } from '../prefs/units.js';
import { saveFile } from '../services/saveFile.js';

export type FlightDataBundleSource = Omit<FlightDataBundleInput, 'includeCoordinates' | 'measurements' | 'attachment'>;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const NUMBER_ERROR = 'Enter zero or a positive number (1.5 or 1,5), without thousands separators, or leave it blank.';
const numeric = (v: string) => {
  const n = readDecimal(v);
  return n !== null && n >= 0 ? n : null;
};
const invalid = (v: string) => {
  if (v.trim() === '') return false;
  const n = readDecimal(v);
  return n === null || n < 0;
};

export function FlightDataBundleDialog({ source, onClose }: { source: FlightDataBundleSource; onClose: () => void }) {
  const [includeCoordinates, setIncludeCoordinates] = useState(false);
  const [altimeterType, setAltimeterType] = useState('');
  const [notes, setNotes] = useState('');
  const [apogee, setApogee] = useState('');
  const [velocity, setVelocity] = useState('');
  const [mass, setMass] = useState('');
  const [attachment, setAttachment] = useState<FlightDataBundleInput['attachment']>();
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const readId = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const saving = useRef(false);
  const firstInvalid = useRef<HTMLInputElement | null>(null);
  const weatherCredit = flightDataBundleWeatherCredit(source);
  const longitudeComparison = flightDataBundleLongitudeComparison(source);
  const preview = useMemo(() => {
    try {
      return { ...flightDataBundleContents({ ...source, includeCoordinates, measurements: {
        altimeterType, apogeeM: numeric(apogee), maxVelocityMs: numeric(velocity), liftoffMassKg: numeric(mass), notes,
      }, ...(attachment ? { attachment } : {}) }), error: '' };
    } catch (e) { return { files: null, filename: '', notices: [], error: e instanceof Error ? e.message : String(e) }; }
  }, [source, includeCoordinates, altimeterType, apogee, velocity, mass, notes, attachment]);
  const fields = [
    { label: 'Measured apogee above launch (m)', value: apogee, set: setApogee },
    { label: 'Measured max velocity (m/s)', value: velocity, set: setVelocity },
    { label: 'As-flown liftoff mass, motor in (kg)', value: mass, set: setMass },
  ];
  const download = async () => {
    if (saving.current || reading) return;
    setError(''); setStatus('');
    if (fields.some(f => invalid(f.value))) {
      setError(NUMBER_ERROR);
      firstInvalid.current?.focus();
      return;
    }
    if (!preview.files) { setError(preview.error); firstInvalid.current?.focus(); return; }
    saving.current = true; setBusy(true);
    try {
      // Zip exactly the contents being previewed, including this manifest.
      const bytes = zipSync(preview.files);
      const outcome = await saveFile(new Blob([new Uint8Array(bytes)], { type: 'application/zip' }), {
        suggestedName: preview.filename, mime: 'application/zip', extensions: ['.zip'], description: 'Flight-data bundle',
      });
      if (outcome.kind !== 'cancelled') setStatus(outcome.kind === 'saved'
        ? 'ZIP saved. You can attach it to a message or forum post.'
        : `ZIP handed to the browser for download.${outcome.fellBack ? ` Save location changed: ${outcome.fellBack}` : ''} You can attach it to a message or forum post.`);
    } catch (e) { setError(`Could not save the ZIP: ${e instanceof Error ? e.message : String(e)}`); }
    finally { saving.current = false; setBusy(false); }
  };
  return <Modal label="Export flight-data bundle" onClose={onClose}>
    <div className="flight-bundle">
      <h2>Export flight-data bundle</h2>
      <p>Selected run: <strong>{formatRunLabel(source.run)}</strong>. Nothing is sent anywhere.
        Download one ZIP to attach to a message or forum post for the app owner.</p>
      <Note tier={source.changedSince?.length || longitudeComparison === 'different' ? 'caution' : 'information'} as="p">
        The design file is the current design.
        {source.changedSince === null ? ' Whether its simulation-relevant inputs match this run is unknown.' : source.changedSince.length
          ? ` ${describeRunChanges(source.changedSince, 'since this run')}; its results describe the earlier rocket.`
          : ' Simulation-relevant inputs match the selected run; this comparison excludes site longitude and design names or appearance.'}
        {longitudeComparison === 'different' && " The current design's site longitude differs from the selected run's recorded site."}
        {' '}The app does not retain an earlier design file with each run.
      </Note>
      <p>{source.run.exportContext ? 'Launch settings and the weather receipt are from the selected run. The receipt may differ from the launch settings after manual edits. A null weather receipt means none was recorded.'
        : 'Launch settings and weather were not recorded with this older run. Their bundle entry is null; current settings remain in the current design file.'}
        {' '}{source.result ? 'Available per-step data may be sampled.' : 'Only the saved summary is available; raw time series are not saved in run history.'}</p>
      {weatherCredit.openMeteo && <p><WeatherCredit geoNames={includeCoordinates && weatherCredit.geoNames} /></p>}
      <form noValidate onSubmit={e => { e.preventDefault(); void download(); }}>
        <fieldset disabled={busy}>
          <legend>What you measured (optional)</legend>
          <p>Leave unknown values blank. These values do not change the design or simulation.</p>
          <label>Altimeter type / model<input value={altimeterType} onChange={e => setAltimeterType(e.target.value)} /></label>
          {fields.map((f, i) => <label key={f.label}>{f.label}<input type="text" inputMode="decimal" value={f.value}
            ref={el => { if (invalid(f.value) && !fields.slice(0, i).some(p => invalid(p.value))) firstInvalid.current = el; }}
            aria-invalid={invalid(f.value)} aria-describedby={invalid(f.value) ? 'bundle-number-error' : undefined}
            onChange={e => f.set(e.target.value)} /></label>)}
          {fields.some(f => invalid(f.value)) && <p id="bundle-number-error">{NUMBER_ERROR}</p>}
          <label>Notes<textarea className="resize-none" rows={5} value={notes} onChange={e => setNotes(e.target.value)} /></label>
          <label>Data-log file (optional, up to 25 MiB)<input ref={fileInput} type="file" disabled={reading} onChange={e => { void (async () => {
            const input = e.currentTarget;
            const file = input.files?.[0];
            const id = ++readId.current;
            setAttachment(undefined); setError('');
            if (!file) return;
            if (file.size > MAX_ATTACHMENT_BYTES) { setError('Choose a data-log file no larger than 25 MiB.'); input.value = ''; return; }
            setReading(true);
            try {
              const bytes = new Uint8Array(await file.arrayBuffer());
              if (readId.current === id) setAttachment({ name: file.name, bytes });
            } catch { if (readId.current === id) {
              input.value = '';
              setError('Could not read that file. Choose it again or leave it out.');
            } }
            finally { if (readId.current === id) setReading(false); }
          })(); }} /></label>
          <p role="status" className={reading ? undefined : 'sr-only'}>{reading ? 'Reading the data-log file…' : ''}</p>
          {attachment && <p>{attachment.name} ({attachment.bytes.byteLength} bytes) <button type="button" className="file-btn"
            onClick={() => { ++readId.current; setAttachment(undefined); if (fileInput.current) fileInput.current.value = ''; }}>Leave out attachment</button></p>}
          <label className="bundle-coordinate-choice"><input type="checkbox" checked={includeCoordinates}
            onChange={e => setIncludeCoordinates(e.target.checked)} /> Include launch site coordinates</label>
          <p>{includeCoordinates ? 'Latitude and longitude are included in the design, recorded launch/weather data and available flight series.'
            : 'Structured latitude, longitude and weather place labels are left out of all bundle files. The design file then lacks its original site coordinates; enter them again before using it for another simulation. The site altitude stays in, because the flight depends on it, and so does any weather time zone.'}
            {' '}Design names, comments, your notes, and attachment contents are unchanged. Check them for location or personal details before sharing.</p>
        </fieldset>
        <h3>Inside this ZIP</h3>
        {preview.notices.length > 0 && <Note tier="caution">{preview.notices.map(n => <p key={n}>{n}</p>)}</Note>}
        <p>Expand each file to review its exact contents before downloading. JSON measurements use null for unknown values.
          {' '}The attachment is copied unchanged and is not displayed here.</p>
        {preview.files ? flightDataBundleFiles(!!source.result, attachment?.name).map(f => <details key={f.path}>
          <summary>{f.path} ({preview.files![f.path]!.byteLength} bytes)</summary>
          <p>{f.description}</p>
          {!f.path.startsWith('attachment/') && <pre tabIndex={0}>{strFromU8(preview.files![f.path]!)}</pre>}
        </details>) : <Note tier="information" as="p">Preview unavailable: {preview.error}</Note>}
        {error && <Note tier="information" as="p" role="alert">{error}</Note>}
        <p role="status">{status}</p>
        <div className="modal-actions">
          <button type="button" className="file-btn" onClick={onClose}>Close</button>
          <button type="submit" className="file-btn file-btn-primary" disabled={busy || reading} aria-busy={busy}>Download ZIP</button>
        </div>
      </form>
    </div>
  </Modal>;
}
