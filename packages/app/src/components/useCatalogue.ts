import { useSyncExternalStore } from 'react';
import {
  getCatalogue, getCatalogueOverlay, subscribeCatalogue, type CatalogueOverlay, type MotorDbEntry,
} from '../services/motorDb.js';

/**
 * The effective motor catalogue — shipped rows plus any live overlay — as a
 * React value that re-renders when a check installs or discards an overlay.
 * motorDb.ts owns the state; this is only the subscription.
 */
export function useCatalogue(): MotorDbEntry[] {
  return useSyncExternalStore(subscribeCatalogue, getCatalogue, getCatalogue);
}

export function useCatalogueOverlay(): CatalogueOverlay | null {
  return useSyncExternalStore(subscribeCatalogue, getCatalogueOverlay, getCatalogueOverlay);
}
