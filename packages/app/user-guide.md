# MMRocket Sim — User Guide

> The complete guide to MMRocket Sim: a quick start, a full feature
> reference, and the physics, math, and citations behind the numbers. This is
> also available inside the app via the **Guide** button in the header.

<a id="welcome"></a>

## Welcome to MMRocket Sim

MMRocket Sim is a rocket design and flight simulator that runs entirely in your web browser. There is nothing to install. It reads and writes `.ork` files, and the **OpenRocket 24.12 physics kernel** is genuinely what computes your flight — that Java source, compiled to JavaScript with TeaVM. A differential test runs the same kernel on a JVM and in JavaScript and requires bit-identical output, so what your browser runs is that kernel and not a re-implementation of it.

The numbers it gives you, though, are not desktop OpenRocket's numbers. The default aerodynamics model here is **Rogers Modified Barrowman (Kbf)**, which adds terms the 24.12 model does not have, and there is a **Supersonic** model scored against published wind-tunnel and free-flight data, which the **Auto** setting brings in once a flight passes Mach 0.9. So expect a design you bring over to read differently — deliberately, toward the measured data. Switching **Preferences → Aerodynamics** to **Classic Extended Barrowman** turns every one of those extensions off, and *How It Works: Physics & Math* sets out exactly what each of them is.

The workflow is simple, and it will feel familiar if you have used desktop OpenRocket: you design a rocket by building up its components, load a motor, set your launch conditions, and press **Launch** to see how high it flies, how fast it goes, and whether it will fly straight and land safely. This guide is written for model and high-power rocketry hobbyists at every level, from your first Estes kit to a multi-stage high-power project.

The app is organized into **three workspaces**, selected by the tabs under the header, one per phase of that workflow: **Design** (the component tree, the 2D/3D view, and the property editor), **Motors & Launch** (motor selection, ejection delays, batch simulation, and launch conditions), and **Results** (flight stats, the launch report, plots, drag analysis, and saved runs). On a phone a fourth workspace, **Fly**, comes first and is the default — see *The Fly screen* under Simulating. A **vitals strip** above the tabs stays visible on Design, Motors & Launch and Results — the rocket's name, stability margin, loaded mass, current motor (with an **⏏ Unload** button that strips every loaded motor so you can view the rocket clean), the **aerodynamics model** (a switch, not just a readout — see *How It Works → Choosing a model*), last apogee, and the **Launch** button — so you can tweak a fin, fly, and check the number without hunting through tabs. Launching switches you to Results automatically.

The guide has three parts:

- **Quick Start** gets you to your first successful flight in about a minute.
- **The In-Depth Feature Guide** is the complete reference for everything the app can do — designing, motors, launch conditions, simulation, staging, files, and preferences.
- **How It Works** opens up the physics, the math, and the references behind the numbers, so you can decide exactly how far to trust them.

## Contents

1. [Quick Start](#quick-start)
2. [Designing the Rocket](#designing-the-rocket)
3. [Visualizing the Design](#visualizing-the-design)
4. [Motors](#motors)
5. [Launch Conditions](#launch-conditions)
6. [Simulating and Reading Results](#simulating-and-results)
7. [Multi-Stage and Clustered Rockets](#multi-stage-and-clusters)
8. [Files, Units, and Offline Use](#files-and-formats)
9. [How It Works: Physics & Math](#how-it-works-physics)
10. [Feedback & Bug Reports](#feedback)
11. [Assumptions, Limitations & References](#limitations-and-references)

---

<a id="quick-start"></a>

## Quick Start

This section gets you to your first successful flight in about a minute. The rest of the guide then covers everything in depth.

## Your first flight in three steps

When the app opens, you already have a complete, flyable rocket called **My Rocket** — a nose cone, a body tube, a fin set, a motor mount, and a parachute. You don't have to build anything to get started. All it's missing is a motor. On your very first visit a **six-step tour** points out the component tree, the drawing, the Motors & Launch workspace, the Launch button, the Results workspace, and the Guide and Feedback buttons — it shows once, and you can replay it any time with the **⟲ Tour** button in the header. *Preferences → Display* has an **Off** switch that takes effect immediately — including on a tour that is currently on screen — and putting it back to **On** genuinely re-arms the tour for your next visit.

**1. Load a motor.** Open the **Motors & Launch** workspace (the tabs under the header) and find the **Motors** panel. The fastest option is the **Quick picks** dropdown — pick a classic Estes motor like **B6-4** or **C6-5** and it loads at once. (It lists the picks that fit this rocket's mount, and it is there while the design is still the starter rocket; once you change the design, use the browser.) (The number after the dash is the ejection delay in seconds.) These are ordinary catalogue motors with their certified thrust curves; their curves ship with the app, so nothing here needs a network. Want something specific? Click **🔎 Browse motors / import EX (.eng, .rse)…** to search the full thrustcurve.org catalog of {{MOTOR_COUNT}} motors — but for your first flight, a quick pick is all you need.

**2. Check your launch conditions (optional).** Beside the Motors panel is the **Launch conditions** panel. The defaults are sensible: a 1-meter launch rod, pointed straight up, no wind, standard sea-level atmosphere. You can leave every field alone for now.

**3. Press Launch.** Hit the **Launch** button — at the bottom of the Launch conditions panel, or the **Launch** button in the vitals strip at the top. The simulation runs in a fraction of a second and the app switches to the **Results** workspace with your numbers.

That's it — you've flown a rocket.

## Reading your first result

After launching, the headline tiles across the top of the results give you the numbers that matter most:

- **Apogee** — the peak altitude the rocket reached. This is your "how high did it go" number.
- **Max velocity** — the fastest the rocket traveled (also shown as **Max Mach** in the detailed report).
- **Max accel** — peak acceleration, a feel for how hard it leaves the pad.
- **Apogee at** — seconds from liftoff to the top of the flight.
- **Descent hits** / **Flight time** — how fast it's coming down at landing and how long the whole flight lasted.

Two health checks tell you whether the flight is actually *safe and stable*, not just how high it went:

- **Stability margin** (shown in the design stats as **Stability**, in *calibers* — the gap between the center of pressure and the center of gravity, measured in body diameters). A healthy rocket sits between **1.0 and 3.0 cal**. Below 1.0 the rocket is *under-stable* and may wobble or go unstable — flagged red with a ⚠. Above 3.0 it's *over-stable* and tends to weathercock (turn into the wind) — flagged as a yellow △ caution, not a failure. Right in that band, marked ✓, is what you want. The design page, vitals strip and launch report all use this same rule.
- **Landing descent rate** — you want to touch down at **20 ft/s (about 6 m/s) or slower** — the app's limit, and the usual target for getting a rocket back undamaged. The report flags a faster landing. **This is the vertical rate, not the speed over the ground:** under a parachute the rocket also drifts with the wind, so on a windy day it meets the ground faster than it descends — the report shows both, and judges the limit on the descent. Parachute presets apply the manufacturer's rated drag coefficient when the catalog carries one, but a simulated descent rate is still an estimate — **always cross-check the parachute manufacturer's own sizing guidance** before you fly.

Open the full launch report below the tiles for more: **thrust-to-weight at the rod** (aim for at least **5:1**), **rod-exit speed** (at least about 50 ft/s / 15 m/s so the fins have airflow to steer with), deployment timing, and plain-language safety comments that name any problem and where it is.

If your first rocket flies stable and lands soft — congratulations, you're done. If a value comes up flagged, the report tells you which one and why, so you know what to adjust.

## Where to go next

Now that you've seen a flight end to end, the rest of this guide shows you how to make it *your* rocket:

- **Build and edit components** — reshape the nose, resize the body, design custom fins (including freeform), and add stages using the component tree.
- **Choose the right motor** — filter the full database by manufacturer, diameter, and impulse; drill ejection delays to any whole second; and batch-test many motors at once.
- **Dial in launch conditions** — wind, launch angle, site altitude, and weather.
- **Read the plots and reports** — altitude, velocity, and stability over the whole flight, plus saving and exporting your results.
- **Import and export** — load and save `.ork`, .rkt, and .CDX1 files.

---

<a id="designing-the-rocket"></a>

## Designing the Rocket

Everything below is organized by the order of a typical workflow: design the rocket, look at it, load a motor, set the launch conditions, fly it, read the results, then save or export. This guide section covers the design stage.

## The component tree

The **Design** workspace's left column is a **stage-rooted tree** of components. Each stage holds an axial chain of external body parts (nose cone → body tubes → transitions), and those in turn hold internal or external parts (fins, motor mounts, recovery gear, mass). Click a part to select it and its property panel opens in the column to the right of the rocket view; selecting it also puts that part's action buttons on its row — **move up, move down, duplicate, copy, cut and delete**, described just below. The tree enforces containment rules — you can only add children a parent legally accepts (for example, fins and inner tubes go inside a body tube, a parachute goes inside any body part, and an engine block goes inside an inner tube).

### Moving, copying and deleting parts

A button that cannot apply is left off rather than greyed out: a stage has no **Copy** or **Cut**, and a rocket's last remaining stage has no **Delete**.

| Button | What it does |
|---|---|
| ↑ ↓ **Move up / Move down** | Swaps the part with its neighbour inside the same parent, and stops at the ends. It does not move a part to a different parent. |
| ⧉ **Duplicate** | Copies the part and everything inside it, drops the copy in beside the original, adds *(copy)* to its name, and selects it. A stage is named for its new position instead — see below. |
| ⎘ **Copy** | Puts the part and everything inside it on the app's clipboard and leaves the tree alone. |
| ✂ **Cut** | The same, but takes the part out of the tree. |
| ✕ **Delete** | Removes the part and everything inside it. |

**Paste is not on the row.** Once the clipboard holds something, **Paste into …** buttons appear under the tree beside the **+ Add** buttons, with a line under them naming what is on the clipboard. The destinations come from your selection — the selected part itself, its parent, and its stage — filtered by the containment rules, so a paste that would break them is never offered rather than refused after you press it. If no **Paste into …** button appears, select a part inside the rocket (the rocket's own row offers no destinations) and check that something around it can hold what you copied. A paste drops a fresh copy in as the **last child** of the destination you pick and leaves the clipboard loaded, so you can paste the same part again.

**Duplicate and Copy + Paste are not the same thing.** Duplicate lands the copy beside the original in the same parent and, for everything but a stage, adds *(copy)* to its name; Paste lands it at the bottom of whichever parent you choose and keeps the name exactly as it was, so a copy and a paste leaves you two parts with the same name in different places. Cut then Paste is how a part moves to a different parent — the ↑ ↓ buttons only reorder inside one parent, and the tree has no drag-and-drop.

**Duplicating a stage names it for its position.** A stage's name says where it sits in the stack, so a duplicated stage does not get *(copy)* — duplicate the **Sustainer** of a two-stage rocket and the copy is called **Booster**, with the stage that was below it renumbered to **Booster 2**. Rename a stage yourself and it is yours: the app then leaves both the name and the numbering alone, and a copy gets *(copy)* like any other part.

**The clipboard belongs to the page.** It is not the system clipboard, so a part cannot be pasted into another tab or another program, there are no Ctrl+C / Ctrl+X / Ctrl+V shortcuts, and it is empty again after a reload. It also holds the part exactly as it stood when you pressed **Copy** or **Cut**: if you edit the original afterwards, a paste still brings back the version you copied, so copy it again after editing.

**The tree works from the keyboard.** ↑ and ↓ move the selection, Home and End jump to the ends of the tree, Enter or Space selects, and Tab reaches the buttons on the selected row. Ctrl+Z takes back anything here that changed the design — a move, a duplicate, a cut, a paste or a delete. **Copy** changes nothing, so there is nothing to undo.

A copy is a new part with its own identity in the design, and anything attached to the original by that identity stays behind: duplicate or paste a motor mount and the new mount has no motor in it, so load one on **Motors & Launch**.

## The component types

| Type | Category | Key parameters |
|---|---|---|
| Nose cone | External body | length, base radius, wall thickness, shape, shoulder |
| Transition | External body | length, fore/aft radius, thickness, shape, two shoulders |
| Body tube | External body | length, outer radius, thickness |
| Trapezoidal fins | Fin set | count, root/tip chord, sweep, height, thickness, cant, cross-section, tabs |
| Elliptical fins | Fin set | count, root chord, height, thickness, cross-section, tabs |
| Freeform fins | Fin set | count, thickness, cross-section, tabs, polygon outline |
| Tube fins | Fin set | count (capped to how many tubes fit around the body once you set an outer radius), length, outer radius (blank = auto-sized so the tubes just touch), wall thickness |
| Inner tube | Structure / mount | length, outer radius, thickness, cluster layout |
| Tube coupler | Structure | length, thickness |
| Centering ring | Structure | axial thickness |
| Bulkhead | Structure | axial thickness |
| Engine block | Structure | length, thickness |
| Launch lug | Guide | length, outer radius, thickness, angle around body |
| Rail button | Guide | outer diameter, total height, inner diameter, base height, flange height, screw height, number of buttons, distance between, angle around body |
| Camera shroud / fairing | External | length, width, height, fore/aft end shape, conformal, angle around body, as-built mass, finish |
| Protuberance (drag bump) | External | drag class, width × height, count, plate angle, angle around body |
| Parachute | Recovery | canopy diameter, Cd, spill hole ⌀, lines, deploy event |
| Streamer | Recovery | strip length/width, Cd, deploy event |
| Shock cord | Recovery | cord length |
| Mass component | Ballast | mass, length, radius, type (ballast / altimeter / tracker / …) |
| Pod set | Assembly | instance count, radial distance & reference, angle |
| Booster (parallel stage) | Assembly | instance count, radial placement, angle, separation |

### Camera shrouds (fairings) — how they're modeled

A camera shroud is a real aerodynamic body: it shifts CP and adds drag. Its
side profile is flown as a **slender strake** — a long, low fin lying along the
body. The app hands the engine a single-panel lifting surface of that outline
and runs it through the same low-aspect-ratio fin lift it uses for your fins,
which at a strake's proportions reduces to the classic Jones slender-body
model — the right physics for this shape. There is no separate shroud model:
whichever **aerodynamics model** you have selected computes the shroud's normal
force the way it computes a fin set's, so a change of model moves the shroud
the same way it moves the fins. Drag uses **Hoerner protuberance coefficients**
(streamlined ≈ 0.25, half-round ≈ 0.55, box ≈ 1.05, body interference included)
charged against the shroud's frontal area — **the area measured from the tube
surface**, which is the shroud's width × height plus the gap its flat
underside leaves over the curve of the body. Both parts block the flow, so both
are charged; the property panel prints the two numbers separately. Enter the
as-built mass — printed parts weigh what they weigh.

**The two ends are shaped separately.** Most shrouds are flat or domed on the end the
camera looks out of, to give the lens a clear aperture, and tapered at the other
end. Set **Fore end** and **Aft end** independently; a forward-facing camera
just swaps them. The default is streamlined at the front and flat at the back, which is the shape most real shrouds take: tapered into the wind, flat where the lens looks out. A
shroud with matching ends is charged exactly the coefficient above; give it two
different ends and it is charged the mean of the two, which is an interpolation
rather than a measurement.

**Conformal to body tube** is on by default, and describes what most
3D-printed shrouds do: the underside formed to the curve of the tube so it sits
flush. Turn it off for a part with a flat base sitting on the tangent — you will
see the gap open up at the corners in the end-on view. This changes the drawing
and the printed shape, not the numbers.

**Angle around body** places the shroud where it really sits. Two buttons beside
the field put it exactly on a fin or exactly between two fins. 

**A shroud in front of a fin gets a sentence on the Design tab.** Put one
within its own width of a fin's line and less than about twenty shroud heights
ahead of that fin — which is exactly where the **▲ on a fin** button puts it —
and the app says so, in the warning strip and in the launch report. The app
charges that fin its full normal force either way, and the clock angle moves
neither the CP, the stability margin nor the drag the app reports: the CP shown
is the most-forward one over a full sweep of roll angles, the margin is the one
that goes with it, and the drag is the same at every angle. The sentence
exists because that is a modelling limit worth knowing about, not because the
design is wrong. Clocking the shroud between the fins removes the question, and
the **⟂ between fins** button beside the angle field does it in one click.

Known limits, stated. The mounting angle steers the shroud's **lift** within the
plane it sits in, not its **drag**: a shroud is charged the same drag wherever it
sits around the body. That holds while the rocket flies straight — the air around
a round body arrives the same way all round it, so turning a bump about the
flight axis presents it with the same air and the same frontal area. At an angle
of attack the windward and leeward sides differ, and that is not modelled. The
wake the shroud sheds onto the fins downstream is not modelled either, and that
one **does** depend on where the shroud sits. The direction is known — a fin in
that wake meets slower air than the app gives it, so on its own that term moves
CP forward, toward less margin — but not the size. No measurement of a shroud's
effect on a downstream fin has turned up in the literature searched for this:
the computational fluid dynamics (CFD) work that raised the question reports
only that the camera's shed wake *can interact* with the fins behind it, with no
per-fin number attached, and the standard wake correlations are being asked to
work well outside the range they were fitted on, where two of them disagree
threefold on how wide the wake even is. So the app flags the geometry and
declines to put a number on it.

The nearest published bounds are for the shroud as a whole, not its wake: Ken
Karbon's CFD puts the total CP change from a camera shroud at *"perhaps 1
caliber forward at the most"*, and Chuck Rogers' worked example moved a
2.63-inch rocket 0.53 caliber. Read those beside the finding that runs the other
way, from the same CFD work: measured against it, Barrowman-based CP predictions
sit up to **2.3 calibers too far forward**, so the app is already conservative on
CP overall. The drag coefficients themselves have no wind-tunnel anchor taken on
a camera shroud: a CFD run on a keychain-camera shroud corroborates the
*area-ratio* family this model belongs to rather than calibrating these
particular numbers, and the Saturn I SA-2/SA-4 flight data cited for that family
carries a ±20–25 % error band of its own, wider than the drag increment it would
be checking. Treat the shroud's drag as a good engineering estimate with a
stated method, and add margin on small-diameter rockets, where a shroud has more
effect.

### Protuberances — the bumps that only make drag

A **protuberance** is anything sticking out of the airframe that costs you drag
without acting as a lifting surface: a cable tunnel, a camera housing, a launch
shoe, an anchor at a fin root, a conduit. (If the thing is big enough to shift
CP, model it as a camera shroud instead — that component flies its side profile
as a lifting strake.) Add one to a body tube, give it a frontal area — directly,
or as width × height — and pick a drag class:

| Class | Cd on frontal area | Use for |
|---|---|---|
| Streamlined — no base drag | **your rocket's body CD, base drag excluded** | a faired bump whose wake closes, or one whose base is captured by something behind it |
| Streamlined — with base drag | **your rocket's body CD, base drag included** | the usual case: a faired bump with an open aft face |
| Inclined flat plate | 1.17·sin²θ | a slab meeting the flow at an angle θ from the body |

**The two streamlined classes are not table values.** They are RASAero II's
*Streamlined Protuberance Method*, which its co-author Chuck Rogers states as:
the drag per unit frontal area of a streamlined bump is *the same as the rocket
body's own*. So a bump with 10 % of the body's frontal area raises the rocket's
CD by 10 % of the **body** CD — without base drag for the no-base class, with it
for the with-base class. The app measures that body CD directly: it strips the
fins and every other appendage, runs the bare airframe, and reads its drag with
and without the base term. The property panel prints the two numbers it found for
your design, at Mach 0.3 — the same Mach as the Design tab's **Cd (M0.3)** tile,
which covers the *whole* rocket including fins, so expect the body figures to be
the smaller pair. Those are quoted figures, not flown ones: in flight the bump is
charged against your body's CD at whatever Mach it is doing at the time.

That means the same cable tunnel gets a different Cd on a different rocket, which
is the whole point: a long slender minimum-diameter bird has a much higher body
CD than a short fat one, and a bump on it costs proportionally more.

The flat-plate class is Hoerner's measured normal-plate value with **no**
interference multiplier — deliberately the "wrapped symmetrically around the
body" case. RASAero multiplies a side-mounted plate by 1.5 (and a rail guide or
launch shoe by 2.25); if your bracket is a genuinely asymmetric lump on one side,
type a Cd of about 1.75 in the Cd field. Going the other way, a step *shorter
than the boundary layer* — a 2 mm motor-retainer ring at the aft end, say —
measures far less than 1.17 in CFD, so this class over-reads there.

RASAero `.CDX1` protuberance entries import onto this component, and export back
out as the per-class frontal-area totals the format stores: bumps of one class
merge into a single number, and there is room for two inclined-plate angles.
Protuberances on a booster stage or a fin can do not export at all — the app
writes the block only inside a body tube, the one place RASAero's own files are
known to carry it.

Three honest limits.

1. **It follows your body's drag curve, and inherits its errors.** The two
   streamlined classes are re-evaluated at every Mach against the body CD of the
   design you are flying, the way RASAero does it — up through the transonic peak
   and back down above it. The consequence is that whatever the body CD gets
   wrong, the bump gets wrong in proportion — and
   it tracks the **aero model you have selected**, so turning on the supersonic
   model raises your protuberance drag above Mach 1 along with the body's. To
   pin it to a fixed number instead, type a Cd in the Cd field.
   Measured data is harsher still for a *ring* right around the body: a band on a
   cylinder adds **no** drag at all below about Mach 0.70, which no model
   proportional to the body's CD can reproduce at any speed.
2. It contributes **no CP shift and no normal force**, the same as RASAero. An
   asymmetric guide really does trim the rocket to a small angle of attack, and
   the app does not model that, nor the wake the bump sheds onto a fin behind
   it: a protuberance in front of a fin gets the same Design-tab sentence a
   camera shroud does — see **Camera shrouds** above.
3. Mass is whatever you type — 0 by default. Weigh the part in if it matters.

As a scale check, the four fin-root anchors on the NASA ARCAS (0.178 in² total,
4.5 % of a 2.25-inch airframe's area) come out at **+0.0158 CD** at Mach 0.3 —
small, but the same size as the difference between a good sim and a disappointing
flight.

### Parachute spill holes

A spill hole reduces the effective drag area: the app flies the standard reduction
Cd_eff = Cd · (1 − (hole ⌀ / canopy ⌀)²) — the same treatment RockSim uses, and
spill holes round-trip through .rkt files.

## Dimensions: diameter vs. radius

Internally every size is stored in **pure SI** (meters, kilograms, seconds) and angles in radians. The property panel shows friendlier units (mm, degrees, grams) and converts at the edge. Fields that describe a round cross-section are stored as a **radius**, but the **Round components entered as** preference is set to **Diameter** by default, so the panel doubles the value and relabels it — "Base outer radius" becomes "Base outer diameter" and accepts the tube's full OD, which is how catalog tubes are quoted. Set that preference to **Radius** if you would rather type radii.

## Nose cones and transitions

Both support six mathematical **shapes**: Ogive, Conical, Ellipsoid, Parabolic, Haack, and Power. The 2D and 3D views draw the **exact mathematical profile** the physics flies, including the shape parameter.

Four of the shapes are really *families* of profiles, selected by a **Shape parameter** field that appears next to the shape picker (Conical and Ellipsoid have a single fixed profile, so the field hides). A blank field means the app uses the kernel's default for that shape — a missing parameter never silently reshapes the part:

| Shape | What the parameter controls | Range | Blank = |
|---|---|---|---|
| Ogive | **1 = tangent ogive** (the circular arc meets the body tube smoothly — the classic kit profile). Below 1 it becomes a **secant ogive** (a shallower arc that meets the tube at an angle), straightening all the way to a cone at 0. | 0–1 | 1 |
| Parabolic | Which segment of a parabola to use: **1 = full parabola** tangent to the tube, 0.75 = ¾-parabola, 0.5 = ½-parabola, **0 = cone**. | 0–1 | 1 |
| Power | The exponent n in r ∝ (x/L)ⁿ: **0.5 = the classic ½-power** (parabola of revolution), 1 = cone, small values = increasingly blunt. | 0–1 | 0.5 |
| Haack | **0 = LD-Haack (Von Kármán)** — minimum drag for a given length and diameter, the usual choice; **1/3 = LV-Haack** — minimum drag for a given length and volume. The field caps at 1/3 (the engine clamps there too). | 0–1/3 | 0 |

Imported files keep whatever parameter they carried — .rkt files in particular often store explicit values, which you can see and edit. A nose cone can be **solid (filled)** or a hollow shell of a given wall thickness, and can carry a **shoulder** (radius, length, thickness, and an optional end cap) that plugs into the tube below. A transition is a shoulder-to-shoulder part with independent fore and aft radii plus a shoulder on **each** end — use it as a reducer, boat tail, or coupler flare.

**Parts that came from a catalogue are recognised on import.** A `.rkt` file names the manufacturer and part number of every component it carries, and desktop OpenRocket writes a preset tag on any part picked from its database. When you open either kind of file, the app looks each part up in its own parts catalogue and fills in whatever the file left **unset** — the file's own values always stand, so a tube you cut to length is not snapped back to stock, and the catalogue never overrides the mass the file carries. The import note lists every part it matched and what it filled in. The case this exists for is a parachute: RockSim writes a drag coefficient of 0.75 to mean *automatic*, so without that lookup a Fruity Chutes Iris Ultra opened from a `.rkt` would descend at the app's default Cd of 0.8 instead of its rated 2.2 — enough to fail the 20 ft/s landing check on a correctly built rocket. A part the file calls **Custom**, or one the catalogue does not carry, is left exactly as the file describes it.

## Fins

Four fin families are supported:

- **Trapezoidal** — the everyday fin, defined by root chord, tip chord, sweep, and height.
- **Elliptical** — a rounded planform from root chord and height.
- **Freeform** — an arbitrary polygon. Selecting one opens the **freeform point editor**, where you drag vertices to draw any outline (needs at least three points). The fin's **length**, for positioning, is its **root chord** — the last point's x, where the outline meets the body again — exactly as the simulation kernel measures it. A tip that trails behind the root corner overhangs the root, and the fin is anchored and drawn by the root chord, not by the overhang.
- **Tube fins** — a ring of full tubes instead of flat fins (up to 12).

Every flat-fin set also carries a **cant angle** (to induce roll), a **fin count** (1–8), and a **cross-section**: **Square**, **Rounded**, or **Airfoil (pointed)**. The cross-section is not cosmetic — a square edge produces markedly more pressure/skin drag than a streamlined airfoil, and the kernel models that difference, so choosing "Airfoil" on a carefully sanded fin gives you the lower drag of the fin you built.

For fast flights there is also an optional **supersonic airfoil** selection (RASAero-style): **hexagonal, NACA, double wedge (diamond), biconvex, hexagonal blunt-base, and single wedge**, plus **LE/TE chamfer lengths** and a **leading-edge bluntness radius**. Each shape gets its proper supersonic thickness wave drag, blunt-base shapes add fin base drag, and a blunt LE adds swept-cylinder drag. Leave this selector on its default, **"Classic"**, and the ordinary cross-section above drives the model instead. Two things are worth knowing, and both depend on which **aerodynamics model** you fly rather than on this selector: the **Classic Extended Barrowman** model ignores a named supersonic section outright — the three basic cross-sections are all it models; and the **Rogers Kbf** and **Supersonic** models do not charge an **Airfoil** cross-section the classic blunt leading-edge drag (see *Aerodynamics* below). These choices also round-trip through `.ork` files (desktop OpenRocket ignores the extra tags with a warning).

**Through-the-wall tabs**: a tab exists only when **both** its depth and length are greater than zero. You set the tab depth, length, offset, and the reference edge the offset is measured from (front / middle / end of fin). The engine clamps tab depth to the body radius, and the tab's volume counts toward fin mass and CG.

## Positioning and snapping

Internal and fin components are placed **axially** relative to their parent, using a method (top / middle / bottom / absolute) plus an offset. You can drag parts in the 2D schematic or nudge the offset slider. The editor provides **magnetic snapping** to meaningful anchors: the parent's ends and middle, every sibling's leading and trailing edges, and — importantly — the front and rear edges of a fin's tab, because in a real build the centering rings usually butt against the tab where it passes through the wall. Any "absolute" positions from an imported file are rewritten to parent-relative offsets so the drawn geometry always matches the simulated geometry.

## Motor mounts and clusters

A motor mount is usually an **inner tube** with the mount flag set. For **minimum-diameter rockets** — where the rocket body tube is the motor mount tube — check **"Motor mount"** on the **body tube** itself and the motor loads directly in it (imported files with body-tube mounts come in as real mounts). For the extreme *sub-minimum* style (fins bonded straight to the motor case, or propellant cast into the airframe tube itself), model a body tube with the motor case's own outer diameter and check **"Sub-minimum: motor case is the airframe"** — the motor browser then fits motors against the tube's *outer* diameter instead of its bore, so the case-diameter motor you're building around stays selectable. Leave the wall thickness at 0 unless the airframe adds real structure on top of the case (the motor file's weight should include the case — it flies), and give the tube the case's true length or the motor will overhang in the drawings. Each stage also carries a **maximum motor length** — the longest motor its airframe has room for. The primary value lives on the motor mount tube in the design (so it travels with the `.ork`); the field on **Motors & Launch** overrides it per stage. The **⌾ Estimate** button beside that field measures it for you: from the aft end of the mount forward to the first thing a motor case cannot pass — an engine block, a bulkhead, or a mass component standing in for a sled — or to the front of the mount tube when nothing is in the way, plus any motor overhang the mount allows. It names whatever set the limit. Treat it as a starting point rather than an answer: it cannot see wadding, a baffle modelled as some other component, or a chute packed hard against the block.

Every mount also takes a **motor overhang** — how far the motor protrudes past the tube's aft end (about 6 mm is standard min-diameter retention practice) — which shifts the motor's mass aft in the simulation and draws in the 2D view.  An inner tube also carries a **cluster layout** — single, rows, rings, and stars up to nine motors, with a spacing multiplier (× tube diameter) and a rotation. One motor choice serves the whole cluster: thrust is multiplied by the count and mass is placed at the real tube positions, exactly matching the kernel's ClusterConfiguration.

## Pods and parallel boosters

Two assembly types place whole component chains **off-axis**, ringed around the airframe:

- **Pod set** — a non-separating pod (camera bay, external raceway, side-mounted tube). It stays attached for the whole flight, contributing its mass and drag rigidly.
- **Booster (parallel stage)** — a separable strap-on booster with its own separation trigger and delay, like the outboard boosters of a Falcon Heavy. After it separates, it flies (and lands) on its own tracked branch, carrying whatever recovery gear you put inside it — two devices on two triggers included, for a drogue-then-main descent (see *Multi-Stage and Clustered Rockets → Booster recovery and clusters*).

Both attach to a body component (body tube, nose cone, or transition) and hold their own axial chain — nose cone, body tubes, fins, even a motor mount — exactly like a miniature rocket. Placement is controlled by an **instance count** (1–8 copies ringed evenly around the body), a **radial distance** with two reference modes (a *gap from the parent surface*, where 0 = touching, or a distance *from the centerline*), and an **angle** around the body. A booster with a motor mount takes a motor like any other mount, and its ignition follows the same trigger rules as serial stages.

## Recovery

**Parachutes** take a canopy diameter, a drag coefficient (blank = automatic, defaulting to 0.8 after deployment — unless the file you opened named a catalogue chute that carries one, in which case its rated Cd is filled in on import), line count, and line length. **Streamers** take strip length and width. Both carry a **deployment trigger**: motor ejection charge, apogee, altitude (descending, with an AGL altitude), launch, or never — plus a deploy delay. Two devices can share a bay on two different triggers, which is how you build a dual deploy: a drogue at apogee and a main on an altitude. The **Altitude (descending)** trigger stands in for the deployment altimeter that would fire it in the real rocket — the app models the trigger, not the electronics. The first canopy stays out when the second opens, so the descent under the main is worked out from both canopies together. The same holds inside a separating booster. A **shock cord** and a **mass component** (for nose weight, altimeters, or dead ballast) round out the bay. A mass component's **Type** dropdown records what it is — altimeter, flight computer, deployment charge, tracker, payload, recovery hardware, or battery — purely descriptive (the physics only uses the mass), and it travels through .ork files both ways, so desktop OpenRocket sees the same identity.

### Recovery weight, and the Recovery sizing panel

A parachute has to lower the rocket **plus its spent motor casing** — the propellant is gone by apogee — the design page shows **recovery weight** once a motor is loaded (without one there is no propellant to subtract) — and, when you have entered a weighed pad mass for that motor, the adapter and closure it carries are in this number too. On a multi-stage rocket it is the **sustainer's** weight — what is still attached when the main opens. Note that a spent booster is not weightless just because it has gone: it comes down under its own parachute and needs its own canopy sized for it, and the figure on the design page is not that number. Stages that are set to separate at **Never** stay attached, and are weighed with the sustainer rather than subtracted from it — separation is a property of the applied **flight configuration**, so the same rocket can honestly show different recovery weights under different configurations. Where the app cannot separate the stages cleanly — a strap-on booster living inside the sustainer's own structure — it says so rather than showing a number it cannot stand behind: no recovery weight and no sizing recommendation, for the sustainer's own canopy as much as the booster's. Any strap-on in the tree does this — even one set to separate at **Never**.

Under the component properties on the right, the **Recovery sizing** panel turns that weight into a recommendation. It leads with the **size** — "about 66 in at Cd 2.13" — because that is the answer whether or not you buy off a shelf, and it always names the drag coefficient it used, since a diameter without one means nothing; it takes the Cd of the chute already in your design when there is one, vent-corrected. Then it lists real catalogue canopies with the descent rate each would give *your* rocket, filtered to the ones whose packed size fits the bay (and saying how many it dropped), sized against what the rocket would weigh with that canopy in it, and using the air at your launch site rather than at sea level — about 8 % faster descent at 5,000 ft. Targets are 18 ft/s for a main and 60 ft/s for a drogue; a drogue candidate above the accepted 70 ft/s is sorted last and marked with the launch report's own words. The panel folds up, and the folded header still carries the two sizes.

## Mass, CG, and Cd overrides

The app attempts to calculate the mass, CG and Cd for every component based on the material selection and size or if the data exists in a catalogue component. For any component, you can override its computed **mass**, **axial CG position**, or **drag coefficient**. This is how you tell the sim what a part *actually* weighs. Applying a component preset that carries a cataloged mass sets a mass override automatically, because a real part weighs what it weighs, not what its shell computes.

### An override never deletes anything

This is the first thing to be clear about. Setting an override does **not** erase the component's attribute values. Its length, radius, material and everything else stay exactly where you put them, in the design and in the saved `.ork` file. The override simply stands in front of the computed result — clear it and the original value is back, unchanged. The same is true of a component that is being covered by an override higher up: its own figures are still there, just not contributing at the moment.

### What "Use instead of everything inside" does

Once an override has a value, a **Use instead of everything inside** checkbox appears under it. It decides how far the override reaches:

- **Ticked** — your figure is used instead of **this component and everything in it**. Nothing below it contributes any more: not the parts' geometry, and not their own overrides.
- **Unticked** — the override stands in for **this component's own figure only**. Its own computed mass, CG or drag steps aside; everything *inside* it still counts on its own, and so do its neighbours.

So on any part with geometry of its own, the two settings are not "add" versus "replace" — an override always replaces something, and the only question is **how much**: just this part, or this part and its whole contents.

**Containers are the exception.** A **stage**, a **pod set** and a **booster** hold other parts but have no mass, CG or drag of their own — so an unticked override on one has nothing to stand in for, and *adds* instead. An unticked **mass** adds to whatever the contents weigh (type 1.2 kg unticked and the rocket gets 1.2 kg **heavier**; tick the box and it weighs exactly 1.2 kg). An unticked **Cd** adds in exactly the same way: a stage Cd of 1.0 left unticked adds 1.0 on top of the drag the parts already compute, so a rocket that computed 0.60 comes out at 1.60. An unticked **CG** override, though, looks like it does nothing — and on its own it genuinely doesn't. The reason ties the three together: unticked, your figure describes a **point mass the container adds**, and the CG says *where that added mass sits*. With no mass override beside it there are zero kilograms to position, so nothing moves. Add a mass override and the same CG bites immediately — 1 kg unticked at a CG of 0.1 m places exactly that kilogram at 0.1 m and pulls the rocket's balance point with it. The panel says so on the field itself when you set a CG that isn't doing anything yet. **On a stage, a pod set or a booster, tick the box.** The panel says so too.

### When overrides are stacked

Because any component can carry one, you can end up with overrides at several levels at once. The rule is simple:

**The nearest ticked ancestor wins.** Once a component is covered by an ancestor's "Use instead of everything inside", nothing below that ancestor matters — including other overrides.

If you set a mass on a body tube and the number never changes, that is almost always why: a stage above it is standing in for the lot. The panel tells you so directly — the override field shows a note naming the component that is covering it, so you never have to guess.

Working from the outside in, then, a whole-stage override is the biggest hammer and the easiest to reason about; per-component overrides are for the parts the geometry genuinely can't know.

### One figure for a whole stage

Because a **stage** is a component like any other, selecting a stage in the tree, entering a **Cd**, and ticking **Use instead of everything inside** sets **one drag coefficient for that whole stage** — the standard way to trim a simulation until its apogee matches what your altimeter recorded. The same move on **mass** pins that stage to its as-weighed number, and on **CG** to its as-balanced point. On a single-stage rocket the stage is the whole airframe; on a two-stage or boosted design it is not. Any stage you did not override goes on computing its own drag from its geometry, and overrides on separate stages **add**, exactly as the unticked case above does — tick 0.50 on the sustainer and 0.50 on the stage below it and the stack flies 1.00 while the two are still together, not 0.50. A strap-on **booster** charges its figure once per instance, so a set of three ticked at 0.50 adds 1.50.

Two things worth knowing before you rely on it. First, the Cd you type here is a **flat** number: the app charges that same coefficient at every speed, where drag computed from the shape rises steeply through the transonic region around Mach 1 and falls away again at higher speed. So a Cd trimmed until the sim matches one altimeter trace describes the speeds *that* flight reached rather than the rocket itself — put the same airframe on a much bigger motor and the app keeps charging the flat figure across a Mach range the trim never saw. Re-trim when the flight regime moves, and model the real shape where you can. Second, replacing a stage's mass means the individual parts stop contributing mass, so the per-component breakdown below it stops being meaningful even though the total is exactly right.

### The one asymmetry to watch: fin sets

A fin set is a single component that stands for several fins, and its two overrides work differently:

- **Mass** covers **all the fins together** — the field is labelled *(all fins combined)*.
- **Cd** is **per fin** — the field says *per fin*. Entering 0.5 on a three-fin set contributes 1.5 to the rocket's drag coefficient; on a four-fin set, 2.0.

This matches desktop OpenRocket exactly. It surprises people, which is why both fields say which they are.

All of this round-trips through `.ork` in both directions, so a design you override here opens the same way in desktop OpenRocket, and vice versa.

## Measured mass & CG (matching the rocket you actually built)

Under the component tree on the Design workspace there is a **Measured mass & CG** box. Weigh
your finished airframe **with the motor out**, balance it on a ruler edge, and type the two
numbers. The box shows how far the model is from the real thing, and offers one button.

Press it and the app inserts a mass component called **Build allowance**, of exactly the
mass you are missing, at exactly the station that also puts the balance point where you measured
it. The arithmetic is:

```
ballast mass     Δm  = measured mass − computed mass
ballast station  x_b = (measured mass · measured CG − computed mass · computed CG) / Δm
```

Change a camera, a battery or an altimeter later, re-weigh, and press the button again — it
**updates the same component** rather than adding a second one. The gap it reports is always
measured against your rocket *without* the allowance, so pressing it twice never stacks.

### Why this and not a stage override

You can pin a whole rocket to its weighed mass and balance point with a stage-level mass and CG
override and **Use instead of everything inside** ticked. That is exact. It costs two things:

- **The per-component breakdown stops meaning anything.** Once the stage stands in for the whole
  subtree, the individual part masses contribute nothing — the total is right and every line
  under it is decoration.
- **You lose the diagnostic.** A single pinned number tells you the answer but not the
  discrepancy; you never learn that your build came out 60 g heavy.

**The two interact, and the app says so.** If a stage already carries a mass override with
**Use instead of everything inside** ticked — a RASAero `.CDX1` import usually arrives that way,
since that is how the file's stated launch weight is applied — then a Build allowance placed
inside that stage weighs *nothing*: the override stands in for it, exactly as it stands in for
every other part underneath. Rather than adding a component that does nothing, the box says
which component is in the way and offers to **pin that component to your measured mass and CG**
instead. It only offers that when one override covers the whole rocket: the measured figures are
whole-airframe and the overrides are per-stage, and there is no rule for which of several stages
should absorb the difference, so it declines to guess.

Ballast keeps both, because it adds real mass at a real station instead of replacing the tree.

**The inertia follows the mass you pinned.** When a mass override covers what is inside it, the
subtree's rotational inertia is scaled to the mass you gave it rather than left describing the
parts underneath. Apogee barely notices, but inertia is what drives weathercocking, pitch
oscillation and how the rocket behaves leaving the rod, so it shows up in a pinned design's
**downwind drift**. Roll and pitch inertia are printed in the **All stats** drawer, so you can
see the figure rather than take it on trust.

### When there is no answer — which is the useful part

Sometimes no ballast anywhere on the rocket can reconcile your two numbers, and the box says so
rather than swallowing it:

- **The station lands ahead of the nose tip, or behind the tail.** Your measured mass and balance
  point cannot both be explained by adding mass, so your part masses are wrong in their
  *distribution*, not just their total.
- **The rocket came out lighter than the model.** There is no negative ballast — something in the
  design is modelled heavier than you built it.
- **Right mass, wrong balance.** Adding mass cannot move the CG without also changing the total,
  so again the distribution is off.

### .rkt files often already know

A `.rkt` file can carry a **measured weight and balance point for the whole rocket**,
recorded on the design rather than on any one part — many do. Opening a single-stage one fills
this box in for you, and the note says so. A multi-stage `.rkt` states its weight per stage,
which has no single whole-rocket meaning, so nothing is filled in and the note says that instead. Nothing is applied to the simulation until you press
the button, so you can see first that (for example) the kit states 292 g where your parts compute
195 g, and decide whether you believe it.

Two things here are deliberately different from desktop OpenRocket. The app honours the file's
own "known mass" flag; desktop OpenRocket never reads it, applying any stated whole-rocket mass
whenever the file carries one — and a number of real kit files carry a stale leftover value it
will happily apply. And the app does not pin the whole stage to the stated number the way desktop
OpenRocket does, because that stops every individual part mass counting and leaves the rocket
carrying the wrong rotational inertia. Ballast at a real station does neither.

The "Build allowance" component is an ordinary mass component: it saves into `.ork` like any
other, and desktop OpenRocket sees the same rocket. **The two numbers you weighed are saved with
it**, so re-opening the file brings the box back with your measurements still in it — and a share
link carries them too. Desktop OpenRocket skips those two extra tags with a warning, the same way
it treats camera shrouds.

The rocket's weight **with the motor in** is a different measurement and lives with the motor, not
here — see *Weighed pad mass* under Motors. What you type in this box is the airframe, and it is
meant to survive a motor change; what you weigh on the pad is not, because it includes that motor's
adapter, retainer and closure.

## Scaling a whole design

**⤢ Scale…** sits above the component tree and multiplies the entire rocket by one factor: every
length, diameter, wall thickness, fin planform (freeform points included), shoulder, tab, fillet,
canopy, cord and axial position. It lands as a **single undo step**, so Ctrl+Z puts the design back
exactly as it was, and the dialog offers to save a `.ork` backup first.

There are two ways to set the factor, and they are linked — change either and the other follows:

- a **factor** ("make it half size"), or
- a **new body diameter**, which is how a scale project really starts. The practitioner's workflow
  is *find the tube first*: the factor is the new tube's outside diameter divided by the old one. A
  dropdown of every body-tube outside diameter in the preset catalogue fills that field from a part
  you can actually buy.

**What is scaled, and what is not.** Angles, fin and instance counts, material densities, drag
coefficients, surface finish, cluster spacing (already a ratio of tube diameters), motor selection,
deployment and separation settings, and the launch conditions are all left alone. Masses you pinned
by hand — mass overrides and mass components — go as the **cube** of the factor, and a pinned CG
station goes as the factor, because that is what holds the balance point at the same percentage of
the length. If a pinned mass was a part you actually weighed, it is a guess afterwards: re-weigh it.
The **Measured mass & CG** box is cleared, because it described a rocket that no longer exists.

**Three things keep their own size** and only move to their new stations: a **camera shroud** (the
camera inside it is the same camera), a **rail button** (they come in fixed sizes — micro, mini,
1010, 1515, unistrut), and a **launch lug's bore** (that is the launch rod's diameter). The spacing
between a pair of rail buttons does scale, and a lug's length does.

**The motor mount is the interesting one.** It scales geometrically, and the dialog then tells you
what that means. An 18 mm mount scaled by 2.27
has a 40.9 mm bore, and there is no such motor; the nearest standard size is 38 mm. A tick box will
snap each mount to the nearest standard size, keeping its wall thickness, but leave it off if you
want the true geometric answer and will choose the mount yourself — the nearest size is not always
the right one. Apogee's own worked example rejected the nearest 38 mm for a 24 mm, for structural
reasons. If a motor is loaded and no longer fits the scaled bore, the dialog says so before you
commit.

**Recovery gear is the one thing that deliberately does not go as the cube.** Densities are left
alone, so every solid part's mass follows its volume: on the app's default rocket a 2× scale takes
the nose, tube, fins and mount to exactly 8× their mass. A parachute does not — its canopy is
fabric of a fixed thickness and its shroud lines are line, so the canopy goes as its *area*.
Holding the cloth thickness fixed is the realistic choice, but it has two consequences worth
knowing. The scaled design is no longer *exactly* similar, so its stability
margin shifts slightly. And **descent rate goes as roughly the square root of the factor** — a 2×
upscale lands about 1.4× faster — so size the canopy for the new mass rather than trusting the
scaled one.

**What scaling cannot do**, here or anywhere. A scale model is defined as photographically scaled
*with CG and CP at the same percentage of body length*. For the structure that is preserved
exactly, and you can check it on the Design tab: on a design with no recovery gear the stability in
calibers does not move at all. What does not carry over
is **Reynolds number** — flight speed times body length divided by how sticky the air is, the
number that describes how the air flows over the skin, and a downscale flies at a lower one — the
ratio of **inertia to aerodynamic moment** (so it damps and oscillates differently), and **surface
finish** (microns stay microns, so a downscale is proportionally rougher). The app recomputes all
three for the new size rather than assuming them — which is the whole reason to scale here instead
of on a photocopier. One thing it does not model: at a low enough Reynolds number a real fin works
less well than its outline suggests. So treat a large downscale with suspicion, and expect to
re-choose recovery gear and motor by hand.

## Materials, finishes, and color

Solid and structural parts pick a **bulk material** from the built-in material database (which writes its density); parachutes and streamers pick a **surface material**, and shock cords and lines pick a **line material**. Typing a custom density detaches the part from the named material. Each body part also has a **surface finish** — nine of them, from Rough (500 µm) through the default Regular paint (60 µm) down to Mirror surface (0 µm) — and that roughness feeds the skin-friction drag model, so a polished airframe genuinely simulates lower drag. Finally, each part has a **display color** (a full picker plus one-click presets) used only in the 2D and 3D views.

## Component presets

The bundled catalog holds roughly **4,700 real-world parts** (tubes, nose cones, transitions, rings, couplers, bulkheads, engine blocks, launch lugs, parachutes, streamers) from named manufacturers with part numbers, materials, and cataloged mass. Open the preset picker on a selected component, choose a part, and its dimensions, material, and mass override are patched in. The 1.3 MB bundle loads lazily on first use, and you can round-trip your own custom presets through CSV. **Inner tubes also get the body-tube catalogue**, so a motor mount can be set to a real catalogue tube — which is where the Composite Warehouse motor-mount tubes live.

### Adding your own parts through CSV

There is no "save this part as a preset" button. The two CSV buttons at the top of the preset
picker are the whole route in — a tube from a supplier the catalogue does not carry, a canopy you
sewed, a coupler you turned — and the same file is the route back out.

1. Select a part and press **📦 Choose from preset database…**. That button appears on the eleven
   part types that have a catalogue.
2. Press **⬇ CSV**. It writes the whole filtered list, so narrow it with the search box and the
   manufacturer dropdown first if you want a short file, or take the unfiltered list as a template.
   The file is named for the kind — `presets-BodyTube.csv`, `presets-Parachute.csv`. **One kind per
   file**, so parts of three kinds mean three exports.
3. Open it in a spreadsheet and add your rows. **Delete the catalogue rows before you import.**
   They are not tracked back to the catalogue, so each one you leave in comes back as a second,
   custom copy beside the original.
4. Press **⬆ CSV** and choose the file. The app reports what it took: *Imported 3 preset(s) — stored in this browser.*

**Every number in the file is SI, whatever your display units are set to:** lengths and diameters
in metres, mass in kilograms, a bulk material's density in kg/m³, a canopy or streamer fabric in
kg/m², shroud line in kg/m. The drag coefficient is a plain number.

The first row is the header and the app reads the columns by name, so their order does not matter,
a column it does not know is ignored, and a column you rename takes its data with it. Delete the
header row and nothing imports at all: the app says *No presets found in that CSV.*

What decides whether a row lands:

- `kind` and `partNo` **both have to be filled in.** A row missing either is skipped, silently.
- `kind` is one of `BodyTube`, `NoseCone`, `Transition`, `CenteringRing`, `TubeCoupler`,
  `BulkHead`, `EngineBlock`, `LaunchLug`, `Parachute`, `Streamer`. An inner tube uses `BodyTube`.
  **Capitals no longer matter** — `bodytube` and `BODYTUBE` are read as `BodyTube` — but a kind the
  app does not recognise is kept exactly as typed, and a row with one shows up in no picker.
- `materialDensity` **has to be a plain positive number.** `1,250` with a thousands separator, or
  `0.68 g/cm3`, is refused: the row is skipped, and the message counts the skipped rows and names
  the first. `lineMaterialDensity` is held to the same rule.
- **Fill in the material name and its density together** — `materialName` and `materialDensity`. A row with one and not the other is
  now **skipped and counted**, with the first one named — it used to import as a success carrying
  no material at all, so the part quietly kept the weight it already had under a new label.
  `materialType` you can leave blank: it is filled in from the kind, `SURFACE` for a parachute or
  streamer canopy and `BULK` for everything solid. Write it yourself only to override that.
- **A canopy's packed size round-trips.** `packedDiameter` and `packedLength` are columns now, so a
  canopy you export, edit and bring back can still be fit-checked against the airframe's bore. Before
  that it came back "packed size unpublished" and lost its place in the recovery sizer to the very
  catalogue row it was exported from.
- **A blank cell elsewhere stays blank** — it is not read as zero — so leave out whatever does not
  apply to your part.

A row is keyed on `kind` + `manufacturer` + `partNo`, so re-importing an edited file replaces your
matching rows instead of piling up copies. An empty `manufacturer` files the row under **Custom**.
Your rows sit in the same list as the catalogue, and the search box matches manufacturer as well as
part number and description, so give them a name you will recognise — that is also how you filter
them back out to export.

**They live in this browser's storage and nowhere else.** Clearing site data for the app takes them
with it, they do not follow you to another browser or another machine, and nothing can re-download
them, because they came off your own disk. **The exported CSV is their only backup — keep one.** If
the browser refuses to store an import (a full quota, a private window, blocked site data) the app
says how many rows it could not store rather than claiming they went in.

**What the CSV does not carry.** Its columns are the fields the picker applies to a part, and a few
things the bundled catalogue holds have no column — a parachute's packed diameter and length among
them. That is the one that bites: a canopy you add by CSV states no packed size, so the recovery
sizing panel shows it as *packed size unpublished* and cannot check it against your airframe bore,
and where it competes with a catalogue canopy of the same maker, part-number family and size, the
one whose fit can be checked is the one you are shown. (To be offered there at all, a canopy needs
a diameter and a drag coefficient above zero.) Export a catalogue row, edit it, import it back, and
it returns without those fields.

---

<a id="visualizing-the-design"></a>

## Visualizing the Design

As you build, five views show you the design — a scale side view, an end-on aft view, a rotatable 3D shell, printable 1:1 fin templates, and a drag-analysis chart.

## The 2D schematic

A true-scale side view drawn from the tree. On a desktop browser the canvas is the hero of the Design workspace: it fills the center column, a **floating chip** carries five numbers you can check constantly (length, loaded mass, CG, CP, stability) — drag it anywhere on the canvas, fold it to a one-line stability pill with the ▾ button (a click unfolds it), and it stays where you put it, sliding back into view if the window gets too small for that spot and returning to it once there is room again. The full stat-tile grid, **All stats**, spans the bottom of the canvas and starts open on a wide screen: **▾ Collapse** at the top right of its header puts it away, and a **▤ All stats** button at the bottom left of the canvas brings it back. Opening the grid folds the chip to its pill — the grid carries the same five numbers — and closing it unfolds the chip again. In a narrower window All stats starts closed, and on a phone-width screen the chip is not shown at all, so the All stats grid is where those numbers live. The drawing shows tubes, lathed nose/transition profiles, fins at their real planforms, fin tabs, and motor cases drawn to scale — a **loaded motor is tinted and labeled with its designation** right in the mount — plus **CG and CP markers** in standard rocketry symbols. Hovering over a component highlights it and names it in a small tag; clicking selects it for editing. Dashed **leader lines** run from each marker to a labeled dot in the clear sky above (CG) and below (CP) the airframe — legible even when the two markers sit almost on top of each other, which is exactly the under-stable case you most need to see — and the **stability margin** floats beside them on the drawing itself, color-coded like the stability card: green ok (1–3 cal), amber over-stable, red under-stable. You can **drag components** to reposition them (with the snapping described earlier) and pan/zoom. Pods and parallel boosters draw off-axis where they actually sit, projected above/below the body in the side view.

**Dimensional rulers** run along the top and down the left, in your Preferences length unit: the top scale reads axial station from the nose tip, the left scale reads distance from the centerline (positive up, negative down), and the corner names the unit. They follow the zoom and the pan, so a zoomed-in view reads finer divisions, and the ⬇ SVG and ⬇ Image exports carry a ruler drawn for the whole rocket whatever the screen is zoomed to. The **📏** button on the canvas turns them off if you want the drawing to have the space back; the setting is remembered.

The **roll slider** down the far left turns the rocket about its long axis — desktop OpenRocket's rotation slider, in the same place. Drag it, and every part that has a clock angle sweeps through the view: each fin is foreshortened by the cosine of its angle, so a three-fin set reads as one fin at full span and two at half. **The moment you move the slider the drawing becomes a wireframe** — every fin is an outline, drawn over the body, with nothing hidden and nothing occluded. All of them stay on screen at every angle, including the one lying flat inside the body, which turns edge-on into a line across the tube rather than vanishing at the wall. **At rest the drawing is filled**: a fin pointing **toward** you is in front of the airframe and is drawn whole, crossing the tube; one pointing **away** is behind it and the tube covers its root. That is what tells the two lower fins of a three-fin set apart in a still picture. One thing to expect: **a set of N identical fins repeats every 360/N degrees** — a three-fin rocket rolled 120° is the same rocket, and the side view has no way to tell you which fin is which, so the wireframe at 130° matches the one at 10° exactly. (Zero itself is the exception, because zero is where the drawing switches back to the filled one.) The Aft view is where you can follow one fin the whole way round. Pods, parallel boosters and motor clusters swing with it. The readout under the slider shows the angle and clicking it returns to zero (so does double-clicking the slider). It is a **view** control, like zoom: it changes nothing in the design, nothing in the numbers, and nothing is saved — but it is shared with the Aft view, so you can roll the side view and switch to Aft to see the same attitude from behind. Launch lugs, rail buttons, camera shrouds and protuberances roll with everything else, each from its own **Angle around body** — zero is the top of this drawing, which is also where an unrotated fin set puts its first fin, so `0` means "in line with fin 1". That is the setting to move if you want a camera pointing between the fins rather than down one of them; the Aft view is where to check it. Two buttons beside that field do it for you: **▲ on a fin** and **⟂ between fins** put the part exactly where singular parts nearly always go — measured against every fin on the airframe stack, not just the tube the part happens to sit on, so a camera on the payload bay snaps to the fin can's fins. Those four parts stay **filled** while the view is rolled, unlike the fins — a fin is a thin plate and an outline is an honest picture of one, but a 20 mm camera shroud drawn as an outline would read as a thin line and lie about the part. They pass behind the airframe and are hidden by it, exactly as they are at rest.

**Rail buttons come as a set.** One rail-button component carries a **Number of rail buttons**
and a **Distance between buttons**, and every
button in the set is drawn, weighed, and flown. **📍 Auto-place rail buttons** in the properties
panel is a one-shot: the forward button goes at the CG (the loaded CG when a motor is loaded),
the aft one about an inch from the aft end. Press it again after the CG moves; anything you type
afterwards wins.

**A lug's or a button's angle decides where it sits, not what it costs you.** Like
the camera shroud above, a lug and a rail button are charged the same drag wherever
they sit around the body — a bump on a round airframe blocks the same air whichever
way round it is. The angle is there to keep
the part clear of the rail and clear of the fins, which is what the check below is for.

**A rail button with something else on its line gets flagged.** The rail runs down that line for the whole length of the rocket, so a fin, a lug or a shroud sharing it means the rocket will not slide onto the rail — the warning strip on the Design tab names both parts and how far apart they are. Two rail buttons at *different* angles get flagged for the same reason: one rail is a straight line, so they cannot both engage it. (Two buttons at the same angle is the normal build and says nothing.)

## The 3D view

An interactive 3D model of the rocket, drawn live in the browser — **drag to rotate, scroll to zoom** — with soft studio lighting and a genuinely translucent shell, so the internals (mounts, inner tubes, and the loaded motor) read through the wall. **Reset / Side / Aft** buttons in the corner jump the camera to known-good views (Reset is the way back if a zoom or pan ever loses the rocket; zoom is distance-limited, so the camera can't bury itself in the hull). It marks the **CG** (a neutral sphere) and **CP** (a red sphere) on the axis, and a **floating callout** beside the rocket repeats the two markers at their true stations with the color-coded stability margin between them, readable from any angle. Both are **optional** — the **◉ CG/CP** button in the corner turns them off for a clean shell, and *Preferences → Display → CG / CP markers in 3D* can keep one and drop the other. Pods and boosters render ringed around the airframe at their true radius and angle — and they export to OBJ too. The **📷 Image** button exports a hi-res snapshot of the view (see *Files, Units, and Offline Use → File formats*); its **Fit rocket to frame** option is on by default, so the export spends its pixels on the rocket rather than the background.

## The Aft view

The rocket seen end-on, sighted straight down the axis — a fin count, a pod ring or a motor cluster reads as it really sits, rather than projected onto one plane the way a side view must. It is the Aft tab on the design canvas, and it also sits under the motor list on **Motors & Launch** for every rocket. Zoom with the wheel and drag to pan. It shares the 2D view's **roll slider**, so the two agree: roll the side view until a fin goes edge-on, switch to Aft, and that is the fin pointing straight at you.

Angle zero points **straight up** here for everything with a clock angle — a fin set's rotation, a pod ring's angle offset, a cluster's rotation — matching where the simulation kernel puts them and what the 3D view draws.

## 1:1 fin templates (SVG)

From any fin set you can export a **true-scale printable cutting template**. It draws the fin outline as a hairline cut path, a dashed root-chord reference line, the through-the-wall tab rectangle where present, a label block (rocket/fin name, cut count, chord/height/thickness/cross-section/tab depth), and a **50 mm calibration ruler**. Print at 100% with no fit-to-page, then check the ruler measures exactly 50 mm — printers silently rescale, and the ruler is how you catch it. The SVG uses physical millimeter units and a 0.2 mm hairline, so it feeds a laser cutter directly.

## Drag analysis (CD vs Mach)

On the **Results** workspace, the **Drag analysis** panel plots your design's drag coefficient against Mach number — a static property of the geometry, no flight needed, recomputed live as you edit. Click **Show CD vs Mach** to open it. The charts pan and zoom like the flight plots: **drag a box** to zoom into it, **scroll the mouse wheel** to zoom about the cursor, **shift-drag** (or middle-button drag, or a one-finger horizontal drag on a touch screen) to pan, and **double-click** to reset — a hints line above the charts keeps those gestures on screen. Each chart's heading also carries two buttons: **↺** resets that chart to the full Mach range (it lights up once you've zoomed), and **⤢** expands the chart to a much taller canvas for reading fine structure — the transonic peak, the M1 CP shift — with **⤡** putting it back. Unlike the flight plots, the three drag charts zoom independently, so each heading resets and expands its own chart only.

- The main chart shows the **power-off** (coasting) drag curve. Give a stage a **nozzle exit diameter** (on the **Motors & Launch** page under the stage, or in the Stage property panel — the same field, two places) and a dashed **power-on** curve appears: during the burn, the motor's exhaust plume pressurizes the base area, so boost drag is genuinely lower than coast drag. The bigger the nozzle exit relative to the base, the bigger the reduction — a minimum-diameter rocket sees a large difference, a small motor in a fat airframe almost none. For a clustered mount, enter one equivalent nozzle whose exit *area* is the sum of the individual exit areas. Zero (the default) means the two curves are identical, and so does **Classic Extended Barrowman**: both halves of the nozzle model need the Rogers Kbf, Auto or Supersonic aerodynamics model. That same number also does a second job in flight, adding the motor's **pressure thrust** as the air thins — see *Multi-Stage and Clustered Rockets → Nozzle exit diameter* — so it is worth typing the motor's real exit rather than a round figure. This chart stays a static, no-flight property of the geometry, so only the drag half shows here.
- The **breakdown chart** splits the drag **by component** (nose, body, fins…) or **by type** (friction / pressure / base), so you can see *why* the rocket is draggy and where cleanup pays — the transonic drag rise starting near Mach 0.9 is plainly visible.
- A **CP-vs-Mach chart** shows the center of pressure across the whole Mach range — as **% of body length** (the wind-tunnel convention, the default) or, with the toggle beside the heading, in **your length unit from the nose**. With the supersonic model on, this is the chart to check before a fast flight: supersonic CP moves forward, and the accepted practice (RASAero's recommendation) is to keep **≥ 2 calibers** of margin through the transonic and supersonic regime.
- A **Conditions** selector says which air the sweep runs in. The default, **Sea level**, is what the drag curves here use, and is usually what you want. Pick **At altitude…** and type an altitude to run the whole sweep in the standard atmosphere at that height — thinner air means a lower **Reynolds number** — how far the airflow's inertia outweighs its viscosity — and so a slightly different skin-friction drag. This matters when you compare against someone else's published curve: wind-tunnel data is quoted at the tunnel's Reynolds number, and RASAero matches it with a **Mach-Alt table** (an altitude per Mach — for the NASA ARCAS tunnel runs, 25,000 ft at Mach 0.9 climbing to 122,500 ft at Mach 25). Comparing a sea-level curve against Reynolds-matched tunnel data invents a disagreement that isn't there. If you opened a **RASAero .CDX1 that carries its own Mach-Alt table**, a third choice appears and sweeps at exactly the file's altitudes, so the two curves are finally answering the same question. The conditions in force are printed under the drag chart and stamped into the CSV.
- A Max-Mach selector (1–5 classic; up to **25** with the supersonic model) and a **⬇ Drag table (.csv)** export round it out. The CSV is a full **aerodynamic-coefficient table** (CD power-off/on, CP, CNα vs Mach) usable as input to external trajectory programs. It opens with `#`-comment lines naming the app version, the design, the **aero model that produced the table** and the **conditions it ran in** — so a curve shared onward can't be mistaken for the other model's, or for one computed in different air — and its CP column follows your length unit. With the classic model, values above roughly Mach 1.5 are Extended-Barrowman estimates and labeled approximate; with the **supersonic model** (Preferences → Aerodynamics) they are validated against NASA wind-tunnel data to ~Mach 4.6 and physically extrapolated to Mach 25.

---

<a id="motors"></a>

## Motors

With the airframe drawn, the next step is choosing a motor. The app bundles the full thrustcurve.org catalog metadata **and every thrust curve it publishes for those motors**, so picking and flying a motor needs no network.

## Flight configurations (.ork)

MMRSim lets one design carry several **flight configurations** — "club field C6", "demo day D12" — each with its own motors and ignition settings. Opening a multi-configuration `.ork` loads **the file's default configuration** and a note names the one that loaded and says how many configurations the file holds. A **Flight configurations** panel then appears here on Motors & Launch listing every one by its name — or by its motor set when it has none of its own. Apply any one with a click, switch freely, or pick **None** to take every motor out and work on the design clean; ⏏ Unload in the vitals strip does the same. With no motor loaded you get the airframe on its own — empty mass, CG and stability margin with no motor in them, and 2D, aft and 3D views with no motor case drawn. The strip's **Launch** button greys out until you load one, and the Recovery readout reads "load a motor" rather than a weight, since there is no burnout mass to size a chute against. Unloading is a switch, not a discard: your other configurations are kept. Applying a configuration switches its motors, its ignition settings, its recovery deployment, its stage separation **and the weighed pad mass entered for its motor**, if any. Whatever you load stays loaded until you change or unload it. Your motor edits belong to the configuration you're flying — they are written back into it when you switch to another and when you save, and pressing Apply on the configuration on screen keeps them — and **saving writes every configuration back** to the `.ork` with its names and ids intact — with the one you were flying marked default. Share links carry the whole set.

## The database and browser

The app bundles **{{MOTOR_COUNT}} thrustcurve.org motors**, as pulled on {{MOTOR_DB_DATE}} (designation, manufacturer, impulse class, diameter, length, average/max thrust, total impulse, burn time, loaded and propellant weight, delays, availability, propellant/case info, type) **and every thrust curve thrustcurve.org publishes for them** — {{CURVE_MOTORS}} of the {{MOTOR_COUNT}} have at least one, and they all ship with the app, so any of those motors flies with no network at all. The {{CURVE_MISSING}} without are motors thrustcurve.org has no simulator file for (mostly out-of-production Gorilla loads and the Jambol line); import a `.eng` or `.rse` to fly one of those. When a motor has several published files, the app takes the one whose burn time agrees with the catalogue's certified figure, then a certification-body file over a user upload, then the richer one. Every motor mount gets its own card in the **Motors** panel, and each card carries a **🔎 Browse motors / import EX (.eng, .rse)…** button — nothing has to be selected in the component tree to use it, and a design with no motor mount has no card and no button. The card you open it from decides where the motor goes: the list is filtered to the diameters that mount can take, and the motor you pick is assigned to that mount. The browser's header names the source, the catalogue's date, its age in days once it has one, and the mount's diameter — so whether the bundled catalogue is still fresh is a readout you can check rather than something to remember. Motors listed as *occasionally produced* are shown alongside regular ones; only *out-of-production* motors sit behind a checkbox, which can be found in the "All Filters" dropdown (off by default).

**If the catalogue is stale — a motor certified last week is not in it — press ↻ Check thrustcurve.org in the browser's header.** The app pulls the live catalogue (one request for the manufacturer list, then one per manufacturer), screens every row for plausibility, and tells you exactly what changed: how many motors are new, which existing motors have different certified figures and by how much, which are no longer listed, and which rows it refused. If a motor loaded in your design is among the changed ones, that goes to the top of the result — it names the motor and which of its figures changed, and tells you to re-run the flight. The result is kept in your browser and applies everywhere a motor is looked up — the browser, the quick picks, batch simulation and file import — so a design saved with a newly listed motor reopens correctly tomorrow. It never edits the app's catalogue file, and it discards itself as soon as an app update ships a newer catalogue. Repeat checks are refused for six hours unless you insist. New motors download their thrust curve on first use as usual; the check refreshes the catalogue, not the bundled curves.

Three filter rows sit above the table, each chip carrying its count: **Makers**, **Diameter** (only the diameters that fit the current mount, or are smaller, are offered), and **Class** — the impulse letter, so "just the H motors" is one click. Beside the search box, **only motors that fit** hides anything longer than the maximum motor length this stage states; when **Max motor length** is blank, the checkbox is disabled and says so, since there is nothing to filter against. **▸ All filters** unfolds the rest — a **burn-time window** and a **total-impulse window** (type a low bound, a high bound, or just one; the placeholders show what this mount's motors actually span), propellant, and *include out-of-production* — kept out of the way so the dialog opens as three rows and a search box. The windows are typed rather than dragged on purpose: the impulse range for a single mount covers three orders of magnitude, which no two-ended slider handles usefully. Every filter is remembered between sessions.

A motor longer than the stated maximum is flagged ⚠ in the table whether or not you filter it out, so you can still choose one deliberately. When a curve lacks CG data the kernel uses its built-in fallback: mass drops from loaded to burnout weight in proportion to cumulative impulse, with CG fixed at half length.

Two things the Thrustcurve database cannot tell you: **the pressure the curve was measured at** (every curve is treated as a sea-level measurement) and **the motor's nozzle exit diameter**.

MMRSim fills in the exit diameter, if it is stored in MMRSim's nozzle database. AeroTech's come from their published drawings: the reload-kit assembly or DMS drawings. Loki Research's come from their reload-kit instruction sheets and the nozzle tables on their Tech Info page — 54 of their 58 in production. Load one of those motors and the **Nozzle exit diameter** field under the stage on the **Motors & Launch** page fills itself in, with a line underneath naming the value, the nozzle, and the document it came from. Six things worth knowing:

- **The number follows the motor.** Change the motor and the exit diameter changes with it; take the motor out and the field empties, and the app tells you what the value it removed belonged to. If the new motor has no published figure the field is cleared rather than carried over, and you are told so.
- **A value in a file is not overwritten.** If a design you open carries a nozzle value and it disagrees with the published figure, the app shows both numbers and offers a one-click accept rather than changing your data.
- **A cluster is filled as one equivalent nozzle.** The correction works on one exit area per stage, so a cluster is entered as the single nozzle of the same total area. Area goes as the square of diameter, so four identical motors have four times the area and exactly twice the diameter — four 1 in exits fill in as one 2 in exit, and nine would be a 3 in one.
- **Nine AeroTech motors have two published nozzles.** The app takes the one AeroTech's dated revision block calls current and says so, naming the alternative — the K1100T's two options differ by 43 % in area, so check which nozzle is in your reload kit. On the Loki side, remember their nozzles are **banded**: the number engraved on the nozzle is its throat in 64ths of an inch, and one moulded exit serves a whole run of throat sizes in a given case.
- **A 76 mm Loki nozzle can be machined out**, and the app says so under the field on those motors. Loki's own note: *"76mm nozzle exits up to 2.0″ are available upon request for an additional machining fee, however this removes more graphite material, thus weakening the part and making it more vulnerable to cracking."* What the app fills in is Loki's **standard** exit for that case; if yours was machined out, type what you have — 2.0″ against the standard 1.818″ is 21 % more area, and against the 1.500″ band it is 78 %.
- **Cesaroni publish nothing anyone has found**, and four Loki motors are short: their published exit table stops at 76 mm, so the 98 mm N3800 and N5500 have none, and the 54/4000 case (L2050, M1378) has no commercial nozzle listed because those nozzles are one-time-use. On the AeroTech side what remains uncovered is the **older single-use line** — motors with neither a reload kit nor a DMS design sheet, mostly 24 mm and 29 mm hobby motors. A handful of covered motors also carry a row with no number on purpose: the J615ST is an aerospike and has no exit plane at all, four 29 mm DMS motors have the nozzle moulded into the case rather than as a separate part, and one has a nozzle the sheet says was cut shorter than the mould, so the moulded exit would be too big. Those motors leave the field alone and say nothing. Take the number from the motor's data sheet or measure the hardware; for a motor with no published figure, all the app can check is that what you type is not wider than the casings it comes out of.

## Filters

Beside the **Makers**, **Diameter** and **Class** chips is a **search box that matches motor names**. Type any part of a designation or a common name — `C6`, `J350`, `I224` — and the list narrows to the rows that contain it. It is a plain substring, not a sentence: case does not matter, spaces do, there are no operators, and a second word is just more literal text, so `J350 AeroTech` finds nothing. It searches the tidied-up name the table shows as well as the raw one, which is how `I224` reaches Cesaroni's `381I224-15A`. And it narrows what the chips are already showing rather than searching the whole catalogue — maker, propellant and out-of-production are filters, not search terms.

The results table (capped at 400 rows) sorts by designation, manufacturer, diameter, length, burn time, or total impulse (the default). Sorting the "Motor" column sorts by the cleaned-up *display* designation, so a Cesaroni motor like `381I224-15A` is ordered as `I224-15A` rather than by its impulse-prefix digits, while the raw designation stays the file identity.

## Diameter-class fit (adapter-down)

The mount's inner diameter drives which classes appear. A mount fits **every class at or below its own** — smaller motors ride in adapters — and nothing more than **1 mm** above it, the clearance the fit check allows. Anything bigger is excluded from the list, not merely flagged. Note that **75 mm and 76 mm are the same class** (shown "75/76"), and diameters snap to the nearest common class within tolerance because tube IDs have variance.

## Delays and the drill-to-fit rule

The prescribed delays from the motor's label are informational only. In the browser's **Delay** select you can choose Auto (optimal), any prescribed delay, or **Custom** and type a value; on the main Motors panel you can type **any whole-second delay** without reloading, or tick **auto (optimal)** on the sustainer. This is the drill-to-fit rule: users drill an adjustable delay to whatever whole second they want, so the recommendation is `round(optimum)` and is **never snapped to the prescribed list**. One subtlety: the kernel's optimum delay is the coast from burnout to *ballistic* apogee (a deployment-free probe), and auto uses a two-pass approach — fly once, read the optimum, round it, and re-fly.

## Weighed pad mass — flying at the mass you put on the pad

Weigh the rocket the way it goes on the pad — motor, adapter, retainer and closure all in — and type that
weight into the field under the loaded motor on **Motors & Launch**. There is no button: it acts as you type,
the line under the field says what the app did with it, and the next **Launch** flies it.

**What it buys you is the hardware no catalogue counts.** A catalogue weight is the motor alone; the adapter,
the retainer and whichever forward closure is fitted are in no catalogue and not in your airframe figures
either. The app subtracts the dry rocket and the catalogue motor from what you weighed and carries the
difference as inert mass on that motor for the whole flight. Your pad mass then comes out at exactly what you
measured, apogee and speed off the rail move with it, and the recovery sizing includes the hardware. It
applies everywhere a flight is flown — the design page, **Launch**, and the batch sweep, where a note says
which row carries it.

**The number belongs to that motor in this design, and goes no further.** It is stored with the flight
configuration it was weighed with, inside the design, so it travels in the `.ork` file and in a share link and
switches with the configuration the way its motors do. Nothing is recorded against the motor itself: weighing
a J460T here does not follow a J460T you load in another design. Load a different motor on this mount and the
field is blank for it, showing dry mass plus the catalogue motor as a placeholder until you weigh again;
unload the motor and the number goes with it.

**When the set changes, it stops being applied rather than quietly going wrong.** Swap a booster's motor,
empty or fill another mount, or edit a cluster count, and the number is kept but greyed and **not flown** —
the line names what changed. Put the set back and it applies again; re-weigh with the new set in, or clear it,
to move on. Load a motor on a stage above the one you weighed and the field follows to that motor, blank,
while your number waits with its own. Changing the delay keeps the weighing, because the hardware does not
change with the delay grain — but a different forward closure is a different weight, so re-weigh if you swap
one.

Two entries are refused outright, with the line saying why: a weight lighter than the dry rocket plus the
catalogue motor, which is a typo or the wrong motor, and a difference heavier than the airframe itself. A
difference over half the motor's own weight is flown but flagged, so check it. Nothing is sent anywhere — it
is an input to the flight, not a statistic. Desktop OpenRocket does not read the figure: it skips the tag with
a warning, the same way it treats the two measured airframe figures, and a file without one opens exactly as
before.

If you have a pad weight typed into an older version's *Measured mass & CG* box, opening the design moves it
under the motor it belongs to, or tells you it could not and names the value so you can re-weigh.

## Per-stage maximum motor length

Each **stage** has its own "Max motor length" — a booster and a sustainer have different room. Motors longer than the limit are flagged in the browser and excluded from batch simulation. This is separate from the diameter-fit rule; a motor can be the right diameter but too long.

## EX and custom motors, and quick picks

You can **import experimental motors** from RASP `.eng` or RockSim `.rse` files — pick one or several files with **⬆ Import .eng/.rse**, or point **📁 Import EX folder** at the folder where you keep your motor files and every `.eng`/`.rse` inside is added in one go. They appear under an "EX" manufacturer (the real manufacturer name is preserved), persist in your browser between sessions, filter and simulate like any database motor, and — for `.rse` files with measured per-sample masses — use those masses instead of the impulse-proportional model. An `.rse` file's `exitDia` is not read, and an imported motor is never looked up in the nozzle database, so a stage's nozzle exit diameter is yours to type. Curves are local; no network needed. Select an imported motor and press 🗑 to remove it. The **Quick picks** dropdown beside the browser is the Quick Start's short list of common Estes motors for one-click loading — ordinary catalogue motors with their certified curves, not a separate set. It appears while the design is still the untouched starter rocket, **My Rocket**, and it lists only the picks that fit the mount you are loading; once you have made the design your own the field becomes a plain readout of the motor on that mount, and everything comes from the browser, which filters to the mount as well. Nothing in the app substitutes a curve for a motor it cannot load — it tells you instead.

---

<a id="launch-conditions"></a>

## Launch Conditions

Before you fly, the Launch Conditions panel (in the **Motors & Launch** workspace) sets the pad and the weather. It collects nine fields: **launch rod/rail length** (default 1 m), **rod angle** (0°, range −30…30°), **average wind**, **wind gust sigma** (standard deviation of gusts about the average), **site altitude** (0–10,000 m), **latitude** (default 28.61°, roughly Florida), **temperature**, **station pressure**, and **time step** (blank = 0.05 s; see below). Values display in your preferred units and convert to SI on Launch.

**Temperature and station pressure fill themselves in from your site altitude.** Leave either one blank and the app flies the standard value *for the altitude you set* — the greyed number you can see in the box — using the ISA profile (15 °C and 101,325 Pa at sea level, the temperature falling 6.5 °C per km). Change the site altitude and both numbers follow it. You only need to type in these boxes to try a **specific day's air**: a hot afternoon, or a pressure you actually measured.

**Two different numbers are both called "pressure", and this field wants the less common one.** Station pressure is the raw reading of a barometer sitting on the pad. Almost every pressure you can look up — a weather app, an airport METAR, the altimeter setting the RSO reads out — has been *reduced to sea level*: the weight of the air between that spot and sea level is added back, so that fields at different elevations can be compared on one scale. At sea level the two are the same number, which is why this never comes up at a coastal field. At a 3,900 ft pad the barometer reads about 878 hPa (25.94 in-Hg) on a standard day, and almost every source you can check says about 1,013 hPa (29.92 in-Hg). Same air, two numbers, and nothing about either one says which kind it is.

Type 1,013 hPa at a pad that high and you have told the app the pad is at sea level. It then flies air about 15 % denser than the real thing: more drag on the way up, and the motor loses the extra thrust thin air gives it (see *Multi-Stage and Clustered Rockets → Nozzle exit diameter*). Measured on a 29 mm test rocket with a 153 N·s motor and an 11.4 mm nozzle exit, flown from that 3,900 ft pad on the app's default aerodynamics: apogee reads **898 m instead of 991 m, 9.4 % low** — and **low is the wrong direction**, because you size recovery and check your waiver against a number the rocket will beat. How much depends on your design and your aerodynamics model. The quick check: above about 2,000 ft, a pressure near 1,013 hPa (29.92 in-Hg) is a sea-level number, not a pad number.

You do not have to catch it yourself. Above a 600 m (about 2,000 ft) site, a typed pressure that reads like a sea-level figure raises a caution in the panel quoting the pressure your altitude implies, and an imported `.CDX1` file carrying one gets a line in its import note. Both give the same fix: **clear the field**, and the app uses the standing pressure for your site altitude. Below 600 m neither says anything — down there a sea-level figure flies air under 7.5 % denser than the pad's, and a caution that fires on nearly every file is one you stop reading. Both go quiet as soon as the pad's pressure is plausible for its altitude, so a pressure you measured is never second-guessed.

### Time step — what it sets, and why the default is 0.05 s

The **time step** is an accuracy control, not a speed control. It sets the longest stride the integrator may take between recalculating the flight — and, at a twentieth of itself, the shortest, so while the rocket is climbing and coasting no stride is finer than that however hard the flight is working. A shorter stride is in principle a more faithful flight; the reason the field behaves like a speed control in practice is narrower than that — the answer has already converged at the default, so asking for something finer buys run time and nothing else. (It governs the ascent and the coast. Once a recovery device is out, the descent runs on a simpler stepper with a stride of its own, up to half a second, whatever you set here.)

**Leave it blank and you get 0.05 s** — the simulation kernel's own recommended value. The field takes anything from 0.01 s to 1 s.

**It is a ceiling, not the step.** The simulator picks each step as the smallest of eight limits (see *How It Works → How a flight is simulated*): your setting is only one of them, and the others — maximum pitch-angle change, roll-rate change, launch-rod length — bind tighter wherever the flight is delicate. It also shortens a step to land on the next scheduled event where it can, so staging, burnout and ejection are caught as they happen rather than somewhere inside a stride; the exception is the floor above, which wins when landing on an event would mean a stride shorter than a twentieth of your setting. That is why asking for a finer step buys much less than it seems.

**How much less: measured.** Four designs — including a Mach 2 minimum-diameter bird, a two-stage 38/54 mm, and a subsonic sport model — were each flown against a converged reference step of 0.002 s, using real published thrust curves. At 0.05 s:

| what you read | how far it moves at 0.05 s |
|---|---|
| Apogee | within **0.06 m on a 6.4 km flight** (exact to the centimetre on the 10.4 km two-stage) |
| Maximum velocity | ≤ 0.018 % |
| Maximum Mach | ≤ 0.025 % |
| Optimum ejection delay | ≤ 36 ms — the recommendation is that optimum rounded to a whole second, so it reads differently only when the optimum sits within 36 ms of a half-second |
| Ground-hit velocity | ≤ 0.004 % |
| **Simulation warnings** | **identical — not one appears or disappears** |

Going finer than 0.05 s does not improve any of those — the answer has already converged. Going **coarser** is the direction that does cost accuracy, and it costs it twice over: each stride covers more of the flight, and your setting also sets the floor at a twentieth of itself, so the simulator can no longer shorten a stride as far as a fast-changing moment asks. No figure for how far a coarse step drifts has ever been recorded here, so there is none to quote.

**What it costs.** Roughly, relative to 0.05 s:

| time step | flight takes |
|---|---|
| 0.04 s | 1.1–1.3× longer |
| 0.03 s | 1.5–1.7× longer |
| 0.02 s | 2.0–2.8× longer |
| 0.01 s | **3.7–6.0× longer** |

The simulation runs inside the browser tab, so while it runs the page cannot respond. On a large design a 0.01 s step is the difference between a wait and the browser offering to kill the page.

**If a file asks for a finer step**, what happens depends on where the file came from. A file this app saved keeps its own step, down to the field's 0.01 s floor. A file from anywhere else is flown at 0.05 s instead, with a line in the file-opened note saying so and telling you how to set it back if you want it flown at the step the file asked for — which you can, as long as that value is 0.01 s or more, since the field will not take less. Either way the Time step field shows the step actually being flown, and below 0.05 s the panel shows what it costs: a multiplier, and once you have flown once, seconds per flight.

**Rod-exit velocity does not depend on your time step**, and two things see to that. While the rocket is still on the guide the simulator works in shorter strides — about a fifth of your setting, and shorter again as the rocket speeds up, since one of the eight limits is a tenth of the time it would take to cover the whole guide at the speed it is doing — so the launch guide is integrated more finely than the rest of the flight whatever you set. And the speed reported is interpolated across the stride that straddles the rod tip, to the instant the rocket clears it, rather than read off the end of that stride. So a finer setting buys nothing here.

**Deterministic by design**: wind turbulence is seeded (default seed 42), so identical inputs always produce an identical flight. That is intentional, and it differs from desktop OpenRocket, which picks a fresh seed for each simulation — re-running here will not vary the result, and that is not a bug. (The physics behind the wind model and this determinism choice is covered in *How It Works*.)

Launch conditions also travel inside your `.ork` file (and in share links), so a design opened on another machine — or in desktop OpenRocket — flies with the same pad and weather you set here. One thing does not travel, because the app does not model it: the compass direction of the wind and of the rod. A file that aims the rod at an angle to the wind loses that relationship when you open it here, and is saved back as a rod pointing straight into the wind.

---

<a id="simulating-and-results"></a>

## Simulating and Reading Results

With a motor assigned and conditions set, press **Launch**. This section covers the single-flight run, the plots, the safety-graded report, saved runs, and batch simulation.

## Running a single flight

Assign a motor, set conditions, and press **Launch**. The app builds the flight options and simulates once; if the primary mount is on auto-delay it reads the kernel's optimum, rounds it, sets that delay, and re-flies. The primary mount is the topmost stage's mount that has a motor — it drives the lead columns and the auto-delay probe. Engine invariants: **RK4 with adaptive time step, Extended Barrowman aerodynamics, quaternion orientation, and a 6DOF→3DOF switch after recovery deployment.** (One caveat worth knowing: before it starts the flight the app waits for the browser to paint the **Simulating…** label, and a browser stops painting a tab you cannot see. A stuck **Simulating…** means the window is hidden — bring it to the front and the flight runs.)

## The Fly screen (phones, at the field)

On a phone the app opens on **Fly** — a launch-centered home screen built for the flying field rather than the workbench: your rocket drawn beside the four numbers that matter at the pad (**apogee, optimum delay, descent rate, max velocity** from the latest flight), the stability verdict up top, a **motor row** that jumps to Motors & Launch to swap what you're flying, the three launch conditions that actually change at the field (**rod length, rod angle, wind**), a full-width **Launch** button, and a shortcut into batch compare for the "which of my motors flies this best today" question. The workspace tabs dock to the bottom of the screen, thumb-height; Design and Results stay one tap away. On a desktop the Fly tab is hidden — the vitals strip already serves that job there. One thing that is on every screen size, mentioned here because a phone is where it matters most: anything the app has to tell you — an import note, a motor warning, a build error — appears in a **message strip** pinned to the bottom of the window, and on a phone it sits above the tab bar rather than under it. Collapsed it shows the most serious message on one line with a **+N** count of the rest; tap **⌃** to open it and read them all, and **×** on a message to clear it. Some messages have no **×** — they state something about the design that is still true, so clearing one would do nothing; change the design and they go by themselves.

## Flight plots

Up to **eleven synchronized single-series panels**: Altitude, Velocity, Acceleration, Mass, Thrust, Drag force, Mach number, Stability margin (cal), CP location, CG location, and Angle of attack. A chip bar toggles panels (default: altitude/velocity/acceleration), and a series only appears if the kernel actually produced it. Measures on different scales are not stacked onto one chart with two y-axes: **each series gets its own panel and its own y-scale**, in a fixed color, with theme-aware axes. Hover for synchronized crosshair readouts.

The block is headed **Flight plots**, and the two raw-data download option buttons sit in that heading: **⬇ Flight data (.csv)** and **⬇ Flight data + charts (.xlsx)**. Both really do re-fly the shown flight: **Launch** asks the kernel only for the series the report and the plots need, so the rest of the columns have to be flown again — which is why the button reads **⏳ Re-flying…** while it works. It is the same flight rather than a second opinion: the wind model's random seed is fixed and nothing in the app varies it, and the ejection delay and aerodynamics model that flight flew on are put back before it runs. One thing to watch — the re-fly uses the design and the launch conditions **as they stand now**, so if you have changed either since that flight (the warning note above the plots names what changed), press **Launch** again before you export. Both stamp the design name into the filename.

The plots pan and zoom, and every gesture acts on **all panels together**: **drag a box** to zoom into it, **scroll the mouse wheel** to zoom about the cursor, **shift-drag** (or middle-button drag, or a one-finger horizontal drag on a touch screen) to pan, and **double-click** to reset to the full flight. You don't have to memorize any of that — a one-line **gesture hint** sits above the charts (it shows the touch gestures instead when you're on a touch screen), and next to it a **↺ Reset view** button brings every panel back to the full flight; it's grayed out until you have zoomed or panned, so it doubles as a "you are zoomed in" indicator. A zoom survives theme and unit changes, and re-flying an unchanged design keeps it; a flight whose time axis has changed opens at full width. Zooming works on the **time axis** — each panel's vertical scale re-fits whatever part of the flight is on screen, so the shape of a curve changes as you zoom into it.

Too small to read? Every panel's heading has an **⤢ expand** button: the panel grows to the **full width of the charts area and a much taller canvas** (on wide screens the other panels reflow around it, so an expanded Altitude chart can sit above the ordinary-size rest). The expanded panel stays in the synced group — crosshairs, zooms and pans still track across all panels. Click **⤡** to restore it, and expand as many panels as you like.

## The launch report and safety checks

The report header shows the **optimal / recommended(available) / flown** delay, then a per-device **recovery table** (drogue and main each get a row: deploy time, altitude, opening velocity, **the drag coefficient that device actually flew**, its settled **vertical descent rate**, its speed **over the ground** — descent plus wind drift — and a verdict). The Cd column is read from what the physics engine was handed, not from the design panel. For a canopy the two agree, with one deliberate exception — a spill hole: the kernel has no concept of a vent, so the vent is taken out of the coefficient instead, and the column shows both figures, `1.44 (1.50 less a 122 mm vent)`, because a manufacturer's rated coefficient is measured against the canopy area minus its vent. Leave the drag coefficient blank and the column says that too — `0.80 (auto)`, the value a canopy flies when none is typed — so the number the landing verdict rests on is always on screen. A **streamer** left blank still reads `—`: its automatic coefficient is worked out from the strip's length and material rather than being a fixed number. "Show all details" expands roughly thirty attributes: max altitude/velocity/Mach/acceleration, times to launch guide exit / burnout / apogee / landing, velocity and thrust:weight at launch guide exit, launch mass, and the angle of attack, CG, CP and static margin at launch guide exit — flight values at the moment the rocket leaves the guide, which is why the CP there sits forward of the Design tab's still-air CP whenever there is a crosswind — landing descent rate, plus the motor's diameter, manufacturer, type, propellant, and case.

Every flight is graded against these thresholds:

| Check | Threshold | Meaning |
|---|---|---|
| Lift-off speed | ≥ 15 m/s (~50 ft/s) | Enough airspeed leaving the guide to be stable |
| Thrust:weight | ≥ 5:1 | Adequate initial acceleration |
| Safe deployment | ≤ 21.34 m/s (70 ft/s) | Opening shock won't zipper the tube |
| Drogue descent | ≤ 21.34 m/s (70 ft/s) | Top of accepted drogue band |
| Landing rate (vertical descent, not speed over the ground) | ≤ 6.1 m/s (20 ft/s) | Survivable ground hit |
| Static margin | 1.0–3.0 cal | Stable but not so over-stable it weathercocks |

The report also flags **weathercocking risk** and echoes the average wind, so an over-stable rocket in a stiff breeze reads as a warning rather than a silent number.

The physics kernel raises its own **simulation warnings**, and they appear as a distinct block near the top of the report — plain-language lines like "No recovery device — the rocket comes down ballistic" or "Recovery device opened at high speed", carrying the kernel's detail (the speed, the device name) where it has one. High-priority warnings are styled red like failed checks, and also banner across the top of the Results view right after a launch, so a ballistic flight can't be scrolled past; lower-priority ones (supersonic flight, geometry cautions) read as notes. The saved-runs CSV keeps the warning keys in a **Sim warnings** column.

"Show all details" also reports **landing drift**: the lateral distance from the pad at touchdown, with its compass bearing. The simulation's wind is a steady east wind, so a windy flight drifts downwind — due west — and the bearing says so. And when a design actually rolls, a **max roll rate** row appears in r/s (revolutions per second, with °/s alongside); rockets that don't roll suppress the row instead of showing integrator noise.

## Saved runs and CSV

Every flight is stored to a **run history** (up to 500 runs, surviving reloads). A typical flight-day flow is to fly many motors, compare the table, and download it with **⬇ Run table (.csv)** or **⬇ Run table (.xlsx)** — one row per saved run, summary numbers only, with the design name in the filename.

Run history stores each flight's **report**, not its raw time series, so the plots are a separate question. The flight you just flew keeps its plots even after you click around the saved-run table and come back. For any *other* stored run of the design currently on screen, a **📈 Charts** button appears in its row (and a **📈 Show charts** button on the run itself) which re-flies the design at that run's conditions and draws the plots — deterministic, so it reproduces that exact flight, and it does **not** add another row to the history. When the design, motor or conditions have moved on since a run was flown, the button is absent and the app says so rather than drawing a flight that isn't the one in the table.

For the raw numbers behind one flight, the Flight plots heading offers **⬇ Flight data (.csv)**: the full per-timestep recording of the shown flight — every series the kernel produced (time first, then the familiar dozen, then the symbol-keyed extras with self-describing headers like "Vz — Vertical velocity (m/s)"), in your preference units (each column header names its unit). Staged flights land in one file, each booster's columns prefixed with its stage name and carrying their own time column. Time series aren't stored with run history, so the app re-flies the shown flight to produce them — the same flight, not a new one, because the wind model's random seed is fixed and that flight's own ejection delay and aerodynamics model are restored for the re-fly. Press **Launch** again first if you have changed the design or the launch conditions since, because the re-fly uses them as they stand now.

Beside it, **⬇ Flight data + charts (.xlsx)** exports the same data as a real spreadsheet: numbers as numbers rather than text that looks like one, a frozen filtered header row, and a live Excel chart tab for **every column it exports** — about 31 tabs on a full single-stage flight — built on the sheet's own cells, so editing the data updates the graph. The headline quantities get a tab each (altitude, velocity, acceleration, mass, thrust, drag force, Mach, stability margin, CP, CG, angle of attack); the coefficient, rate and position families share themed tabs; anything left over gets its own. Staged flights get one data sheet per stage, one series per stage on the headline tabs, and a per-stage tab for each themed family.

## Batch simulate

Batch mode flies **every motor that fits the mount** (after your diameter-class, manufacturer and out-of-production filters) through the current design at each motor's auto-optimal delay, then grades each flight against your acceptance criteria — minimum rod-exit velocity, minimum thrust:weight, and an apogee window. Results append to the run history and download as CSV. This is the motor-shopping tool: pick the airframe, pour in a manufacturer's whole catalog, and read off which motors hit your target altitude safely. If the loaded motor carries a weighed pad mass, the batch flies that motor at the mass you weighed and every other candidate at its catalogue weight — there is no honest number for hardware you have not weighed — and the note above the table names the row that carries it; expect that row's apogee to read a little lower than another candidate of the same impulse. The mixed-cluster combination rows fly at catalogue weight.

Every candidate flies **its own published nozzle exit diameter**, where the app has one for it — the same number the design page would use for that motor — so a motor reads the same in the sweep as it does from the **Launch** button. Rows that flew one are marked **· nozzle** in the Motor column, and a note above the table says so. The app holds a published exit for AeroTech and Loki motors only, so on a typical sweep some rows carry the nozzle model and some do not; that is why two motors of similar impulse can sit a few percent apart, and the marker is there so you can see which is which. A candidate the app has no exit for flies without one, exactly as before. If you have typed your own exit under the stage, the row for **the motor you typed it for** flies your value rather than the published one — which is what you want for a nozzle you machined yourself. Under **Classic Extended Barrowman** none of this is live, in the sweep or on the design page (see *Multi-Stage and Clustered Rockets → Nozzle exit diameter*).

---

<a id="multi-stage-and-clusters"></a>

## Multi-Stage and Clustered Rockets

Once you are comfortable with single-stage flights, the same tools scale up to staged and clustered rockets.

## Staging and separation

Add stages as siblings under the rocket root; they flatten nose-to-tail into one chain for layout. A **lower** stage carries a **separation trigger**: its own ejection charge (the default), its own burnout, its own ignition, the upper stage's ignition, launch, apogee, altitude ascending/descending, or never — plus a separation delay. The top stage ignores separation (it separates *from* nothing). After a stage drops, the kernel simulates the separated piece's own flight, which the report can summarize.

## Ignition triggers on a staged rocket

Each staged motor has an **ignition trigger**: Automatic (the launch stage at launch, every stage above it on the ejection charge of the stage immediately below), lower-stage burnout + delay (electronics), launch + delay (timer), lower-stage ejection charge + delay, or never. **You can set the trigger on any motor**, and what decides which one is right is the motor's **propellant**, not the rocket's power class: gap staging lights a black powder motor off the charge below it, and a composite motor generally will not light that way — so plenty of ordinary mid-power composites need electronics.

The app has to start somewhere, so a motor loaded into **any stage above the launch stage** — the sustainer, and the middle stage of a three-stage rocket too — starts on *burnout + 1 s* (electronics-timed) unless the catalogue records its propellant as black powder, in which case it starts on Automatic. A motor the catalogue records no propellant for also starts electronics-timed: that is the safer of the two guesses, because a sustainer that will not light is a flight you can see going wrong, while one the app lit for you in a simulation is not. A strap-on booster starts on Automatic whatever it burns, because it lights at launch alongside the stage it rides on. Treat all of that as a starting point rather than a recommendation, and set it to match your own staging hardware. One thing to watch: picking a motor sets that mount's trigger afresh, so choose the motor first and the trigger after.

## Booster recovery and clusters

Every booster gets its own landing rate in the report, judged against the same 20 ft/s (6.1 m/s) descent target as the sustainer — under a canopy or tumbling in — and flagged when it is over. A booster with **no recovery device at all** also draws a comment naming the speed it tumbles or falls in at, when its motor is above 80 N average thrust or 160 Ns total impulse.

**A booster can be dual-deploy.** From the moment a stage lets go, the app flies it as an independent rocket — a serial booster stage and a strap-on alike — so it can fly a drogue-then-main descent the way the sustainer does. Put two recovery devices in the booster's own body tube and give each its own trigger: a drogue on **Apogee**, a main on **Altitude (descending)** at the height you want. That stage flies its own branch, with its own apogee, and gets its own recovery table in the report. The drogue stays out under the main, and the descent is worked out from both canopies together.

Three things to watch. A booster's **motor ejection charge** is scheduled at its own burnout plus its motor's delay, which is not the separation clock — give a strap-on a long separation delay and the charge can fire while the booster is still attached, opening its chute on the rocket as a whole, and a fast one is flagged as a high-speed deployment. Triggering on **Apogee** or **Altitude (descending)** avoids that, as does matching the motor's delay to the separation. Next, a ring of strap-ons is one part with an instance count, so it flies as one branch and gets one verdict; its mass and its canopy area both scale with the count, so the descent rate shown is what one of them would see alone. And recovery weight and the **Recovery sizing** panel both stand down on any design holding a strap-on booster (see *Designing the Rocket → Recovery*), so size a booster canopy from its own weight and check it against the descent rate the report measures.

**Clusters** (see *Designing the Rocket → Motor mounts and clusters*) let one motor selection drive several tubes; thrust scales with the count and mass sits at the real pattern positions.

## Parallel (strap-on) boosters and pods

Serial stages stack nose-to-tail; a **parallel stage** rides alongside. Build one with the **Booster (parallel stage)** assembly (see *Designing the Rocket → Pods and parallel boosters*): it carries its own separation trigger and delay, its motor ignites by the same trigger rules as any staged motor, and after separation it descends on its **own tracked flight branch** with its own recovery verdict. A non-separating **pod set** simply adds its mass and drag for the whole flight. One planning note: batch motor simulation is disabled while a separating booster is present, just as for serial staging — the motor combinations multiply beyond what a single sweep can grade.

## Nozzle exit diameter: power-on drag and pressure thrust

Each stage carries its own **nozzle exit diameter** (see *Visualizing the Design → Drag analysis*), and while that stage's motor burns it does two jobs — so a booster and a sustainer each get the right treatment during their own burn, the same way RASAero II does. Leave it at zero and neither job applies: nothing changes.

**Less drag while the motor burns.** The exhaust plume pressurizes the base area over the nozzle-exit footprint, so boost drag is genuinely lower than coast drag; the sim picks power-on or power-off drag per stage, per time step.

**More thrust as the air thins.** A published thrust curve is a **sea-level measurement** — the motor was fired on a stand with the whole atmosphere pressing back on its nozzle exit. As the rocket climbs the air pushes back less, and the motor gains exactly the exit area times the pressure it has lost. That is the *pressure thrust* term, the one RASAero II adds, and the app flies it using the exit diameter you type under the stage. The formula, and the sea-level assumption behind it, are in *How It Works: Physics & Math → Motor thrust-curve model*.

Five rules ride with the thrust term, and they are worth knowing before you trust the number:

- **Only while the motor is burning.** Before ignition and after burnout it is exactly zero — the same moments the power-on drag reduction switches on and off, so the two turn on together.
- **Once per stage at every step of the burn**, using that stage's exit diameter. "Once per stage" is about how many nozzle areas are counted, not how often — the term is worked out afresh at every step the simulator takes while the motor burns, so it grows the whole way up as the air thins. For a clustered mount, type the single equivalent nozzle whose exit *areas* are summed, exactly as the drag half already expects — one motor's exit would under-count a cluster, and the app charges the typed area once, not once per motor. One limit worth knowing if you airstart part of a cluster: the whole summed area is charged from the moment the *first* motor in that stage lights, so a staggered cluster is over-credited until the rest of them light. (The power-on drag reduction behaves the same way.)
- **It follows the aerodynamics model,** as the power-on drag reduction does: on under **Rogers Kbf** (the default), **Auto** and **Supersonic**; off under **Classic Extended Barrowman**.
- **Two ways to turn it off:** pick **Classic Extended Barrowman** in the vitals strip's Aero selector, or clear the stage's nozzle exit diameter — which drops the power-on drag reduction with it.
- **It cannot drive the thrust below zero.** The term goes slightly negative if you fly from a pad *above* 101,325 Pa (type an altimeter setting and you will), which is correct and tiny. But a wildly oversized exit typed against such a pad could in principle drive the total below zero, and a burning motor cannot push a rocket backwards, so the corrected thrust is floored at zero.

**How big is it?** It is **smallest at liftoff and grows the whole way up** — and on a high pad it is already working before the rocket moves, because the air there is thinner than sea level to begin with. Measured on a tester's file — G record 2023, a 0.45 inch (11.4 mm) exit on an 8,800 ft pad — the term is **+2.91 N** on the pad and climbs from there. (A blank station pressure fills itself in from the site altitude, so that is the number you get on import with nothing typed. See *Launch Conditions*.)

Over a whole flight it is worth measuring on your own design. Across the twenty RASAero designs testers have sent that carry a nozzle and a motor the database can resolve, the thrust term adds **+0.007 % to +29.7 % of apogee, with a median of +0.27 %**: twelve of the twenty move by less than half a percent, and four move by more than five. The big movers are minimum-diameter airframes with large exits going high. A deliberately extreme check case shows the shape — a 14 mm exit on a C6, far larger than any real C6 nozzle, on a 24 mm minimum-diameter test rocket: it gains **1.5 % of apogee** from a sea-level pad and **31 %** from a 1,400 m pad with that pad's pressure stated. Large airframes on large motors sit at the low end, because exit area grows more slowly than thrust.

**So the exit diameter and the thrust curve are a matched pair.** Type the motor's real exit-plane diameter — not the case diameter, not the throat. It will not be a leftover from the motor you flew last week: the field follows the motor, and changing or removing the motor changes or empties it. An exit typed two or three times too big adds thrust the motor does not make, and the error grows with altitude, which is exactly where you are least able to check it. The app warns you when the exit is wider than the motor it has to come out of — for a cluster, wider than all the loaded casings taken together — and where it holds the manufacturer's own published figure, AeroTech's or Loki's, it shows their number beside yours with a one-click accept. Past that it cannot check you: a motor you imported yourself is never looked up, and the app reads no nozzle exit out of a `.eng` or `.rse` file either.

Three things it deliberately does not touch:

- **Batch simulate** gives each candidate **its own** published exit where the app has one, so a motor reads the same there as it does here — see *Simulating and Reading Results → Batch simulate*.
- **Exports.** Saving an `.ork` here and re-opening it keeps the nozzle exit diameter — the element is this app's own addition to the format, so desktop OpenRocket skips it, with a warning, when it opens the file. A `.CDX1` export carries it too, into both of the places RASAero keeps it, so a design sent out to RASAero II and read back comes home with its nozzle intact. The app's `.rkt` export is the one that cannot: the format has no field for a nozzle exit diameter, so a round trip through `.rkt` drops the number and with it both the drag reduction and the thrust term.
- **Drag analysis** stays a static, no-flight property of the geometry: its power-on curve is the drag half only. Thrust appears in a flight, not in a CD sweep.

---

<a id="files-and-formats"></a>

## Files, Units, and Offline Use

Finally, save your work, move it between tools, and use the app with no network.

## File formats

The app reads and writes several formats. What survives a round-trip depends on how much each format can represent:

| Format | Import | Export | Notes |
|---|---|---|---|
| **.ork** (OpenRocket) | Yes | Yes | The richest format the app reads, and the one to keep your work in — every component type the format defines, plus the app's own camera shroud and protuberance, and with them motors, materials, overrides, fin tabs, clusters, shoulders, staging, pods and parallel boosters, launch conditions, and each flight configuration's computed results. The camera shroud, the protuberance, the nozzle exit diameter and the weighed pad mass are this app's own additions to the format, so desktop OpenRocket ignores them when it opens the file. Accepts zipped or bare XML, and reads files written by OpenRocket 15.03 and earlier. One import note: a stage the file marks inactive in a configuration still flies here, and the app says so. |
| **.rkt** (RockSim) | Yes | Yes | Up to **3 stages**, and that ceiling belongs to the file format rather than to the app: a `.rkt` has three fixed stage slots — `Stage3Parts`, `Stage2Parts`, `Stage1Parts`, numbered top-down so the sustainer sits in `Stage3Parts` — so a fourth stage has nowhere in the file to go, and export refuses the design rather than quietly dropping one. Keeps the motor designations the file carries, so it auto-loads motors. Clusters split into individual tubes. Spill holes round-trip. Parts the file names by manufacturer and part number are matched to the parts catalogue on import, and the link is written back as `<PartMfg>`/`<PartNo>` on export. Parts the app has no equivalent for — a ring tail, for one — are dropped on import and the note names them. On export a shock cord goes out as a mass object flagged as a cord, and comes back as a shock cord; a camera shroud goes out as a plain mass object, so its weight and balance survive but its drag does not, and it comes back as a mass component. No nozzle exit diameter — `.rkt` has no field for one — so a round-trip drops it, and with it the power-on drag reduction and the pressure-thrust term. |
| **.CDX1** (RASAero II) | Yes | Yes | Geometry and surface finish — **no materials and no per-part masses**. Walls default to a faked 2 mm and the importer warns you to "review masses before trusting the numbers." What the file does hold is the author's own stated launch weight and CG: where a simulation states them, each stage gets a mass and CG override with its motor's weight and moment backed out, so the rocket totals the weight the author typed; a stage whose numbers don't support an override keeps the computed 2 mm-wall figures, and the import note says which and why. The file's own CD override, Modified Barrowman flag and turbulence setting are read past and not applied — the app flies its own aerodynamics. Motors round-trip: each engine-carrying `<Simulation>` imports as a flight configuration with the motor mounted on that stage's aft-most tube, and export writes each stage's motor back as a RASAero engine string — only for the manufacturers RASAero's own database documents, others are omitted rather than guessed. **Nozzle exit diameters import too:** RASAero keeps one on its Design tab and one inside each simulation, and flies with the simulation's, so that is the one taken — per flight configuration, with the Design-tab value as the fallback when the simulation's is 0. Switching flight configuration switches the stage's nozzle the way it switches the motor; the import note says where each value came from. Export writes it back into both of those places, so a design sent out and read back keeps its nozzle. **The launch site is checked as well:** a file that states an altimeter setting instead of a pad reading gets one line in the import note whenever the pad is above 600 m, with the pressure that site really stands at. A file that states no pressure at all needs no note — the app fills that in from the site altitude (see *Launch Conditions*). Strict export validation (≤3 stages, one fin set per tube, 3–8 fins, conical transitions only). |
| **.eng** (RASP motor file) | Motors only | — | A motor, not a design: **⬆ Import .eng/.rse** in the motor browser adds it to your library under manufacturer **EX**. Read: the header line's designation, diameter and length in mm, delay list, propellant mass and loaded mass, and manufacturer — then every `time thrust` pair. A `P` in the delay list means plugged, and stays plugged. One file may hold several motors back to back, and all of them import. Nothing in it sets a stage's nozzle exit diameter, and it carries no per-sample mass, so propellant burn-off is spread in proportion to impulse. |
| **.rse** (RockSim motor file) | Motors only | — | Also a motor, not a design, and imported the same way. Read: `code`, `mfg`, `dia`, `len`, `initWt`, `propWt`, `delays`, and each `<eng-data>` point's `t` and `f` — plus its `m` when every point carries a positive one, in which case those measured masses fly instead of the impulse-proportional model. A file with no `initWt` is refused rather than imported as a weightless motor. **Nothing else in the file is read** — including `exitDia` and `throatDia`, so importing a motor never fills in a stage's nozzle exit diameter. Total impulse, average thrust, peak thrust and burn time are ignored because all four are re-derived from the thrust samples — burn time as the last sample's time, which can differ from the figure printed in the file. `massFrac` and `Type` are ignored too, so every imported motor lists as single-use. |
| **.obj** (Wavefront) | — | Yes | External shell only — the meshes the 3D view renders. Meters, nose at x=0. Not guaranteed watertight; for print-preview/CAD reference. |
| **.svg** (fin template) | — | Yes | True-scale 1:1 cut template with calibration ruler (see *Visualizing the Design*). |
| **.dxf** (CNC/laser cut profile) | — | Yes | The same 1:1 flat profile as CAD geometry rather than a printable page — **AutoCAD R12 (AC1009) ASCII in millimetres**, which LightBurn, Carbide Create, Easel, Fusion 360's sketch import and essentially every cutter's own software read. Select a component and press **✂ DXF (CNC/laser, 1:1)** in its property panel: **one fin or one ring per file**, the fin as a single closed contour with the through-the-wall tab merged into it, rings/bulkheads/couplers as true circles CAM can bore. Cut geometry is on the **CUT** layer alone — **REFERENCE** (root chord, centre marks) and **TEXT** (the label block) are guides, so switch them off before cutting. As with the STL, the airfoil cross-section and fin cant are not represented. |
| **.csv / .xlsx** (component data) | — | Yes | Every component as one row — dimensions, material, shape, and the engine's computed mass/CG/position — in your preferred units. For sharing measurement data with people who don't run a simulator. |
| **.svg / .png / .jpg** (2D drawing & 3D snapshot) | — | Yes | The 2D side view with a data header (dimensions, mass, CG/CP, stability margin) via **⬇ SVG** (physical-mm size — prints at true 100 % scale) and **⬇ Image** (PNG or JPG at HD / 4K / 8K width). The 3D view's **📷 Image** button re-renders the scene at the chosen resolution — an 8K snapshot is genuinely 8K — with the same data header. Its **Fit rocket to frame** checkbox (ticked by default) moves the snapshot camera in so the rocket fills the exported frame at your current viewing angle; untick it to export the view exactly as framed on screen. These are the drawings L3 and Tripoli Class 3 documentation packets ask for. |
| **.glb** (glTF binary) | — | Yes | Modern 3D model *with your component colors as real materials* — opens directly in Windows 3D Viewer, PowerPoint, Blender, Fusion 360, and web viewers. Meters; nose at the origin, rocket along +X. |
| **.stl** (whole rocket / per component) | — | Yes | Two very different exports, both in **millimetres**. Save As / Export → whole-rocket *display shell* (reference only — not watertight). The real one: select a component and press **🖨 STL for printing** in its property panel — a *guaranteed-watertight solid* built for slicers: hollow nose cones and transitions with their shoulders and caps, single fins with the through-the-wall tab merged in, true-bore centering rings, bulkheads, and tubes. Fins print as flat prisms (airfoil shaping is left to sanding); verify fit before a long print. With a printer set in **Preferences → 3D printing**, the same button also measures the part against your build volume and splits it when it is too tall — see *Printing oversized parts on a 3D printer* below. |

**Flight results travel too, when they can be vouched for.** Saving a `.ork` writes each flight
configuration's *computed results* into the file, so opening it in desktop OpenRocket shows the
flight this app calculated rather than a table of blanks — ten numbers in all: apogee, max
velocity, max acceleration, max Mach, time to apogee, flight time, ground-hit velocity, rod-exit
velocity, velocity at deployment and optimum delay, every one of which desktop OpenRocket's own
reader takes back out of the file. It is written **only** for a configuration whose design,
motors and launch conditions are unchanged since the run that produced those numbers; change a
fin and save again and that configuration goes back to *not simulated*, because a stale result
sitting in that table looking exactly like a fresh one is worse than an honest blank. Only the
summary travels: the per-timestep trace is not stored with run history, so desktop OpenRocket
will offer to re-run the simulation before it will plot it. And it travels one way — opening that
`.ork` back here restores the design, its motors and its launch conditions, but puts nothing into
**Saved simulations**. To keep your run history, export it with **⬇ Run table (.csv)**.

**Where the file goes.** On **Chrome and Edge**, the design formats under *Save As / Export* — `.ork`, `.rkt`, `.CDX1` and the component tables — open a real **Save As dialog**: the name is prefilled from the rocket's name and you can change it, and you choose the folder. (The three 3D exports — `.obj`, `.glb`, `.stl` — load their exporter on the click and so lose the browser's permission to open a dialog; they download, and the app names the file.) On **Firefox and Safari**, which have no such dialog available to a web app, the file goes to the browser's download folder under the rocket's name and the app tells you the exact filename it wrote. Either way the rocket's name is the default filename, and you edit that in **Design → Rocket name**. Saving never writes back over a file you opened — every save creates a new file.

The caveat worth repeating about `.CDX1` is about **distribution, not total**: the geometry comes in faithfully, the mass breakdown underneath it is invented, and where the file states a launch weight the stage totals are pinned to it — the right rocket at the right all-up mass, with a made-up idea of where that mass sits. Treat its predicted altitudes as provisional until you put real materials and overrides in. One detail that holds for every motor the app flies, imported or catalogued: the center of gravity handed to the simulator is the middle of the motor's length — an `.rse` file can state a measured one, and the app does not use it. `.ork` keeps the most of any format here; use it as your working save.

## Sharing a design by link

**Save As / Export → 🔗 Copy share link** packs the whole design — components, materials, overrides, assigned motors, and the launch conditions — into the link itself, compressed into the part after the `#`. Paste it in a chat or an email; opening it loads the rocket straight into the recipient's browser, no account and no upload involved — the design never touches a server, because browsers don't send the `#` fragment anywhere. If the recipient already has a design open, the app asks before replacing it. Two caveats: motors named in the link are resolved against the bundled catalogue on arrival, which needs no network; and a very complex design makes a very long link, which some chat apps truncate — if a pasted link refuses to open, send the `.ork` file instead.

## Printing oversized parts on a 3D printer

Tell the app what printer you own — **Preferences → 3D printing** — by picking a preset (Bambu H2D, X1C/P1S/A1, A1 mini, Prusa MK4S, Prusa XL, Ender 3, K1 Max, Neptune 4 Plus) or typing a custom bed X/Y and maximum Z in your preferred units. 8 mm is kept clear at each end of every axis (brim and first layer at the bed, gantry clearance up top). The **joint clearance** — the gap per side between a spigot and its socket — defaults to 0.15 mm, an FDM-realistic slip fit sized for 30-minute epoxy; drop it toward 0.05 mm only if you glue with thin CA, which seizes in a wider gap.

With a printer set, the **🖨 STL** button measures the selected part against the build volume and says what it found before you click. A part that fits reports so — sometimes **leaned**: a slender part may fit in one piece tipped up to 30° off vertical, and the angle quoted is computed from that part's own steepest wall so nothing overhangs past the 45° a slicer can bridge unsupported. A part too tall changes the button to **🖨 STL for printing — N pieces** and exports a **zip** instead of one unprintable file: numbered segment STLs (`name-print-1of3.stl`, …) plus a README covering print orientation (base down, tip up, no supports — the layer lines end up across the joint, the direction an ejection charge loads it), gluing (30-minute epoxy, dry-fit every joint first), and the same-material shrinkage rule that decides whether the halves fit each other at all. At each cut the fore piece grows a tapered **spigot** that registers in the next piece's own bore, and the two flat faces meeting set the assembled length exactly — the segment lengths add up to the part, and cuts are placed clear of shoulders. Splitting is never silent: the piece count is in the button, in the file names, and in the README, and when the joints add real material (a thin-walled tube cut into many pieces) the note prices the extra filament and print time.

Some parts refuse to split, on purpose: a part wider than the usable bed (no axial cut makes it narrower), a plan needing more than 6 pieces (at that many joints, buy the tube), a wall too thin to key a spigot into, or a part whose only legal cut planes land in shoulder or end faces. A refusal still exports the whole part — a club printer or a friend's machine may be bigger — with the reason shown under the button. Fins are flat prisms and are never split. A split tube carrying a rail button or launch lug gets a note to draw an alignment line down the outside before gluing, because a round joint holds no clocking. And with no printer configured, nothing changes at all — the button exports the whole part in one piece, and a part too long to assume it fits anything just shows a hint to set your printer.

## Units and preferences

Open **Preferences** to switch between one-click **Metric** and **Imperial** presets, or set each quantity individually — length, motor dimensions, distance, mass, velocity, wind speed, acceleration, angle, density, temperature, and pressure. You also choose whether round parts are entered as **diameter or radius**, and how the **stability margin** reads everywhere in the app — **Calibers** (the traditional body-diameter margin, the default), **% of length**, or **Both**. The percentage is measured against the aerodynamic length of the airframe; it is the figure that stays comparable between a stubby rocket and a very long one, where "two calibers" means quite different things. The same dialog sets the app's **Theme** — **Light**, **Dark**, or **Follow system** (which tracks your operating system's light/dark setting); this is what drives the theme-aware plot axes and the rest of the interface. Beside it sits **Daylight mode**, the launch-site setting: black on white at maximum contrast, with doubled borders, bolder small type, and darker, thicker chart lines, so a phone screen stays readable in direct sun. Daylight **overrides the theme** while it is on — in sunlight the polarity is the whole point, and a high-contrast dark screen is the right answer indoors and the wrong one on the field — and turning it off restores the theme you picked. The **Daylight** button in the header is the same switch. A **First-run tour** setting controls whether the six-step interface tour offers itself to a new visitor. Setting it to **Off** dismisses the tour straight away if it happens to be open, and keeps it from offering itself again; setting it back to **On** re-arms it, so it will introduce itself once more next time you load the app. Either way the **⟲ Tour** header button replays it on demand. A **3D printing** section holds your printer's build volume and joint clearance — what they do is covered in *Printing oversized parts on a 3D printer* above. An **Aerodynamics** section holds the four-way **Aerodynamics model** choice — **Rogers Modified Barrowman (Kbf)** (the default), **Classic Extended Barrowman** (the 24.12 kernel's own aerodynamics), **Auto** (a short probe decides the model, then the whole flight runs on it; re-checked after the flight in case the probe under-read), or **Supersonic** (the RASAero-class model at all speeds). This is the **durable** setting; the **Aero** selector in the vitals strip switches the model for the current session only, and while it is doing so this section says so and offers to go back. What they do and when to use them is covered in *How It Works*. Every saved simulation records which aero model produced it, and a flight that goes supersonic on the classic model raises an in-report alert so you know the better model exists. Because everything is stored in SI internally, **switching units never changes your design** — it only changes how the numbers are displayed and entered.

## Installing, offline, and saving your work

**It works at a field with no signal, and you do not have to install anything.** The first time you open the address, your browser downloads the whole program and keeps its own copy. Every visit after that runs from that local copy, which picks up a new build the next time you open the app with a connection (see *Updates* below). The simulation runs in your browser rather than on a server, so with the program local there is nothing left to ask the network for. That was measured in Chrome, Edge, Firefox, Android Chrome and Safari on an iPad — with one exception, and it is the one that costs the most: **the Home Screen app on an iPad would not open at all with no connection.** If an iPhone or an iPad is the machine you take to a launch, read *iPhone and iPad* below before you rely on it.

The browser copy is made by a **service worker**, and it is made on an ordinary page load. You do not have to install the app, click anything, or find a setting. Installing (below) gives you a window and an icon; on desktop and on Android it is not what makes the app work offline, and on an iPhone or iPad it did not work offline when it was tested — see *iPhone and iPad* below.

**The download is all-or-nothing.** It is **about 6 MB once it is unpacked on your device, and about 1.4 MB over the connection**, because it travels compressed. That transfer figure was measured on a repeat load; a genuine first visit re-fetches a few of the files and lands a little above it, so if you are paying by the megabyte, budget two. The browser only starts using the offline copy once every one of those files has arrived. Lose the connection part-way through and there is no half-built copy to go wrong — you simply do not have one yet, and the next visit with a connection tries again. So give the first visit a moment on a real connection, and then **prove it**: turn on airplane mode, reload, and fly something. It takes thirty seconds and is worth doing once on every device you plan to take to a launch. **Rehearse the copy you will fly with** — proving it in Safari and then flying from a Home Screen icon proves the wrong thing.

**What is in the offline copy:** everything. The physics kernel, the parts catalogue, the nozzle database, the 3D view and the OBJ/STL/GLB exporters, the fonts — and **every thrust curve**, all {{CURVE_FILES}} simulator files covering {{CURVE_MOTORS}} of the {{MOTOR_COUNT}} catalogued motors. A motor flies offline whether or not you ever flew it online; in Chrome and in Edge an AeroTech D13 was loaded and flown with the network off.

**The 80 catalogued motors with no bundled curve are the one gap, and they are worth knowing about before you drive out.** thrustcurve.org had no usable simulator file for any of them when this build's catalogue was pulled (5 September 2026), so neither a connection nor the offline copy can fly them: the app asks the site when you pick one, and an error comes back where the motor should be — online it says there is no sample data, offline it fails as any request does with no network. The answer either way is to import the motor's own `.eng` or `.rse`, and at a field with no signal that has to have been done before you left.

**What needs the network, and what you see without it.** Four things in the app itself ever reach out, and none of them carries your design. Two happen by themselves on every page load: the **version badge**, which offline reads *Version unknown* rather than guessing — it will never tell you that you are out of date when it simply could not ask — and the **site navigation band** across the top, which offline draws from a stored copy. The other two only happen when you ask: pressing **↻ Check thrustcurve.org**, which offline greys out with a tooltip saying why; and a thrust-curve download, which happens when you pick a motor the app has no bundled curve for — one of the 80 above, or one a live ↻ check has added since this build was made. With no network that download fails at once; if a connection stalls instead, the app gives up after fifteen seconds and says which motor it was waiting for, rather than spinning.

### Installing it

Optional. On **Chrome, Edge and Android Chrome** it is exactly what it sounds like: the same app, in its own window with its own icon, reading and writing the **same storage as the browser tab**. On Chrome and on Android Chrome that was measured both ways — a design named in the tab appeared in the installed window along with its saved simulation run, and a rename made in the installed window showed up in the tab after a reload. On Edge it was measured one way, tab to installed window, and the design was there.

- **Chrome and Edge:** an install icon appears in the address bar.
- **Android Chrome:** menu → *Add to Home screen*.
- **Firefox:** there is nothing to install. Its *add tab to taskbar* option is a bookmark rather than an installed app — and Firefox does not need one, because the offline copy is made on an ordinary page load and works in the tab. It ran offline in testing with its design intact.
- **iOS and iPadOS Safari:** Share → *Add to Home Screen* — but read the next part before you do.

### iPhone and iPad: read this before you take one to a launch

Measured on **one iPad running iPadOS 18.6.2**. No iPhone has been tested. An iPhone Home Screen app is the same kind of container, so treat it the same way until someone measures one.

On an iPhone or iPad, the Home Screen app is not the same app as Safari with the same address open. It is a separate copy with its own storage, and nothing passes between the two:

- Adding it to the Home Screen and opening the icon gave a **brand new empty rocket**, not the design that was open in Safari a moment earlier.
- Renaming the rocket in the Home Screen app left Safari's copy under its old name, and the other way round. Neither ever sees the other.
- Settings, Safari, *Clear History and Website Data* wiped Safari's copy and left the Home Screen app's design exactly where it was.
- Deleting the Home Screen icon destroyed that copy's design. Re-adding the icon gave an empty app, back at the tutorial.
- **And the installed app did not work offline.** Left open on wifi for a minute, then put into airplane mode, force-closed and reopened from the icon, it would not open at all: the page reads *Safari can't open the page… because your iPad is not connected to the internet*, over an iOS prompt offering *Turn Off Airplane Mode or Use Wi-Fi to Access Data* — and at a field with no signal, neither of those is available to you. In the same airplane mode, on the same iPad, opening the address in **Safari** worked — the motor was changed and a simulation flown.

**So on an iPhone or iPad, use Safari for field work and do not rely on the Home Screen icon.** The consequence of having this backwards is specific: you drive to a launch site with no signal, tap the icon you installed for exactly that purpose, and get an error page instead of the app — with nothing you can do about it there, because the only fix is a connection. Open the app in Safari instead, bookmark it if you want it a tap away, and run the airplane-mode rehearsal in Safari before you leave.

Why the installed copy fails where the browser succeeds is not yet known, and this page will not guess at a cause. It is one device, one version of iPadOS, one run, and it has not been explained. Safari on a Mac has not been tested at all — no result either way. If you have an iPhone, an iPad or a Mac, running the airplane-mode rehearsal on both copies would settle it; the **Feedback** button in the header is the place to send what you find.

### What happens if I clear my browser cache?

**Four different actions, four different answers.** The first costs you nothing, the second costs you everything the app remembers, and the last two depend on which device you are holding.

- **Clear cached images and files.** Costs you nothing at all — not your designs, and not the offline copy of the program. Cleared at *All time* in Chrome, Edge and Firefox, then reloaded with the network off, the app opened every time; in Chrome and Firefox the design was still there, and in Chrome and Edge a motor was loaded and flown with the network off. The offline copy lives in a different store from the one that checkbox empties.
- **Clear cookies and site data** for this address. **This is the one to be careful with, and this is the one not to do the night before a launch.** It removes everything the app remembers *and* the offline copy along with it. **Files on your disk are not touched** — an `.ork` you saved, a CSV or XLSX you exported, the `.eng` or `.rse` you imported a motor from are ordinary files and are still there afterwards. What goes is the copy the browser is holding for this address: the design you were working on, the **Saved simulations** table, your preferences, **any parts you imported or created, and any EX motors you imported from your own motor files**. Saving an `.ork` first covers the design, but it does not bring the run table with it, so export what you want to keep before you clear — **Save As → .ork** for the design, **⬇ Run table (.csv)** or **⬇ Run table (.xlsx)** under *Saved simulations* for the run history, **⬇ Flight data (.csv)** for one flight's per-timestep numbers, and **⬇ CSV** in the preset picker for parts, one file per part type (it writes every row the search and manufacturer filter match — not just the 300 the table shows — bundled parts included, and there is no filter for your own rows, so search your part numbers or manufacturer first; see *Component presets*). An EX motor has no export of its own, so keep the `.eng` or `.rse` it came from; preferences have none either. Firefox showed the offline half directly: after the clear the app would not open with the network off. Getting the offline copy back takes a visit with a connection, left open long enough for the download to finish — **and that is a length of time, not a number of loads.** In Firefox, going offline straight after the next online load still failed, and offline working returned only after a further visit online. Treat every browser the same: assume the offline copy went with it, rebuild it on a connection, and prove it with airplane mode before you rely on it.
- **Uninstall the installed app** — different on every platform. On **Chrome** the dialog is titled *Uninstall app?* and offers a checkbox, *Remove this app's data from Chrome*, which is **not ticked by default**; leave it alone and your work is still there when you open the address again. **Edge** asks the same question in wider terms — *Uninstall app from Microsoft Edge on all synced devices?* — with its own unticked *Delete app history and data*; the synced-devices wording is Edge's, not the app's, so read it before you agree to it. On **Android**, uninstalling from the launcher gives **no prompt of any kind** and takes nothing with it: the design was still there in Chrome at the same address afterwards. On an **iPhone or iPad**, deleting the Home Screen icon destroys everything that copy held, and it cannot be undone — iOS does warn first, in its own words: *Deleting this bookmark will also delete its data.* That copy is not Safari's copy; *iPhone and iPad* above has the rest.
- **On an iPhone or iPad — Settings, Safari, Clear History and Website Data.** This wipes Safari's copy of your work — back to the tutorial and an untouched *My Rocket* — and it does **not** reach a Home Screen app, which still had its design afterwards. Two separate stores on one device; again, *iPhone and iPad* above.

**The rule underneath all four: the only durable copy of a design is an .ork file you saved.** The autosave is a convenience, not an archive. Only one of the four tells you, at the moment you act, that a design is about to be destroyed — iOS, when you delete the icon. The browser's own clear-data dialog says nothing about what it costs you here. Your work also lives in exactly one browser profile, on one device, at one address — nothing syncs, there is no account, and a different browser or a different machine starts empty. On an iPhone or iPad, Safari and the Home Screen app count as two different places even at the same address. **Save As → .ork** before you clear anything, change browsers, delete an icon, or rely on a design you care about.

### Updates

When a new version ships, the browser picks it up the next time you open the app with a connection, and applies it on the following load. You never have to reinstall. The main program chunk changes on every release, so an update re-downloads about **2.7 MB of program, which is under a megabyte over the connection** because it travels compressed. The big data files — the parts catalogue, the thrust curves, the nozzle data, the 3D library — are separate and are reused from your existing copy unless their own contents changed. That happens whenever one of those databases is updated, which is not unusual — the nozzle data in particular changes often. Offline, nothing changes and nothing nags — you keep running the version you have.

### Your work, and where it is kept

The design tree, assigned motors, launch conditions, per-stage motor-length limits, run history, motor filters, imported parts and imported EX motors all persist in your browser's local storage and survive reloads and restarts. If that storage fills while the app is saving your design, it says so — the saved-runs table shows what is really stored, and a banner stays up while autosave cannot write, clearing itself once saving recovers. That guard covers the autosave, the run history and your preferences. It does **not** yet cover an EX-motor import: if storage is full when you import one, the app still reports success, and the motor is not there after a reload. Until that is fixed, keep the original `.eng` or `.rse`. Autosaves also belong to the web address you saved them at, so the same design opened at a different address, or inside a page embedding the app, starts fresh — and on an iPhone or iPad the Home Screen app counts as a different place even at the same address.

One more limit, and it is the browser's rule rather than the app's: **that storage is not guaranteed.** A browser may clear it on its own if the device runs short of space, or if you go long enough without opening the app — on an iPhone or iPad that is about a month of Safari use, as little as a week if you arrived from a tracking link, and a week on Safari 17 and older. Nothing warns you first, and it is the same reason the .ork rule exists.

The app **header** carries **Open…**, **Undo/Redo** (Ctrl+Z / Ctrl+Shift+Z, 50 steps each way — they cover the **design tree** only: assigned motors, flight configurations and launch conditions are not undone, and re-applying a flight configuration is what puts a motor set back), and the **Save As / Export** menu (.ork, share link, and every format in the table above), alongside the **Guide**, **Feedback**, **Changelog** (the version badge), and **Preferences**; **New** sits atop the component tree in the Design workspace.

Beside the version badge sits the answer to *"am I on the current version?"* — **✓ Up to date** when the running build matches what is deployed, or **↻ v0.0NN available — Reload** when it does not, which reloads onto the new build. It checks once when the app loads and again whenever you click it, and it reads the deployed version directly rather than anything cached, so it is never fooled by the offline copy the app runs from. For a durable archive, or to move a design to another machine or to desktop OpenRocket, **Save as .ork** — it carries the design, its materials and overrides, the assigned motors and the launch conditions. Two things it does not carry: a **per-stage motor-length limit** (the file format has a per-mount field only), and the **curve of an EX or custom motor you imported from your own file** — there is nowhere in an `.ork` to put one, so keep the original `.eng` or `.rse` alongside the `.ork` or that motor will not open on the other machine. What an `.ork` does and does not carry of your flight results is under *File formats* above.


Because the whole app is a self-contained static build, the same files can also be **embedded inside another web page** — for example a WordPress post — through an `<iframe>`. If you meet MMRocket Sim living inside someone else's site rather than at its own address, it is the identical app running the identical physics kernel, with the same design, motor, and simulation tools described in this guide.

---

<a id="how-it-works-physics"></a>

## How It Works: Physics & Math

This section is what the app computes, what it defaults to, and where its honest limits are.

**Start with what you fly.** Until you change it in Preferences, a new design starts on **Rogers Modified Barrowman (Kbf)**, and so does a file you open — nothing in an `.ork`, `.rkt` or `.CDX1` chooses the aerodynamics model. On that setting these terms are live, and none of them is in the OpenRocket 24.12 kernel underneath:

- the **Kbf body carryover** — the lift the fins induce on the body — which raises total CNα and moves CP aft;
- a **sharp-airfoil fin pressure model**: a fin whose cross-section is **Airfoil** is not charged the blunt leading-edge drag classic Barrowman puts on every non-square section, and a fin that names a specific supersonic section (hexagonal, double wedge and the rest) gets that section's own wave drag;
- a **fin interference factor of ×1.8** on fin skin-friction drag, settled on the validation data rather than on one published figure;
- **power-on base drag** and **pressure thrust**, both driven by a stage's **nozzle exit diameter** — a field that is zero until you type one or open a file that carries one (`.ork` and `.CDX1` both import it), so both do nothing until a stage has one.

**Under all of that sits the OpenRocket 24.12 kernel, and it is what runs.** Its Java source (`info.openrocket.core`) is compiled to JavaScript with TeaVM, and a differential test runs the same scenarios on a Java VM and on the compiled JavaScript and requires bit-identical output — so what your browser executes is a faithful compile of that kernel rather than a re-implementation of it. That test proves the compile, not that any particular answer matches another program; the two lists here are where the app and the plain 24.12 model part company. The integration scheme, the flight-phase logic, the mass and center-of-gravity build-up, the ISA atmosphere, the WGS84 gravity and Coriolis model, the thrust-curve interpolation and the Barrowman build-up described below are all 24.12's own. The terms listed above change that model at specific points — adding a load in some places, dropping a classic term in others — and **Classic Extended Barrowman** switches every one of them off.

**If you want the 24.12 model's own answers**, choose **Classic Extended Barrowman** — it is named the same way in **Preferences → Aerodynamics** and in the vitals strip's **Aero** selector. A few things it does not turn off, because they are not part of that switch: turbulence is seeded from a fixed number rather than from the clock, so a re-run repeats exactly (see *Wind, turbulence, and why a re-run repeats exactly*); a mass override that stands in for everything inside a part scales that part's moments of inertia along with its mass (see *Designing the Rocket → Measured mass & CG*); and a **streamlined protuberance**'s drag is computed as a fraction of the body's own drag at every Mach (see *Designing the Rocket → Protuberances*).

Throughout, the engine works in **pure SI units** (metres, kilograms, seconds, newtons) and **radians**. Degrees, feet and grams exist only at the file-format and screen boundaries.

## How a flight is simulated

The rocket is treated as a **six-degree-of-freedom (6DOF) rigid body**: three of position and three of orientation. Orientation is stored as a **quaternion**, never as Euler angles, which avoids gimbal-lock singularities when the rocket pitches over at apogee.

The equations of motion are integrated with the classical **fourth-order Runge–Kutta method (RK4)**. Each step evaluates the derivatives (velocity, acceleration, angular velocity, angular acceleration) four times — at the start, twice at the midpoint, and at the end — and combines them:

```
y(n+1) = y(n) + (h/6)·(k1 + 2·k2 + 2·k3 + k4)
```

RK4 is far more accurate for a given step size than simple Euler integration, and the fourth-order error term keeps energy drift small over a full flight.

**Adaptive time step.** The step length `h` is not fixed. Each step, the kernel takes the *smallest* of eight candidate limits, so the step shrinks automatically wherever the flight gets delicate:

- the user's requested time step (default 0.05 s), or one-fifth of it while still on the launch rod;
- a maximum pitch-angle change per step (default 3°) and a maximum roll-angle step;
- limits on how fast the roll rate and the pitch/yaw rates may change in one step;
- one-tenth of the launch-rod length while the rocket is still on the rod;
- no more than 1.5× the previous step (smooth growth).

A floor of 1/20th of the nominal step prevents numerical stall. This is why a wobbly, near-unstable flight is computed with many small steps while a clean boost coasts in large ones.

**Phases of flight.** Before lift-off the rocket cannot sink into the ground (downward acceleration is zeroed). While on the **launch rod/rail**, motion is projected onto the rod direction and angular acceleration is forced to zero — the rod holds the rocket straight until it clears. Once clear, full 6DOF applies: aerodynamic moments are shifted from the center of pressure to the current center of gravity, and pitch, yaw and roll accelerations follow from the body's moments of inertia.

After a **recovery device deploys**, the rocket is no longer a rigid airframe flying nose-first, so the simulation switches from 6DOF to a simpler **3-degree-of-freedom (point-mass) descent**: it tracks position under gravity and parachute drag but not tumbling orientation. A parachute's drag coefficient defaults to **0.8**. An airframe that goes unstable without a chute is handed to a separate tumble model instead.

## Aerodynamics — the Extended Barrowman method

Stability and normal force come from the **Extended Barrowman method** — the 1966 Barrowman equations, extended for body lift and for transonic/supersonic fins. The rocket's total normal-force coefficient slope (CNα) and center of pressure (CP) are built up component by component and summed.

**Nose cones and transitions.** A body of revolution generates normal force only where its cross-sectional area *changes*. For a transition from fore area `A₀` to aft area `A₁`, the kernel uses

```
CNα = 2·(A₁ − A₀) / A_ref      CP = (L·A₁ − V) / (A₁ − A₀)
```

where `L` is length, `V` the enclosed volume and `A_ref` the reference area. A pure cylindrical body tube produces no area-change normal force at all.

**Body lift (Galejs extension).** Straight Barrowman ignores the lift a long body generates at angle of attack. The kernel adds the Galejs correction, with a coefficient of 1.1, proportional to the body's planform area and to `sin²(α)/α`, acting at the planform centroid. This is what keeps a long, small-finned rocket from looking falsely over-stable at high angle of attack.

**Fins.** A fin set's lift-curve slope in the subsonic regime is

```
CNα1 = 2π·s² / ( 1 + √(1 + (1 − M²)·(s²/(A_fin·cosΓ))²) ) / A_ref
```

where `s` is the fin span, `A_fin` the fin area, `Γ` the mid-chord sweep angle and `M` the Mach number. This is the standard finite-span lifting result: aspect ratio and sweep both reduce slope, and the `(1 − M²)` term is the Prandtl–Glauert compressibility factor. Above Mach ~1.5 the kernel switches to a supersonic formula (with Mach-dependent K1, K2, K3 terms) and interpolates smoothly through the transonic gap. Multiple fins interfere with each other and with the body: fixed empirical factors reduce the per-fin slope for 4, 5, 6… fins, and a body-interference multiplier `(1 + τ)` accounts for the airflow the body diverts onto the fins (τ = r/(s+r), the body-radius-to-total-semispan ratio).

**Optional: the Kbf body carryover (Rogers Modified Barrowman).** Classic Barrowman keeps the fins-in-presence-of-body factor above but drops its reciprocal — the lift the fins induce *on the body* near the fin root, the `K_B(W)` carryover of NACA Report 1307. Turning on **Preferences → Aerodynamics → Rogers Modified Barrowman (Kbf)** adds it back: slender-body theory makes the fin-plus-carryover total `(1 + τ)²` times the fin-alone value, so the added body load is `τ · (fin CNα)`, acting at the fin root quarter-chord. The result is a somewhat higher total CNα and a slightly **more aft CP**, matching the direction RASAero II's "Rogers Modified Barrowman" method reports. Read that direction carefully: static margin is (CP − CG) ÷ diameter, so moving the CP aft **raises the margin the app shows you** — it is the closer answer for the geometries it was validated against, not automatically the safer one. Whether it makes any particular rocket's margin better or worse depends on that rocket. It is **on by default** — it is what a design flies until you choose otherwise. Choosing **Classic Extended Barrowman** in the same selector turns it off and hands back the 24.12 kernel's own fin-body treatment, bit for bit, along with the rest of the list at the top of this section.

The Kbf model also **does not charge a sharp airfoil fin the blunt leading-edge drag** that classic Barrowman applies to every non-square cross-section. Classic treats an **Airfoil** fin's leading edge as a swept cylinder — a pressure-drag plateau of about 1.2 on the leading-edge frontal area, which neither decays with Mach nor belongs on a sharp section, and whose subsonic form climbs steeply approaching Mach 0.9. On a genuinely streamlined section the subsonic profile drag belongs in the skin-friction form factor (which already carries it) and the only pressure term is **supersonic wave drag**: thin-airfoil `K·4·(t/c)²/β`, swept by `cos²Γ`, referenced to fin planform area. That is what Kbf computes, and the Supersonic model uses the same treatment.

**This lowers drag on fast airfoil designs, substantially.** On the reference designs it is under 1 % below Mach 0.5, about 4–12 % at Mach 0.9, and 9–16 % at Mach 2 — and because drag compounds over a coast, apogee moves more than that. Only fins whose **cross-section is Airfoil** take it, and only while the supersonic-airfoil selector is left on **Classic**. A **Square** (the default) or **Rounded** fin keeps the classic pressure term under every model; a fin that names a specific **Supersonic airfoil** section gets that section's own wave drag instead; and under **Classic Extended Barrowman** every fin, Airfoil included, takes the classic term. If you want the classic leading-edge term on a particular design, set its fins' cross-section to **Rounded**, which is what that term models.

**Roll.** Canted fins produce a roll-driving moment proportional to the cant angle, opposed by a **roll-damping moment** that grows with roll rate — so a canted rocket spins up toward a steady-state roll rate rather than accelerating forever.

**Drag build-up.** Total drag is assembled from four independent pieces:

```
CD = CD_friction + CD_pressure + CD_base + CD_override
```

- **Skin friction** comes from the **Reynolds number** — flight speed × the airframe's aerodynamic length ÷ the air's kinematic viscosity, worked out once for the whole rocket at each step and charged to every surface on it. The boundary layer is treated as **fully turbulent**, and each part's own surface finish sets a roughness floor under the coefficient: the higher of the two is what that part pays. On top of that come a compressibility correction near Mach 1 and a whole-rocket fineness-ratio correction `(1 + 1/(2·f_B))`.
- **Pressure drag** for nose cones is interpolated from wind-tunnel/free-flight data (the kernel embeds experimental curves for ogive, conical, ellipsoid, power, parabolic and Haack shapes from NASA TR-R-100), plus stagnation drag at any forward-facing area increase.
- **Base drag** on the blunt tail follows `CD_base = 0.12 + 0.13·M²` subsonic and `0.25/M` supersonic.
- **Power-on base drag**: while a stage's motor is thrusting, its exhaust plume pressurizes the base over the nozzle-exit footprint, so the kernel subtracts the nozzle-exit area from the drag-producing base area — boost drag is lower than coast drag by `CD_base · A_nozzle/A_ref`. This is driven by the per-stage **nozzle exit diameter** (0 = no reduction, the default) and mirrors RASAero II's power-on/power-off CD distinction; the power-on curve is visible in the Drag analysis panel. It applies under **Rogers Kbf**, **Auto** and **Supersonic** only — under **Classic Extended Barrowman** the nozzle exit diameter changes nothing — and under those same models that one diameter also adds the motor's pressure thrust as the air thins (see *Motor thrust-curve model* below).
- **Override** lets you pin a component's CD to a measured value.

The drag coefficient is finally resolved into an axial component using an angle-of-attack multiplier, and pitch/yaw **damping moments** (which resist the rocket "weather-vaning" too sharply, especially the apogee turnover) are subtracted from the aerodynamic moments.

## The optional supersonic aerodynamics model (beta)

Classic Extended Barrowman is honest only to roughly Mach 1.5: it freezes body CP at its Mach-1 value forever, uses half the theoretical supersonic fin lift, clamps wave-drag data flat past Mach 2–4, and lets boattails ignore Mach entirely. Choosing **Supersonic** in the **Aerodynamics model** selector — **Preferences → Aerodynamics**, or the **Aero** selector in the vitals strip — replaces those with a RASAero-class model built from the open literature:

- **Fin lift** at the proper 2D Busemann level with a finite-span correction, evaluated analytically to any Mach (no grid clamp), plus the exact **NACA Report 1307** body-fin interference split with an afterbody carryover factor. This raises fin lift ~25–35% even subsonic (the physics behind RASAero's "Rogers Modified Barrowman"), so CP and stability shift slightly on all flights while the option is on.
- **Body (nose) lift grows with Mach**, bracketed by exact Taylor–Maccoll cone theory, so the combined CP moves with Mach the way wind tunnels measure instead of racing forward.
- **Drag**: per-shape supersonic thickness wave drag for fins, supersonic boattail/reducer wave drag, nose wave drag with its physical high-Mach decay, a vacuum-limit cap on base drag, and **Van Driest II** compressible skin friction above Mach 4.

The model is scored continuously against an automated validation harness of published measured data — NASA's ARCAS sounding-rocket wind-tunnel tests (Mach 0.6–4.63), the Army-Navy Basic Finner free-flight range data (Mach 1.05–4.5), and the AGARD HB-2 hypersonic standard model (to Mach 10). Supersonic CP matches the ARCAS tunnel within ±2% of body length through Mach 4.6 — including above Mach 3.5, where RASAero's own published prediction diverges from that same tunnel. Known honest limits: transonic **peak** drag (Mach 0.95–1.2) reads low against tunnel data (a regime every engineering method struggles with), and everything above Mach 10 is physically-shaped extrapolation.

**Choosing a model.** There are four choices, and they live in two places. **Rogers Kbf** is the default. **Classic Extended Barrowman** is the parity setting: it turns off every addition listed at the top of this section and gives the 24.12 kernel's own answers back. **Supersonic** uses the validated model at all speeds. **Auto** is the practical setting for mixed fleets: a short probe run — it stops just after burnout, which is where peak Mach happens — decides which model the flight needs, and then the flight runs **once** on it. If the probe says the design will pass **Mach 0.9** (the transonic onset, where classic aero starts degrading), the *entire* flight uses the supersonic model. A probe can under-read, and it never sees the descent, so the finished flight is re-checked afterwards and re-flown on the supersonic model if its real peak crossed 0.9 — a flight that stays subsonic runs on Rogers Kbf, a fast one gets the validated physics, and the design's displayed stability follows whichever model the flight used (an **M+** mark appears beside the selector once Auto has upgraded itself). One thing besides aerodynamics rides on this choice: a stage's **nozzle exit diameter** only does its work — the power-on drag reduction and the pressure-thrust term — under Rogers Kbf, Auto and Supersonic. Classic Extended Barrowman ignores it entirely, which is also the quickest way to see what those two terms are worth on a design.

The **Aero** selector in the vitals strip switches the model from any workspace, and it is deliberately **for this session only** — trying the other model on a design should not quietly become what every future session flies. **Preferences → Aerodynamics** is the durable setting; while the strip is overriding it, the strip shows a **↺** to go back and Preferences says so and offers the same. Choosing a *different* model in Preferences wins, and clears the session override.

A model always applies to the **whole flight**, subsonic portions included, so switching shifts stability and apogee. Switching does **not** throw away the flight you are looking at — that would make comparing the two models impossible, which is the point of being able to switch them. Instead the Results tab says which model those numbers were flown on, and the strip's Apogee reading carries a ⚠, until you press Launch again. If you fly supersonic while on a classic model, the report warns you and offers a one-click re-fly on Auto. Every saved run records which model flew it.

## Mass, center of gravity and inertia

At every step the kernel computes the rocket's total **mass**, **center of gravity** and **moments of inertia** (longitudinal and rotational) by summing every component — walls, nose, fins, mounts, mass objects — from its geometry and material density, honoring any user overrides. The **motor** is then added as a separate rigid body: as propellant burns, both its mass and its own CG shift, read from the thrust curve's mass/CG data points, and the two bodies are combined. This is why your stability margin (the CP-to-CG gap, measured in calibers) changes continuously through the boost as propellant leaves the tail.

## Atmosphere — the International Standard Atmosphere

Air properties follow the **International Standard Atmosphere (ISA)**, with sea-level defaults of **288.15 K (15 °C)** and **101 325 Pa**, and a troposphere temperature **lapse rate of −6.5 K per km** up to 11 km. Above that the kernel models the full layered ISA profile: the isothermal tropopause to 20 km, the warming stratosphere, and so on up past 84 km.

Within each layer, pressure follows the **barometric formula**. For a layer with a non-zero lapse rate `L`:

```
p = p_b · (1 + (h − h_b)·L / T_b)^(−g / (L·R))
```

and the isothermal exponential form where the lapse rate is zero. Temperature is linear within a layer, and density follows the ideal-gas relation `ρ = p/(R·T)`. The speed of sound — the divisor behind every Mach number the app reports — comes from the kernel's linear fit in temperature, `a = 331.3 + 0.606·T` with `T` in °C, which stays within about 0.5 m/s of the exact adiabatic value `√(γ·R·T)` (γ = 1.4, the ratio of specific heats for air) between −30 °C and +30 °C and runs about 0.7 % high at the −56.5 °C of the tropopause. You can override the launch-site temperature and pressure, and the model rebuilds a consistent profile above you. One documented caveat comes straight from the kernel: above ~32 km the layered values drift from the exact standard by about 5 % — irrelevant for essentially all hobby altitudes.

## Gravity and geodesy

Gravity uses a **WGS84 ellipsoid** model rather than a single constant. Sea-level gravity varies with latitude φ via the Somigliana formula:

```
g₀ = 9.7803267714 · (1 + 0.00193185138639·sin²φ) / √(1 − 0.00669437999013·sin²φ)
```

so it is weaker at the equator and stronger at the poles. An altitude correction `(R_earth / (R_earth + h))²` reduces it as the rocket climbs. When a launch latitude/longitude is supplied and geodetic computation is enabled, the kernel also adds the **Coriolis acceleration** from Earth's rotation. The altitude correction assumes a spherical Earth — the kernel's own comment notes this is a deliberately small approximation.

## Motor thrust-curve model

A motor is a table of measured samples: time, thrust, remaining mass and propellant CG, exactly as published in RASP/RSE thrust-curve files. At any simulation instant the kernel finds the bracketing samples and does **linear interpolation** between them (snapping to a sample when it lands within 0.1 ms of one). Instantaneous thrust, motor mass and motor CG are all read this way; total impulse and average thrust are derived from the same curve. There is no internal combustion model — the published thrust curve *is* the input, which is exactly what you want for matching real motor performance.

**Pressure thrust: the curve is a sea-level number.** That curve was measured on a stand at the bottom of the atmosphere, with about 101,325 Pa pushing back on the nozzle's exit plane. In flight that back-pressure falls away and the motor's real thrust rises by the exit area times the pressure it has lost — the pressure term of the rocket thrust equation, and the correction RASAero II applies:

```
F(h) = F_curve(t) + A_exit · (101,325 Pa − P(h))
```

`A_exit` is the area of the per-stage **nozzle exit diameter** you type under the stage, and `P(h)` is the pressure the ISA profile above hands the drag term at that same instant — thrust and drag always see one atmosphere, so the site's typed temperature and pressure flow through both. (Which is why the **Station pressure** field matters here: a blank field means the standing pressure for your site altitude, so a high pad gets its thinner air — and its extra thrust — without anyone typing anything. See *Launch Conditions*.) The term is added **once per thrusting stage**, **only while the curve's own thrust is above zero**, and only under the **Rogers Kbf**, **Auto** and **Supersonic** models, which is the same gate the power-on base drag uses (see *Multi-Stage and Clustered Rockets → Nozzle exit diameter*). Two visible consequences: the **Thrust** plot sits above the published curve while a stage burns — by nothing at a sea-level pad, by up to the exit area times full sea-level pressure near vacuum — and the launch report's **thrust:weight at rod departure** reads from the same value, so at a high site it moves too.

**The sea-level reference is an assumption, and this is what justifies it.** The app has no way to know where any particular motor was fired, so it assumes every published curve is referenced to sea level. That assumption rests on a rule rather than on habit: static testing for certification **must be done at, or corrected to, sea level and 20 °C** — that is NFPA 1125, the code the American certifying bodies test to, as summarised on [ThrustCurve's certification page](https://www.thrustcurve.org/info/certification.html). The NAR's own *S&T Motor Testing Manual* §1.5 says the same from the other side: until documented procedures exist *"for correcting results from tests at other altitudes to sea level conditions as required by NFPA 1125, all test sites must be at an altitude that is within 500 feet of mean sea level"* — so NAR does not correct, it tests within 500 ft of the sea, which is worth at most about 1,825 Pa, or 0.9 N on a 1 inch exit. And where it has tested high, it says so and corrects: the AeroTech G77R certification sheet records *"Data taken at 5850 feet ASL and corrected to sea level"* against an Elevation field reading 5850 ft — which is Cedar City, Utah, AeroTech's own factory. Across all 312 certification documents in that set, 61 record a test elevation and **60 of them are at or under 500 ft**; that Cedar City firing is the single outlier, and it is the one that says it was corrected. None of the 312 records an ambient pressure.

**Why it stays an assumption.** That rule binds *certification* testing, and only about two in five of the curves this app flies are certification files — counted from ThrustCurve's own source tag across the {{CURVE_FILES}} bundled files, **41.1 % come from a certifying body, 45.3 % are contributed by users and 13.6 % from the manufacturer**. Neither the RASP nor the RSE file format has a test-site field, so a contributed curve carries no way to know where it was shot. What ties them back is that the app already checks every curve against the motor's **certified** total impulse (see *Motors → the impulse check*), and those certified figures are sea-level-referenced by the rule above. A curve that really was fired on a mountain and never corrected is overstated by a constant offset: a 1 inch (25 mm) exit at a 1,300 m stand is out by about **7.4 N — 1.4 % of a J540R** — at every altitude. That bias sits in the app's numbers with or without this term, because a sea-level-referenced curve flown from a sea-level pad produces exactly the thrust its curve states. Referencing the correction to the pad's pressure instead would be wrong for every curve that genuinely was measured near sea level, which the rule above says is most of them. The term therefore adds no new bias anywhere — it supplies the exact slope above the pad and leaves any existing offset where it was.

## Wind, turbulence, and why a re-run repeats exactly

Wind is modeled as **pink noise** around a mean speed. You set an average wind speed and a standard deviation (their ratio is the *turbulence intensity*); the kernel drives a two-pole pink-noise filter (spectral exponent α = 5/3, sampled every 0.05 s and linearly interpolated) to produce gusts with a realistic frequency content — more low-frequency wander than white noise. In this single-level model the wind blows in one horizontal direction and does not vary with altitude.

There is also a deliberately tiny random perturbation (±0.0005) added to the pitch and yaw moments each step, which prevents an unnaturally perfect, knife-edge-symmetric flight from never tipping over.

One of those differences is worth spelling out, because it is the one you can see in two runs of the same design. Desktop OpenRocket draws a random seed for each simulation when the simulation is created, and does not store it in the file, so the same design opened again there gives a different gust history. (Re-running one simulation you already have open reuses its seed — the seed is a property of the simulation, not of the run.) **MMRocket Sim seeds them deterministically** (a fixed seed, 42). Same design + same settings ⇒ **exactly the same flight, every time** — better for teaching, sharing and comparing, and it makes a clean before/after comparison of a design change possible. (For the same reason the engine also fixes a couple of internal iteration orders that desktop OpenRocket leaves free to wander at the sub-rounding-error level. Results stay inside desktop OpenRocket's own run-to-run envelope.)

---

<a id="feedback"></a>

## Feedback & Bug Reports

Found something broken, or want the app to do something it doesn't? Both are genuinely wanted — beta reports directly shape what gets built next. The **Feedback** button in the header offers every route, or use these links directly:

- **[Report a bug](https://github.com/mtnmanak/mountainmanrockets-feedback/issues/new?template=bug-report.yml)** — what you did, what you expected, what happened instead. The app version (next to the logo) and your browser help a lot; attaching the .ork file (zipped) makes most fixes far faster. Only attach designs you're comfortable sharing publicly.
- **[Request a feature](https://github.com/mtnmanak/mountainmanrockets-feedback/issues/new?template=feature-request.yml)** — describe the real task it would help with; the use case shapes the design more than the feature description does.
- **[Browse open issues](https://github.com/mtnmanak/mountainmanrockets-feedback/issues?q=is%3Aopen%20label%3Atool%3Ammrocket-sim)** — see what's already filed before adding a duplicate. The tracker covers mountainmanrockets.com and all of its online tools; a dropdown routes your report to the right one.
- **No GitHub account?** Email [admin@mountainmanrockets.com](mailto:admin@mountainmanrockets.com) and it gets filed for you — you don't need an account to *read* anything on the tracker.

The open-issues list is the real queue — anything filed there is logged, visible, and not forgotten.

**Your files stay yours.** Design files, flight recordings and screenshots you send in — by email or on the forum — are used to reproduce what you reported and to check the app's predictions against real flights. They are not published, passed on, or added to any public collection. If a comparison drawn from your file is worth showing others, you are asked first and credited the way you prefer. Anything you attach to a public GitHub issue is, of course, public — attach there only what you are comfortable sharing.

---

<a id="limitations-and-references"></a>

## Assumptions, Limitations & References

The physics above is powerful, but every simulation makes modeling choices. Knowing them tells you exactly where to trust the numbers and where to add engineering margin.

## Assumptions and honest limitations

- **Speed regime.** Extended Barrowman is at its best **subsonic and through the transonic region**. Fins get a genuine supersonic treatment, but body CNα and CP above Mach 1 are assumed equal to their subsonic values, and the engine raises a *supersonic* warning past Mach 1.1. Treat high-supersonic stability numbers as indicative, not precise — the Drag analysis chart labels its values above ~Mach 1.5 as approximate for the same reason.
- **Small-angle / attached-flow aerodynamics.** The method assumes slender bodies and largely attached flow. Fin normal force is capped at a **20° stall angle** — past that, more angle of attack buys no more fin force. A separate **17.5°** threshold flags the flight, before any recovery device opens: a large angle-of-attack warning while the rocket is still stable, a transition to tumbling once it is not. The body-lift term is damped below Mach 0.05 at angles of attack over 45° — the apogee turnaround — to avoid an artifact there. Extreme angles of attack are approximations.
- **Descent is a point mass.** Under parachute the rocket is 3DOF: drag (default Cd 0.8) and gravity only. Swinging, spilling, and canopy dynamics are not modeled, and **streamers** — especially at extreme length-to-width ratios — are represented by an effective drag area, not by true flexible-body aerodynamics.
- **Wind is horizontal and altitude-uniform** in the standard model; real wind shear and vertical gusts are not captured here.
- **Geodesy approximations.** The altitude gravity correction assumes a spherical Earth; the atmosphere drifts a few percent above ~32 km.
- **The thrust curve is trusted verbatim.** Motor-to-motor manufacturing variation, temperature effects on propellant, and off-axis thrust are outside the model.
- **The thrust curve is also assumed to be a sea-level curve.** Neither the RASP (`.eng`) nor the RSE (`.rse`) file format has a field for the pressure a curve was fired at, so the app adds the exact pressure-thrust rise above the pad but cannot remove the constant offset in a curve that was measured on a mountain — at most about 1.4 % of a J540R for a 1 inch exit fired at 1,300 m (see *How It Works: Physics & Math → Motor thrust-curve model*). A wrongly typed nozzle exit diameter is a much larger error than that one.

None of these are bugs — they are the modeling choices of a mature, widely validated tool, and that tool's kernel is genuinely what computes your flight, so its accuracy *and* its limits come with it. **Classic Extended Barrowman** is that kernel's own aerodynamics with none of the app's additions switched on, which is what makes it the baseline. What the app adds on top of it — the Kbf body carryover, the sharp-airfoil leading-edge treatment, the validated supersonic model, and the nozzle's power-on base drag and pressure-thrust terms — brings accuracy and limits of its own, described in *How It Works: Physics & Math*.

## Licensing and source code

MMRocket Sim is **free software**, released under the **GNU General Public License, version 3 or later (GPL v3+)** — the same license as OpenRocket itself, which it inherits. You are free to use, study, share, and modify it under that license. Because the GPL requires that anyone running a distributed build be offered its corresponding source code, the app's header carries a **source (GPL)** link — titled *"This app is free software under the GPL v3 or later — source code for this build"* — that opens the public source repository. If you want to see exactly what the app does, that link is the front door.

## References & further reading

- **Barrowman, J. S., & Barrowman, J. A. (1966).** *The Practical Calculation of the Aerodynamic Characteristics of Slender Finned Vehicles.* (J. S. Barrowman, M.S. thesis, The Catholic University of America, 1967.) The origin of the center-of-pressure and normal-force method used here.
- **Niskanen, S. (2009, rev. 2013).** *Development of an Open Source model rocket simulation software* / *OpenRocket technical documentation.* The definitive derivation of OpenRocket's extended Barrowman aerodynamics, drag build-up, mass model and simulation loop. https://openrocket.info/documentation.html
- **Galejs, R. (2006).** *Wind instability — what Barrowman left out.* Sport Rocketry / online. Source of the body-lift extension applied to long airframes.
- **NASA (1963).** *Collection of Zero-Lift Drag Data on Bodies of Revolution from Free-Flight Investigations,* NASA TR-R-100 (NTRS 19630004995). Source of the nose-cone pressure-drag data tables.
- **Pitts, W. C., Nielsen, J. N., & Kaattari, G. E. (1957).** *Lift and Center of Pressure of Wing-Body-Tail Combinations at Subsonic, Transonic, and Supersonic Speeds,* NACA Report 1307. Source of the optional body-in-presence-of-fins (Kbf) interference factor.
- **Rogers, C. E., & Cooper, D. (2011).** *RASAero Aerodynamic Analysis and Flight Simulation Program.* Rogers Aeroscience. Documents the power-on/power-off drag distinction, the sea-level-referenced pressure-thrust correction, and the Rogers Modified Barrowman method that inspired those options here.
- **International Standard Atmosphere:** ISO 2533:1975; and the *U.S. Standard Atmosphere, 1976* (NOAA/NASA/USAF). Basis of the temperature, pressure and density model.
- **WGS84 / Somigliana gravity formula:** *Department of Defense World Geodetic System 1984,* NIMA TR8350.2. Basis of the latitude- and altitude-dependent gravity model.
- **Runge–Kutta integration:** Butcher, J. C., *Numerical Methods for Ordinary Differential Equations;* or Press et al., *Numerical Recipes,* ch. 16. The RK4 scheme used for the equations of motion.
- **OpenRocket project:** https://openrocket.info — source at https://github.com/openrocket/openrocket. Licensed under the **GNU General Public License v3.0-or-later**: https://www.gnu.org/licenses/gpl-3.0.html . MMRocket Sim inherits this license.
