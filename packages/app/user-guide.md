# MMRocket Sim — User Guide

> The complete guide to MMRocket Sim: a quick start, a full feature
> reference, and the physics, math, and citations behind the numbers. This is
> also available inside the app via the **Guide** button in the header.

<a id="welcome"></a>

## Welcome to MMRocket Sim

MMRocket Sim runs the real OpenRocket flight physics entirely in your web browser. There is nothing to install: the same **24.12 physics kernel** that powers the OpenRocket desktop application has been compiled to JavaScript and verified bit-for-bit against the desktop program. When your browser reports an apogee, it ran the same code, in the same order, with the same rounding as the desktop app.

The workflow is simple and always the same. You design a rocket by building up its components, hang a motor, set your launch conditions, and press **Launch** to see how high it flies, how fast it goes, and whether it will fly straight and land safely. This guide is written for model and high-power rocketry hobbyists at every level, from your first Estes kit to a multi-stage high-power project.

The app is organized into **three workspaces**, selected by the tabs under the header, one per phase of that workflow: **Design** (the component tree, the 2D/3D view, and the property editor), **Motors & Launch** (motor selection, ejection delays, batch simulation, and launch conditions), and **Results** (flight stats, the launch report, plots, drag analysis, and saved runs). On a phone a fourth workspace, **Fly**, comes first and is the default — see *The Fly screen* under Simulating. A **vitals strip** above the tabs stays visible everywhere — the rocket's name, stability margin, loaded mass, current motor (with an **⏏ Unload** button that strips every loaded motor so you can view and weigh the rocket clean), the **aerodynamics model** (a switch, not just a readout — see *How It Works → Choosing a model*), last apogee, and the **Launch** button — so you can tweak a fin, fly, and check the number without hunting through tabs. Launching switches you to Results automatically.

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

When the app opens, you already have a complete, flyable rocket called **My Rocket** — a nose cone, a body tube, a fin set, a motor mount, and a parachute. You don't have to build anything to get started. All it's missing is a motor. (On your very first visit a **six-step tour** points out the component tree, the drawing, the Motors & Launch workspace, the Launch button, the Results workspace, and the Guide and Feedback buttons — it shows once, and you can replay it any time with the **⟲ Tour** button in the header. *Preferences → Display* has an **Off** switch that takes effect immediately — including on a tour that is currently on screen — and putting it back to **On** genuinely re-arms the tour for your next visit.)

**1. Load a motor.** Open the **Motors & Launch** workspace (the tabs under the header) and find the **Motors** panel. The fastest option is the **Quick picks (built-in, offline)** dropdown — pick a classic Estes motor like **B6-4** or **C6-5** and it loads instantly, no download needed. (The number after the dash is the ejection delay in seconds.) Want something specific? Click **🔎 Browse motor database…** to search the full thrustcurve.org catalog of about 1,100 motors — but for your first flight, a quick pick is all you need.

**2. Check your launch conditions (optional).** Beside the Motors panel is the **Launch conditions** panel. The defaults are sensible: a 1-meter launch rod, pointed straight up, no wind, standard sea-level atmosphere. You can leave every field alone for now.

**3. Press Launch.** Hit the **Launch** button — at the bottom of the Launch conditions panel, or the always-visible **Launch** in the vitals strip at the top. The simulation runs in a fraction of a second and the app switches to the **Results** workspace with your numbers.

That's it — you've flown a rocket.

## Reading your first result

After launching, the headline tiles across the top of the results give you the numbers that matter most:

- **Apogee** — the peak altitude the rocket reached. This is your "how high did it go" number.
- **Max velocity** — the fastest the rocket traveled (also shown as **Max Mach** in the detailed report).
- **Max accel** — peak acceleration, a feel for how hard it leaves the pad.
- **Apogee at** — seconds from liftoff to the top of the flight.
- **Descent hits** / **Flight time** — how fast it's coming down at landing and how long the whole flight lasted.

Two health checks tell you whether the flight is actually *safe and stable*, not just how high it went:

- **Stability margin** (shown in the design stats as **Stability**, in *calibers*). A healthy rocket sits between **1.0 and 3.0 cal**. Below 1.0 the rocket is *under-stable* and may wobble or go unstable — flagged red with a ⚠. Above 3.0 it's *over-stable* and tends to weathercock (turn into the wind) — flagged as a yellow △ caution, not a failure. Right in that band, marked ✓, is what you want. The design page, vitals strip and launch report all use this same rule.
- **Landing descent rate** — you want to touch down at **20 ft/s (about 6 m/s) or slower** so nothing breaks. The report flags a faster landing. Parachute presets apply the manufacturer's rated drag coefficient when the catalog carries one, but a simulated descent rate is still an estimate — **always cross-check the parachute manufacturer's own sizing guidance** before you fly.

Open the full launch report below the tiles for more: **thrust-to-weight at the rod** (aim for at least **5:1**), **rod-exit speed** (at least about 50 ft/s / 15 m/s so the fins have airflow to steer with), deployment timing, and plain-language safety comments that name any problem and where it is.

If your first rocket flies stable and lands soft — congratulations, you're done. If a value comes up flagged, the report tells you which one and why, so you know what to adjust.

## Where to go next

Now that you've seen a flight end to end, the rest of this guide shows you how to make it *your* rocket:

- **Build and edit components** — reshape the nose, resize the body, design custom fins (including freeform), and add stages using the component tree.
- **Choose the right motor** — filter the full database by manufacturer, diameter, and impulse; drill ejection delays to any whole second; and batch-test many motors at once.
- **Dial in launch conditions** — wind, launch angle, site altitude, and weather.
- **Read the plots and reports** — altitude, velocity, and stability over the whole flight, plus saving and exporting your results.
- **Import and export** — load and save `.ork`, RockSim, and RASAero files.

---

<a id="designing-the-rocket"></a>

## Designing the Rocket

Everything below is organized by the order you actually work: design the rocket, look at it, hang a motor, set the weather, fly it, read the results, then save or export. This section covers the design stage.

## The component tree

The **Design** workspace's left column is a **stage-rooted tree** of components. Each stage holds an axial chain of external body parts (nose cone → body tubes → transitions), and those in turn hold internal parts (fins, motor mounts, recovery gear, mass). Click a node to select it and its property panel opens in the column to the right of the rocket view; inline buttons on each node **move, duplicate, or delete** it. The tree enforces OpenRocket's containment rules — you can only add children a parent legally accepts (for example, fins and inner tubes go inside a body tube, a parachute goes inside any body part, and an engine block goes inside an inner tube).

## The nineteen component types

| Type | Category | Key parameters |
|---|---|---|
| Nose cone | External body | length, base radius, wall thickness, shape, shoulder |
| Transition | External body | length, fore/aft radius, thickness, shape, two shoulders |
| Body tube | External body | length, outer radius, thickness |
| Trapezoidal fins | Fin set | count, root/tip chord, sweep, height, thickness, cant, cross-section, tabs |
| Elliptical fins | Fin set | count, root chord, height, thickness, cross-section, tabs |
| Freeform fins | Fin set | count, thickness, cross-section, tabs, polygon outline |
| Tube fins | Fin set | count (up to 12), length, outer radius, wall thickness |
| Inner tube | Structure / mount | length, outer radius, thickness, cluster layout |
| Tube coupler | Structure | length, thickness |
| Centering ring | Structure | axial thickness |
| Bulkhead | Structure | axial thickness |
| Engine block | Structure | length, thickness |
| Launch lug | Guide | length, outer radius, thickness |
| Rail button | Guide | outer diameter |
| Camera shroud / fairing | External | length, width, height, fore/aft end shape, conformal, angle around body, as-built mass, finish |
| Protuberance (drag bump) | External | frontal area (or width × height), drag class, count |
| Parachute | Recovery | canopy diameter, Cd, spill hole ⌀, lines, deploy event |
| Streamer | Recovery | strip length/width, Cd, deploy event |
| Shock cord | Recovery | cord length |
| Mass component | Ballast | mass, length, radius, type (ballast / altimeter / tracker / …) |
| Pod set | Assembly | instance count, radial distance & reference, angle |
| Booster (parallel stage) | Assembly | instance count, radial placement, angle, separation |

### Camera shrouds (fairings) — how they're modeled

A camera shroud is a real aerodynamic body: it shifts CP and adds drag, and
MMRocket Sim is (as far as we know) the only hobby simulator that computes both. The
side profile is flown as a **slender strake** through the kernel's own
low-aspect-ratio fin lift (which reduces to the classic Jones slender-body model —
the right physics for a strake), so the CP shift falls out of the same Barrowman
machinery as everything else. Drag uses **Hoerner protuberance coefficients**
referenced to the shroud's frontal area (streamlined ≈ 0.25, half-round ≈ 0.55,
box ≈ 1.05, body interference included). Enter the as-built mass — printed parts
weigh what they weigh.

**The two ends are shaped separately.** Real shrouds are domed on the end the
camera looks out of, to give the lens a clear aperture, and tapered at the other
end. Set **Fore end** and **Aft end** independently; a forward-facing camera
just swaps them. The default is streamlined at the front, domed at the back. A
shroud with matching ends is charged exactly the coefficient above; give it two
different ends and it is charged the mean of the two, which is an interpolation
rather than a measurement — say so if you quote it.

**Conformal to body tube** is on by default, and describes what nearly every
3D-printed shroud is: the underside cut to the curve of the tube so it sits
flush. Turn it off for a part with a flat base sitting on the tangent — you will
see the gap open up at the corners in the end-on view. This changes the drawing
and the printed shape, not the numbers.

**Angle around body** places the shroud where it really sits. Two buttons beside
the field put it exactly on a fin or exactly between two fins, which is where
singular parts nearly always go. A shroud in line with a fin has the fin in
shot.

Known limits, stated: the mounting angle changes no flight number (a shroud's
drag is computed the same wherever it sits, as in desktop OpenRocket), the
frontal area is charged as width × height, which ignores the small extra
blockage the body's curvature adds, and there is **no wind-tunnel anchor for
this model** — treat the numbers as good engineering estimates, and add margin
on small-diameter rockets where a shroud matters most.

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
for the with-base class. We compute that body CD by doing exactly what Rogers
tells OpenRocket users to do by hand: strip the fins and every other appendage,
run the bare airframe, and read off its drag with and without the base term. The
property panel prints the two numbers it found for your design, so you can check
them. They are quoted at Mach 0.3 — the same Mach as the Design tab's
**Cd (M0.3)** tile, which shows the *whole* rocket including fins, so expect the
body figures to be the smaller pair.

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

RASAero `.CDX1` protuberance entries import onto this component and export back
out, class and area intact.

Three honest limits.

1. The drag is **Mach-flat**. RASAero re-evaluates the body CD at every Mach, so
   its protuberance drag tracks the body's transonic drag rise; ours is frozen at
   **Mach 0.3**. On the NASA ARCAS the true curve runs +0.0093 to +0.0206 CD and
   ours sits at +0.0158 — inside the band everywhere, exact around M0.3–0.6, low
   at the transonic peak. If your flight lives up there, read your body CD off
   the **Drag** tab at your own max-Q Mach and type it into the Cd field.
   Measured data is harsher still for a *ring* right around the body: a band on a
   cylinder adds **no** drag at all below about Mach 0.70, which no Mach-flat
   model can reproduce.
2. It contributes **no CP shift and no normal force**, the same as RASAero. An
   asymmetric guide really does trim the rocket to a small angle of attack; that
   is not modeled anywhere in the hobby tools.
3. Mass is whatever you type — 0 by default. Weigh the part in if it matters.

As a scale check, the four fin-root anchors on the NASA ARCAS (0.178 in² total,
4.5 % of a 2.25-inch airframe's area) come out at **+0.0158 CD** — small, but the
same size as the difference between a good sim and a disappointing flight. Before
v0.069 these classes were flat constants (0.10 and 0.22) and gave +0.0098 for the
same anchors, about 1.6× low against the method whose names they borrowed.

### Parachute spill holes

A spill hole reduces the effective drag area: we fly the standard reduction
Cd_eff = Cd · (1 − (hole ⌀ / canopy ⌀)²) — the same treatment RockSim uses, and
spill holes round-trip through RockSim files.

## Dimensions: diameter vs. radius

Internally every size is stored in **pure SI** (meters, kilograms, seconds) and angles in radians. The property panel shows friendlier units (mm, degrees, grams) and converts at the edge. Fields that describe a round cross-section are stored as a **radius**, but if you set your preference to "Diameter" the panel doubles the value and relabels it — so "Base outer radius" becomes "Base outer diameter" and accepts the tube's full OD. This matters because catalog tubes are always quoted by diameter, so most builders switch to diameter mode.

## Nose cones and transitions

Both support six mathematical **shapes**: Ogive, Conical, Ellipsoid, Parabolic, Haack, and Power. The 2D and 3D views draw the **exact mathematical profile** the physics flies, including the shape parameter.

Four of the shapes are really *families* of profiles, selected by a **Shape parameter** field that appears next to the shape picker (Conical and Ellipsoid have a single fixed profile, so the field hides). A blank field always means OpenRocket's own default for that shape — a missing parameter never silently reshapes the part:

| Shape | What the parameter controls | Range | Blank = |
|---|---|---|---|
| Ogive | **1 = tangent ogive** (the circular arc meets the body tube smoothly — the classic kit profile). Below 1 it becomes a **secant ogive** (a shallower arc that meets the tube at an angle), straightening all the way to a cone at 0. | 0–1 | 1 |
| Parabolic | Which segment of a parabola to use: **1 = full parabola** tangent to the tube, 0.75 = ¾-parabola, 0.5 = ½-parabola, **0 = cone**. | 0–1 | 1 |
| Power | The exponent n in r ∝ (x/L)ⁿ: **0.5 = the classic ½-power** (parabola of revolution), 1 = cone, small values = increasingly blunt. | 0–1 | 0.5 |
| Haack | **0 = LD-Haack (Von Kármán)** — minimum drag for a given length and diameter, the usual choice; **1/3 = LV-Haack** — minimum drag for a given length and volume. The field caps at 1/3 (the engine clamps there too). | 0–1/3 | 0 |

Imported files keep whatever parameter they carried — RockSim designs in particular often store explicit values, which you can now see and edit. A nose cone can be **solid (filled)** or a hollow shell of a given wall thickness, and can carry a **shoulder** (radius, length, thickness, and an optional end cap) that plugs into the tube below. A transition is a shoulder-to-shoulder part with independent fore and aft radii plus a shoulder on **each** end — use it as a reducer, boat tail, or coupler flare.

## Fins

Four fin families are supported:

- **Trapezoidal** — the everyday fin, defined by root chord, tip chord, sweep, and height.
- **Elliptical** — a rounded planform from root chord and height.
- **Freeform** — an arbitrary polygon. Selecting one opens the **freeform point editor**, where you drag vertices to draw any outline (needs at least three points).
- **Tube fins** — a ring of full tubes instead of flat fins (up to 12).

Every flat-fin set also carries a **cant angle** (to induce roll), a **fin count** (1–8), and a **cross-section**: **Square**, **Rounded**, or **Airfoil (pointed)**. The cross-section is not cosmetic — a square edge produces markedly more pressure/skin drag than a streamlined airfoil, and the kernel models that difference, so choosing "Airfoil" on a carefully sanded fin gives you the lower drag you actually built.

For fast flights there is also an optional **supersonic airfoil** selection (RASAero-style): **hexagonal, NACA, double wedge (diamond), biconvex, hexagonal blunt-base, and single wedge**, plus **LE/TE chamfer lengths** and a **leading-edge bluntness radius**. Each shape gets its proper supersonic thickness wave drag, blunt-base shapes add fin base drag, and a blunt LE adds swept-cylinder drag. Leave this selector on its default, **"Classic"**, and the ordinary cross-section above drives the model instead. Two things are worth knowing, and both depend on which **aerodynamics model** you fly rather than on this selector: the **Classic Extended Barrowman** model ignores a named supersonic section outright, because desktop OpenRocket knows only the three cross-sections; and since v0.075 the **Rogers Kbf** and **Supersonic** models no longer charge an **Airfoil** cross-section the classic blunt leading-edge drag (see *Aerodynamics* below). These choices also round-trip through `.ork` files (the desktop app ignores the extra tags with a warning).

**Through-the-wall tabs**: a tab exists only when **both** its depth and length are greater than zero (OpenRocket's rule). You set the tab depth, length, offset, and the reference edge the offset is measured from (front / middle / end of fin). The engine clamps tab depth to the body radius, and the tab's volume counts toward fin mass and CG.

## Positioning and snapping

Internal and fin components are placed **axially** relative to their parent, using a method (top / middle / bottom / absolute) plus an offset. You can drag parts in the 2D schematic or nudge the offset slider. The editor provides **magnetic snapping** to meaningful anchors: the parent's ends and middle, every sibling's leading and trailing edges, and — importantly — the front and rear edges of a fin's tab, because in a real build the centering rings butt against the tab where it passes through the wall. Any "absolute" positions from an imported file are rewritten to parent-relative offsets so the drawn geometry always matches the simulated geometry.

## Motor mounts and clusters

A motor mount is usually an **inner tube** with the mount flag set. For **minimum-diameter rockets** — where the motor case is essentially the airframe and there is no room for a mount tube — check **"Motor mount"** on the **body tube** itself and the motor loads directly in it (the same kernel path the desktop uses; imported files with body-tube mounts now come in as real mounts). Each stage also carries a **maximum motor length** — the longest motor its airframe has room for. The primary value lives on the motor mount tube in the design (so it travels with the `.ork`); the field on **Motors & Launch** overrides it per stage. The **⌾ Estimate** button beside that field measures it for you: from the aft end of the mount forward to the first thing a motor case cannot pass — an engine block, a bulkhead, or a mass component standing in for a sled — or to the front of the mount tube when nothing is in the way, plus any motor overhang the mount allows. It names whatever set the limit. Treat it as a starting point rather than an answer: it cannot see wadding, a baffle modelled as some other component, or a chute packed hard against the block.

Every mount also takes a **motor overhang** — how far the motor protrudes past the tube's aft end (about 6 mm is standard min-diameter retention practice) — which shifts the motor's mass aft in the simulation and draws in the 2D view. For the extreme *sub-minimum* style (fins bonded straight to the motor case, or propellant cast into the airframe tube itself), model a body tube with the motor case's own outer diameter and check **"Sub-minimum: motor case is the airframe"** — the motor browser then fits motors against the tube's *outer* diameter instead of its bore, so the case-diameter motor you're building around stays selectable. Leave the wall thickness at 0 unless the airframe adds real structure on top of the case (the motor file's weight should include the case — it flies), and give the tube the case's true length or the motor will overhang in the drawings. An inner tube also carries a **cluster layout** — single, rows, rings, and stars up to nine motors, with a spacing multiplier (× tube diameter) and a rotation. One motor choice serves the whole cluster: thrust is multiplied by the count and mass is placed at the real tube positions, exactly matching the kernel's ClusterConfiguration.

## Pods and parallel boosters

Two assembly types place whole component chains **off-axis**, ringed around the airframe:

- **Pod set** — a non-separating pod (camera bay, external raceway, side-mounted tube). It stays attached for the whole flight, contributing its mass and drag rigidly.
- **Booster (parallel stage)** — a separable strap-on booster with its own separation trigger and delay, like the outboard boosters of a Falcon Heavy. After it separates, it flies (and lands) on its own tracked branch.

Both attach to a body component (body tube, nose cone, or transition) and hold their own axial chain — nose cone, body tubes, fins, even a motor mount — exactly like a miniature rocket. Placement is controlled by an **instance count** (1–8 copies ringed evenly around the body), a **radial distance** with two reference modes (a *gap from the parent surface*, where 0 = touching, or a distance *from the centerline*), and an **angle** around the body. A booster with a motor mount takes a motor like any other mount, and its ignition follows the same trigger rules as serial stages.

## Recovery

**Parachutes** take a canopy diameter, a drag coefficient (blank = automatic, defaulting to 0.8 after deployment), line count, and line length. **Streamers** take strip length and width. Both carry a **deployment trigger**: motor ejection charge, apogee, altitude (descending, with an AGL altitude), launch, or never — plus a deploy delay. A **shock cord** and a **mass component** (for nose weight, altimeters, or dead ballast) round out the bay. A mass component's **Type** dropdown records what it actually is — altimeter, flight computer, deployment charge, tracker, payload, recovery hardware, or battery — purely descriptive (the physics only uses the mass), and it travels through .ork files both ways, so the desktop app sees the same identity.

## Mass, CG, and Cd overrides

Any component can override its computed **mass**, **axial CG position**, or **drag coefficient**. This is how you tell the sim what a part *actually* weighs when the geometry can't know — a machined coupler, a loaded electronics bay, a store-bought chute. Applying a component preset that carries a cataloged mass sets a mass override automatically, because a real part weighs what it weighs, not what its shell computes.

### An override never deletes anything

This is the first thing to be clear about. Setting an override does **not** erase the component's own numbers. Its length, radius, material and everything else stay exactly where you put them, in the design and in the saved `.ork` file. The override simply stands in front of the computed result — clear it and the original value is back, unchanged. The same is true of a component that is being covered by an override higher up: its own figures are still there, just not contributing at the moment.

### What "Use instead of everything inside" does

Once an override has a value, a **Use instead of everything inside** checkbox appears under it. It decides how far the override reaches:

- **Ticked** — your figure is used instead of **this component and everything in it**. Nothing below it contributes any more: not the parts' geometry, and not their own overrides.
- **Unticked** — the override stands in for **this component's own figure only**. Its own computed mass, CG or drag steps aside; everything *inside* it still counts on its own, and so do its neighbours.

So on any part with geometry of its own, the two settings are not "add" versus "replace" — an override always replaces something, and the only question is **how much**: just this part, or this part and its whole contents.

**Containers are the exception, and it matters.** A **stage**, a **pod set** and a **booster** hold other parts but have no mass, CG or drag of their own — so an unticked override on one has nothing to stand in for, and *adds* instead. An unticked **mass** adds to whatever the contents weigh (type 1.2 kg unticked and the rocket gets 1.2 kg **heavier**; tick the box and it weighs exactly 1.2 kg). An unticked **Cd** adds in exactly the same way: a stage Cd of 1.0 left unticked adds 1.0 on top of the drag the parts already compute, so a rocket that computed 0.60 comes out at 1.60. An unticked **CG** override, though, looks like it does nothing — and on its own it genuinely doesn't. The reason ties the three together: unticked, your figure describes a **point mass the container adds**, and the CG says *where that added mass sits*. With no mass override beside it there are zero kilograms to position, so nothing moves. Add a mass override and the same CG bites immediately — 1 kg unticked at a CG of 0.1 m places exactly that kilogram at 0.1 m and pulls the rocket's balance point with it. The panel says so on the field itself when you set a CG that isn't doing anything yet. **On a stage, a pod set or a booster, tick the box.** The panel says so too.

### When overrides are stacked

Because any component can carry one, you can end up with overrides at several levels at once. The rule is simple:

**The nearest ticked ancestor wins.** Once a component is covered by an ancestor's "Use instead of everything inside", nothing below that ancestor matters — including other overrides.

If you set a mass on a body tube and the number never changes, that is almost always why: a stage above it is standing in for the lot. The panel tells you so directly — the override field shows a note naming the component that is covering it, so you never have to guess.

Working from the outside in, then, a whole-stage override is the biggest hammer and the easiest to reason about; per-component overrides are for the parts the geometry genuinely can't know.

### One figure for the whole rocket

Because a **stage** is a component like any other, selecting the stage in the tree, entering a **Cd**, and ticking **Use instead of everything inside** sets **one drag coefficient for the entire rocket** — the standard way to trim a simulation until its apogee matches what your altimeter actually recorded. The same move on **mass** pins a whole stage to its as-weighed number, and on **CG** to its as-balanced point.

Two things worth knowing before you rely on it. First, a whole-rocket Cd is a *calibration to one flight*, not a prediction — it will not follow you to a different motor or a different day the way real geometry does, so prefer modelling the actual shape where you can. Second, replacing a stage's mass means the individual parts stop contributing mass, so the per-component breakdown below it stops being meaningful even though the total is exactly right.

### The one asymmetry to watch: fin sets

A fin set is a single component that stands for several fins, and OpenRocket treats its two overrides differently:

- **Mass** covers **all the fins together** — the field is labelled *(all fins combined)*.
- **Cd** is **per fin** — the field is labelled *(per fin)*. Entering 0.5 on a three-fin set contributes 1.5 to the rocket's drag coefficient; on a four-fin set, 2.0.

This matches desktop OpenRocket exactly. It surprises people, which is why both fields say which they are.

All of this round-trips through `.ork` in both directions, so a design you override here opens the same way in desktop OpenRocket, and vice versa.

## Measured mass & CG (matching the rocket you actually built)

Under the component tree on the Design workspace there is a **Measured mass & CG** box. Weigh
your finished airframe **with the motor out**, balance it on a ruler edge, and type the two
numbers. The box shows how far the model is from the real thing, and offers one button.

Press it and MMRocket Sim inserts a mass component called **Build allowance**, of exactly the
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
override and **Use instead of everything inside** ticked. That is exact, and it is the standard
desktop-OpenRocket move. It costs two things:

- **The per-component breakdown stops meaning anything.** Once the stage stands in for the whole
  subtree, the individual part masses contribute nothing — the total is right and every line
  under it is decoration.
- **You lose the diagnostic.** A single pinned number tells you the answer but not the
  discrepancy; you never learn that your build came out 60 g heavy.

**The two interact, and the app now says so.** If a stage already carries a mass override with
**Use instead of everything inside** ticked — every RASAero `.CDX1` import arrives that way,
because that is how the file's stated launch weight is applied — then a Build allowance placed
inside that stage weighs *nothing*: the override stands in for it, exactly as it stands in for
every other part underneath. Rather than adding a component that does nothing, the box says
which component is in the way and offers to **pin that component to your measured mass and CG**
instead. It only offers that when one override covers the whole rocket: the measured figures are
whole-airframe and the overrides are per-stage, and there is no rule for which of several stages
should absorb the difference, so it declines to guess.

Ballast keeps both, because it adds real mass at a real station instead of replacing the tree.

**A wrinkle in the inherited kernel used to make this worse, and it is fixed as of v0.088.** When
a mass override covered a subtree, the children's mass was zeroed but their **moments of inertia
were still summed in**, so a pinned rocket flew with the rotational inertia of the parts
underneath rather than of the mass you pinned — the mass, the balance point and the inertia
described three different objects. The inertia now scales with the mass you gave it. Apogee
barely notices, but inertia is what drives weathercocking, pitch oscillation and how the rocket
behaves leaving the rod, so a pinned design's **downwind drift** moves: measured, about +0.2 % at
a 1.35x pin and +0.8 % at 2x on a 54 mm airframe in a 5 m/s wind. A design with no covering mass
override is completely unaffected. Roll and pitch inertia are now printed in the All-stats
drawer, so you can see the figure rather than take it on trust.

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

### RockSim files often already know

A RockSim `.rkt` design can carry a **measured weight and balance point for the whole rocket**,
recorded on the design rather than on any one part — most vendor kit files do. Opening one fills
this box in for you, and the note says so. Nothing is applied to the simulation until you press
the button, so you can see first that (for example) the kit states 292 g where your parts compute
195 g, and decide whether you believe it.

Two things we do differently from desktop OpenRocket here, both deliberate. We honour the file's
own "known mass" flag — the desktop reader ignores it, and a number of real kit files carry a
stale leftover value that it will happily apply. And we don't pin the whole stage to the stated
number the way the desktop does, because that stops every individual part mass counting and leaves
the rocket carrying the wrong rotational inertia. Ballast at a real station does neither.

The "Build allowance" component is an ordinary mass component: it saves into `.ork` like any
other, and desktop OpenRocket sees the same rocket. **The two numbers you weighed are saved with
it**, so re-opening the file brings the box back with your measurements still in it — and a share
link carries them too. Desktop OpenRocket skips those two extra tags with a warning, the same way
it treats camera shrouds.

## Materials, finishes, and color

Solid and structural parts pick a **bulk material** from the desktop material database (writing its density); parachutes and streamers pick a **surface material**, and shock cords/lines pick a **line material**. Typing a custom density detaches the part from the named material. Each body part also has a **surface finish** — Rough, Unfinished, Regular paint, Smooth paint, Aircraft sheet-metal, or Polished — and surface roughness feeds the skin-friction drag model, so a polished airframe genuinely simulates lower drag. Finally, each component has a **display color** (a full picker plus one-click presets) used only in the 2D/3D views.

## Component presets

The bundled catalog holds roughly **4,700 real-world parts** (tubes, nose cones, transitions, rings, couplers, bulkheads, engine blocks, launch lugs, parachutes, streamers) from named manufacturers with part numbers, materials, and cataloged mass. Open the preset picker on a selected component, choose a part, and its dimensions, material, and mass override are patched in. The 1.3 MB bundle loads lazily on first use, and you can round-trip your own custom presets through CSV.

---

<a id="visualizing-the-design"></a>

## Visualizing the Design

As you build, five views keep the design honest — a scale side view, an end-on aft view, a rotatable 3D shell, printable 1:1 fin templates, and a drag-analysis chart.

## The 2D schematic

A true-scale side view drawn from the tree. On a desktop the canvas is the hero of the Design workspace: it fills the center column, a **floating chip** carries the five numbers you check constantly (length, loaded mass, CG, CP, stability) — drag it anywhere on the canvas, fold it to a one-line stability pill with the ▾ button (a click unfolds it), and it stays where you put it — and the full stat-tile grid sits one click away behind the **▤ All stats** button (bottom-left of the canvas). The drawing shows tubes, lathed nose/transition profiles, fins at their real planforms, fin tabs, and motor cases drawn to scale — a **loaded motor is tinted and labeled with its designation** right in the mount — plus **CG and CP markers** in standard rocketry symbols. Hovering a component highlights it and names it in a small tag; clicking selects it for editing. Dashed **leader lines** run from each marker to a labeled dot in the clear sky above (CG) and below (CP) the airframe — legible even when the two markers sit almost on top of each other, which is exactly the under-stable case you most need to see — and the **stability margin** floats beside them on the drawing itself, color-coded like the stability card: green ok (1–3 cal), amber over-stable, red under-stable. You can **drag components** to reposition them (with the snapping described earlier) and pan/zoom. Pods and parallel boosters draw off-axis where they actually sit, projected above/below the body in the side view.

**Dimensional rulers** run along the top and down the left, in your Preferences length unit, the way desktop OpenRocket draws them: the top scale reads axial station from the nose tip, the left scale reads distance from the centerline (positive up, negative down), and the corner names the unit. They follow the zoom and the pan, so a zoomed-in view reads finer divisions rather than the same coarse ones spread apart, and the ⬇ SVG and ⬇ Image exports carry a ruler drawn for the whole rocket whatever the screen is zoomed to. The **📏** button on the canvas turns them off if you want the drawing to have the space back; the setting is remembered.

The **roll slider** down the far left turns the rocket about its long axis — desktop OpenRocket's rotation slider, in the same place. Drag it, and every part that has a clock angle sweeps through the view: each fin is foreshortened by the cosine of its angle, so a three-fin set reads as one fin at full span and two at half. **The moment you move the slider the drawing becomes a wireframe** — every fin is an outline, drawn over the body, with nothing hidden and nothing occluded. That is desktop OpenRocket's convention exactly: its figure draws every component as an outline and fills nothing, which is why a fin there can be followed all the way round. All of them stay on screen at every angle, including the one lying flat inside the body, which turns edge-on into a line across the tube rather than vanishing at the wall. **At rest the drawing is the filled one you know**: a fin pointing **toward** you is in front of the airframe and is drawn whole, crossing the tube; one pointing **away** is behind it and the tube covers its root. That is what tells the two lower fins of a three-fin set apart in a still picture. One thing to expect rather than puzzle over: **a set of N identical fins repeats every 360/N degrees** — a three-fin rocket rolled 120° is the same rocket, and the side view has no way to tell you which fin is which, so the wireframe at 130° matches the one at 10° exactly. (Zero itself is the exception, because zero is where the drawing switches back to the filled one.) Desktop OpenRocket repeats the same way. The Aft view is where you can follow one fin the whole way round. Pods, parallel boosters and motor clusters swing with it. The readout under the slider shows the angle and clicking it returns to zero (so does double-clicking the slider). It is a **view** control, like zoom: it changes nothing in the design, nothing in the numbers, and nothing is saved — but it is shared with the Aft view, so you can roll the side view and switch to Aft to see the same attitude from behind. Launch lugs, rail buttons, camera shrouds and protuberances roll with everything else, each from its own **Angle around body** — zero is the top of this drawing, which is also where an unrotated fin set puts its first fin, so `0` means "in line with fin 1". That is the setting to move if you want a camera pointing between the fins rather than down one of them; the Aft view is where to check it. Two buttons beside that field do it for you: **▲ on a fin** and **⟂ between fins** put the part exactly where singular parts nearly always go. Those four parts stay **filled** while the view is rolled, unlike the fins — a fin is a thin plate and an outline is an honest picture of one, but a 20 mm camera shroud drawn as an outline would read as a thin line and lie about the part. They pass behind the airframe and are hidden by it, exactly as they are at rest.

**A rail button with something else on its line gets flagged.** The rail runs down that line for the whole length of the rocket, so a fin, a lug or a shroud sharing it means the rocket will not slide onto the rail — the warning strip on the Design tab names both parts and how far apart they are. Two rail buttons at *different* angles get flagged for the same reason: one rail is a straight line, so they cannot both engage it. (Two buttons at the same angle is the normal build and says nothing.)

## The 3D view

A three.js render you can **drag to rotate and scroll to zoom**, with soft studio lighting and a genuinely translucent shell so the internals — mounts, inner tubes, and the loaded motor — read through the wall. **Reset / Side / Aft** buttons in the corner jump the camera to known-good views (Reset is the way back if a zoom or pan ever loses the rocket; zoom is also distance-limited now so the camera can't bury itself in the hull). It marks the **CG** (a neutral sphere) and **CP** (a red sphere) on the axis, and a **floating callout** beside the rocket repeats the two markers at their true stations with the color-coded stability margin between them, readable from any angle. Both are **optional** — the **◉ CG/CP** button in the corner turns them off for a clean shell, and *Preferences → Display → CG / CP markers in 3D* can keep one and drop the other. Pods and boosters render ringed around the airframe at their true radius and angle — and they export to OBJ too. The **📷 Image** button exports a hi-res snapshot of the view (see *Files, Units, and Offline Use → File formats*); its **Fit rocket to frame** option is on by default, so the export spends its pixels on the rocket rather than the background.

## The Aft view

The rocket seen end-on, which is the only place a fin count, a pod ring or a motor cluster is visible as it really sits — every side view projects those onto one plane. It is the Aft tab on the design canvas, and it also sits under the motor list on **Motors & Launch** for every rocket. Zoom with the wheel and drag to pan. It shares the 2D view's **roll slider**, so the two agree: roll the side view until a fin goes edge-on, switch to Aft, and that is the fin pointing straight at you.

Angle zero points **straight up** here for everything with a clock angle — a fin set's rotation, a pod ring's angle offset, a cluster's rotation — matching where the simulation kernel puts them and what the 3D view draws. (Before v0.078 pods and clusters were drawn ninety degrees away from the fins in this view. Fins are unchanged; a design with a pod ring or an off-single cluster will look rotated a quarter turn from how it looked before, and the new picture is the correct one.)

## 1:1 fin templates (SVG)

From any fin set you can export a **true-scale printable cutting template**. It draws the fin outline as a hairline cut path, a dashed root-chord reference line, the through-the-wall tab rectangle where present, a label block (rocket/fin name, cut count, chord/height/thickness/cross-section/tab depth), and a **50 mm calibration ruler**. Print at 100% with no fit-to-page, then check the ruler measures exactly 50 mm — printers silently rescale, and the ruler is how you catch it. The SVG uses physical millimeter units and a 0.2 mm hairline, so it feeds a laser cutter directly.

## Drag analysis (CD vs Mach)

On the **Results** workspace, the **Drag analysis** panel plots your design's drag coefficient against Mach number — a static property of the geometry, no flight needed, recomputed live as you edit. Click **Show CD vs Mach** to open it. The charts pan and zoom like the flight plots: **drag a box** to zoom into it, **scroll the mouse wheel** to zoom about the cursor, **shift-drag** (or middle-button drag, or a one-finger horizontal drag on a touch screen) to pan, and **double-click** to reset — a hints line above the charts keeps those gestures on screen. Each chart's heading also carries two buttons: **↺** resets that chart to the full Mach range (it lights up once you've zoomed), and **⤢** expands the chart to a much taller canvas for reading fine structure — the transonic peak, the M1 CP shift — with **⤡** putting it back. Unlike the flight plots, the three drag charts zoom independently, so each heading resets and expands its own chart only.

- The main chart shows the **power-off** (coasting) drag curve. Give a stage a **nozzle exit diameter** (in the Stage property panel) and a dashed **power-on** curve appears: during the burn, the motor's exhaust plume pressurizes the base area, so boost drag is genuinely lower than coast drag. The bigger the nozzle exit relative to the base, the bigger the reduction — a minimum-diameter rocket sees a large difference, a small motor in a fat airframe almost none. For a clustered mount, enter one equivalent nozzle whose exit *area* is the sum of the individual exit areas. Zero (the default) means the two curves are identical.
- The **breakdown chart** splits the drag **by component** (nose, body, fins…) or **by type** (friction / pressure / base), so you can see *why* the rocket is draggy and where cleanup pays — the transonic drag rise starting near Mach 0.9 is plainly visible.
- A **CP-vs-Mach chart** shows the center of pressure across the whole Mach range — as **% of body length** (the wind-tunnel convention, the default) or, with the toggle beside the heading, in **your length unit from the nose**. With the supersonic model on, this is the chart to check before a fast flight: supersonic CP moves forward, and the accepted practice (RASAero's recommendation) is to keep **≥ 2 calibers** of margin through the transonic and supersonic regime.
- A **Conditions** selector says which air the sweep runs in. The default, **Sea level**, is what every drag curve here has always used and is almost always what you want. Pick **At altitude…** and type an altitude to run the whole sweep in the standard atmosphere at that height — thinner air means a lower Reynolds number and a slightly different skin-friction drag. This matters when you compare against someone else's published curve: wind-tunnel data is quoted at the tunnel's Reynolds number, and RASAero matches it with a **Mach-Alt table** (an altitude per Mach — for the NASA ARCAS tunnel runs, 25,000 ft at Mach 0.9 climbing to 122,500 ft at Mach 25). Comparing a sea-level curve against Re-matched tunnel data invents a disagreement that isn't there. If you opened a **RASAero .CDX1 that carries its own Mach-Alt table**, a third choice appears and sweeps at exactly the file's altitudes, so the two curves are finally answering the same question. The conditions in force are printed under the drag chart and stamped into the CSV.
- A Max-Mach selector (1–5 classic; up to **25** with the supersonic model) and a **⬇ Drag table (.csv)** export round it out. The CSV is a full **aerodynamic-coefficient table** (CD power-off/on, CP, CNα vs Mach) usable as input to external trajectory programs. It opens with `#`-comment lines naming the app version, the design, the **aero model that produced the table** and the **conditions it ran in** — so a curve shared onward can't be mistaken for the other model's, or for one computed in different air — and its CP column follows your length unit. With the classic model, values above roughly Mach 1.5 are Extended-Barrowman estimates and labeled approximate; with the **supersonic model** (Preferences → Aerodynamics) they are validated against NASA wind-tunnel data to ~Mach 4.6 and physically extrapolated to Mach 25.

---

<a id="motors"></a>

## Motors

With the airframe drawn, the next step is choosing a motor. The app bundles the full thrustcurve.org catalog metadata and downloads the actual thrust curves on demand.

## Flight configurations (.ork)

Desktop OpenRocket lets one design carry several **flight configurations** — "club field C6", "demo day D12" — each with its own motors and ignition settings. Those now travel. Opening a multi-configuration `.ork` loads **the file's own default configuration**, exactly as desktop OpenRocket does, and the import note names the one that loaded and says how many the file holds. A **Flight configurations** panel then appears here on Motors & Launch listing every one by its name — or by its motor set when it has none of its own, the way the desktop labels them. Apply any one with a click, switch freely, or pick **None** to fly the design clean; ⏏ Unload does the same from the vitals strip. Applying a configuration switches its motors, its ignition settings **and its recovery deployment**. Whatever you load stays loaded until you change or unload it. Your motor edits belong to the configuration you're flying, and **saving writes every configuration back** to the `.ork` with its names and ids intact — desktop OpenRocket sees them all, with the one you were flying marked default. Share links carry the whole set. (One limit: per-configuration **stage separation** overrides still come from the file's default configuration.)

## The database and browser

The app bundles metadata for about **1,129 thrustcurve.org motors** (designation, manufacturer, impulse class, diameter, length, average/max thrust, total impulse, burn time, loaded and propellant weight, delays, availability, propellant/case info, type). **Thrust curves are not bundled** — they download on demand the first time you pick a motor and cache in your browser. From a motor mount, click **Browse motor database** to open the browser; the header shows the source, date, and the mount's diameter.

Three filter rows sit above the table, each chip carrying its count: **Makers**, **Diameter** (only the diameters that fit this mount are offered at all), and **Class** — the impulse letter, so "just the H motors" is one click. Beside the search box, **only motors that fit** hides anything longer than the maximum motor length this stage states; when the rocket states none, the checkbox is disabled and says so, since there is nothing to filter against. **▸ All filters** unfolds the rest — a **burn-time window** and a **total-impulse window** (type a low bound, a high bound, or just one; the placeholders show what this mount's motors actually span), propellant, and *include out-of-production* — kept out of the way so the dialog opens as three rows and a search box. The windows are typed rather than dragged on purpose: the impulse range for a single mount covers three orders of magnitude, which no two-ended slider handles usefully. Every filter is remembered between sessions.

A motor longer than the stated maximum is flagged ⚠ in the table whether or not you filter it out, so you can still choose one deliberately. When a curve lacks CG data the kernel uses OpenRocket's model: mass drops from loaded to burnout weight in proportion to cumulative impulse, with CG fixed at half length.

## Filters

The browser gives you **manufacturer chips** (with live counts), **diameter-class chips**, an **include out-of-production** checkbox, and free-text search across the designation and common name. The results table (capped at 400 rows) sorts by designation, manufacturer, diameter, length, burn time, or total impulse (the default). Filters persist between sessions. Sorting the "Motor" column sorts by the cleaned-up *display* designation, so a Cesaroni motor like `381I224-15A` is shown and ordered as `I224-15A` rather than by its impulse-prefix digits, while the raw designation stays the file identity.

## Diameter-class fit (adapter-down)

The mount's inner diameter drives which classes appear. A mount fits **every class at or below its own** — smaller motors ride in adapters — but **never** a larger one. Motors too big are physically excluded from the list, not merely flagged. Note that **75 mm and 76 mm are the same class** (shown "75/76"), and diameters snap to the nearest common class within tolerance because tube IDs run oversize.

## Delays and the drill-to-fit rule

The prescribed delays from the motor's label are informational only. In the browser's **Delay** select you can choose Auto (optimal), any prescribed delay, or **Custom** and type a value; on the main Motors panel you can type **any whole-second delay** without reloading, or tick **auto (optimal)** on the sustainer. This is the drill-to-fit rule: real flyers drill an adjustable delay to whatever whole second they want, so the recommendation is `round(optimum)` and is **never snapped to the prescribed list**. One subtlety: the kernel's optimum delay is the coast from burnout to *ballistic* apogee (a deployment-free probe), and auto uses a two-pass approach — fly once, read the optimum, round it, and re-fly.

## Per-stage maximum motor length

Each **stage** has its own "Max motor length" — a booster and a sustainer have different room. Motors longer than the limit are flagged in the browser and excluded from batch simulation. This is separate from the diameter-fit rule; a motor can be the right diameter but too long.

## EX and custom motors, and built-in quick picks

You can **import experimental motors** from RASP `.eng` or RockSim `.rse` files — pick one or several files with **⬆ Import .eng/.rse**, or point **📁 Import EX folder** at the folder where you keep your motor files and every `.eng`/`.rse` inside is added in one go. They appear under an "EX" manufacturer (the real manufacturer name is preserved), persist in your browser between sessions, filter and simulate like any database motor, and — for `.rse` files with measured per-sample masses — use those masses instead of the impulse-proportional model. Curves are local; no network needed. Select an imported motor and press 🗑 to remove it. For instant offline use there are three **built-in quick picks** (A8-3, B6-4, C6-5) as full motor specs. When you import a design whose motor prefix-matches a built-in, the app loads the built-in curve but **keeps the file's ejection delay**, so a saved C6-7 doesn't silently become a C6-5.

---

<a id="launch-conditions"></a>

## Launch Conditions

Before you fly, the Launch Conditions panel (in the **Motors & Launch** workspace) sets the pad and the weather. It collects nine fields: **launch rod/rail length** (default 1 m), **rod angle** (0°, range −30…30°), **average wind**, **wind gust sigma** (standard deviation of gusts about the average), **site altitude** (0–10,000 m), **latitude** (default 28.61°, roughly Florida), **temperature** (blank = ISA standard), **pressure** (blank = ISA standard), and **time step** (blank = 0.05 s; see below). Values display in your preferred units and convert to SI on Launch. When temperature and pressure are blank the sim uses the ISA atmosphere (288.15 K, 101325 Pa, −6.5 K/km lapse).

### Time step — and why 0.05 s is the right answer

The **time step** is the largest stride the integrator may take between recalculating the flight. It is the one launch setting that changes how *long* a simulation takes rather than how the rocket flies, so it is worth understanding before you touch it.

**Leave it blank and you get 0.05 s** — the engine's default, and desktop OpenRocket's own recommended value. Almost every design file already asks for exactly that.

**It is a ceiling, not the step.** The simulator picks each step as the smallest of eight limits (see *How It Works → How a flight is simulated*): your setting is only one of them, and the others — maximum pitch-angle change, roll-rate change, launch-rod length — bind tighter wherever the flight is actually delicate. The simulator also shortens a step so it lands exactly on the next scheduled event, so staging, burnout and ejection are never straddled. That is why asking for a finer step buys much less than it seems.

**How much less: measured.** Four designs — including a Mach 2 minimum-diameter bird, a two-stage 38/54 mm, and a subsonic sport model — were each flown against a converged reference step of 0.002 s, using real published thrust curves. At 0.05 s:

| what you read | how far it moves at 0.05 s |
|---|---|
| Apogee | within **0.06 m on a 6.4 km flight** (exact to the centimetre on the 10.4 km two-stage) |
| Maximum velocity | ≤ 0.018 % |
| Maximum Mach | ≤ 0.025 % |
| Optimum ejection delay | ≤ 36 ms — never enough to change the recommended whole second |
| Ground-hit velocity | ≤ 0.004 % |
| **Simulation warnings** | **identical — not one appears or disappears** |

Going finer than 0.05 s does not improve any of those. The answer has already converged.

**What it costs.** Roughly, relative to 0.05 s:

| time step | flight takes |
|---|---|
| 0.04 s | 1.1–1.3× longer |
| 0.03 s | 1.5–1.7× longer |
| 0.02 s | 2.0–2.8× longer |
| 0.01 s | **3.7–6.0× longer** |

The simulation runs inside the browser tab, so while it runs the page cannot respond. On a large design a 0.01 s step is the difference between a wait and the browser offering to kill the page.

**If a file asks for something finer**, we fly it at 0.05 s and say so in the file-opened note. Nothing is hidden: the Time step field shows what we are actually using, and you can type the file's original value back in if you want to reproduce a desktop number exactly. Below 0.05 s the panel shows what it will cost — as a multiplier, and in seconds per flight once you have flown once.

**The one number that does move.** Launch-rod exit velocity reads up to about 1 m/s (≈3 %) *higher* at 0.05 s than at a converged step, because the rod phase lasts a fraction of a second. If you are checking a marginal rod-exit speed against the 15 m/s guidance, that is the one case where a finer step is worth the wait.

**Deterministic by design**: wind turbulence is seeded (default seed 42), so identical inputs always produce an identical flight. This is intentional and differs from the desktop's time-seeded randomness — re-running won't vary the result, and that is not a bug. (The physics behind the wind model and this determinism choice is covered in *How It Works*.)

Launch conditions also travel inside your `.ork` file (and in share links), so a design opened on another machine — or in the desktop app — flies with the same pad and weather you set here.

---

<a id="simulating-and-results"></a>

## Simulating and Reading Results

With a motor assigned and conditions set, press **Launch**. This section covers the single-flight run, the plots, the safety-graded report, saved runs, and batch simulation.

## Running a single flight

Assign a motor, set conditions, and press **Launch**. The app builds the flight options and simulates once; if the primary mount is on auto-delay it reads the kernel's optimum, rounds it, sets that delay, and re-flies. The primary mount is the topmost stage's mount that has a motor — it drives the lead columns and the auto-delay probe. Engine invariants: **RK4 with adaptive time step, Extended Barrowman aerodynamics, quaternion orientation, and a 6DOF→3DOF switch after recovery deployment.** (One automation caveat: the sim runs inside a requestAnimationFrame callback, which Chrome pauses in hidden tabs — a stuck "Simulating" means the window isn't visible.)

## The Fly screen (phones, at the field)

On a phone the app opens on **Fly** — a launch-centered home screen built for the flying field rather than the workbench: your rocket drawn beside the four numbers that matter at the pad (**apogee, optimum delay, descent rate, max velocity** from the latest flight), the stability verdict up top, a **motor row** that jumps to Motors & Launch to swap what you're flying, the three launch conditions that actually change at the field (**rod length, rod angle, wind**), a full-width **Launch** button, and a shortcut into batch compare for the "which of my motors flies this best today" question. The workspace tabs dock to the bottom of the screen, thumb-height; Design and Results stay one tap away. On a desktop the Fly tab is hidden — the vitals strip already serves that job there.

## Flight plots

Up to **eleven synchronized single-series panels**: Altitude, Velocity, Acceleration, Mass, Thrust, Drag force, Mach number, Stability margin (cal), CP location, CG location, and Angle of attack. A chip bar toggles panels (default: altitude/velocity/acceleration), and a series only appears if the kernel actually produced it. Following dataviz discipline, **different-scale measures are never dual-axed** — each gets its own panel and y-scale, with a fixed per-series color and theme-aware axes. Hover for synchronized crosshair readouts.

The block is headed **Flight plots**, and the two raw-data downloads sit in that heading, beside the plots they belong to: **⬇ Flight data (.csv)** and **⬇ Flight data + charts (.xlsx)**. Both re-fly the shown flight to capture every series the kernel records — the physics is deterministic, so it is the same flight with more columns, not a new one — and both stamp the design name into the filename.

The plots pan and zoom, and every gesture acts on **all panels together**: **drag a box** to zoom into it, **scroll the mouse wheel** to zoom about the cursor, **shift-drag** (or middle-button drag, or a one-finger horizontal drag on a touch screen) to pan, and **double-click** to reset to the full flight. You don't have to memorize any of that — a one-line **gesture hint** sits above the charts (it shows the touch gestures instead when you're on a touch screen), and next to it a **↺ Reset view** button brings every panel back to the full flight; it's grayed out until you've actually zoomed or panned, so it doubles as a "you are zoomed in" indicator. A zoom survives theme and unit changes; a new flight always opens at full width.

Too small to read? Every panel's heading has an **⤢ expand** button: the panel grows to the **full width of the charts area and a much taller canvas** (on wide screens the other panels reflow around it, so an expanded Altitude chart can sit above the ordinary-size rest). The expanded panel stays in the synced group — crosshairs, zooms and pans still track across all panels. Click **⤡** to restore it, and expand as many panels as you like.

## The launch report and safety checks

The report header shows the **optimal / recommended(available) / flown** delay, then a per-device **recovery table** (drogue and main each get a row: deploy time, altitude, opening velocity, settled descent rate, and a verdict). "Show all details" expands roughly thirty attributes: max altitude/velocity/Mach/acceleration, times to launch guide exit / burnout / apogee / landing, velocity and thrust:weight at launch guide exit, launch mass, and the angle of attack, CG, CP and static margin at launch guide exit — flight values at the moment the rocket leaves the guide, which is why the CP there sits forward of the Design tab's still-air CP whenever there is a crosswind — landing descent rate, plus the motor's diameter, manufacturer, type, propellant, and case.

Every flight is graded against these thresholds:

| Check | Threshold | Meaning |
|---|---|---|
| Lift-off speed | ≥ 15 m/s (~50 ft/s) | Enough airspeed leaving the guide to be stable |
| Thrust:weight | ≥ 5:1 | Adequate initial acceleration |
| Safe deployment | ≤ 21.34 m/s (70 ft/s) | Opening shock won't zipper the tube |
| Drogue descent | ≤ 21.34 m/s (70 ft/s) | Top of accepted drogue band |
| Landing rate | ≤ 6.1 m/s (20 ft/s) | Survivable ground hit |
| Static margin | 1.0–3.0 cal | Stable but not so over-stable it weathercocks |

The report also flags **weathercocking risk** and echoes the average wind, so an over-stable rocket in a stiff breeze reads as a warning rather than a silent number.

The physics kernel raises its own **simulation warnings**, and they appear as a distinct block near the top of the report — plain-language lines like "No recovery device — the rocket comes down ballistic" or "Recovery device opened at high speed", carrying the kernel's detail (the speed, the device name) where it has one. High-priority warnings are styled red like failed checks, and also banner across the top of the Results view right after a launch, so a ballistic flight can't be scrolled past; lower-priority ones (supersonic flight, geometry cautions) read as notes. The saved-runs CSV keeps the warning keys in a **Sim warnings** column.

"Show all details" also reports **landing drift**: the lateral distance from the pad at touchdown, with its compass bearing. The simulation's wind is a steady east wind, so a windy flight drifts downwind — due west — and the bearing says so. And when a design actually rolls, a **max roll rate** row appears in r/s (revolutions per second, the desktop's unit, with °/s alongside); rockets that don't roll suppress the row instead of showing integrator noise.

## Saved runs and CSV

Every flight is stored to a **run history** (up to 500 runs, surviving reloads). A typical flight-day flow is to fly many motors, compare the table, and download it with **⬇ Run table (.csv)** or **⬇ Run table (.xlsx)** — one row per saved run, summary numbers only, with the design name in the filename.

Run history stores each flight's **report**, not its raw time series, so the plots are a separate question. The flight you just flew keeps its plots even after you click around the saved-run table and come back. For any *other* stored run of the design currently on screen, a **📈 Charts** button appears in its row (and a **📈 Show charts** button on the run itself) which re-flies the design at that run's conditions and draws the plots — deterministic, so it reproduces that exact flight, and it does **not** add another row to the history. When the design, motor or conditions have moved on since a run was flown, the button is absent and the app says so rather than drawing a flight that isn't the one in the table.

For the raw numbers behind one flight, the Flight plots heading offers **⬇ Flight data (.csv)**: the full per-timestep recording of the shown flight — every series the kernel produced (time first, then the familiar dozen, then the symbol-keyed extras with self-describing headers like "Vz — Vertical velocity (m/s)"), in your preference units (each column header names its unit). Staged flights land in one file, each booster's columns prefixed with its stage name and carrying their own time column. Time series aren't stored with run history, so the app re-flies the shown flight to produce them — deterministically, so it is that flight and not a new one.

Beside it, **⬇ Flight data + charts (.xlsx)** exports the same data as a real spreadsheet: numbers as numbers (no more text-that-looks-like-a-number), a frozen filtered header row, and a live Excel chart tab for **every column it exports** — about 31 tabs on a full single-stage flight — built on the sheet's own cells, so editing the data updates the graph. The headline quantities get a tab each (altitude, velocity, acceleration, mass, thrust, drag force, Mach, stability margin, CP, CG, angle of attack); the coefficient, rate and position families share themed tabs; anything left over gets its own. Staged flights get one data sheet per stage, one series per stage on the headline tabs, and a per-stage tab for each themed family.

## Batch simulate

Batch mode flies **every motor that fits the mount** (after your manufacturer/class/OOP filters) through the current design at each motor's auto-optimal delay, then grades each flight against your acceptance criteria — minimum rod-exit velocity, minimum thrust:weight, and an apogee window. Results append to the run history and download as CSV. This is the motor-shopping tool: pick the airframe, pour in a manufacturer's whole catalog, and read off which motors hit your target altitude safely.

---

<a id="multi-stage-and-clusters"></a>

## Multi-Stage and Clustered Rockets

Once you are comfortable with single-stage flights, the same tools scale up to staged and clustered rockets.

## Staging and separation

Add stages as siblings under the rocket root; they flatten nose-to-tail into one chain for layout. A **lower** stage carries a **separation trigger**: its own ejection charge (the default), its own burnout, its own ignition, the upper stage's ignition, launch, apogee, altitude ascending/descending, or never — plus a separation delay. The top stage ignores separation (it separates *from* nothing). After a stage drops, the kernel simulates the separated piece's own flight, which the report can summarize.

## Ignition and the G80 rule

Each staged motor has an **ignition trigger**: Automatic (launch-stage motors at launch, upper motors on the lower stage's ejection charge — right for low and mid power), lower-stage burnout + delay (electronics), launch + delay (timer), lower-stage ejection charge + delay, or never. The critical default is the **G80 rule**: when you drop a **high-power** motor into the **sustainer** of a multi-stage rocket, the app defaults its ignition to *burnout + 1 s* (electronics-timed), because nobody lights a high-power sustainer directly off the booster's ejection charge. You can always override it.

## Booster recovery and clusters

Boosters get their own recovery gear and their own landing-rate verdict in the report — a chuteless high-power booster is called out. **Clusters** (see *Designing the Rocket → Motor mounts and clusters*) let one motor selection drive several tubes; thrust scales with the count and mass sits at the real pattern positions.

## Parallel (strap-on) boosters and pods

Serial stages stack nose-to-tail; a **parallel stage** rides alongside. Build one with the **Booster (parallel stage)** assembly (see *Designing the Rocket → Pods and parallel boosters*): it carries its own separation trigger and delay, its motor ignites by the same trigger rules as any staged motor, and after separation it descends on its **own tracked flight branch** with its own recovery verdict. A non-separating **pod set** simply adds its mass and drag for the whole flight. One planning note: batch motor simulation is disabled while a separating booster is present, just as for serial staging — the motor combinations multiply beyond what a single sweep can grade.

## Power-on drag, per stage

Each stage carries its own **nozzle exit diameter** (see *Visualizing the Design → Drag analysis*), so a booster and a sustainer each get the correct power-on drag reduction during their own burn — the sim picks power-on or power-off drag per stage, per time step, the same way RASAero II does. Leave it at zero and nothing changes.

---

<a id="files-and-formats"></a>

## Files, Units, and Offline Use

Finally, save your work, move it between tools, and set up the app for offline use.

## File formats

The app reads and writes several formats. What survives a round-trip depends on how much each format can represent:

| Format | Import | Export | Notes |
|---|---|---|---|
| **.ork** (OpenRocket) | Yes | Yes | Full fidelity — all 19 types, motors, materials, overrides, tabs, clusters, shoulders, staging, pods/boosters, nozzle exit diameters, launch conditions. Accepts zipped or bare XML; handles legacy ≤15.03 files. |
| **.rkt** (RockSim) | Yes | Yes | Up to **3 stages** (export throws beyond that). Uniquely keeps motor designations the desktop drops, so it auto-loads motors. Clusters split into individual tubes; spill holes unsupported. |
| **.CDX1** (RASAero II) | Yes | Yes | Aerodynamics only — **no mass or material data**. Walls default to a faked 2 mm and the importer warns you to "review masses before trusting the numbers." Motors round-trip: each engine-carrying `<Simulation>` imports as a flight configuration with the motor mounted on that stage's aft-most tube, and export writes each stage's motor back as a RASAero engine string — only for the manufacturers RASAero's own database documents, others are omitted rather than guessed. Strict export validation (≤3 stages, one fin set per tube, 3–8 fins, conical transitions only). |
| **.obj** (Wavefront) | — | Yes | External shell only — the meshes the 3D view renders. Meters, nose at x=0. Not guaranteed watertight; for print-preview/CAD reference. |
| **.svg** (fin template) | — | Yes | True-scale 1:1 cut template with calibration ruler (see *Visualizing the Design*). |
| **.dxf** (CNC/laser cut profile) | — | Yes | The same 1:1 flat profile as CAD geometry rather than a printable page — **AutoCAD R12 (AC1009) ASCII in millimetres**, which LightBurn, Carbide Create, Easel, Fusion 360's sketch import and essentially every cutter's own software read. Select a component and press **✂ DXF (CNC/laser, 1:1)** in its property panel: **one fin or one ring per file**, the fin as a single closed contour with the through-the-wall tab merged into it, rings/bulkheads/couplers as true circles CAM can bore. Cut geometry is on the **CUT** layer alone — **REFERENCE** (root chord, centre marks) and **TEXT** (the label block) are guides, so switch them off before cutting. As with the STL, the airfoil cross-section and fin cant are not represented. |
| **.csv / .xlsx** (component data) | — | Yes | Every component as one row — dimensions, material, shape, and the engine's computed mass/CG/position — in your preferred units. For sharing measurement data with people who don't run a simulator. |
| **.svg / .png / .jpg** (2D drawing & 3D snapshot) | — | Yes | The 2D side view with a data header (dimensions, mass, CG/CP, stability margin) via **⬇ SVG** (physical-mm size — prints at true 100 % scale) and **⬇ Image** (PNG or JPG at HD / 4K / 8K width). The 3D view's **📷 Image** button re-renders the scene at the chosen resolution — an 8K snapshot is genuinely 8K — with the same data header. Its **Fit rocket to frame** checkbox (ticked by default) moves the snapshot camera in so the rocket fills the exported frame at your current viewing angle; untick it to export the view exactly as framed on screen. These are the drawings L3 and Tripoli Class 3 documentation packets ask for. |
| **.glb** (glTF binary) | — | Yes | Modern 3D model *with your component colors as real materials* — opens directly in Windows 3D Viewer, PowerPoint, Blender, Fusion 360, and web viewers. Meters; nose at the origin, rocket along +X. |
| **.stl** (whole rocket / per component) | — | Yes | Two very different exports, both in **millimetres**. Save As / Export → whole-rocket *display shell* (reference only — not watertight). The real one: select a component and press **🖨 STL for printing** in its property panel — a *guaranteed-watertight solid* built for slicers: hollow nose cones and transitions with their shoulders and caps, single fins with the through-the-wall tab merged in, true-bore centering rings, bulkheads, and tubes. Fins print as flat prisms (airfoil shaping is left to sanding); verify fit before a long print. With a printer set in **Preferences → 3D printing**, the same button also measures the part against your build volume and splits it when it is too tall — see *Printing oversized parts on a 3D printer* below. |

**Flight results travel too, when they can be vouched for.** Saving a `.ork` writes each flight
configuration's *computed results* into the file, so opening it in desktop OpenRocket shows the
flight this app actually calculated rather than a table of blanks — apogee, max velocity, max
acceleration, time to apogee, flight time, optimum delay and the rest, exactly the columns
desktop's simulation table has. It is written **only** for a configuration whose design, motors
and launch conditions are unchanged since the run that produced those numbers; change a fin and
save again and that configuration goes back to *not simulated*, because the alternative — a
stale result sitting in desktop's table looking exactly like a fresh one — is the worst outcome
of the three. Only the summary travels: the per-timestep trace is not stored with run history,
so desktop will offer to re-run the simulation before it will plot it.

**Where the file goes.** On **Chrome and Edge**, the design formats under *Save As / Export* — `.ork`, `.rkt`, `.CDX1` and the component tables — open a real **Save As dialog**: the name is prefilled from the rocket's name and you can change it, and you choose the folder. (The three 3D exports — `.obj`, `.glb`, `.stl` — load their exporter on the click and so lose the browser's permission to open a dialog; they download, and the app names the file.) On **Firefox and Safari**, which have no such dialog available to a web app, the file goes to the browser's download folder under the rocket's name and the app tells you the exact filename it wrote. Either way the rocket's name is the default filename, and you edit that in **Design → Rocket name**. Saving never writes back over a file you opened — every save creates a new file.

The most important domain caveat is **RASAero has no mass data** — a `.CDX1` import gives you accurate geometry but placeholder masses, so treat its predicted altitudes as provisional until you add real materials and overrides. `.ork` is the only lossless format; use it as your working save.

## Sharing a design by link

**Save As / Export → 🔗 Copy share link** packs the whole design — components, materials, overrides, assigned motors, and the launch conditions — into the link itself, compressed into the part after the `#`. Paste it in a chat or an email; opening it loads the rocket straight into the recipient's browser, no account and no upload involved — the design never touches a server, because browsers don't send the `#` fragment anywhere. If the recipient already has a design open, the app asks before replacing it. Two caveats: motors named in the link load from the motor database on arrival, so an unusual motor may need re-picking when opened offline; and a very complex design makes a very long link, which some chat apps truncate — if a pasted link refuses to open, send the `.ork` file instead.

## Printing oversized parts on a 3D printer

Tell the app what printer you own — **Preferences → 3D printing** — by picking a preset (Bambu H2D, X1C/P1S/A1, A1 mini, Prusa MK4S, Prusa XL, Ender 3, K1 Max, Neptune 4 Plus) or typing a custom bed X/Y and maximum Z in your preferred units. 8 mm is kept clear at each end of every axis (brim and first layer at the bed, gantry clearance up top). The **joint clearance** — the gap per side between a spigot and its socket — defaults to 0.15 mm, an FDM-realistic slip fit sized for 30-minute epoxy; drop it toward 0.05 mm only if you glue with thin CA, which seizes in a wider gap.

With a printer set, the **🖨 STL** button measures the selected part against the build volume and says what it found before you click. A part that fits reports so — sometimes **leaned**: a slender part may fit in one piece tipped up to 30° off vertical, and the angle quoted is computed from that part's own steepest wall so nothing overhangs past the 45° a slicer can bridge unsupported. A part too tall changes the button to **🖨 STL for printing — N pieces** and exports a **zip** instead of one unprintable file: numbered segment STLs (`name-print-1of3.stl`, …) plus a README covering print orientation (base down, tip up, no supports — the layer lines end up across the joint, the direction an ejection charge loads it), gluing (30-minute epoxy, dry-fit every joint first), and the same-material shrinkage rule that decides whether the halves fit each other at all. At each cut the fore piece grows a tapered **spigot** that registers in the next piece's own bore, and the two flat faces meeting set the assembled length exactly — the segment lengths add up to the part, and cuts are placed clear of shoulders. Splitting is never silent: the piece count is in the button, in the file names, and in the README, and when the joints add real material (a thin-walled tube cut into many pieces) the note prices the extra filament and print time.

Some parts refuse to split, on purpose: a part wider than the usable bed (no axial cut makes it narrower), a plan needing more than 6 pieces (at that many joints, buy the tube), a wall too thin to key a spigot into, or a part whose only legal cut planes land in shoulder or end faces. A refusal still exports the whole part — a club printer or a friend's machine may be bigger — with the reason shown under the button. Fins are flat prisms and are never split. A split tube carrying a rail button or launch lug gets a note to draw an alignment line down the outside before gluing, because a round joint holds no clocking. And with no printer configured, nothing changes at all — the button behaves exactly as before, and a part too long to assume it fits anything just shows a hint to set your printer.

## Units and preferences

Open **Preferences** to switch between one-click **Metric** and **Imperial** presets, or set each quantity individually — length, motor dimensions, distance, mass, velocity, wind speed, acceleration, angle, density, temperature, and pressure. You also choose whether round parts are entered as **diameter or radius**, and how the **stability margin** reads everywhere in the app — **Calibers** (the traditional body-diameter margin, the default), **% of length**, or **Both**. The percentage is measured against the aerodynamic length of the airframe, exactly as desktop OpenRocket measures it; it is the figure that stays comparable between a stubby rocket and a very long one, where "two calibers" means quite different things. The same dialog sets the app's **Theme** — **Light**, **Dark**, or **Follow system** (which tracks your operating system's light/dark setting); this is what drives the theme-aware plot axes and the rest of the interface. Beside it sits **Daylight mode**, the launch-site setting: black on white at maximum contrast, with doubled borders, bolder small type, and darker, thicker chart lines, so a phone screen stays readable in direct sun. Daylight **overrides the theme** while it is on — in sunlight the polarity is the whole point, and a high-contrast dark screen is the right answer indoors and the wrong one on the field — and turning it off restores the theme you picked. The **Daylight** button in the header is the same switch. A **First-run tour** setting controls whether the six-step interface tour offers itself to a new visitor. Setting it to **Off** dismisses the tour straight away if it happens to be open, and keeps it from offering itself again; setting it back to **On** re-arms it, so it will introduce itself once more next time you load the app. Either way the **⟲ Tour** header button replays it on demand. A **3D printing** section holds your printer's build volume and joint clearance — what they do is covered in *Printing oversized parts on a 3D printer* above. An **Aerodynamics** section holds the four-way **Aerodynamics model** choice — **Rogers Modified Barrowman (Kbf)** (the default), **Classic Extended Barrowman** (exact desktop parity), **Auto** (a short probe decides the model, then the whole flight runs on it; re-checked after the flight in case the probe under-read), or **Supersonic** (the RASAero-class model at all speeds). This is the **durable** setting; the **Aero** selector in the vitals strip switches the model for the current session only, and while it is doing so this section says so and offers to go back. What they do and when to use them is covered in *How It Works*. Every saved simulation records which aero model produced it, and a flight that goes supersonic on the classic model raises an in-report alert so you know the better model exists. Because everything is stored in SI internally, **switching units never changes your design** — it only changes how the numbers are displayed and entered.

## Installing, offline, and saving your work

MMRocket Sim is a **PWA** — install it from the browser and it runs offline, since the physics kernel, the motor database metadata, and the preset catalog are all bundled locally. Only motor thrust curves fetch on demand, and once fetched they cache in your browser. Your work — the design tree, assigned motors, launch conditions, per-stage motor-length limits, run history, and motor filters — persists to local storage and survives reloads. If browser storage ever fills up, the app says so instead of losing work quietly: the saved-runs table shows what is actually stored, and a warning banner stays up while autosave cannot write, clearing itself once saving recovers. Autosaves also belong to the web address you saved them at — the same design opened at a different address, or inside a page embedding the app, starts fresh — so use Save As / Export → .ork to carry work between addresses. The app **header** carries **Open…**, **Undo**, and the **Save As / Export** menu (.ork, share link, and every format in the table above), alongside the **Guide**, **Feedback**, **Changelog** (the version badge), and **Preferences**; **New** sits atop the component tree in the Design workspace.

Beside the version badge sits the answer to *"am I on the current version?"* — **✓ Up to date** when the running build matches what is deployed, or **↻ v0.0NN available — Reload** when it does not, which reloads onto the new build. It checks once when the app loads and again whenever you click it, and it reads the deployed version directly rather than anything cached, so it is never fooled by the offline cache the app runs from. Offline it reads **Version unknown** and says so rather than guessing — it will never tell you that you are out of date when it simply could not ask. For a durable archive or to move a design to another machine or to the OpenRocket desktop, **Save as .ork** — it's the format that keeps everything.

Because the whole app is a self-contained static build, the same files can also be **embedded inside another web page** — for example a WordPress post — through an `<iframe>`. If you meet MMRocket Sim living inside someone else's site rather than at its own address, it is the identical app running the identical kernel, with the same design, motor, and simulation tools described in this guide.

---

<a id="how-it-works-physics"></a>

## How It Works: Physics & Math

MMRocket Sim does not approximate OpenRocket's physics — it runs it. The simulation engine is the real OpenRocket 24.12 physics kernel (the Java `info.openrocket.core` package), compiled to JavaScript with TeaVM and verified bit-for-bit against the desktop program by an automated differential test. Every number below comes from that kernel: when your browser reports an apogee, it ran the same code, in the same order, with the same rounding as the desktop app. This section explains what that code does so you can decide how far to trust it — and where its honest limits are.

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

**Optional: the Kbf body carryover (Rogers Modified Barrowman).** Classic Barrowman keeps the fins-in-presence-of-body factor above but drops its reciprocal — the lift the fins induce *on the body* near the fin root, the `K_B(W)` carryover of NACA Report 1307. Turning on **Preferences → Aerodynamics → Rogers Modified Barrowman (Kbf)** adds it back: slender-body theory makes the fin-plus-carryover total `(1 + τ)²` times the fin-alone value, so the added body load is `τ · (fin CNα)`, acting at the fin root quarter-chord. The result is a somewhat higher total CNα and a slightly **more aft CP** — a more conservative stability margin, matching the direction RASAero II's "Rogers Modified Barrowman" method reports. It is **on by default**; choosing **Classic Extended Barrowman** in the same selector is what turns it off, and that setting is exactly classic Barrowman, bit-for-bit.

Since v0.075 the Kbf model also **stops charging a sharp airfoil fin the blunt leading-edge drag** that classic Barrowman applies to every non-square cross-section. Classic treats an **Airfoil** fin's leading edge as a swept cylinder — a pressure-drag plateau of about 1.2 on the leading-edge frontal area, which neither decays with Mach nor belongs on a sharp section, and whose subsonic form climbs steeply approaching Mach 0.9. On a genuinely streamlined section the subsonic profile drag belongs in the skin-friction form factor (which already carries it) and the only pressure term is **supersonic wave drag**: thin-airfoil `K·4·(t/c)²/β`, swept by `cos²Γ`, referenced to fin planform area. That is what Kbf now computes, and it is the same treatment the Supersonic model has used since v0.045.

**This lowers drag on fast airfoil designs, substantially.** On the reference designs it is under 1 % below Mach 0.5, about 4–12 % at Mach 0.9, and 9–16 % at Mach 2 — and because drag compounds over a coast, apogee moves more than that. Only fins whose **cross-section is Airfoil** are affected; **Square** (the default) and **Rounded** fins, the **Classic Extended Barrowman** model, and any fin that names a specific **Supersonic airfoil** section are all unchanged, bit-for-bit. If you want the old behaviour on a particular design, set its fins' cross-section to **Rounded**, which is what the classic leading-edge term actually models.

**Roll.** Canted fins produce a roll-driving moment proportional to the cant angle, opposed by a **roll-damping moment** that grows with roll rate — so a canted rocket spins up toward a steady-state roll rate rather than accelerating forever.

**Drag build-up.** Total drag is assembled from four independent pieces:

```
CD = CD_friction + CD_pressure + CD_base + CD_override
```

- **Skin friction** comes from the Reynolds number and a skin-friction coefficient (laminar, turbulent or transitional), with corrections for surface roughness/finish, for compressibility near Mach 1, and a whole-rocket fineness-ratio correction `(1 + 1/(2·f_B))`.
- **Pressure drag** for nose cones is interpolated from wind-tunnel/free-flight data (the kernel embeds experimental curves for ogive, conical, ellipsoid, power, parabolic and Haack shapes from NASA TR-R-100), plus stagnation drag at any forward-facing area increase.
- **Base drag** on the blunt tail follows `CD_base = 0.12 + 0.13·M²` subsonic and `0.25/M` supersonic.
- **Power-on base drag**: while a stage's motor is thrusting, its exhaust plume pressurizes the base over the nozzle-exit footprint, so the kernel subtracts the nozzle-exit area from the drag-producing base area — boost drag is lower than coast drag by `CD_base · A_nozzle/A_ref`. This is driven by the per-stage **nozzle exit diameter** (0 = no reduction, the default) and mirrors RASAero II's power-on/power-off CD distinction; the power-on curve is visible in the Drag analysis panel.
- **Override** lets you pin a component's CD to a measured value.

The drag coefficient is finally resolved into an axial component using an angle-of-attack multiplier, and pitch/yaw **damping moments** (which resist the rocket "weather-vaning" too sharply, especially the apogee turnover) are subtracted from the aerodynamic moments.

## The optional supersonic aerodynamics model (beta)

Classic Extended Barrowman is honest only to roughly Mach 1.5: it freezes body CP at its Mach-1 value forever, uses half the theoretical supersonic fin lift, clamps wave-drag data flat past Mach 2–4, and lets boattails ignore Mach entirely. Turning on **Preferences → Aerodynamics → Supersonic aerodynamics** replaces those with a RASAero-class model built from the open literature:

- **Fin lift** at the proper 2D Busemann level with a finite-span correction, evaluated analytically to any Mach (no grid clamp), plus the exact **NACA Report 1307** body-fin interference split with an afterbody carryover factor. This raises fin lift ~25–35% even subsonic (the physics behind RASAero's "Rogers Modified Barrowman"), so CP and stability shift slightly on all flights while the option is on.
- **Body (nose) lift grows with Mach**, bracketed by exact Taylor–Maccoll cone theory, so the combined CP moves with Mach the way wind tunnels measure instead of racing forward.
- **Drag**: per-shape supersonic thickness wave drag for fins, supersonic boattail/reducer wave drag, nose wave drag with its physical high-Mach decay, a vacuum-limit cap on base drag, fin-body junction interference drag, and **Van Driest II** compressible skin friction above Mach 4.

The model is scored continuously against an automated validation harness of published measured data — NASA's ARCAS sounding-rocket wind-tunnel tests (Mach 0.6–4.63), the Army-Navy Basic Finner free-flight range data (Mach 1.05–4.5), and the AGARD HB-2 hypersonic standard model (to Mach 10). Supersonic CP matches the ARCAS tunnel within ±2% of body length through Mach 4.6 — including above Mach 3.5, where RASAero's own published prediction diverges from that same tunnel. Known honest limits: transonic **peak** drag (Mach 0.95–1.2) reads low against tunnel data (a regime every engineering method struggles with), and everything above Mach 10 is physically-shaped extrapolation.

**Choosing a model.** There are four choices, and they live in two places. **Rogers Kbf** (the default) and **Classic Extended Barrowman** are the two classic models — the second is bit-identical to desktop OpenRocket. **Supersonic** uses the validated model at all speeds. **Auto** is the practical setting for mixed fleets: a short probe run — it stops just after burnout, which is where peak Mach happens — decides which model the flight needs, and then the flight runs **once** on it. If the probe says the design will pass **Mach 0.9** (the transonic onset, where classic aero starts degrading), the *entire* flight uses the supersonic model. A probe can under-read, and it never sees the descent, so the finished flight is re-checked afterwards and re-flown on the supersonic model if its real peak crossed 0.9 — subsonic flights keep exact desktop parity, fast flights get the validated physics, and the design's displayed stability follows whichever model the flight used (an **M+** mark appears beside the selector once Auto has upgraded itself).

The **Aero** selector in the vitals strip switches the model from any workspace, and it is deliberately **for this session only** — trying the other model on a design should not quietly become what every future session flies. **Preferences → Aerodynamics** is the durable setting; while the strip is overriding it, the strip shows a **↺** to go back and Preferences says so and offers the same. Choosing a model in Preferences always wins, and clears the session override.

A model always applies to the **whole flight**, subsonic portions included, so switching shifts stability and apogee. Switching does **not** throw away the flight you are looking at — that would make comparing the two models impossible, which is the point of being able to switch them. Instead the Results tab says which model those numbers were flown on, and the strip's Apogee reading carries a ⚠, until you press Launch again. If you fly supersonic while on a classic model, the report warns you and offers a one-click re-fly on Auto. Every saved run records which model flew it.

## Mass, center of gravity and inertia

At every step the kernel computes the rocket's total **mass**, **center of gravity** and **moments of inertia** (longitudinal and rotational) by summing every component — walls, nose, fins, mounts, mass objects — from its geometry and material density, honoring any user overrides. The **motor** is then added as a separate rigid body: as propellant burns, both its mass and its own CG shift, read from the thrust curve's mass/CG data points, and the two bodies are combined. This is why your stability margin (the CP-to-CG gap, measured in calibers) changes continuously through the boost as propellant leaves the tail.

## Atmosphere — the International Standard Atmosphere

Air properties follow the **International Standard Atmosphere (ISA)**, with sea-level defaults of **288.15 K (15 °C)** and **101 325 Pa**, and a troposphere temperature **lapse rate of −6.5 K per km** up to 11 km. Above that the kernel models the full layered ISA profile: the isothermal tropopause to 20 km, the warming stratosphere, and so on up past 84 km.

Within each layer, pressure follows the **barometric formula**. For a layer with a non-zero lapse rate `L`:

```
p = p_b · (1 + (h − h_b)·L / T_b)^(−g / (L·R))
```

and the isothermal exponential form where the lapse rate is zero. Temperature is linear within a layer; density and speed of sound then come from the ideal-gas relations `ρ = p/(R·T)` and `a = √(γ·R·T)` with `γ = 1.4`. You can override the launch-site temperature and pressure, and the model rebuilds a consistent profile above you. One documented caveat carried straight from OpenRocket: above ~32 km the layered values drift from the exact standard by a few percent — irrelevant for essentially all hobby altitudes.

## Gravity and geodesy

Gravity uses a **WGS84 ellipsoid** model rather than a single constant. Sea-level gravity varies with latitude φ via the Somigliana formula:

```
g₀ = 9.7803267714 · (1 + 0.00193185138639·sin²φ) / √(1 − 0.00669437999013·sin²φ)
```

so it is weaker at the equator and stronger at the poles. An altitude correction `(R_earth / (R_earth + h))²` reduces it as the rocket climbs. When a launch latitude/longitude is supplied and geodetic computation is enabled, the kernel also adds the **Coriolis acceleration** from Earth's rotation. The altitude correction assumes a spherical Earth — the kernel's own comment notes this is a deliberately small approximation.

## Motor thrust-curve model

A motor is a table of measured samples: time, thrust, remaining mass and propellant CG, exactly as published in RASP/RSE thrust-curve files. At any simulation instant the kernel finds the bracketing samples and does **linear interpolation** between them (snapping to a sample when it lands within 0.1 ms of one). Instantaneous thrust, motor mass and motor CG are all read this way; total impulse and average thrust are derived from the same curve. There is no internal combustion model — the certified thrust curve *is* the input, which is exactly what you want for matching real motor performance.

## Wind, turbulence, and why our results are repeatable

Wind is modeled as **pink noise** around a mean speed. You set an average wind speed and a standard deviation (their ratio is the *turbulence intensity*); the kernel drives a two-pole pink-noise filter (spectral exponent α = 5/3, sampled every 0.05 s and linearly interpolated) to produce gusts with a realistic frequency content — more low-frequency wander than white noise. In this single-level model the wind blows in one horizontal direction and does not vary with altitude.

There is also a deliberately tiny random perturbation (±0.0005) added to the pitch and yaw moments each step, which prevents an unnaturally perfect, knife-edge-symmetric flight from never tipping over.

Here is the one intentional difference from the desktop. Desktop OpenRocket seeds these random streams from the wall clock, so two identical runs give slightly different gust histories. **MMRocket Sim seeds them deterministically** (a fixed seed, 42). Same design + same settings ⇒ **exactly the same flight, every time** — better for teaching, sharing and comparing, and it makes a clean before/after comparison of a design change possible. (For the same reason the engine also fixes a couple of internal iteration orders that the desktop leaves free to wander at the sub-rounding-error level. Physics results stay inside the desktop's own run-to-run envelope.)

---

<a id="feedback"></a>

## Feedback & Bug Reports

Found something broken, or want the app to do something it doesn't? Both are genuinely wanted — beta reports directly shape what gets built next. The **Feedback** button in the header offers every route, or use these links directly:

- **[Report a bug](https://github.com/mtnmanak/mountainmanrockets-feedback/issues/new?template=bug-report.yml)** — what you did, what you expected, what happened instead. The app version (next to the logo) and your browser help a lot; attaching the .ork file (zipped) makes most fixes far faster. Only attach designs you're comfortable sharing publicly.
- **[Request a feature](https://github.com/mtnmanak/mountainmanrockets-feedback/issues/new?template=feature-request.yml)** — describe the real task it would help with; the use case shapes the design more than the feature description does.
- **[Browse open issues](https://github.com/mtnmanak/mountainmanrockets-feedback/issues?q=is%3Aopen%20label%3Atool%3Ammrocket-sim)** — see what's already filed before adding a duplicate. The tracker covers mountainmanrockets.com and all of its online tools; a dropdown routes your report to the right one.
- **No GitHub account?** Email [admin@mountainmanrockets.com](mailto:admin@mountainmanrockets.com) and it gets filed for you — you don't need an account to *read* anything on the tracker.

The open-issues list is the real queue — anything filed there is logged, visible, and not forgotten.

---

<a id="limitations-and-references"></a>

## Assumptions, Limitations & References

The physics above is powerful, but every simulation makes modeling choices. Knowing them tells you exactly where to trust the numbers and where to add engineering margin.

## Assumptions and honest limitations

- **Speed regime.** Extended Barrowman is at its best **subsonic and through the transonic region**. Fins get a genuine supersonic treatment, but body CNα and CP above Mach 1 are assumed equal to their subsonic values, and the engine raises a *supersonic* warning past Mach 1.1. Treat high-supersonic stability numbers as indicative, not precise — the Drag analysis chart labels its values above ~Mach 1.5 as approximate for the same reason.
- **Small-angle / attached-flow aerodynamics.** The method assumes slender bodies and largely attached flow. A stall angle around 17.5° caps fin normal force, and the body-lift term is damped at very low speed near apogee to avoid an artifact. Extreme angles of attack are approximations.
- **Descent is a point mass.** Under parachute the rocket is 3DOF: drag (default Cd 0.8) and gravity only. Swinging, spilling, and canopy dynamics are not modeled, and **streamers** — especially at extreme length-to-width ratios — are represented by an effective drag area, not by true flexible-body aerodynamics.
- **Wind is horizontal and altitude-uniform** in the standard model; real wind shear and vertical gusts are not captured here.
- **Geodesy approximations.** The altitude gravity correction assumes a spherical Earth; the atmosphere drifts a few percent above ~32 km.
- **The thrust curve is trusted verbatim.** Motor-to-motor manufacturing variation, temperature effects on propellant, and off-axis thrust are outside the model.

None of these are bugs — they are the modeling choices of a mature, widely validated tool. Because you are running that tool's actual kernel, its accuracy *and* its limits are inherited exactly, and your results will match the OpenRocket desktop program.

## Licensing and source code

MMRocket Sim is **free software**, released under the **GNU General Public License, version 3 or later (GPL v3+)** — the same license as OpenRocket itself, which it inherits. You are free to use, study, share, and modify it under that license. Because the GPL requires that anyone running a distributed build be offered its corresponding source code, the app's header carries a **source (GPL)** link — titled *"This app is free software under the GPL v3 or later — source code for this build"* — that opens the public source repository. If you want to see exactly what the app does, that link is the front door.

## References & further reading

- **Barrowman, J. S., & Barrowman, J. A. (1966).** *The Practical Calculation of the Aerodynamic Characteristics of Slender Finned Vehicles.* (J. S. Barrowman, M.S. thesis, The Catholic University of America, 1967.) The origin of the center-of-pressure and normal-force method used here.
- **Niskanen, S. (2009, rev. 2013).** *Development of an Open Source model rocket simulation software* / *OpenRocket technical documentation.* The definitive derivation of OpenRocket's extended Barrowman aerodynamics, drag build-up, mass model and simulation loop. https://openrocket.info/documentation.html
- **Galejs, R. (2006).** *Wind instability — what Barrowman left out.* Sport Rocketry / online. Source of the body-lift extension applied to long airframes.
- **NASA (1963).** *Collection of Zero-Lift Drag Data on Bodies of Revolution from Free-Flight Investigations,* NASA TR-R-100 (NTRS 19630004995). Source of the nose-cone pressure-drag data tables.
- **Pitts, W. C., Nielsen, J. N., & Kaattari, G. E. (1957).** *Lift and Center of Pressure of Wing-Body-Tail Combinations at Subsonic, Transonic, and Supersonic Speeds,* NACA Report 1307. Source of the optional body-in-presence-of-fins (Kbf) interference factor.
- **Rogers, C. E., & Cooper, D. (2011).** *RASAero Aerodynamic Analysis and Flight Simulation Program.* Rogers Aeroscience. Documents the power-on/power-off drag distinction and the Rogers Modified Barrowman method that inspired those options here.
- **International Standard Atmosphere:** ISO 2533:1975; and the *U.S. Standard Atmosphere, 1976* (NOAA/NASA/USAF). Basis of the temperature, pressure and density model.
- **WGS84 / Somigliana gravity formula:** *Department of Defense World Geodetic System 1984,* NIMA TR8350.2. Basis of the latitude- and altitude-dependent gravity model.
- **Runge–Kutta integration:** Butcher, J. C., *Numerical Methods for Ordinary Differential Equations;* or Press et al., *Numerical Recipes,* ch. 16. The RK4 scheme used for the equations of motion.
- **OpenRocket project:** https://openrocket.info — source at https://github.com/openrocket/openrocket. Licensed under the **GNU General Public License v3.0-or-later**: https://www.gnu.org/licenses/gpl-3.0.html . MMRocket Sim inherits this license.
