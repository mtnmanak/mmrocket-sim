# Online OpenRocket

A browser-based re-creation of [OpenRocket](https://openrocket.info/) — model-rocketry
design and flight simulation with the real OpenRocket 24.12 physics kernel compiled to
JavaScript and verified bit-for-bit against the desktop application. Design, simulate,
fly: nothing to install, works offline as a PWA.

**Live app:** https://online-open-rocket.pages.dev
(after DNS cutover: https://openrocket.mountainmanrockets.com)

Part of [mountainmanrockets.com](https://www.mountainmanrockets.com)'s online tools.

**Found a bug or want a feature?** File it at
[mountainmanrockets-feedback](https://github.com/mtnmanak/mountainmanrockets-feedback/issues)
— the public tracker for the site and all its tools — or use the 🐞 Feedback button in
the app itself.

## Licensing

GPL-3.0-or-later, inherited from OpenRocket. The engine's physics kernel is carved from
the OpenRocket 24.12 source (`info.openrocket.core`) and compiled to JavaScript with
TeaVM; targeted modifications are documented in `engine-java/patches/LEDGER.md`.

## Repository layout

- `packages/engine` — the UI-free simulation engine (`@online-openrocket/engine`)
- `packages/app` — Vite + React front-end
- `engine-java/` — the TeaVM Java→JS kernel build (carve + patches + differential tests)
- `docs/` — plan, findings, user guide, session notes
- `validation/` — supersonic-aero validation harness and anchors

See `CLAUDE.md` for build commands and engine invariants.
