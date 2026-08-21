/**
 * App version + changelog — the single source of truth for what the user
 * sees. Beta scheme (owner's rule): 0.NNN, incrementing NNN by 1 for every
 * released (pushed) build, until the first production release resets to
 * 1.0.0. The npm package versions stay independent (they're internal
 * workspace plumbing; npm requires strict semver).
 *
 * Release checklist: bump APP_VERSION, prepend a CHANGELOG entry, update
 * /version.json at the repo root (version + released + a short user-facing
 * note — the owner's online-tools page polls it to prompt refreshes; the package
 * script fails if it doesn't match APP_VERSION), commit, push.
 */

export const APP_VERSION = '0.047';

export interface ChangelogEntry {
  version: string;
  /** ISO date of the release. */
  date: string;
  title: string;
  items: string[];
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: '0.047',
    date: '2026-08-21',
    title: 'A new name: MMRocket Sim',
    items: [
      'RENAMED: Online OpenRocket is now MMRocket Sim, at a new address — https://mmrsim.mountainmanrockets.com. Two honest reasons: "Online" undersold an app that works fully offline once loaded, and "OpenRocket" is the upstream project\'s name — this tool is proudly derived from OpenRocket 24.12 (and still says so, right under the logo), but it is not published by the OpenRocket project. Same app, same physics, same GPL source.',
      'The old address keeps working for now but shows a moved notice and no longer installs or updates as an app. Designs autosaved in your browser belong to the old address: export your design there (Save / Export → .ork) and open it at the new one. Home-screen installs should be reinstalled from the new address.',
      'Everything stamped with the old name now says MMRocket Sim: .ork files, STL/OBJ exports, fin templates, print packs, schematics, and the feedback tracker (reports now file under "MMRocket Sim").',
    ],
  },
  {
    version: '0.046',
    date: '2026-08-20',
    title: 'Share a design as a link, launch conditions that travel, and a sim that tells you what worried it',
    items: [
      'NEW: "🔗 Copy share link" in Save / Export packs your whole design — geometry, motors, launch conditions — into the link itself. No account, no upload, no server copy: the link IS the file (a typical design is a ~2.5 KB URL). Opening one asks before replacing a design you’re working on, a corrupt link fails with a note instead of a blank screen, and hostile oversized links are rejected outright.',
      'NEW: .ork files now carry your launch conditions both ways — wind, launch rod, site altitude and latitude, temperature and pressure — written the way the desktop writes them, and applied when you open a desktop design instead of silently resetting to defaults. Files holding several flight configurations now say which one was imported; altimeters, trackers and other mass components keep their identity through open→save instead of flattening to generic ballast.',
      'NEW: the simulator’s own warnings reach you — no recovery device, high-speed deployment, separation order, large angle of attack, and two dozen more — as a warnings block in the flight report, a banner when a serious one fires, and a column in the saved-runs table.',
      'NEW: the report now says where the rocket lands — distance from the pad and compass bearing — plus your peak roll rate when fins are canted, and a "⬇ Flight data .csv" export with the full per-timestep recording (every series the kernel computes; it re-flies the shown flight to gather them, which the deterministic engine makes byte-exact).',
      'FIXED: the header no longer forces the page to scroll sideways on phones — at a 375 px viewport the page was 946 px wide, with the Guide and 🐞 Feedback buttons off-screen. Buttons now wrap below 980 px, both dropdown menus stay fully on-screen down to 320 px, and nothing changes on desktop.',
      'FIXED: a transition’s shape parameter and clipping flag now reach both the physics and the drawing — a secant-ogive reducer simulates the shape it draws, and an imported unclipped transition renders the way it flies.',
      'FIXED: when browser storage fills up, saved runs and autosave now TELL you instead of silently losing work — the runs table shows what is actually stored, and a banner clears itself when saving recovers.',
      'The source repository opens to the public with this release (GPL-3.0-or-later, LICENSE included) — the header’s "source (GPL)" link is the corresponding-source offer — and the old preview address now forwards to openrocket.mountainmanrockets.com.',
    ],
  },
  {
    version: '0.045',
    date: '2026-08-12',
    title: 'Print parts too big for your printer, in pieces that fit — plus a framed 3D snapshot',
    items: [
      'NEW: 3D-printable parts that DON\'T FIT your printer are now split for you. Set your machine once in Preferences → 3D printing (Bambu H2D, X1C/P1S/A1, A1 mini, Prusa MK4S, Prusa XL, Ender 3, K1 Max, Neptune 4 Plus, or a custom build volume) and the 🖨 STL button becomes printer-aware: a part that fits exports exactly as before, and one that doesn\'t exports as a zip of numbered segments joined by a printed internal spigot, with a README covering print orientation, the joint clearance used, and the glue-up. A 3" 4:1 nose cone is 381 mm printed — 64 mm too tall for an H2D — and comes out as two pieces that each print base-down and support-free.',
      'The spigot is a tapered offset of the part\'s own bore, so it registers along its whole length instead of just at its root, and the flat face at the cut is a hard stop — the joint sets the assembled length exactly. Slender parts get leaned in and printed whole instead of cut, but only when the shape\'s own wall angle allows it: a 4:1 ogive leans the full 30°, an ellipsoid nose (54° wall) is never leaned, because tipping it would print unsupported air.',
      'If you have no printer configured, nothing changes at all — same button, same single STL, same filename.',
      'NEW: "Fit rocket to frame" on the 3D image export (on by default). The snapshot now frames the rocket before rendering, so an 8K export is 8K of rocket instead of 8K of empty space — it keeps whatever angle you rotated to, and only moves the camera in and out. Untick it to export exactly the view on screen.',
      'FIXED: the Mountain Man Rockets menu across the top wrapped to two or three rows on laptops between about 768 and 924 pixels wide. It is now a single row at every width, with the menu scrolling sideways when it runs out of room. The menu also now reads from the site\'s canonical address, so it keeps tracking the site if the old preview address ever goes away.',
    ],
  },
  {
    version: '0.044',
    date: '2026-08-12',
    title: 'DXF export for CNC & laser, a live site menu, and an elliptical-fin fix',
    items: [
      'NEW: ✂ DXF (CNC/laser, 1:1) — select a fin, centering ring, bulkhead, tube coupler or engine block and export its flat cut profile as AutoCAD R12 (AC1009) DXF in millimetres, the format LightBurn, Carbide Create, Easel, Fusion 360\'s sketch import and essentially every cutter\'s own software read. A fin comes out as ONE closed contour with the through-the-wall tab merged into it, so CAM offsets it correctly in a single pass; rings and bulkheads come out as true circles a machine can bore, with the centering ring taking its real bore from the motor-mount tube. Cut geometry is on the CUT layer alone — REFERENCE (root chord, centre marks) and TEXT (the label block) are guides, so switch them off before cutting.',
      'FIXED: elliptical fin sets exported the wrong outline. The 3D-printing STL (and any elliptical fin you had already exported) used a sine curve instead of a true ellipse, so the fin enclosed about 19% less area than the one the simulator flies and the one the 📐 SVG template prints. All three now use the kernel\'s own ellipse. Simulation results are unaffected — fin aerodynamics never read those points — but re-export any elliptical fin you cut or printed from an earlier build.',
      'The Mountain Man Rockets menu across the top is now LIVE: it reads the site\'s published menu on each load, so when the site adds or renames a page this tool follows on the next visit instead of waiting for an app release. The menu now matches the new site (Rocketry U, Tools & Techniques, Checklists & Info, Media…), gained a site search box, and picked up a small footer strip. It fails safe in every direction — offline, or if the site is unreachable, the menu that ships inside the app renders instantly, and nothing about the simulator depends on it.',
      'Bug reports: the report links no longer claim to preselect which tool you are reporting on — GitHub issue forms cannot prefill a dropdown, so you pick the tool yourself. The app version is still filled in for you.',
    ],
  },
  {
    version: '0.043',
    date: '2026-08-11',
    title: 'Feedback button — report bugs and request features from inside the app',
    items: [
      'NEW: 🐞 Feedback in the header — report a bug or request a feature on the public tracker (github.com/mtnmanak/mountainmanrockets-feedback, one tracker for mountainmanrockets.com and all its tools), browse open issues for this tool, or email instead (no GitHub account needed). Bug reports arrive with the app version prefilled; you pick which tool from a dropdown.',
      'Guide: new "Feedback & Bug Reports" section with the same routes and tips for a useful report (version, browser, and a zipped .ork make fixes far faster).',
    ],
  },
  {
    version: '0.042',
    date: '2026-08-11',
    title: '3D-printable component STL, glTF with colors, image picker (JPG + up to 8K)',
    items: [
      'NEW: 🖨 STL for printing — select a nose cone, transition, fin, centering ring, bulkhead, tube, coupler, engine block, launch lug, or tube fin and export a WATERTIGHT solid STL (millimetres) built for slicers: hollow noses/transitions include their shoulders and end caps at your wall thickness, fins export one fin with the through-the-wall tab merged in, centering rings get their true bore from the mount tube. Every mesh is manifold-verified by the test suite. (We believe no other rocketry sim offers this.)',
      'NEW: Export .glb — binary glTF of the whole rocket WITH your component colors as real materials. Opens directly in Windows 3D Viewer, PowerPoint, Blender, Fusion 360, and web viewers.',
      'NEW: Export .stl — whole-rocket display shell (mm) for reference models.',
      'The 2D ⬇ PNG and 3D 📷 PNG buttons became ⬇ Image / 📷 Image with a picker: PNG or JPG, at HD (1920), 4K (3840), or 8K (7680) width. The 3D snapshot re-renders the scene at the chosen resolution, so 8K is genuinely 8K — not an upscale.',
      'Guide: a proper shape-parameter table for nose cones and transitions (what the parameter means per shape, its range, and the default), plus the new export formats.',
    ],
  },
  {
    version: '0.041',
    date: '2026-08-11',
    title: 'True nose/transition shapes in 2D & 3D, component data export, cert-packet drawings',
    items: [
      'FIXED: the 2D and 3D views now draw the exact mathematical profile for every nose-cone and transition shape (ogive, conical, ellipsoid, parabolic, Haack, power — including the shape parameter). Before, the 2D view always drew a fixed ogive-ish nose and a straight-taper transition regardless of the selected shape, and the 3D transition was always a cone. The drawing math is a direct port of the kernel\'s own Transition.Shape equations, so what you see is what the physics flies.',
      'NEW: a Shape parameter field on nose cones and transitions, shown only for shapes that use it (ogive 1 = tangent / <1 = secant, Haack 0 = Von Karman / 1/3 = LV, power series exponent, parabolic segment). Blank = OpenRocket\'s default. It caps itself at each shape\'s legal maximum, and round-trips through .ork files as before.',
      'NEW: Export component data as .csv or .xlsx (Save/Export menu) — every component as one row with its dimensions, material, shape, and the engine\'s computed mass/CG/position, in your preferred units. For sharing measurement data with builders who don\'t run a simulator.',
      'NEW: 2D drawing export with a data header — ⬇ SVG / ⬇ PNG buttons on the 2D view. The header carries the name, length/diameter/span, dry & launch mass, CG, CP, and stability margin (the numbers cert packets want). The SVG is sized in physical millimetres so it prints at true 100% scale; the PNG is 3840 px wide.',
      'NEW: 📷 PNG snapshot on the 3D view — rotate/zoom to taste, click, and get the current 3D render with the same data header.',
      'Transition .ork export now writes the clipped-shape flag the way the engine actually simulates it (clipped for ellipsoid/power/Haack), so the desktop app reproduces our aerodynamics on those files.',
    ],
  },
  {
    version: '0.040',
    date: '2026-08-05',
    title: 'Auto-align fin sets, shroud conversion on import, sub-minimum rockets, EX motor folders',
    items: [
      'NEW: 🧭 Auto-align fin sets button (on any fin set that shares its tube with another set) — rotates overlapping sets so their fins interleave with the widest possible clearance, no manual rotation math. 6 tube fins + 3 straight fins lands at 30°, two 4-fin sets at 45°, and it generalizes to three or more sets.',
      'Imports now DETECT hand-rolled camera shrouds (one-fin freeform sets named like "Camera Shroud") and offer one-click conversion to the native camera-shroud component — real frontal-area drag and as-built mass instead of a pretend fin. Dimensions carry over; mass uses your override or a density-based estimate.',
      'Tube-fin collision limits now hold with hand-typed values too: the outer-diameter field and slider cap at the touching radius for the current fin count, and the fin count caps at what physically fits the entered diameter. (Before, typing both values let the sliders push the tubes into each other.)',
      'A blank tube-fin outer diameter now shows the auto-computed touching diameter grayed in the field — the number you need to actually build the fins — and stays auto until you type over it.',
      'NEW: sub-minimum diameter rockets. On a body-tube motor mount, check "Sub-minimum: motor case is the airframe" — the motor browser then fits motors against the tube\'s OUTER diameter, so the case-diameter motor you\'re building around (fins bonded to the case, or propellant cast into the airframe) stays selectable. The aft view now draws the motor in body-tube mounts too. Flag round-trips through .ork.',
      'EX/research motors: import several .eng/.rse files at once, or point "📁 Import EX folder" at the folder where you keep them — every RASP/RockSim motor file inside joins your local library in one go (it persists in this browser; nothing is uploaded). The mount button now says "Browse motors / import EX" so the feature is findable, and the guide gained an "EX motors & sub-minimum builds" section.',
    ],
  },
  {
    version: '0.039',
    date: '2026-08-05',
    title: 'Fin rotation, auto-interleave, and 4+2 / 2+2+2 cluster combos',
    items: [
      'NEW: every fin set (trapezoidal, elliptical, freeform, tube fins) has a Rotation field — turn the whole set about the body axis, so straight fins sit BETWEEN tube fins. It reaches the real physics (the kernel\'s base-rotation, an engine rebuild verified bit-identical at rotation 0), draws correctly in 3D and the aft view, and round-trips through .ork (the desktop\'s own tag) and RockSim (RadialAngle).',
      'RockSim imports auto-interleave colliding fin sets: RockSim renders tube fins + straight fins interleaved without storing an angle, so they arrived on top of each other — physically impossible. Overlapping same-angle sets now rotate by half the other set\'s pitch, with a note telling you what moved (the reported 4" Ultra Neon\'s tube fins come in at 30°). Adding a second fin set in the editor also defaults between the existing fins.',
      'NEW: 6-motor clusters batch as THREE opposite-tube pairs — the "mixed 4+2 / 2+2+2" checkbox flies every candidate combination across the three pairs, covering 4 of one + 2 of another AND three different motors in pairs (every pair is thrust-balanced, so all of it is symmetric — and much cheaper than buying 6 identical motors). Grouped in the exports like the other configs, each on its own XLSX tab. Watch the count line: this mode grows fast.',
    ],
  },
  {
    version: '0.038',
    date: '2026-08-05',
    title: 'Real-world cluster imports, batch mount picker, unload motors',
    items: [
      'RockSim cluster reconstruction now tolerates RockSim\'s own rounding drift — real files write the same physical tube with slightly different diameters between copies (79.38 vs 79.375 mm in the reported 12" Darkstar), which silently broke the ring detection. Tubes now group within 1%, and that Darkstar\'s 6×75mm ring imports as one tagged 6-motor cluster around its central 98mm mount.',
      'The batch dialog gets a MOUNT picker: choose which motor mount the batch flies candidates in (the ring or the central mount, for example). Other mounts keep their currently loaded motors for every flight, so you can batch the ring while the central 98 carries its chosen motor. This is also why "mixed pairs (3+3)" seemed missing on 6-motor clusters — the option existed, but the batch was locked to the primary mount; pick the cluster mount and it appears.',
      'Batch simulation no longer touches the design\'s engine state at all — it flies its own private copy, so a batch can never leave a stray motor on the design.',
      'New ⏏ button in the vitals strip (visible on every tab, next to the Motor readout): unload ALL motors in one click to view and weigh the rocket clean. Reload any time from Motors & Launch.',
    ],
  },
  {
    version: '0.037',
    date: '2026-08-05',
    title: 'Mixed-motor combination batching + max motor length on the mount',
    items: [
      'NEW: combination batching for 4- and 6-motor clusters. An opt-in "mixed pairs" checkbox in the batch dialog (off by default — the default batch still flies one motor type in every tube) also flies every PAIR of candidates split symmetrically across the cluster: 2+2 in opposite tubes on a 4-motor, 3+3 alternating on a 6-motor. The tube positions are exact — the cluster is split into two symmetric groups occupying the same holes. Larger clusters are deliberately out (no symmetric mixed arrangement worth flying), and the dialog shows the flight count before you commit — pairs grow fast.',
      'Combination results are grouped: a "Motor config" column (single / mixed 2+2) in every export, CSV sorted with single-motor rows first then the pairs, and the XLSX gets three tabs — All results, Single motor, Mixed pairs.',
      'Max motor length now lives ON the motor mount tube (Design tab), so it persists with the design — through sessions, .ork saves, everything. The Motors & Launch field became a per-stage OVERRIDE: it shows the design value as its placeholder, typing overrides it, clearing it falls back. (The old field was session-only and silently vanished when a design was reopened from a file — that was the bug.)',
      'Fixed: clearing the Motors & Launch limit now genuinely removes the override instead of storing a permanent "no limit".',
    ],
  },
  {
    version: '0.036',
    date: '2026-08-05',
    title: 'One clear model picker, batch aero choice, XLSX, RockSim pods',
    items: [
      'The aerodynamics choice is ONE pulldown now, with four explicit options: OpenRocket — Extended Barrowman (exact desktop parity) · Rogers Modified Barrowman (Kbf, the default) · Auto (Kbf, switching to our supersonic model past Mach 0.9) · Supersonic (our extended model at all speeds). The confusing separate Kbf checkbox is gone; your stored settings carry over unchanged.',
      'The supersonic model is now labeled as what it is — OUR model. It was built from the open literature and validated directly against NASA wind-tunnel data (no RASAero code or equations exist in it, or anywhere public); the guide keeps RASAero as the historical reference.',
      'Batch motor simulation gets its own aero-model pulldown, defaulting to Auto — each candidate motor flies the model its own flight calls for (a G stays subsonic-classic, an M goes supersonic), recorded per row. Your design\'s setting is untouched.',
      'New ⬇ XLSX export beside CSV (saved simulations and batch results): typed cells so Excel/Google Sheets never mangle designations or delays into dates, bold frozen header, autofilter, sized columns. Built in ~2 KB — no bloated spreadsheet library in the offline bundle.',
      'RockSim: external pods now import AND export (desktop semantics; a Detachable pod becomes a strap-on booster with its own flight branch; multi-instance pod sets split into N pods like the desktop); fin cant angle round-trips (the desktop only writes it — we read it back too). Ring tails remain unsupported, same as desktop OpenRocket, and the import notes say so.',
    ],
  },
  {
    version: '0.035',
    date: '2026-08-05',
    title: 'Hotfix: aft-view pan crash',
    items: [
      'Fixed a crash ("Cannot read properties of null") when panning the zoomed aft view and releasing the pointer mid-move — a timing race between the pan handler and the pointer-up. Reported from the live site within the hour; nothing else changed.',
    ],
  },
  {
    version: '0.034',
    date: '2026-08-05',
    title: 'Camera shrouds, spill holes, custom result tiles — issue batch b',
    items: [
      'NEW: Camera shroud / fairing component (add it to any body tube) — the first hobby-sim shroud that actually computes CP shift AND drag. Length, width, height, three shapes (streamlined / half-round / box), as-built mass, color and finish. The physics: the side profile flies as a slender strake through the kernel\'s own low-aspect-ratio fin lift (the classic Jones model), drag uses Hoerner protuberance coefficients on the frontal area. Draws solid in 2D, 3D and the aft view; round-trips through .ork (desktop warns-and-skips); exports to RockSim as a mass object so CG survives.',
      'NEW: parachute spill holes — a spill hole ⌀ field on every parachute, flown as the standard effective-area reduction (RockSim\'s treatment). RockSim files with spill holes now import and export them instead of dropping them.',
      'The highlighted result tiles are now YOURS: a ⚙ button on the Results tab opens a picker with 14 metrics (recovery weight, thrust:weight, guide-departure velocity, drogue descent, pad weight, static margin, optimal delay and more). Your picks persist. The old "Descent hits" tile is now labeled honestly: Landing rate. Stored runs opened from the history show tiles too.',
      'Rogers Modified Barrowman (Kbf) is now ON by default — it tracks real flight data better (the owner\'s testing). Turn it off in Preferences → Aerodynamics for exact desktop-OpenRocket parity; an explicit off stays off.',
      'New tagline: "Design, simulate, fly — OpenRocket-derived physics, validated to Mach 4.6 against NASA wind-tunnel data."',
      'The aft view zooms and pans: mouse wheel about the cursor, drag to pan, + / − / fit buttons.',
      '2D view: parachutes, mass items, centering rings and shock cords now draw miniature GLYPHS (canopy, weight block, ring section, zigzag); bulkheads get an engineering hatch fill. Clicking any component in the drawing selects it in the tree, and the tree selection highlights it in the drawing (accent outline) — both directions.',
      'RockSim export: a component with only ONE override (mass without CG, or CG without mass) now exports the calculated value for the other — RockSim couples them under one flag, so the missing half used to export as 0 and pin the CG to the component\'s front.',
      'Overstability thresholds confirmed (red < 1.0 cal, green 1.0–3.0, yellow caution above 3.0).',
    ],
  },
  {
    version: '0.033',
    date: '2026-08-05',
    title: 'Beta issue batch: descent rates, plugged motors, aft view, and 15 more',
    items: [
      'FIXED: parachute presets now apply their manufacturer-rated drag coefficient. Every preset that carries one (230 of 459, including all Fruity Chutes Iris Ultra at Cd 2.2) was silently simulated at the generic 0.8 — descent rates for those chutes were up to 1.66× too fast. Our IFC-144-S test case now lands within ~2% of Fruity Chutes\' own calculator. Still: always confirm against the manufacturer\'s guidance before flying.',
      'Motor delays now offer "Plugged — no ejection charge" on every motor (for electronics deployment, or factory -P motors), plus a plugged checkbox on the mount. Plugged flights show "-P" labels, warn that recovery must fire on apogee/altitude electronics, and still report the optimal delay for flying that motor with motor eject another day.',
      'New Aft view (Design tab: 2D / 3D / Aft) — the rocket from behind: cluster layouts, pod rings, fin counts and motor sizes as they really sit. The Motors & Launch tab shows it automatically beside the schematic while you adjust a cluster\'s layout, rotation and spacing.',
      'RASAero .CDX1 exports open in RASAero II again — our simulation block was missing 17 fields RASAero\'s loader reads unconditionally (the "Object reference not set" crash), and an empty engine tag added a second crash path. Also removed a stray fin field and matched RASAero\'s own recovery-block field order.',
      'RockSim fixes: mass components export their real (override) mass instead of the 10 g default (this was skewing CG in exported files); cluster mounts import as one tagged cluster again with layout, spacing and rotation recovered (they used to arrive as separate centerline tubes); tube fins now import their wall thickness.',
      'Tube fins now DRAW — side silhouettes in 2D, the full ring of tubes in 3D and the Aft view. They simulated correctly all along; they were just invisible.',
      'Couplers (and nose/transition shoulders) overhanging into the NEXT tube are now visible — e-bay couplers under a switch band used to show only their forward half.',
      'Over-stability is now a yellow caution (△), not a red failure, and the design page, vitals strip and launch report finally agree: ⚠ red below 1.0 cal, ✓ green 1.0–3.0, △ yellow above 3.0 (it mostly means weathercocking in wind). Thresholds are provisional — see the response doc.',
      'Saved simulations show which ROCKET flew them (new column + launch-report title) — no more guessing which sim belonged to which design.',
      'Recovery weight (mass at burnout) now appears in the launch report details, not just the CSV.',
      'The simulations CSV\'s detail columns now follow your unit preferences (headers say the unit); the 14 flight-day lead columns stay in the fixed ft/mph/Gs/g comparison format.',
      'CP, CG, lengths and diameters read out to 3 decimal places everywhere.',
      'Real component cut/copy/paste: ⎘ copy or ✂ cut any component from the tree, then "Paste into …" buttons appear for every legal destination — build one centering ring, paste it everywhere.',
      'Undo moved into the header so it\'s visible on every tab (Ctrl+Z always worked; nothing said so outside the Design tab).',
      'Inner components are now visually distinct in the 2D view: parachutes, streamers, shock cords, mass items, centering rings, bulkheads and engine blocks each get their own outline color and a small label at readable sizes.',
      'The import/export notification now clears when you start a new design; the header tagline now names the aero model actually in use; the Rogers Kbf preference is greyed out (with the reason) when the supersonic model supersedes it, and each saved run records whether Kbf was on.',
    ],
  },
  {
    version: '0.032',
    date: '2026-08-04',
    title: 'Daylight mode: readable in direct sun',
    items: [
      'New "Daylight" mode for using the app outdoors — one tap on the Daylight button in the header, or Preferences → Display → Daylight mode.',
      'Black on white at maximum contrast, with doubled borders, bolder small type, and a flat white stage behind the rocket instead of the soft gradient (the first thing sunlight washes out).',
      'The flight plots and drag charts switch to a darker line palette with thicker strokes and black axes, so altitude, velocity and acceleration stay separable on a phone screen at the pad.',
      'Daylight overrides your theme while it is on — a high-contrast dark screen is the right answer indoors and the wrong one on the field. Switch it off and your theme comes back exactly as it was. Your choice is remembered.',
      'Display only — no change to physics, designs, or saved files.',
    ],
  },
  {
    version: '0.031',
    date: '2026-08-04',
    title: 'Full-codebase audit: 20+ fixes',
    items: [
      'Renaming your rocket (or changing a display color) no longer clears the current flight results.',
      'Plugged motors (e.g. Cesaroni -P) now import from .ork files correctly — they used to import as a 0-second delay, firing the ejection charge at burnout. They display with the standard "-P" suffix and never eject.',
      'Strap-on (parallel-stage) boosters now get the high-power chuteless-booster safety warning — the check was keyed so it could never fire for them.',
      'File fidelity: .ork tube-fin wall thickness now imports; "override for all subcomponents" mass/CG/CD flags now round-trip AND apply in the simulation; RockSim export places middle-positioned parts correctly (a centered launch lug used to land at the tube front) and no longer flattens editor-created power-series noses; RASAero export keeps fins positioned away from the tube bottom in place; parachute shroud-line materials survive the preset CSV round-trip.',
      'The saved-runs CSV gains an "Aero model" column so classic vs supersonic vs auto flights are distinguishable.',
      'Rail buttons now draw at their entered size in the 2D view; tall freeform fins no longer clip the top of the drawing.',
      'You can no longer delete the last stage (which left the design broken until reload), and the first edit after an undo is never merged into the undone step.',
      'Engine internals: restored a determinism patch that had been silently inactive (simulation iteration order is again pinned identically in the browser and the reference JVM), plus several kernel-bridge hardening fixes. Differential test re-verified 5× (258 lines).',
      'Validation harness: removed a double-counted ARCAS anchor that flattered the supersonic score by one point (now 64/135 gates under the corrected accounting).',
    ],
  },
  {
    version: '0.030',
    date: '2026-08-04',
    title: 'Big screens: the rocket gets the room',
    items: [
      'On a large monitor the app now uses the whole screen instead of sitting in a fixed centered column. The rocket drawing takes the full width of its panel and sizes its height to the rocket\'s own proportions — on a 27" display it draws roughly twice as large as before, larger still on the Motors & Launch workspace.',
      'Visible zoom controls on the rocket view (+ / − / Fit). Scroll-wheel zoom around the cursor and drag-to-pan were already there — now they\'re discoverable.',
      'Wide-screen layout (1600px and up): wider component-tree and properties columns, flight plots paired two-up (three-up on ultrawide) with taller panels, a 3D view that grows with the window, and text in the working panels steps up a size so labels and inputs read comfortably at desk distance.',
      'Smaller screens keep the dense layout — laptops and phones are unchanged. Cosmetic only; physics and your designs are untouched.',
    ],
  },
  {
    version: '0.029',
    date: '2026-08-04',
    title: 'Identity pass 3: the Rajdhani display face',
    items: [
      'Headings, tab labels, the wordmark, the Launch button and every instrument numeral now speak Rajdhani — an engineered, squared technical face that gives the app its own voice. Body text stays in your system font for reading density.',
      'The font is bundled with the app (no CDN, ~30 KB) and precached, so it works fully offline at the launch site like everything else.',
      'This completes the three-part design refresh: brand orange + icons (v0.027), the telemetry bar + rocket stage (v0.028), and typography (v0.029). Cosmetic only throughout — physics and designs untouched.',
    ],
  },
  {
    version: '0.028',
    date: '2026-08-04',
    title: 'Identity pass 2: the telemetry bar, a stage for the rocket, real empty states',
    items: [
      'The always-visible vitals bar is now a proper instrument readout: each value gets a labeled station (ROCKET · STABILITY · MASS · MOTOR · APOGEE) with hairline dividers, ending in the orange Launch button — mission control at the top of every workspace.',
      'The rocket view sits on a subtle dusk-sky stage in both the Design and Motors workspaces, so the vehicle reads as the subject instead of floating on panel gray.',
      'Empty states now invite instead of apologize: a proper "This design hasn\'t flown yet" card on Results, a matching hint in the property column, and collapsed panels (Drag analysis, Saved simulations) that look intentionally dormant.',
    ],
  },
  {
    version: '0.027',
    date: '2026-08-04',
    title: 'Identity pass: Mountain Man orange, real icons, quieter chrome',
    items: [
      'The app now wears the Mountain Man Rockets colors: exhaust orange is the single interactive accent (Launch button, active tab, links, unit chips), so the chart blues/greens are unambiguously data. The top site menu matches the main site’s tracked-caps style, and the wordmark is a proper line-art rocket mark instead of an emoji.',
      'Every emoji icon replaced with a crisp built-in icon set that renders identically on every device and follows the theme.',
      'Quieter chrome: the "session restored" message is now a subtle line that fades away by itself instead of a banner; stage/motor badges in the tree are neutral outlines; chart hover legends are muted; assorted label and dialog-layout fixes (including the Preferences checkbox row).',
      'version.json now ships at the app root with every release so the Online Tools page can detect new versions automatically.',
    ],
  },
  {
    version: '0.026',
    date: '2026-08-04',
    title: 'Auto aero-model selection + supersonic-flight alert',
    items: [
      'The aerodynamics preference is now three-way: Classic (desktop parity, still the default during beta), Supersonic (the new model at all speeds), and Auto — every flight flies classic first, and if it is projected past Mach 0.9 the entire flight automatically re-flies on the validated supersonic model. Subsonic flights keep exact desktop parity; fast flights get the physics that matters.',
      'Supersonic-flight alert: fly past Mach 0.9 on the Classic model and the results page (and the saved report) now tell you a validated supersonic model exists, with a one-click "Switch to Auto & re-fly" — no need to find the Preferences page. The alert is explicit that a model applies to the ENTIRE flight, so stability and apogee shift when it changes.',
      'When the supersonic model is active, an "M+ aero" chip appears in the header strip, and Auto-selected runs are recorded as "Supersonic (auto)" in the launch report and run history.',
    ],
  },
  {
    version: '0.025',
    date: '2026-08-04',
    title: 'Supersonic aerodynamics (beta): RASAero-class CP & drag, Mach 0–25',
    items: [
      'New opt-in aero model (Preferences → Aerodynamics → "Supersonic aerodynamics"): corrected supersonic fin lift, exact NACA-1307 body-fin interference, Mach-dependent nose lift, per-shape wave drag with physical hypersonic decay, vacuum-limited base drag, and Van Driest II friction. CP and drag now move with Mach the way wind tunnels measure — validated against NASA ARCAS and Army-Navy Basic Finner data to ~Mach 4.6 (supersonic CP within ±2% of body length, matching the tunnel even where RASAero’s own prediction diverges). Off by default during beta — off is bit-identical to desktop OpenRocket. Every saved run records which model produced it.',
      'Supersonic fin airfoils: fins can now declare a RASAero-style section — hexagonal, NACA, double wedge, biconvex, hexagonal blunt-base, or single wedge — plus chamfer lengths and a leading-edge bluntness radius. Each gets its proper supersonic thickness wave drag; blunt-base sections add fin base drag. Round-trips through .ork files.',
      'Drag analysis panel upgrades: a CP-vs-Mach chart (the pre-flight stability check for fast rockets — keep ≥2 cal through the supersonic regime), Mach range to 25 with the supersonic model, and the CSV export is now a full aerodynamic-coefficient table (CD power-off/on, CP, CNα vs Mach) for external trajectory programs.',
      'Under the hood: an automated validation harness (validation/ in the repo) scores every physics change against published wind-tunnel and free-flight anchors — classic Barrowman scores 8/137 points, the new model 65/137, with the remaining gaps documented honestly (transonic peak drag, free-flight base-drag environment, blunt/flare bodies).',
    ],
  },
  {
    version: '0.024',
    date: '2026-08-03',
    title: 'A cleaner workflow: Design / Motors & Launch / Results workspaces',
    items: [
      'The app is now organized into three workspaces, one per task: Design (component tree, 2D/3D view, and a dedicated property-editor column), Motors & Launch (motor selection and launch conditions side by side, with the to-scale schematic above), and Results (flight stats, launch report, plots, drag analysis, and saved runs). No more one long page doing everything at once.',
      'A vitals strip stays visible above the tabs on every workspace: rocket name, stability margin, loaded mass, current motor, last apogee, and the Launch button — so the tweak-and-refly loop never needs a tab switch. Launching switches you to Results automatically, and the app remembers which workspace you were on.',
      'Editing a component no longer reshuffles the page: the property editor has its own column on the Design workspace, to the right of the rocket view.',
      'The five file buttons are consolidated into the header: Open… plus one Save / Export menu (.ork, .rkt, .CDX1, .obj).',
    ],
  },
  {
    version: '0.023',
    date: '2026-07-06',
    title: 'Minimum-diameter rockets: a body tube can be the motor mount',
    items: [
      'A body tube can now be a motor mount — check "Motor mount" in its properties and the motor loads directly in the tube, no inner tube needed. This is how minimum-diameter rockets are built (the motor case is essentially the airframe), and they are exactly the high-performance designs the new power-on drag and drag-analysis features target. Same kernel path as the desktop app.',
      'Imported files with body-tube mounts (.ork from the desktop, RockSim .rkt) now come in as real, working mounts instead of a "move it onto an inner tube" note, and the mount flag round-trips through save/reload even before a motor is loaded. The 2D view draws the motor case seated in the body tube.',
      'Motor overhang: every mount (body tube or inner tube) now takes an overhang — how far the motor protrudes past the tube\'s aft end (about 6 mm is standard minimum-diameter retention practice). It shifts the motor\'s mass aft in the simulation, draws in the 2D view, and round-trips through .ork and .rkt files.',
      'The user guide is updated for everything recent: pods & parallel boosters, the drag analysis panel, power-on drag, the Rogers Kbf stability option, and body-tube mounts.',
    ],
  },
  {
    version: '0.022',
    date: '2026-07-06',
    title: 'RASAero-style drag & stability: power-on drag, a CD-vs-Mach chart, and Rogers Kbf',
    items: [
      'Power-on vs power-off drag. Give a stage a nozzle exit diameter (in the Stage panel) and the sim now models how the motor exhaust pressurizes the base during boost, lowering base drag — so boost drag is lower than coast drag, just like RASAero. 0 (the default) means no change, so existing designs fly exactly as before.',
      'New Drag analysis panel (under the rocket view). Shows drag coefficient vs Mach with separate power-off and power-on curves, plus a breakdown by component (nose/body/fins) or by type (friction/pressure/base), with CSV export. A static design property — no need to run a flight. Above ~Mach 1.5 the values are labelled as approximate (full supersonic fidelity is still to come).',
      'Optional "Rogers Modified Barrowman" stability (Preferences → Aerodynamics). Adds the body-in-presence-of-fins lift carryover (NACA 1307) that classic Barrowman leaves out, for a slightly more aft, more conservative CP and stability margin. Off by default — turning it off is exactly the old behaviour.',
    ],
  },
  {
    version: '0.021',
    date: '2026-07-05',
    title: 'Pods & boosters now fly — and save to .ork',
    items: [
      'Parallel boosters and pods are now part of the flight simulation. A strap-on booster adds its mass, drag and thrust, separates on its trigger, and flies (and lands) on its own tracked branch — using the real OpenRocket kernel, verified bit-identical to the desktop. A non-separating pod adds its mass and drag rigidly. This completes the pods feature: design it, see it off-axis in 2D/3D, and fly it.',
      'Pods and boosters round-trip through .ork files (and open in OpenRocket desktop), so a strap-on design saves and reloads intact. Batch motor simulation is switched off while a separating booster is present, the same as for serial staging (the motor combinations explode).',
    ],
  },
  {
    version: '0.020',
    date: '2026-07-05',
    title: 'Pods & boosters drawn off-axis (2D & 3D)',
    items: [
      'Pod sets and parallel boosters are now drawn where they actually sit — ringed around the airframe at their radius and angle — in both the 2D side view (projected above/below the body) and the rotatable 3D model, and they export to OBJ too. Fins on a pod/booster draw as well.',
      'They are still not part of the flight simulation yet — that is the next step (it needs the engine build). A booster shows in the drawing but does not yet change the predicted flight.',
    ],
  },
  {
    version: '0.019',
    date: '2026-07-05',
    title: 'Groundwork for parallel boosters & pods',
    items: [
      'You can now add a Pod set or a Booster (parallel stage) onto a body component and give it its own nose/body/fin/motor-mount chain, with controls for how many, how far out from the airframe, and at what angle around it.',
      'This is the design foundation only: a pod or booster is saved in your design, but off-axis 2D/3D rendering and flight simulation of it arrive in upcoming updates — for now it does not yet change the simulated flight (your core rocket still simulates normally).',
    ],
  },
  {
    version: '0.018',
    date: '2026-07-05',
    title: 'Motor mount sizes shown at a glance',
    items: [
      'The Rocket panel now shows each motor mount\'s size (the nominal motor diameter it accepts — 24/29/38/54/75-76 mm, etc.), labeled by stage and with the cluster count. No more clicking into the mount tube in the component tree just to recall what the rocket takes.',
      'The same size is shown next to each mount in the Motors panel, right where you pick a motor.',
    ],
  },
  {
    version: '0.017',
    date: '2026-07-05',
    title: 'Fix: CG/CP markers now visible in the 3D view',
    items: [
      'The center-of-gravity and center-of-pressure spheres in the 3D view sit on the rocket\'s axis — inside the body tube — so they were hidden by the opaque shell. They now render on top (like the 2D markers), are a bit larger, and the CG sphere uses a visible neutral color instead of near-black. You can once again see the stability margin in space.',
    ],
  },
  {
    version: '0.016',
    date: '2026-07-04',
    title: 'Built-in user guide',
    items: [
      'New "❓ Guide" button in the header opens a full user guide without leaving the app: a one-minute Quick Start, an in-depth reference to every feature (designing, motors, launch conditions, simulating, staging/clusters, files, units), and a "How It Works" section documenting the physics and math with proper citations.',
      'The physics documentation explains the models the sim actually runs — Extended Barrowman aerodynamics, 6-DOF RK4 integration, the ISA atmosphere, WGS84 gravity, the thrust-curve model, and why our results are deterministic — with honest assumptions/limitations and a references list (Barrowman, Niskanen\'s OpenRocket technical documentation, NASA drag data, ISA, WGS84, and the OpenRocket project).',
      'The same guide is included in the repository as docs/user-guide.md.',
    ],
  },
  {
    version: '0.015',
    date: '2026-07-04',
    title: 'Max motor length is now per stage',
    items: [
      'On a staged rocket, each stage\'s airframe has its own room — the Motors panel now groups mounts by stage, and every stage gets its own "Max motor length" limit (flagging in the motor browser and batch-simulation exclusion use the right stage\'s value).',
      'Single-stage rockets look exactly as before: one input. An existing universal limit carries over onto every stage automatically.',
    ],
  },
  {
    version: '0.014',
    date: '2026-07-04',
    title: 'Issue batch 2026-07-04a — add-to-parent, site menu, motors drawn to scale',
    items: [
      'Adding components: selecting a component now offers every sensible target — the component itself (when it can hold children), its parent tube, and its stage. Click the nose cone and you get both "Add to Nose cone" and "Add to Sustainer".',
      'Mountain Man Rockets site menu across the top (Home, Builds, HPR Primer, Tools and Tips, Online Tools, Gallery, Videos, Links) — links open in the same tab, escaping the page embed, so the app feels like part of the site.',
      'Loaded motors are drawn in the 2D rocket view: a brownish silhouette at the motor\'s REAL case length and diameter, seated flush against the mount\'s aft end — every mount, clusters included.',
    ],
  },
  {
    version: '0.013',
    date: '2026-07-04',
    title: 'Debug & polish pass — a full-codebase review, 25+ fixes',
    items: [
      'Duplicate-ID bug fixed: after restoring a session, the first component you added could silently collide with an existing one (selection highlighting two rows, edits landing on both). IDs now always continue past the restored ones.',
      'Undo is usable again: dragging a component or holding a slider now counts as ONE undo step instead of flooding the history — Ctrl+Z steps back a whole gesture. Ctrl+Z inside a text field leaves normal text editing alone.',
      'RockSim round trip: mass components no longer import back as 0 g (a duplicate KnownMass field); sub-assemblies nested inside tubes keep their contents; streamers with RockSim\'s default drag stay on "auto".',
      '.ork fidelity: files from OpenRocket 15.03 and older keep their component positions (legacy <position> fallback); parachute shroud-line materials, elliptical fin cant, and transition shoulder thickness now survive save/reload; per-configuration stage separation settings are read.',
      'RASAero export honesty: fins RASAero can\'t represent now stop the export with a clear message instead of silently vanishing — and trapezoid-shaped freeform fins (including fins on boat tails) convert exactly. Booster shoulders and boat tails round-trip.',
      '"Fit shoulder to tube ⌀" on nose cones works again (broken since the multi-stage release); "Discard & start new" clears motors and the max-motor-length; the schematic\'s Reset-view button appears whenever the view is panned; imported designs keep their saved ejection delay when a built-in motor matches.',
      'Under the hood: 3D-view geometry no longer leaks GPU memory on every edit, per-device descent checks are sign-safe, corrupt cached thrust curves self-heal, preset CSVs with multi-line descriptions import correctly, and the file-format services share one XML/CSV toolkit.',
    ],
  },
  {
    version: '0.012',
    date: '2026-07-04',
    title: 'RASAero II files + 3D model export — the file-format arc completes',
    items: [
      'Open .CDX1: RASAero II designs import — full geometry (flat inch-based part lists become proper stages; boosters, shoulders and boat tails included), fins with cross-sections, launch lugs, and both recovery slots as parachutes with their deployment settings. RASAero carries no material/mass data, so the import says so honestly (2 mm default walls, "review masses") and lists the motors named in the file so you can load them from our database.',
      'Save .CDX1: exports designs that fit RASAero\'s model (up to 3 stages, conical transitions, 3–8 trapezoid fins per set) with recovery and the computed launch weight/CG for RASAero\'s simulation.',
      'Save .obj: the rocket\'s external 3D geometry as a Wavefront OBJ (meters) — print previews, renders, CAD reference.',
      'The file bar now covers: OpenRocket .ork (native), RockSim .rkt (both ways), RASAero .CDX1 (both ways), OBJ + SVG fin templates (out).',
    ],
  },
  {
    version: '0.011',
    date: '2026-07-04',
    title: 'Printable fin templates (SVG, true scale)',
    items: [
      'Select any fin set (trapezoidal, elliptical, or freeform) and hit "📐 Fin template (SVG, 1:1)" — you get a true-scale cut template: hairline outline for laser cutting, the through-the-wall tab hanging below the root line, a dashed root-chord reference, the fin\'s specs, and a 50 mm calibration ruler so you can verify the printer didn\'t rescale.',
      'The SVG uses physical millimeter units — print at 100% from any browser, or drop the file straight into a laser-cutter workflow.',
    ],
  },
  {
    version: '0.010',
    date: '2026-07-04',
    title: 'RockSim files — import and export',
    items: [
      'Open .rkt: RockSim design files import whole — all stages (RockSim\'s three-slot model maps onto our stages), nose/transition shapes, tubes, all four ring types, trapezoid/elliptical/freeform fins with their point lists and tabs, tube fins, launch lugs, chutes, streamers, and mass objects. Units and quirks mirror the desktop\'s own RockSim reader (mm→m, diameters→radii, rear-referenced positions flip sign).',
      'Better than the desktop: RockSim files carry their motor selections (EngineCode per mount) — the desktop throws them away; we match them against the motor database and load them onto the right mounts automatically, stale serial links and all.',
      'Save .rkt: export any design (up to RockSim\'s 3-stage limit) for RockSim users — clusters split into individually-placed tubes exactly like the desktop does, and motors are written back as EngineSets.',
      'Tested against the desktop\'s own RockSim fixture files (the 24.12 test suite) plus full export→import round-trips.',
    ],
  },
  {
    version: '0.009',
    date: '2026-07-04',
    title: 'Multi-stage rockets — design, fly, and recover every stage',
    items: [
      'Stages in the editor: "+ Add stage" appends a booster below the stack; each stage has a name and (for lower stages) a separation trigger + delay in its property panel. Existing designs and sessions migrate automatically into a single "Sustainer" stage — nothing changes until you add a second.',
      'Every motor mount now holds ITS OWN motor — the Motors panel lists each mount by stage with its own picker, ejection delay, and (on staged rockets) ignition setting. Defaults follow the field rules: a high-power sustainer (above the G80 line) defaults to electronics-timed ignition (booster burnout + 1 s); low/mid-power staging lights the sustainer off the booster\'s ejection charge automatically. This also enables mixed symmetric clusters via two clustered mounts.',
      'The launch report covers every stage: each separated booster gets its own section — apogee, its recovery deployments (or tumble), and its own landing verdict. A chuteless HIGH-POWER booster is flagged loudly (HPR requires active recovery); a low/mid booster may tumble in peace. CSV gains booster motor/apogee/landing columns.',
      '.ork files now carry the full multi-stage design both ways — stages, separation settings, and every mount\'s motor with its ignition config. Desktop 2-stage files import whole (the old "imported the first stage" limitation is gone).',
      'Batch simulate is intentionally unavailable on staged rockets (motor combinations explode); it still works on single-stage designs, clusters included.',
    ],
  },
  {
    version: '0.008',
    date: '2026-07-04',
    title: 'Staging groundwork: the engine now flies multi-stage rockets',
    items: [
      'The simulation engine (the real OpenRocket kernel) now accepts serial multi-stage designs: stages with separation triggers (ejection charge, burnout, upper ignition, altitude, apogee…) and per-motor ignition settings — including the high-power standard, electronics-timed sustainer ignition (e.g. booster burnout + N seconds). Low/mid-power gap staging (sustainer lit by the booster\'s ejection charge) works with zero configuration.',
      'Staged flights return EVERY flight branch: the sustainer\'s full flight plus each separated booster\'s own descent, recovery deployment, and ground hit — verified bit-for-bit against the desktop JVM with two new golden scenarios (5× stable, 229 differential lines).',
      'One kernel patch (documented in the ledger): a log statement in the separation handler used a number format TeaVM doesn\'t implement, crashing every staged flight in the browser. Log-only fix, zero physics impact.',
      'The design EDITOR for stages (stage rows, per-mount motors, per-branch launch reports) is the next release — this one is the physics foundation.',
    ],
  },
  {
    version: '0.007',
    date: '2026-07-03',
    title: 'Clustered motor mounts',
    items: [
      'Inner tubes can now be motor CLUSTERS: pick a layout (double, 3/4-row, 3–6-ring, 3–6-star, 9-grid, 9-star) plus tube spacing and rotation on the inner-tube panel. One motor choice fires the whole cluster — the real OpenRocket kernel multiplies thrust by tube count and places every motor\'s mass at its true position (differential-tested against the desktop JVM, 5× stable).',
      'The 2D view draws each cluster tube at its actual position; the Motor panel and batch simulation show the ×N motor count; the launch report and CSV gain a "Motors (cluster)" field. Pad weight, thrust:weight and acceleration are automatically cluster-aware.',
      '.ork files round-trip the cluster layout with the desktop (pattern, spacing, rotation) — and desktop files with clustered mounts now import them instead of collapsing to a single tube.',
      'Batch simulate works on clustered mounts: every candidate motor flies ×N. (Reminder from the field: mixed motor types in one cluster must stay symmetric — full mixed-cluster support lands with per-mount motor assignment in the staging release.)',
    ],
  },
  {
    version: '0.006',
    date: '2026-07-03',
    title: 'Phase 3 begins: deployable, installable, offline-capable',
    items: [
      'The app is now a PWA: the whole app shell — physics engine, motor database, presets — precaches in the browser, so once visited it works fully offline (remote launch sites have no internet). Previously-loaded thrust curves already persisted offline; now the app itself does too. Installable from the browser menu, with a proper app icon.',
      'Ready-to-upload deployment package: `npm run package` builds and zips the site for manual upload to any web host (docs/deployment.md has the walkthrough, cache-header tips, and a paste-in WordPress iframe embed snippet).',
      'A dormant GitHub Pages deploy workflow is included for one-click hosting when the repository goes public.',
      'The header now links to the source code (GPL v3+ obligation for distributed builds).',
    ],
  },
  {
    version: '0.005',
    date: '2026-07-03',
    title: 'Motor workflow: max length as a rocket property, cleaner designations, richer CSV',
    items: [
      'Max motor length moved out of the motor browser into the main Motor panel — it\'s a physical property of the rocket, saved with your session. The browser still flags ⚠ too-long motors (selectable, as before); batch simulation now EXCLUDES them and says how many it skipped.',
      'Motor designations cleaned up everywhere: Cesaroni\'s catalog impulse prefix is stripped (381I224-15A shows as I224-15A) and HP- prefixes (AeroTech/Loki) are removed. Sorting and search understand the clean form; .ork files keep the raw catalog designation.',
      'Launch/batch CSV rebuilt to the flight-day column order: Designation, Apogee (ft), Velocity (mph), Manufacturer, Diameter, Type, Propellant, Case, T:W, Guide (mph), Accel (Gs), Delay (s), Pad Weight (g), Recovery Weight (g) — then the full SI detail columns. Motor type (single-use/reload/hybrid), propellant and reload case come from a refreshed thrustcurve.org bundle; recovery weight is the simulated rocket mass after burnout.',
      'Opening an .ork no longer nags "isn\'t built-in" for motors we know: the file\'s motor is matched against the 1,129-motor database (designation, clean form, or common name + diameter) and loaded automatically, thrust curve and all.',
      'Saved simulations are clickable — click a row to open that run\'s full launch report; the selected row highlights. Delete still works without opening the run.',
    ],
  },
  {
    version: '0.004',
    date: '2026-07-03',
    title: 'Preset database completeness — the desktop\'s own component files',
    items: [
      'The desktop app bundles its own component database beyond the public GitHub one — Fruity Chutes Enhanced (42 chutes, was 10 here), Spherachutes (46), Rocketman (107), FlisKits (160), Front Range, b2 Rocketry, Quest, and ~440 more legacy parts. All merged in: the preset database grows from 3,936 to 4,700 parts.',
      'Investigated the "215 mph descent" report: the descent-rate math is correct — that number is the OPENING velocity of the main when the drogue stage is a 36"×1" streamer, which genuinely cannot brake an 800 g rocket (kernel-verified: the same 15" chute deployed at apogee descends at 26 mph). The per-device recovery table from v0.003 shows exactly this.',
    ],
  },
  {
    version: '0.003',
    date: '2026-07-03',
    title: 'Dual-deployment aware recovery reporting',
    items: [
      'The launch report now lists EVERY recovery deployment by device name (drogue, main, …) with its own deploy time, altitude, opening velocity, descent rate, and verdict — safety warnings name the device that caused them.',
      'Descent-rate safety uses the accepted dual-deploy numbers: descent under a drogue up to 70 ft/s is fine, landing target is 20 ft/s or lower. A main opening under a healthy drogue no longer trips a false "high velocity at deployment" warning.',
      'New "Landing descent rate" line and verdict in the report; CSV gains Deployments, Drogue descent rate, Landing rate columns.',
      'Engine: flight events now carry their source component name (differential-tested with a dual-deploy golden scenario).',
    ],
  },
  {
    version: '0.002',
    date: '2026-07-03',
    title: 'Delay handling the way flyers actually do it + nose cone OD/ID sync',
    items: [
      'Ejection delay is editable right on the Motor panel — type any value without reloading the motor (typing overrides auto). The manufacturer\'s prescribed delays are shown for reference.',
      'Motor browser delay picker adds "Custom (drilled)…" — enter any delay, not just the prescribed list.',
      'Auto (optimal) delay now recommends the nearest WHOLE second to the simulated optimum (e.g. optimal 12.7 s → 13 s), matching how delays get drilled in the real world — it no longer snaps to the manufacturer\'s prescribed values. Batch simulation uses the same rule.',
      'Nose cone base now syncs like a body tube: base outer diameter, base inner diameter, and wall thickness — editing any one updates the others.',
    ],
  },
  {
    version: '0.001',
    date: '2026-07-03',
    title: 'First versioned beta — full response to the 3 July test pass',
    items: [
      'Fin tabs (through-the-wall) on trapezoidal, freeform and elliptical fin sets: depth/length/offset, "Fit tab to motor tube", 2D rendering, centering-ring snap, desktop-compatible .ork round-trip; tab volume counts toward fin mass and CG.',
      'Numeric input rebuilt: type negatives freely, clearing never resets to 0, letters and invalid values turn the field red and are not committed, display capped at 3 decimals (full precision stored).',
      'Session autosave & restore: the whole working state survives closing the tab or a crash.',
      '"New" asks for confirmation and offers to save the .ork first.',
      'Launch report: ~30 flight-day attributes including times to rod departure/burnout/apogee, rod-exit velocity and thrust:weight, launch mass/CG/CP/static margin, altitude & velocity at deployment, optimal delay (ballistic-probe) and recommended delay, safety verdicts, weathercocking, execution time.',
      'Saved simulations: every run persists, compare in a table, download all as CSV (33 columns).',
      'Batch simulate: fly every motor that fits the mount with per-motor optimal delay, acceptance criteria (min rod-exit speed, min thrust:weight, apogee window), progress + cancel, CSV.',
      '"Auto (optimal)" ejection-delay option in the motor browser.',
      'EX motor import from RASP (.eng) and RockSim (.rse) files — imported motors live under manufacturer "EX" and simulate like any other.',
      'Component editing: wall thickness ⇄ inner diameter dual input, finish "→ all", per-component mass/CG/position readout, two add buttons, new components inherit diameter/material/finish from the previous one, duplicate (⧉), override boxes show the calculated value until overridden, color quick-presets, motor-mount tubes auto-name.',
      '2D view: wheel zoom, drag-to-pan, reset view; nose/transition shoulders drawn sliding into their tubes.',
      'Rocket names: imported designs falling back to the desktop\'s generic "Rocket" take the filename; saves already use the rocket name.',
      '487 RockSim catalog parts merged into the preset database (now 3,936 parts).',
      'Engine: simulations are now strictly deterministic run-to-run (fixed an upstream OpenRocket force-summation ordering bug); differential JVM↔JS parity re-verified.',
    ],
  },
];

/** Milestones that predate version numbering (shown at the bottom of the changelog). */
export const PRE_VERSIONING_NOTE = `Before versioning (June–July 2026): Phase 0 engine spikes and the TeaVM
decision; Phase 1 MVP (real OpenRocket kernel in the browser, motor search,
.ork files); Phase 2 (component-tree editor, 3D view, launch conditions, plot
series, full-tree .ork); fin cross-sections + freeform fin editor; desktop-
mirrored units & preferences with click-to-change units; motor selection
rewrite with the bundled thrustcurve.org database; materials, 3,449-part
preset database, snap positioning and display colors.`;
