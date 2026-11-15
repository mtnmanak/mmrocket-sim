import { useEffect, useRef } from 'react';
import type { MountMotor } from '../model/design.js';
import type { otherMountPlan } from '../services/otherMountLoad.js';
import { noteField } from '../services/noteField.js';
import { usePrefs } from '../prefs/PrefsContext.js';
import { noticeQuantity } from '../prefs/units.js';
import { baseLabel } from '../services/unitText.js';

export function OtherMountOffer({ motor, plan, loaded, onLoad, onUndo, onDismiss }: {
  motor: MountMotor;
  plan: ReturnType<typeof otherMountPlan>;
  loaded: boolean;
  onLoad: () => void;
  onUndo: () => void;
  onDismiss: () => void;
}) {
  const { prefs } = usePrefs();
  const undoButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (loaded) undoButton.current?.focus();
  }, [loaded]);
  const dimension = (m: number) => noticeQuantity('motorDimensions', m, prefs.units);
  const count = plan.targets.length;
  const mounts = `${count} ${count === 1 ? 'mount' : 'mounts'}`;
  return <div className="other-mount-offer">
    {loaded ? <>
      <p>Loaded {noteField(baseLabel(motor.label))} into {mounts}.</p>
      <p>{plan.targets.map(t => `${noteField(t.name)}: ${noteField(t.loadLabel ?? motor.label)}`).join('; ')}.</p>
      <button ref={undoButton} className="file-btn" onClick={onUndo}>Undo</button>
      <button className="file-btn" onClick={onDismiss}>Dismiss</button>
    </> : <>
      <p>Also load {noteField(baseLabel(motor.label))} into the other {mounts} that {count === 1 ? 'fits' : 'fit'} (⌀{dimension(motor.spec.diameter)})?</p>
      <p>{plan.targets.map(t => `${noteField(t.name)}${t.replaces ? ` (replaces ${noteField(t.replaces)})` : ''}`).join(', ')}.</p>
      <p>{plan.targets.map(t => `${noteField(t.name)} will use ${noteField(t.loadLabel ?? motor.label)}`).join('; ')}.</p>
      <button className="file-btn" onClick={onLoad}>Load into {mounts}</button>
      <button className="file-btn" onClick={onDismiss}>No thanks</button>
      {plan.skipped.length > 0 && <p>Skipped: {plan.skipped.map(t => `${noteField(t.name)} (${t.reason === 'narrow'
        ? `too narrow for ⌀${dimension(motor.spec.diameter)}` : t.reason === 'short'
          ? `too short for ${noticeQuantity('motorDimensions', motor.spec.length, prefs.units, { against: t.limit })}` : 'a different bore'})`).join(', ')}.</p>}
    </>}
  </div>;
}
