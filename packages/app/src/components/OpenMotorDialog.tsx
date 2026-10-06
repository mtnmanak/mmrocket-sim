import { useId, useRef, useState } from 'react';
import { Modal } from './Modal.js';
import { describeRow, matchingExMotors } from '../services/motorMatch.js';
import { importMotorFiles } from '../services/importMotorFiles.js';
import { loadExMotors, type ExMotor } from '../services/exMotors.js';
import type { OpenMotorChoice, OpenMotorIdentity } from '../services/openMotorChoices.js';

export function OpenMotorDialog({ identities, onApply, onLater }: {
  identities: OpenMotorIdentity[];
  onApply: (choices: Record<string, OpenMotorChoice>) => Promise<void>;
  onLater: () => void;
}) {
  const id = useId();
  const [choices, setChoices] = useState<Record<string, OpenMotorChoice>>(() =>
    Object.fromEntries(identities.map(g => [g.key, { kind: 'catalogue', motor: g.candidates[0]! }])));
  const [library, setLibrary] = useState<ExMotor[]>(loadExMotors);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const importingFor = useRef<OpenMotorIdentity | null>(null);
  const pending = useRef(false);
  const choose = (key: string, choice: OpenMotorChoice) => setChoices(prev => ({ ...prev, [key]: choice }));
  const later = () => { if (!pending.current) onLater(); };
  const run = async (action: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try { await action(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { pending.current = false; setBusy(false); }
  };
  return (
    <Modal label="Choose motors for this file" onClose={later}>
      <h2>Choose motors for this file</h2>
      <div className="open-motor-choices" aria-busy={busy}>
      {identities.map((group, index) => {
        const selected = choices[group.key];
        const exMatches = matchingExMotors(group.ref, library);
        return (
          <fieldset key={group.key} disabled={busy}>
            <legend>{group.ref.manufacturer} {group.ref.designation}</legend>
            <p>The file names {group.ref.manufacturer} {group.ref.designation}. The motor database has no {group.ref.manufacturer} {group.ref.designation}.</p>
            <p>{group.carriedBy.join('; ')}</p>
            {group.candidates.map(motor => (
              <label key={motor.motorId}>
                <input type="radio" name={`${id}-${index}`} checked={selected?.kind === 'catalogue' && selected.motor.motorId === motor.motorId}
                  onChange={() => choose(group.key, { kind: 'catalogue', motor })} />
                {describeRow(motor, group.candidates)}
              </label>
            ))}
            {exMatches.map(motor => (
              <label key={motor.motorId}>
                <input type="radio" name={`${id}-${index}`} checked={selected?.kind === 'ex' && selected.motor.motorId === motor.motorId}
                  onChange={() => choose(group.key, { kind: 'ex', motor })} />
                {motor.realManufacturer} {motor.designation} (EX, {motor.diameter} mm)
              </label>
            ))}
            <label>
              <input type="radio" name={`${id}-${index}`} checked={selected?.kind === 'empty'}
                onChange={() => choose(group.key, { kind: 'empty' })} />
              Leave the mount empty
            </label>
            <button type="button" className="file-btn" onClick={() => {
              importingFor.current = group;
              fileInput.current?.click();
            }}>Import .eng/.rse…</button>
          </fieldset>
        );
      })}
      </div>
      <input ref={fileInput} type="file" accept=".eng,.rse,.txt" multiple hidden aria-label="Import motor files"
        onChange={e => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (!files.length) return;
          void run(async () => {
            const result = await importMotorFiles(files);
            setError(result.error);
            setNotice(result.notice);
            if (!result.write) return;
            setLibrary(result.write.motors);
            const group = importingFor.current;
            const matches = group ? matchingExMotors(group.ref, result.write.motors) : [];
            // @atestani TRF #162, Eric 2026-10-06: use the open's EX rule, including ambiguity.
            if (group && matches.length === 1) choose(group.key, { kind: 'ex', motor: matches[0]! });
            else setNotice([result.notice, matches.length ? 'Several imported motors match. Choose one above.'
              : 'No imported motor matches this file’s maker, designation and diameter.'].filter(Boolean).join(' '));
          });
        }} />
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="file-btn" disabled={busy} onClick={() => { void run(() => onApply(choices)); }}>Apply</button>
        <button type="button" className="file-btn" disabled={busy} onClick={later}>Decide later</button>
      </div>
    </Modal>
  );
}
