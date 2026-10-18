import { useEffect, useState } from 'react';
import { readUserMaterials, USER_MATERIALS_CHANGED, USER_MATERIALS_KEY } from '../services/userMaterials.js';

/** Refresh both other selectors in this tab and other tabs' library edits. */
export function useUserMaterials() {
  const [state, setState] = useState(readUserMaterials);
  useEffect(() => {
    const refresh = () => setState(readUserMaterials());
    const storage = (e: StorageEvent) => { if (e.key === null || e.key === USER_MATERIALS_KEY) refresh(); };
    window.addEventListener(USER_MATERIALS_CHANGED, refresh);
    window.addEventListener('storage', storage);
    return () => {
      window.removeEventListener(USER_MATERIALS_CHANGED, refresh);
      window.removeEventListener('storage', storage);
    };
  }, []);
  return state;
}
