# MMRocket Sim

Formerly "Online OpenRocket" — renamed 2026-08 (same app; the name now makes clear this
is an independent derivative of OpenRocket, not the OpenRocket project's own).

A browser-based re-creation of [OpenRocket](https://openrocket.info/) — model-rocketry
design and flight simulation with the real OpenRocket 24.12 physics kernel compiled to
JavaScript and verified bit-for-bit against the desktop application. Design, simulate,
fly: nothing to install, works offline as a PWA.

**Live app:** https://mmrsim.mountainmanrockets.com

Part of [mountainmanrockets.com](https://www.mountainmanrockets.com)'s online tools.

## Feedback

Bug reports and feature requests for this tool — and for every mountainmanrockets.com
tool — go to one central public tracker,
[mountainmanrockets-feedback](https://github.com/mtnmanak/mountainmanrockets-feedback/issues):

- **[Report a bug](https://github.com/mtnmanak/mountainmanrockets-feedback/issues/new?template=bug-report.yml)**
- **[Request a feature](https://github.com/mtnmanak/mountainmanrockets-feedback/issues/new?template=feature-request.yml)**
  — content requests count too ("write up how to assemble an Aerotech RMS motor")
- **[Browse this tool's open issues](https://github.com/mtnmanak/mountainmanrockets-feedback/issues?q=is%3Aopen+label%3Atool%3Ammrocket-sim)**

Both forms ask which tool the report is about — pick **MMRocket Sim**. That
dropdown is what routes the issue, and GitHub can't preselect it from a link, so the
🐞 Feedback button in the app opens the same bug form with only the app version
filled in for you.

No GitHub account? Email **admin@mountainmanrockets.com** and I'll file it for you.
(Reading the tracker needs no account; filing does.)

**This repository's Issues tab is disabled on purpose** — all reports live in the one
tracker above, so nothing gets filed in two places.

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
