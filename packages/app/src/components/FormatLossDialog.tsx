import { Modal } from './Modal.js';
import { formatExtension, type FormatLossReport } from '../services/formatLoss.js';

export function FormatLossDialog({ report, confirm, onSave, onSaveOrk, onClose }: {
  report: FormatLossReport; confirm: boolean;
  onSave: () => void; onSaveOrk: () => void; onClose: () => void;
}) {
  const ext = formatExtension(report.format);
  const title = report.refused ? `Can't save as ${ext}` : confirm ? `Save as ${ext}?` : `What this ${ext} can't hold`;
  return <Modal label={title} onClose={onClose}>
    <h2>{title}</h2>
    {report.refused ? <p>{report.refused}</p> : <>
      <p>A {report.format === 'rkt' ? 'RockSim' : 'RASAero II'} file cannot hold everything in this design. These will not be in the file:</p>
      <ul className="format-loss-list">{report.losses.map(loss => <li key={loss}>{loss}</li>)}</ul>
    </>}
    <div className="modal-actions">
      <button className="file-btn" onClick={onSaveOrk}>{confirm || report.refused ? 'Save .ork instead' : 'Save .ork'}</button>
      {confirm && !report.refused && <button className="file-btn modal-danger" onClick={onSave}>Save {ext} anyway</button>}
      <button className="file-btn" onClick={onClose}>{confirm && !report.refused ? 'Cancel' : 'Close'}</button>
    </div>
  </Modal>;
}
