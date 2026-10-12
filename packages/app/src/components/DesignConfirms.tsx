import { Note } from './Note.js';
import type { ReactNode } from 'react';
import type { RocketTree } from '@online-openrocket/engine';
import type { FormatLossReport, LossyFormat } from '../services/formatLoss.js';
import type { ImportedDesign } from '../services/importApply.js';
import type { SaveOutcome } from '../services/saveFile.js';
import type { ShroudCandidate } from '../tree/shroudConvert.js';
import { FormatLossDialog } from './FormatLossDialog.js';
import { Icon } from './Icon.js';
import { Modal } from './Modal.js';

interface DesignConfirmsProps {
  tree: RocketTree;
  unprotected?: boolean;
  lossDialog: { report: FormatLossReport; confirm: boolean } | null;
  setLossDialog: (value: null) => void;
  saveLossy: (format: LossyFormat, report: FormatLossReport) => void;
  confirmNew: boolean;
  setConfirmNew: (value: boolean) => void;
  replaceLoss: string | null;
  startNewDesign: () => void;
  onSaveOrk: () => Promise<SaveOutcome | { kind: 'failed' }>;
  pendingOpen: File | null;
  setPendingOpen: (value: null) => void;
  onOpenOrk: (file: File) => Promise<void>;
  shareOffer: ImportedDesign | null;
  setShareOffer: (value: null) => void;
  applyImported: (design: ImportedDesign) => Promise<void>;
  shroudPrompt: ShroudCandidate[] | null;
  setShroudPrompt: (value: null) => void;
  hasOpenMotorQuestion: boolean;
  onConvertShrouds: () => void;
  children?: ReactNode;
}

/**
 * What a replacement loses — the generic consequence AND, when the last save
 * was lossy, the exact items that file did not keep — is ONE block directly
 * above the Save / Discard buttons (D7 §5, G21), not a red paragraph with a
 * second note between it and the action.
 *
 * The five design confirmations, kept in their original order with the motor
 * question between New and Open. App owns state; markup and save-before-open
 * cancellation semantics stay together (audit 2026-10-11, S2-8).
 */
export function DesignConfirms({ tree, unprotected = false, lossDialog, setLossDialog, saveLossy, confirmNew, setConfirmNew,
  replaceLoss, startNewDesign, onSaveOrk, pendingOpen, setPendingOpen, onOpenOrk, shareOffer, setShareOffer,
  applyImported, shroudPrompt, setShroudPrompt, hasOpenMotorQuestion, onConvertShrouds, children }: DesignConfirmsProps) {
  return <>
      {lossDialog && <FormatLossDialog report={lossDialog.report} confirm={lossDialog.confirm}
        onClose={() => setLossDialog(null)}
        onSave={() => saveLossy(lossDialog.report.format, lossDialog.report)}
        onSaveOrk={() => { setLossDialog(null); void onSaveOrk(); }} />}
      {confirmNew && (
        <Modal label="Start a new design" onClose={() => setConfirmNew(false)}>
          <h2>Start a new design?</h2>
          <Note tier={unprotected || replaceLoss ? 'danger' : 'information'}>
            <p className="note-para">
              This clears “{tree.name ?? 'the current rocket'}” — all components,
              overrides and the current simulation. Make sure it's saved as an
              .ork file first: Ctrl+Z brings the components back, but not the
              motors, the flight configurations, the Measured mass &amp; CG, the
              Geodetic calculations choice or the flight.
            </p>
            {replaceLoss && <p className="replacement-loss note-para">{replaceLoss}</p>}
          </Note>
          <div className="modal-actions">
            <button className="file-btn" onClick={() => { void onSaveOrk(); }}>
              <Icon name="save" /> Save .ork first
            </button>
            <button
              className="file-btn modal-danger"
              onClick={startNewDesign}
            >
              Discard &amp; start new
            </button>
            <button className="file-btn" onClick={() => setConfirmNew(false)}>Cancel</button>
          </div>
        </Modal>
      )}
      {children}
      {pendingOpen && (
        <Modal label="Unsaved changes" onClose={() => setPendingOpen(null)}>
          <h2>Save “{tree.name ?? 'the current rocket'}” first?</h2>
          <Note tier="danger">
            <p className="note-para">
              Opening “{pendingOpen.name}” replaces what is on screen, and
              “{tree.name ?? 'the current rocket'}” has changes that are not in any
              file you have saved. There is one autosave slot and the new design
              takes it, so those changes would be gone — Ctrl+Z does not reach
              across a file open.
            </p>
            {replaceLoss && <p className="replacement-loss note-para">{replaceLoss}</p>}
          </Note>
          <div className="modal-actions">
            <button
              className="file-btn"
              onClick={() => {
                const f = pendingOpen;
                void (async () => {
                  const out = await onSaveOrk();
                  // Backing out of the Save-As picker must NOT then open the
                  // file — that would discard the work the user just tried
                  // to protect — and nor must a save that failed. Leave the
                  // prompt up and let them decide.
                  if (out.kind === 'cancelled' || out.kind === 'failed') return;
                  setPendingOpen(null);
                  void onOpenOrk(f);
                })();
              }}
            >
              <Icon name="save" /> Save .ork, then open
            </button>
            <button
              className="file-btn modal-danger"
              onClick={() => {
                const f = pendingOpen;
                setPendingOpen(null);
                void onOpenOrk(f);
              }}
            >
              Open without saving
            </button>
            <button className="file-btn" onClick={() => setPendingOpen(null)}>Cancel</button>
          </div>
        </Modal>
      )}
      {shareOffer && (
        <Modal label="Open design from link" onClose={() => setShareOffer(null)}>
          <h2>Open design from this link?</h2>
          <Note tier={unprotected || replaceLoss ? 'danger' : 'information'}>
            <p className="note-para">
              This link opens “{shareOffer.name}”. Your current design
              “{tree.name ?? 'Rocket'}” will be replaced. If you want to keep
              it, save it as an .ork file first — declining simply drops the
              link. Ctrl+Z will not put it back: the undo history starts over
              from the linked design.
            </p>
            {replaceLoss && <p className="replacement-loss note-para">{replaceLoss}</p>}
          </Note>
          <div className="modal-actions">
            <button className="file-btn" onClick={() => { void onSaveOrk(); }}>
              <Icon name="save" /> Save mine first
            </button>
            <button
              className="file-btn modal-danger"
              onClick={() => {
                const offered = shareOffer;
                setShareOffer(null);
                void applyImported(offered);
              }}
            >
              Open “{shareOffer.name}”
            </button>
            <button className="file-btn" onClick={() => setShareOffer(null)}>Keep my design</button>
          </div>
        </Modal>
      )}
      {shroudPrompt && !hasOpenMotorQuestion && (
        <Modal label="Convert camera shrouds" onClose={() => setShroudPrompt(null)}>
          <h2>Camera shroud detected</h2>
          <p>
            It looks like this file has {shroudPrompt.length === 1
              ? <>a camera shroud modeled as a one-fin freeform set (<strong>{shroudPrompt[0]!.name}</strong>)</>
              : <>{shroudPrompt.length} camera shrouds modeled as one-fin freeform sets ({shroudPrompt.map((s) => `“${s.name}”`).join(', ')})</>}.
            Convert {shroudPrompt.length === 1 ? 'it' : 'them'} to this app&apos;s native
            camera-shroud component? The native component charges the shroud&apos;s
            frontal-area drag and takes its as-built mass in place of the fin set&apos;s
            computed one; it still flies as a slender one-panel strake, so its small
            lift stays —
            dimensions carry over, and you can fine-tune shape and as-built mass
            in its properties. (Ctrl+Z undoes the conversion.)
          </p>
          <div className="modal-actions">
            <button
              className="file-btn"
              onClick={onConvertShrouds}
            >
              Convert to camera shroud
            </button>
            <button className="file-btn" onClick={() => setShroudPrompt(null)}>
              Keep as freeform fin
            </button>
          </div>
        </Modal>
      )}
  </>;
}
