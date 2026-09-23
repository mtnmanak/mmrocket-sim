/**
 * App version — the single source of truth for the number the user sees.
 * Beta scheme (owner's rule): 0.NNN, incrementing NNN by 1 for every
 * released (pushed) build, until the first production release resets to
 * 1.0.0. The npm package versions stay independent (they're internal
 * workspace plumbing; npm requires strict semver).
 *
 * THIS FILE HOLDS APP_VERSION AND NOTHING ELSE; the changelog is in
 * changelog.ts (audit 2026-09-22, row 510). The header badge, the session
 * stamp (services/session.ts), the update check (services/versionCheck.ts)
 * and the drag-table export (services/dragTable.ts) all import APP_VERSION
 * at startup, and while the CHANGELOG array sat beside it — 461,213 bytes of
 * this file at v0.140 — every one of them pulled all of it into the entry
 * chunk the app must load and parse before it draws. Add nothing here that
 * startup does not need. And keep APP_VERSION's line in exactly its present
 * shape: the deploy workflow's version-pairing step and
 * scripts/package-dist.mjs read it from this file's text, not by importing
 * it, and so does the release helper that bumps it, which is kept outside
 * this repo (version.test.ts pins the shape).
 *
 * Release checklist: merge or close any open motors-refresh PR and rebuild
 * nozzles.json if the catalogue moved (2026-09-19 — `check-upstream` flags a
 * catalogue over 8 days old, and printed `ok` over a 14-day one before that
 * limit came down); then bump APP_VERSION, prepend a CHANGELOG entry in
 * changelog.ts, update /version.json at the repo root (version + released + a
 * short user-facing note — the site's online-tools page polls it to prompt
 * refreshes; the package script fails if it doesn't match APP_VERSION),
 * commit, push.
 *
 * ⚠ AND CHECK THE ENTRY'S OWN NUMBERS BEFORE PUSHING, claim by claim, against
 * the code — not against this file and not against the commit messages. Five of
 * the last ten releases have had to correct a published claim, and the v0.135
 * check caught fourteen, one of which was a guide paragraph that still stated a
 * rule the same release had deleted from the code.
 */

export const APP_VERSION = '0.141';
