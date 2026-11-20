import { useState } from 'react';
import { isRequestedReloadHeld } from '../services/swUpdate.js';

/** Download failures must not bypass the update hold protecting this tab. */
export function ReloadPageButton() {
  const [saveFirst, setSaveFirst] = useState(false);
  return <>
    <button className="file-btn" onClick={() => {
      if (isRequestedReloadHeld()) { setSaveFirst(true); return; }
      window.location.reload();
    }}>↻ Reload the page</button>
    <span role="status">{saveFirst && <> This tab has work to keep. Save this tab&rsquo;s
      design as an .ork file before choosing Reload anyway, or finish or cancel the pending open.
      Saving does not clear an autosave conflict or storage failure. Reloading can lose
      this tab&rsquo;s design because another tab may have replaced the shared autosave.</>}</span>
    {saveFirst && <button className="file-btn" onClick={() => window.location.reload()}>Reload anyway</button>}
  </>;
}
