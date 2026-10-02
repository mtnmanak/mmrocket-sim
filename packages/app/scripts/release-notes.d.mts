// Types for release-notes.mjs, which vite.config.ts imports (tsc reads no .mjs).
import type { Plugin } from 'vite';

export function escapeHtml(text: string): string;
export function releaseAnchor(version: string): string;
export function renderReleaseNotes(
  changelog: readonly { version: string; date: string; title: string; items: readonly string[] }[],
  preNote: string,
): string;
export const RELEASES_NAVIGATION: RegExp;
export const RELEASES_FILE: string;
export function releaseNotesPlugin(
  changelog: readonly { version: string; date: string; title: string; items: readonly string[] }[],
  preNote: string,
): Plugin;
