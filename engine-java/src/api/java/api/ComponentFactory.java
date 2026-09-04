package api;

import java.util.List;
import java.util.Map;

import info.openrocket.core.material.Material;
import info.openrocket.core.rocketcomponent.BodyTube;
import info.openrocket.core.rocketcomponent.Bulkhead;
import info.openrocket.core.rocketcomponent.CenteringRing;
import info.openrocket.core.rocketcomponent.ClusterConfiguration;
import info.openrocket.core.rocketcomponent.DeploymentConfiguration;
import info.openrocket.core.rocketcomponent.EllipticalFinSet;
import info.openrocket.core.rocketcomponent.EngineBlock;
import info.openrocket.core.rocketcomponent.ExternalComponent;
import info.openrocket.core.rocketcomponent.FinSet;
import info.openrocket.core.rocketcomponent.FreeformFinSet;
import info.openrocket.core.rocketcomponent.InnerTube;
import info.openrocket.core.rocketcomponent.LaunchLug;
import info.openrocket.core.rocketcomponent.MassComponent;
import info.openrocket.core.rocketcomponent.NoseCone;
import info.openrocket.core.rocketcomponent.Parachute;
import info.openrocket.core.rocketcomponent.RailButton;
import info.openrocket.core.rocketcomponent.RecoveryDevice;
import info.openrocket.core.rocketcomponent.RocketComponent;
import info.openrocket.core.rocketcomponent.ShockCord;
import info.openrocket.core.rocketcomponent.Streamer;
import info.openrocket.core.rocketcomponent.StructuralComponent;
import info.openrocket.core.rocketcomponent.Transition;
import info.openrocket.core.rocketcomponent.TrapezoidFinSet;
import info.openrocket.core.rocketcomponent.TubeCoupler;
import info.openrocket.core.rocketcomponent.TubeFinSet;
import info.openrocket.core.rocketcomponent.AxialStage;
import info.openrocket.core.rocketcomponent.ComponentAssembly;
import info.openrocket.core.rocketcomponent.ParallelStage;
import info.openrocket.core.rocketcomponent.PodSet;
import info.openrocket.core.rocketcomponent.RingInstanceable;
import info.openrocket.core.rocketcomponent.position.AngleMethod;
import info.openrocket.core.rocketcomponent.position.AxialMethod;
import info.openrocket.core.rocketcomponent.position.RadiusMethod;
import info.openrocket.core.util.Coordinate;

import static api.JsonLite.bool;
import static api.JsonLite.dbl;
import static api.JsonLite.obj;
import static api.JsonLite.str;

/**
 * Builds carved RocketComponents from JSON tree nodes. Node shape:
 * { "type": "bodytube", "id": "body", "name": "...", ...typed params...,
 *   "position": {"method": "top|middle|bottom|absolute", "offset": 0.0},
 *   "density": 950, "children": [ ...nodes... ] }
 * All SI, radians. Unknown types throw — callers surface the message.
 */
final class ComponentFactory {

    private ComponentFactory() {}

    static RocketComponent create(Map<String, Object> node) {
        String type = str(node, "type", "");
        RocketComponent c;
        switch (type) {
            case "nosecone": {
                NoseCone nose = new NoseCone(
                        shapeOf(str(node, "shape", "ogive")),
                        dbl(node, "length", 0.07),
                        dbl(node, "aftRadius", 0.012));
                nose.setThickness(dbl(node, "thickness", 0.002));
                double shapeParam = dbl(node, "shapeParameter", Double.NaN);
                if (!Double.isNaN(shapeParam)) {
                    nose.setShapeParameter(shapeParam);
                }
                nose.setFilled(bool(node, "filled", false));
                // Nose cones use the AFT shoulder (into the tube behind them).
                double shR = dbl(node, "shoulderRadius", Double.NaN);
                if (!Double.isNaN(shR)) {
                    nose.setAftShoulderRadius(shR);
                }
                double shL = dbl(node, "shoulderLength", Double.NaN);
                if (!Double.isNaN(shL)) {
                    nose.setAftShoulderLength(shL);
                }
                double shT = dbl(node, "shoulderThickness", Double.NaN);
                if (!Double.isNaN(shT)) {
                    nose.setAftShoulderThickness(shT);
                }
                nose.setAftShoulderCapped(bool(node, "shoulderCapped", false));
                c = nose;
                break;
            }
            case "transition": {
                Transition t = new Transition();
                t.setShapeType(shapeOf(str(node, "shape", "conical")));
                // Shape parameter — the SAME Shape enum as the nose cone
                // (ogive 0..1 secant fraction, power 0..1 exponent, parabolic
                // 0..1 segment, haack 0..1/3; conical/ellipsoid ignore it).
                // Must follow setShapeType, which resets it to the default.
                double shapeParam = dbl(node, "shapeParameter", Double.NaN);
                if (!Double.isNaN(shapeParam)) {
                    t.setShapeParameter(shapeParam);
                }
                // Clipped vs full profile (ellipsoid/power/haack only —
                // Shape.isClippable(); nose cones are never clipped). Absent
                // keeps the kernel default: setShapeType resets clipped to
                // isClippable(), i.e. clipped, matching the desktop.
                Object clippedRaw = node.get("clipped");
                if (clippedRaw instanceof Boolean) {
                    t.setClipped((Boolean) clippedRaw);
                }
                t.setLength(dbl(node, "length", 0.05));
                double fore = dbl(node, "foreRadius", Double.NaN);
                if (Double.isNaN(fore)) {
                    t.setForeRadiusAutomatic(true);
                } else {
                    t.setForeRadius(fore);
                }
                double aft = dbl(node, "aftRadius", Double.NaN);
                if (Double.isNaN(aft)) {
                    t.setAftRadiusAutomatic(true);
                } else {
                    t.setAftRadius(aft);
                }
                t.setThickness(dbl(node, "thickness", 0.002));
                t.setFilled(bool(node, "filled", false));
                double fShR = dbl(node, "foreShoulderRadius", Double.NaN);
                if (!Double.isNaN(fShR)) {
                    t.setForeShoulderRadius(fShR);
                }
                double fShL = dbl(node, "foreShoulderLength", Double.NaN);
                if (!Double.isNaN(fShL)) {
                    t.setForeShoulderLength(fShL);
                }
                double aShR = dbl(node, "aftShoulderRadius", Double.NaN);
                if (!Double.isNaN(aShR)) {
                    t.setAftShoulderRadius(aShR);
                }
                double aShL = dbl(node, "aftShoulderLength", Double.NaN);
                if (!Double.isNaN(aShL)) {
                    t.setAftShoulderLength(aShL);
                }
                // A CAPPED shoulder is closed off by a disc of the component's
                // own material, so it is mass, not just geometry. The nose-cone
                // branch above has always called this (line ~86); the transition
                // branch did not, so both flags round-tripped through the file
                // and were then dropped on the way to the kernel. Absent keeps
                // the kernel default (false), so nothing already built moves.
                t.setForeShoulderCapped(bool(node, "foreShoulderCapped", false));
                t.setAftShoulderCapped(bool(node, "aftShoulderCapped", false));
                c = t;
                break;
            }
            case "bodytube": {
                BodyTube bodyTube = new BodyTube(
                        dbl(node, "length", 0.3),
                        dbl(node, "outerRadius", 0.012),
                        dbl(node, "thickness", 0.0003));
                // Min-diameter rockets: the body tube itself is the motor mount
                // (kernel BodyTube implements MotorMount, same as the desktop).
                bodyTube.setMotorMount(bool(node, "motorMount", false));
                // Motor overhang (m): protrusion past the mount's aft end —
                // standard min-diameter practice (~6 mm); shifts the motor mass.
                bodyTube.setMotorOverhang(dbl(node, "motorOverhang", 0));
                c = bodyTube;
                break;
            }
            case "trapezoidfinset": {
                TrapezoidFinSet fins = new TrapezoidFinSet(
                        (int) dbl(node, "finCount", 3),
                        dbl(node, "rootChord", 0.05),
                        dbl(node, "tipChord", 0.03),
                        dbl(node, "sweep", 0.02),
                        dbl(node, "height", 0.03));
                fins.setThickness(dbl(node, "thickness", 0.003));
                fins.setCantAngle(dbl(node, "cant", 0));
                fins.setCrossSection(crossSectionOf(str(node, "crossSection", "square")));
                c = fins;
                break;
            }
            case "ellipticalfinset": {
                EllipticalFinSet fins = new EllipticalFinSet();
                fins.setFinCount((int) dbl(node, "finCount", 3));
                fins.setLength(dbl(node, "rootChord", 0.05));
                fins.setHeight(dbl(node, "height", 0.03));
                fins.setThickness(dbl(node, "thickness", 0.003));
                fins.setCantAngle(dbl(node, "cant", 0));
                fins.setCrossSection(crossSectionOf(str(node, "crossSection", "square")));
                c = fins;
                break;
            }
            case "freeformfinset": {
                FreeformFinSet fins = new FreeformFinSet();
                fins.setFinCount((int) dbl(node, "finCount", 3));
                fins.setThickness(dbl(node, "thickness", 0.003));
                fins.setCantAngle(dbl(node, "cant", 0));
                fins.setCrossSection(crossSectionOf(str(node, "crossSection", "square")));
                Object rawPoints = node.get("points");
                if (rawPoints instanceof List) {
                    List<?> list = (List<?>) rawPoints;
                    Coordinate[] pts = new Coordinate[list.size()];
                    for (int i = 0; i < list.size(); i++) {
                        Object row = list.get(i);
                        if (!(row instanceof List) || ((List<?>) row).size() < 2
                                || !(((List<?>) row).get(0) instanceof Double)
                                || !(((List<?>) row).get(1) instanceof Double)) {
                            throw new IllegalArgumentException(
                                    "freeformfinset points must be [[x,y],...] numbers");
                        }
                        pts[i] = new Coordinate(
                                (Double) ((List<?>) row).get(0),
                                (Double) ((List<?>) row).get(1), 0);
                    }
                    if (pts.length < 3) {
                        throw new IllegalArgumentException(
                                "freeformfinset needs at least 3 points");
                    }
                    fins.setPoints(pts);
                }
                c = fins;
                break;
            }
            case "tubefinset": {
                TubeFinSet fins = new TubeFinSet();
                fins.setFinCount((int) dbl(node, "finCount", 6));
                fins.setLength(dbl(node, "length", 0.1));
                double or = dbl(node, "outerRadius", Double.NaN);
                if (!Double.isNaN(or)) {
                    fins.setOuterRadius(or);
                }
                // TubeFinSet is not a FinSet — rotation applies here directly.
                double tubeRot = dbl(node, "rotation", 0);
                if (tubeRot != 0) {
                    fins.setBaseRotation(tubeRot);
                }
                // Wall thickness is NOT set here. It is applied post-attach by
                // applyTubeFinThickness: setThickness clamps to getOuterRadius()
                // (TubeFinSet.java:200), which is 0 for an auto-radius set that
                // has no parent yet, so a call here would pin the wall to zero
                // on the app's OWN default set. See that method's comment.
                c = fins;
                break;
            }
            case "innertube": {
                InnerTube tube = new InnerTube();
                tube.setLength(dbl(node, "length", 0.07));
                tube.setOuterRadius(dbl(node, "outerRadius", 0.0095));
                // Wall thickness is NOT set here — see applyPostAttachDimensions.
                // An inner tube's outer radius is ALWAYS explicit (the line
                // above), so its clamp was already real and moving the call is
                // provably mass-neutral today. It moves anyway so that every
                // ring wall in the bridge is set in ONE place, and the next
                // reader does not have to re-derive which of them happens to be
                // safe pre-attach.
                tube.setMotorMount(bool(node, "motorMount", false));
                tube.setMotorOverhang(dbl(node, "motorOverhang", 0));
                // Radial placement off the centreline. The 2D aft view, the 3D
                // view and both file writers have carried these two since
                // v0.087, but the bridge never set them - so a mount deliberately
                // offset in the drawing flew on the axis, and its mass and
                // inertia were computed there. The 0 default is the kernel's own,
                // so a design that never set them is bit-identical.
                tube.setRadialPosition(dbl(node, "radialPosition", 0));
                tube.setRadialDirection(dbl(node, "radialDirection", 0));
                // Cluster: pattern by its .ork XML name ("3-ring", "double"…).
                // One motor definition serves the whole cluster — the kernel
                // multiplies thrust by tube count and places mass/inertia at
                // the cluster geometry points. Rotation is radians (SI/rad
                // everywhere inside; degrees exist only at UI/.ork edges).
                String clusterName = str(node, "cluster", null);
                if (clusterName != null && !clusterName.isEmpty()) {
                    ClusterConfiguration cc = null;
                    for (ClusterConfiguration known : ClusterConfiguration.CONFIGURATIONS) {
                        if (known.getXMLName().equals(clusterName)) {
                            cc = known;
                            break;
                        }
                    }
                    if (cc == null) {
                        throw new IllegalArgumentException("Unknown cluster configuration: " + clusterName);
                    }
                    tube.setClusterConfiguration(cc);
                    tube.setClusterScale(dbl(node, "clusterScale", 1.0));
                    tube.setClusterRotation(dbl(node, "clusterRotation", 0.0));
                }
                c = tube;
                break;
            }
            case "tubecoupler": {
                TubeCoupler tc = new TubeCoupler();
                tc.setLength(dbl(node, "length", 0.05));
                double or = dbl(node, "outerRadius", Double.NaN);
                if (Double.isNaN(or)) {
                    tc.setOuterRadiusAutomatic(true);
                } else {
                    tc.setOuterRadius(or);
                }
                // Wall thickness is NOT set here — see applyPostAttachDimensions.
                // With the automatic radius above, getOuterRadius() falls through
                // to the raw 0 field until the coupler has a RadialParent
                // (ThicknessRingComponent.java:40-51), and setThickness clamps to
                // it (:82-100), so a call here wrote thickness 0 and every
                // automatic-radius coupler weighed exactly nothing. Measured on
                // the shipped kernel: 0.0000 g against 7.1298 g for the same
                // 50 mm x 1.5 mm coupler given an explicit 23 mm outer radius.
                c = tc;
                break;
            }
            case "centeringring": {
                CenteringRing ring = new CenteringRing();
                ring.setLength(dbl(node, "length", 0.002));
                // BOTH radii are set post-attach by applyPostAttachDimensions,
                // and the centering ring is the ONE ring type whose OUTER radius
                // has to move as well. RadiusRingComponent.setOuterRadius:66
                // clamps against getInnerRadius(), and CenteringRing overrides
                // that to walk the parent's children for a sibling InnerTube
                // (CenteringRing.java:22-48, guarded on getParent() != null at
                // :27) — parentless it returns 0, so the clamp desktop would
                // apply can never fire. setInnerRadius:81-102 has the mirror
                // fault: :95 freezes an automatic outer radius AT the inner
                // radius, which measured 0.0000 g against 2.8119 g for the same
                // ring given an explicit outer radius.
                c = ring;
                break;
            }
            case "bulkhead": {
                Bulkhead b = new Bulkhead();
                b.setLength(dbl(node, "length", 0.002));
                double or = dbl(node, "outerRadius", Double.NaN);
                if (!Double.isNaN(or)) {
                    b.setOuterRadius(or);
                }
                c = b;
                break;
            }
            case "engineblock": {
                EngineBlock eb = new EngineBlock();
                eb.setLength(dbl(node, "length", 0.005));
                double or = dbl(node, "outerRadius", Double.NaN);
                if (!Double.isNaN(or)) {
                    eb.setOuterRadius(or);
                }
                // Wall thickness is NOT set here — see applyPostAttachDimensions.
                // EngineBlock's constructor sets the automatic radius itself
                // (EngineBlock.java:13-20), so an engine block that states no
                // outer radius — which is EVERY engine block the app's own UI
                // can produce, and every one a .rkt import makes — hit the same
                // clamp-to-zero as the coupler above and weighed 0 g.
                c = eb;
                break;
            }
            case "launchlug": {
                LaunchLug lug = new LaunchLug();
                lug.setLength(dbl(node, "length", 0.05));
                lug.setOuterRadius(dbl(node, "outerRadius", 0.0022));
                lug.setThickness(dbl(node, "thickness", 0.0003));
                applyMountAngle(lug, node);
                applyLineInstances(lug, node);
                c = lug;
                break;
            }
            case "railbutton": {
                // ALL SIX DIMENSIONS, in DESKTOP'S OWN ORDER. Until v0.103 only
                // outerDiameter crossed this bridge, so every rail button in
                // every design flew and weighed as the constructor's generic
                // 9.7 mm part (RailButton.java:58-64) whatever the file said —
                // and total height is in the drag twice over
                // (RailButtonCalc.java:57-60 sizes the reference area, :85-92
                // compares it against the boundary-layer thickness), so the
                // error is superlinear. Measured on the ARCAS-short fixture,
                // 2 buttons, whole-rocket CD at M0.3: 0.003099 at 6 mm,
                // 0.012523 at the 9.7 mm default, 0.040118 at 15 mm.
                //
                // THE ORDER IS LOAD-BEARING — every setter clamps against the
                // others, so replaying desktop's XML document order is what
                // makes our clamping bit-identical to its:
                //   setOuterDiameter re-runs setInnerDiameter(this.innerDiameter_m)
                //     and can therefore SHRINK the ID (RailButton.java:196-205,
                //     :177-186) — a 4.19 mm RB-Micro collapses the default 8 mm
                //     waist to 4.19 and zeroes the notch term;
                //   setTotalHeight floors at getMinTotalHeight() = base + flange
                //     (:147-158, :168-170);
                //   setBaseHeight ceilings at totalHeight - flange (:121-132);
                //   setFlangeHeight ceilings at totalHeight - base (:134-145).
                // That inherits desktop's quirk too — a button under 4 mm tall
                // imported before its base and flange come down is floored at
                // 4 mm. Do NOT "improve" it; parity ruling.
                //
                // GUARDED ON KEY PRESENCE, exactly as applyLineInstances is
                // (see its comment below): a node carrying no geometry keys —
                // an old localStorage design, or the protuberance carrier
                // synthesised at treeModel.ts engineTree — must stay
                // bit-identical to the pre-v0.103 kernel, which is the
                // constructor's own values.
                RailButton rb = new RailButton();
                double od = dbl(node, "outerDiameter", Double.NaN);
                if (!Double.isNaN(od)) {
                    rb.setOuterDiameter(od);
                }
                double id = dbl(node, "innerDiameter", Double.NaN);
                if (!Double.isNaN(id)) {
                    rb.setInnerDiameter(id);
                }
                double th = dbl(node, "totalHeight", Double.NaN);
                if (!Double.isNaN(th)) {
                    rb.setTotalHeight(th);
                }
                double bh = dbl(node, "baseHeight", Double.NaN);
                if (!Double.isNaN(bh)) {
                    rb.setBaseHeight(bh);
                }
                double fh = dbl(node, "flangeHeight", Double.NaN);
                if (!Double.isNaN(fh)) {
                    rb.setFlangeHeight(fh);
                }
                // Screw head: mass only. It is in getComponentVolume
                // (RailButton.java:301-308) and in no drag term at all.
                double sh = dbl(node, "screwHeight", Double.NaN);
                if (!Double.isNaN(sh)) {
                    rb.setScrewHeight(sh);
                }
                applyMountAngle(rb, node);
                applyLineInstances(rb, node);
                c = rb;
                break;
            }
            case "parachute": {
                Parachute p = new Parachute();
                p.setDiameter(dbl(node, "diameter", 0.3));
                double cd = dbl(node, "cd", Double.NaN);
                if (!Double.isNaN(cd)) {
                    p.setCD(cd);
                }
                p.setLineCount((int) dbl(node, "lineCount", 6));
                p.setLineLength(dbl(node, "lineLength", 0.3));
                double chuteSurf = dbl(node, "surfaceDensity", Double.NaN);
                if (!Double.isNaN(chuteSurf)) {
                    p.setMaterial(Material.newMaterial(Material.Type.SURFACE,
                            str(node, "surfaceMaterialName", "custom"), chuteSurf, true));
                }
                double chuteLine = dbl(node, "lineDensity", Double.NaN);
                if (!Double.isNaN(chuteLine)) {
                    p.setLineMaterial(Material.newMaterial(Material.Type.LINE,
                            str(node, "lineMaterialName", "custom"), chuteLine, true));
                }
                applyDeployment(p, node);
                c = p;
                break;
            }
            case "streamer": {
                Streamer s = new Streamer();
                s.setStripLength(dbl(node, "stripLength", 0.5));
                s.setStripWidth(dbl(node, "stripWidth", 0.05));
                double cd = dbl(node, "cd", Double.NaN);
                if (!Double.isNaN(cd)) {
                    s.setCD(cd);
                }
                double streamerSurf = dbl(node, "surfaceDensity", Double.NaN);
                if (!Double.isNaN(streamerSurf)) {
                    s.setMaterial(Material.newMaterial(Material.Type.SURFACE,
                            str(node, "surfaceMaterialName", "custom"), streamerSurf, true));
                }
                applyDeployment(s, node);
                c = s;
                break;
            }
            case "shockcord": {
                ShockCord sc = new ShockCord();
                sc.setCordLength(dbl(node, "cordLength", 0.3));
                double cordLine = dbl(node, "lineDensity", Double.NaN);
                if (!Double.isNaN(cordLine)) {
                    sc.setMaterial(Material.newMaterial(Material.Type.LINE,
                            str(node, "lineMaterialName", "custom"), cordLine, true));
                }
                c = sc;
                break;
            }
            case "masscomponent": {
                MassComponent m = new MassComponent();
                m.setComponentMass(dbl(node, "mass", 0.01));
                m.setLength(dbl(node, "length", 0.02));
                m.setRadius(dbl(node, "radius", 0.005));
                // Same fact as the inner tube above: MassObject carries a radial
                // offset and direction, the file and the drawings keep them, and
                // the bridge dropped them - so a nose weight taped to one side
                // was flown on the axis. 0 is the kernel's own default.
                m.setRadialPosition(dbl(node, "radialPosition", 0));
                m.setRadialDirection(dbl(node, "radialDirection", 0));
                c = m;
                break;
            }
            case "podset": {
                // Off-axis pod (non-separating). Geometry is applied post-attach
                // (applyAssembly) — the setters NPE without a parent.
                c = new PodSet();
                break;
            }
            case "parallelstage": {
                // Strap-on booster: a ParallelStage IS an AxialStage, so it
                // separates and flies its own branch. Config applied post-attach.
                c = new ParallelStage();
                break;
            }
            default:
                throw new IllegalArgumentException("Unknown component type: '" + type + "'");
        }

        // ---- common parameters ----
        String name = str(node, "name", null);
        if (name != null) {
            c.setName(name);
        }
        double density = dbl(node, "density", Double.NaN);
        if (!Double.isNaN(density) && density > 0) {
            Material m = Material.newMaterial(Material.Type.BULK,
                    str(node, "materialName", "custom"), density, true);
            if (c instanceof ExternalComponent) {
                ((ExternalComponent) c).setMaterial(m);
            } else if (c instanceof StructuralComponent) {
                ((StructuralComponent) c).setMaterial(m);
            }
        }
        String finish = str(node, "finish", null);
        if (finish != null && c instanceof ExternalComponent) {
            ((ExternalComponent) c).setFinish(finishOf(finish));
        }
        // RASAero feature #4: fin airfoil cross-sections + LE bluntness radius.
        // Absent keys keep the classic 3-value crossSection behavior.
        if (c instanceof FinSet) {
            FinSet fs = (FinSet) c;
            // Fin-set rotation about the body axis (radians; issue
            // 2026-08-05d: interleaving straight fins between tube fins).
            double rot = dbl(node, "rotation", 0);
            if (rot != 0) {
                fs.setBaseRotation(rot);
            }
            String section = str(node, "airfoilSection", null);
            if (section != null) {
                String s = section.toLowerCase();
                // Validate here so a bad name fails the build with a clear
                // message instead of an UnsupportedOperationException from
                // FinSetCalc mid-simulation.
                switch (s) {
                    case "hexagonal":
                    case "naca":
                    case "doublewedge":
                    case "biconvex":
                    case "hexbluntbase":
                    case "singlewedge":
                        break;
                    default:
                        throw new IllegalArgumentException(
                                "Unknown airfoilSection '" + section + "'");
                }
                fs.setAirfoilSection(s);
            }
            fs.setAirfoilLeDiamond(dbl(node, "airfoilLeDiamond", 0));
            fs.setAirfoilTeDiamond(dbl(node, "airfoilTeDiamond", 0));
            fs.setFinLeRadius(dbl(node, "finLeRadius", 0));
            // Fillet epoxy. The .ork reader has always KEPT <filletradius> and
            // <filletmaterial>, and desktop counts the fillet volume toward fin
            // mass (FinSet.calculateFilletVolume), but nothing bridged it here —
            // so every filleted design flew light, and the app said so in an
            // import note rather than fixing it. Three fins with a 9.5 mm radius
            // on a 40 mm body is ~25 g of epoxy sitting at the tail, which moves
            // the CG as well as the mass. The volume calculation guards on a null
            // parent, so setting it before the component is attached is safe.
            double filletRadius = dbl(node, "filletRadius", 0);
            if (filletRadius > 0) {
                fs.setFilletRadius(filletRadius);
                double filletDensity = dbl(node, "filletDensity", Double.NaN);
                if (!Double.isNaN(filletDensity) && filletDensity > 0) {
                    fs.setFilletMaterial(Material.newMaterial(Material.Type.BULK,
                            str(node, "filletMaterialName", "custom"), filletDensity, true));
                }
            }
        }
        applyOverrides(c, node);
        Map<String, Object> position = obj(node, "position");
        // Off-axis assemblies (PodSet/ParallelStage) have no parent here yet, and
        // their setAxialMethod NPEs without one — their position is applied
        // post-attach in applyAssembly. Every other component positions here.
        if (position != null && !(c instanceof ComponentAssembly)) {
            c.setAxialMethod(axialMethodOf(str(position, "method", "top")));
            c.setAxialOffset(dbl(position, "offset", 0));
        }
        return c;
    }

    /**
     * Mass / CG / CD overrides, plus the "applies to all subcomponents" flags
     * (desktop .ork {@code <overridemass>} / {@code <overridesubcomponents*>}).
     * An absent key means "not overridden".
     *
     * <p>Package-private and separate from {@link #create} because a STAGE is
     * built directly by {@code OrkEngine.buildTree} rather than through the
     * factory switch, and that path never applied overrides — so a whole-stage
     * Cd or mass override typed in the app did nothing at all. (The app's .ork
     * layer had the same blind spot on both sides, fixed separately; see
     * orkFile.ts readOverrides.) The kernel itself always handled them:
     * MassCalculation honours {@code isMassOverridden} for a non-massive
     * assembly, and BarrowmanCalculator.calculateOverrideCD explicitly includes
     * {@code ComponentAssembly}.
     */
    static void applyOverrides(RocketComponent c, Map<String, Object> node) {
        double overrideMass = dbl(node, "overrideMass", Double.NaN);
        if (!Double.isNaN(overrideMass)) {
            c.setOverrideMass(overrideMass);
            c.setMassOverridden(true);
        }
        double overrideCGX = dbl(node, "overrideCGX", Double.NaN);
        if (!Double.isNaN(overrideCGX)) {
            c.setOverrideCGX(overrideCGX);
            c.setCGOverridden(true);
        }
        double overrideCD = dbl(node, "overrideCD", Double.NaN);
        if (!Double.isNaN(overrideCD)) {
            c.setOverrideCD(overrideCD);
            c.setCDOverridden(true);
        }
        // Body-proportional CD override (MMRocket Sim; see
        // engine-java/patches/LEDGER.md and RocketComponent.overrideCDBodyRatio).
        // The override stops being a frozen scalar and becomes a fraction of the
        // rocket BODY's own CD, re-evaluated at every Mach —
        // BarrowmanCalculator.calculateOverrideCD. `overrideCD` above stays the
        // Mach-0.3 fallback and is the number the app's property panel quotes.
        //
        // THESE TWO KEYS ARE SYNTHESIZED ONLY BY THE APP'S engineTree, for the two
        // STREAMLINED protuberance classes. The `.ork` <overridecd> path
        // (orkFile.ts readOverrides) must never set them, so every user-typed CD
        // override and every desktop file stays Mach-flat and desktop-parity is
        // untouched. An absent key leaves the field at NaN, which is the plain
        // scalar behaviour.
        double bodyRatio = dbl(node, "overrideCDBodyRatio", Double.NaN);
        if (!Double.isNaN(bodyRatio)) {
            c.setOverrideCDBodyRatio(bodyRatio);
            c.setOverrideCDBodyIncludesBase(bool(node, "overrideCDBodyIncludesBase", true));
        }
        // The override REPLACES the whole subtree's computed value rather than
        // adding to this component's own.
        if (bool(node, "overrideSubcomponentsMass", false)) {
            c.setSubcomponentsOverriddenMass(true);
        }
        if (bool(node, "overrideSubcomponentsCG", false)) {
            c.setSubcomponentsOverriddenCG(true);
        }
        if (bool(node, "overrideSubcomponentsCD", false)) {
            c.setSubcomponentsOverriddenCD(true);
        }
    }

    /**
     * Deployment settings for recovery devices, applied to the DEFAULT
     * deployment configuration (inherited by every flight configuration).
     * Keys: deployEvent (launch|ejection|apogee|altitude|never),
     * deployAltitude (m AGL, for "altitude"), deployDelay (s).
     */
    private static void applyDeployment(RecoveryDevice device, Map<String, Object> node) {
        DeploymentConfiguration config = device.getDeploymentConfigurations().getDefault();
        String event = str(node, "deployEvent", null);
        if (event != null) {
            config.setDeployEvent(deployEventOf(event));
        }
        double altitude = dbl(node, "deployAltitude", Double.NaN);
        if (!Double.isNaN(altitude)) {
            config.setDeployAltitude(altitude);
        }
        double delay = dbl(node, "deployDelay", Double.NaN);
        if (!Double.isNaN(delay)) {
            config.setDeployDelay(delay);
        }
    }

    private static DeploymentConfiguration.DeployEvent deployEventOf(String name) {
        switch (name.toLowerCase()) {
            case "launch": return DeploymentConfiguration.DeployEvent.LAUNCH;
            case "apogee": return DeploymentConfiguration.DeployEvent.APOGEE;
            case "altitude": return DeploymentConfiguration.DeployEvent.ALTITUDE;
            case "never": return DeploymentConfiguration.DeployEvent.NEVER;
            case "ejection":
            default: return DeploymentConfiguration.DeployEvent.EJECTION;
        }
    }

    private static ExternalComponent.Finish finishOf(String name) {
        switch (name.toLowerCase()) {
            case "rough": return ExternalComponent.Finish.ROUGH;
            case "roughunfinished": return ExternalComponent.Finish.ROUGHUNFINISHED;
            case "unfinished": return ExternalComponent.Finish.UNFINISHED;
            case "smooth": return ExternalComponent.Finish.SMOOTH;
            // OPTIMUM (5 um) and MIRROR (0 um) had no case and fell through to
            // the NORMAL default (60 um) — a 12x roughness error, silent, on any
            // desktop-saved file using them. It also made the ladder
            // non-monotonic: "Optimum paint" came out ROUGHER than "Smooth
            // paint". Measured before the fix: optimum gave byte-identical drag
            // and apogee to normal.
            case "optimum": return ExternalComponent.Finish.OPTIMUM;
            case "mirror": return ExternalComponent.Finish.MIRROR;
            case "polished": return ExternalComponent.Finish.POLISHED;
            case "finishpolished": return ExternalComponent.Finish.FINISHPOLISHED;
            case "normal":
            case "regular":
            default: return ExternalComponent.Finish.NORMAL;
        }
    }

    /** Builds and attaches the node's children recursively. */
    static void attachChildren(RocketComponent parent, Map<String, Object> node,
            Map<String, RocketComponent> idIndex) {
        List<Map<String, Object>> kids = JsonLite.objList(node, "children");
        for (Map<String, Object> kid : kids) {
            RocketComponent child = create(kid);
            parent.addChild(child);
            // Assemblies and fin tabs configure AFTER addChild (they read the
            // parent for reprojection / radius clamping). Guard on
            // ComponentAssembly, NOT RingInstanceable — FinSet/SymmetricComponent
            // ALSO implement RingInstanceable, and applyAssembly would clobber
            // their instance count with the pod default.
            if (child instanceof ComponentAssembly) {
                applyAssembly(child, kid);
            }
            if (child instanceof FinSet) {
                applyFinTabs((FinSet) child, kid);
            }
            // Ring dimensions run POST-ATTACH for the same reason.
            // ThicknessRingComponent.setThickness (:82-100) clamps to
            // getOuterRadius(), and RadiusRingComponent.setInnerRadius (:81-102)
            // freezes an automatic outer radius at the inner radius. While the
            // component is parentless an AUTOMATIC outer radius reads 0 — both
            // getOuterRadius() overrides fall through to the raw field — so the
            // pre-attach calls this replaces silently wrote thickness 0, and
            // every tube coupler and engine block in the app weighed exactly
            // nothing (a 4-inch fibreglass coupler: 0 g where it should be
            // 27.4 g; Eric's LEM-M2B, 653.4 g dry where it should be 680.8 g).
            // Desktop never hits this: importt/ComponentHandler.java:51 calls
            // parent.addChild(c) on element OPEN, before ComponentParameterHandler
            // applies any setter.
            // MUST precede the recursion below: TubeCoupler is itself a
            // RadialParent (TubeCoupler.java:8, :50-52), so a bulkhead or ring
            // nested INSIDE a coupler reads the inner radius this call
            // establishes.
            applyPostAttachDimensions(child, kid);
            if (child instanceof TubeFinSet) {
                applyTubeFinThickness((TubeFinSet) child, kid);
            }
            String id = str(kid, "id", null);
            if (id != null) {
                idIndex.put(id, child);
            }
            attachChildren(child, kid, idIndex);
        }
    }

    /**
     * Fin tabs (through-the-wall mounting). Applied AFTER the fin set is
     * attached: setTabHeight() clamps against the parent body radius, which
     * is only known post-attach. Keys: tabHeight, tabLength (both > 0 to
     * enable), tabOffset, tabOffsetMethod (top|middle|bottom).
     */
    private static void applyFinTabs(FinSet fins, Map<String, Object> node) {
        double tabHeight = dbl(node, "tabHeight", 0);
        double tabLength = dbl(node, "tabLength", 0);
        if (tabHeight <= 0 || tabLength <= 0) {
            return;
        }
        fins.setTabOffsetMethod(axialMethodOf(str(node, "tabOffsetMethod", "middle")));
        fins.setTabLength(tabLength);
        fins.setTabOffset(dbl(node, "tabOffset", 0));
        fins.setTabHeight(tabHeight);
    }

    /**
     * Ring dimensions that must be applied AFTER parent.addChild(): every one of
     * them clamps against a radius that is only knowable once the component has
     * a parent. See the comment at the call site in attachChildren.
     *
     * Dispatch is on the node's "type" string, NOT instanceof. That keeps each
     * default beside the type that owns it, it does not rest on a carved class
     * hierarchy that upstream is free to change, and it adds no new instanceof
     * checks under TeaVM's fastGlobalAnalysis. The per-type defaults MUST stay
     * the ones the create() switch used to carry, or a node that omits
     * "thickness" changes mass.
     */
    private static void applyPostAttachDimensions(RocketComponent child, Map<String, Object> node) {
        switch (str(node, "type", "")) {
            case "innertube":
                ((InnerTube) child).setThickness(dbl(node, "thickness", 0.0005));
                break;
            case "tubecoupler":
                ((TubeCoupler) child).setThickness(dbl(node, "thickness", 0.0005));
                break;
            case "engineblock":
                ((EngineBlock) child).setThickness(dbl(node, "thickness", 0.00095));
                break;
            case "centeringring": {
                CenteringRing ring = (CenteringRing) child;
                // Outer first, then inner — desktop's own element order
                // (RadiusRingComponentSaver:15-24) and the order the two clamps
                // in RadiusRingComponent assume of each other.
                double or = dbl(node, "outerRadius", Double.NaN);
                if (!Double.isNaN(or)) {
                    ring.setOuterRadius(or);
                }
                double ir = dbl(node, "innerRadius", Double.NaN);
                if (!Double.isNaN(ir)) {
                    ring.setInnerRadius(ir);
                }
                break;
            }
            default:
                // Bulkhead takes an outer radius only, and for it
                // RadiusRingComponent.setOuterRadius reads no parent state:
                // its clamp at :66 calls getInnerRadius(), which Bulkhead
                // hard-returns 0 from (Bulkhead.java:24-26). Measured 3.3903 g
                // on an automatic radius, exactly pi*0.023^2*0.003*680 — which
                // is also the proof that the automatic radius itself resolves
                // fine once attached, and that only the setter timing was
                // broken. So the bulkhead stays in create().
                break;
        }
    }

    /**
     * Tube-fin wall thickness. MUST run AFTER parent.addChild(child), and the
     * ordering is the entire point of this method existing instead of a line in
     * the "tubefinset" case.
     *
     * TubeFinSet.setThickness clamps to getOuterRadius() (TubeFinSet.java:200).
     * An AUTOMATIC-radius set — which is the app's OWN default, since
     * schema.ts defaultsFor('tubefinset') supplies no outerRadius — resolves its
     * radius from the parent body tube: getOuterRadius() (:84-93) calls
     * getTouchingRadius() (:109-116), which calls getBodyRadius() (:387-399),
     * which returns 0 with no parent. MathUtil.clamp(t,0,0) is 0
     * (MathUtil.java:50-56), so a pre-attach call would pin the wall to ZERO
     * permanently — and BodyTube.addChild's rescue would not fire either,
     * because getThickness() would then be 0 rather than NaN. That is strictly
     * worse than the bug being fixed: it would zero the common case instead of
     * mis-sizing it.
     *
     * Desktop runs its setters post-attach for exactly this reason:
     * importt/ComponentHandler.java:51 attaches THEN hands over to
     * ComponentParameterHandler (DocumentConfig.java:317-318 is the setter), and
     * the RockSim reader does the same at importt/TubeFinSetHandler.java:41-44,
     * :89-92. Post-attach is the parity order, not a workaround.
     *
     * NO KEY MEANS DO NOTHING. BodyTube.addChild (BodyTube.java:584-592) has
     * already inherited the parent tube's wall into the NaN field, which is
     * precisely what desktop does for a set that was never given one. Writing a
     * default here would overwrite that inheritance.
     *
     * Until this bridged, a tube fin set flew the AIRFRAME's wall and the wall
     * box in the property panel was decoration. It drives MASS
     * (getComponentVolume, TubeFinSet.java:285-293) and both inertia terms
     * (:318, :336) AND normal force — TubeFinSetCalc.java:67 reads
     * getInnerRadius() into :82 and :135 — so it moves CP and static margin as
     * well, even on a set whose mass is pinned by an override. Measured: the
     * app's own default set on a 2 mm-wall 50 mm airframe goes 123.05 g ->
     * 31.72 g, and TubeFins2.rkt's geometry 6.759 g -> 20.310 g, which is that
     * file's own CalcMass to the last digit.
     */
    private static void applyTubeFinThickness(TubeFinSet fins, Map<String, Object> node) {
        double thickness = dbl(node, "thickness", Double.NaN);
        if (!Double.isNaN(thickness)) {
            fins.setThickness(thickness);
        }
    }

    /**
     * PodSet / ParallelStage placement — MUST run AFTER parent.addChild(child):
     * setRadiusMethod/setAxialMethod read getParent() and NPE with no parent.
     * Radial uses OFFSET/GAP semantics (setRadiusMethod + setRadiusOffset), NEVER
     * setRadius(method,value) (which is radius-from-centerline and double-subtracts
     * the parent radius). PodSet.setAngleMethod is a no-op (pods are always
     * RELATIVE), so angleMethod is applied for parallelstage only. AFTER axial
     * method is downgraded by the kernel — the app never offers it.
     */
    /**
     * Rail buttons and launch lugs are LineInstanceable in the kernel: one
     * component draws, weighs and drags as N collinear copies marching AFT
     * from the node's own position at `instanceSeparation` spacing (RailButton
     * and LaunchLug both; RailButtonCalc returns the MEAN per-instance CD and
     * BarrowmanCalculator multiplies by the instance-context count, so the
     * whole pipeline is instance-correct once these two setters are called).
     *
     * Until v0.089 the bridge never read these keys, so an imported desktop
     * design carrying <instancecount>2</instancecount> flew ONE button's mass
     * and drag — the app even confessed it in an import note. Guarded on key
     * presence so the kernel's own default separation (outerDiameter*6, set in
     * RailButton's constructor) is not clobbered with zero, and clamped
     * because setInstanceCount silently ignores values <= 0 — a JSON 0 would
     * otherwise leave the kernel at 1 while the UI showed 0.
     */
    private static void applyLineInstances(info.openrocket.core.rocketcomponent.LineInstanceable li,
            Map<String, Object> node) {
        double count = dbl(node, "instanceCount", Double.NaN);
        if (Double.isNaN(count)) {
            return; // no instance keys at all: the kernel's own defaults, as before v0.089
        }
        // Clamped BOTH ways. Low: setInstanceCount silently ignores <= 0, so a
        // JSON 0 would leave the kernel at 1 while the UI showed 0. High:
        // getInstanceOffsets allocates one Coordinate per instance on every
        // mass and aero pass, so a corrupt or hostile .ork saying 100000000
        // would wedge the browser tab — and this bridge is the first thing to
        // route a FILE's raw count into that allocation for lugs and buttons.
        // 64 is far above any real rail (a 3 m airframe at 100 mm spacing is
        // 30) and far below anything that hurts.
        li.setInstanceCount(Math.min(64, Math.max(1, (int) Math.round(count))));
        // Separation is applied WHENEVER a count was given, defaulting to 0 —
        // the same value every app renderer and the .ork writer assume for a
        // missing key. Leaving it unset instead would fly the buttons at the
        // kernel constructor's own default (outerDiameter*6, frozen at the
        // DEFAULT diameter) while the drawing and the saved file showed them
        // coincident: three descriptions of one rocket.
        li.setInstanceSeparation(dbl(node, "instanceSeparation", 0));
    }

    /**
     * Where a surface-mounted part sits AROUND the body (the clock angle,
     * radians). Launch lugs and rail buttons are the kernel's AnglePositionable
     * components; a protuberance reaches this through the carrier RailButton
     * that treeModel.ts engineTree lowers it to.
     *
     * Until v0.103 nothing called setAngleOffset for either, so a lug or a
     * button that was read from the file, drawn in all three views, warned
     * about by the rail-interference strip and written back out at (say) 90
     * degrees was nevertheless SIMULATED at the kernel constructor's default of
     * PI (LaunchLug.java:24, RailButton.java:54). That is never a drag error —
     * LaunchLugCalc.calculateNonaxialForces is empty, TubeCalc reads no angle,
     * and RailButtonCalc.calculatePressureCD is a function of Mach, Reynolds
     * and reference area only, so a bump on a round body is charged the same
     * drag whichever way round it sits. What it IS is a lateral CG error
     * (LaunchLug.java:236-237 and RailButton.java:389-390 both put the part's CG
     * at cos/sin of this angle times the parent radius) and therefore a 6DOF
     * wind-response error.
     *
     * DEFAULTS TO 0, NOT to the kernel's PI, deliberately: 0 is what every app
     * renderer reads for a missing key (Rocket3D, TreeSchematic and AftView all
     * call num(child, 'angleOffset', 0)) and what the .ork writer emits for one.
     * Taking the kernel default here instead would fly a part 180 degrees from
     * where the app draws it and from where the file it just wrote says it is —
     * the same "three descriptions of one rocket" applyLineInstances refuses
     * above. The .ork reader was fixed in the same sitting to stop dropping an
     * explicit zero (orkFile.ts readMountAngle), so "absent" and "zero" now
     * agree end to end whichever way a design arrived.
     */
    private static void applyMountAngle(info.openrocket.core.rocketcomponent.position.AnglePositionable ap,
            Map<String, Object> node) {
        ap.setAngleOffset(dbl(node, "angleOffset", 0));
    }

    private static void applyAssembly(RocketComponent child, Map<String, Object> node) {
        RingInstanceable ring = (RingInstanceable) child;
        ring.setInstanceCount((int) dbl(node, "instanceCount", 2));
        ring.setRadiusMethod(radiusMethodOf(str(node, "radiusMethod", "relative")));
        ring.setRadiusOffset(dbl(node, "radiusOffset", 0)); // gap in metres, stored raw for RELATIVE/FREE
        ring.setAngleOffset(dbl(node, "angleOffset", 0));    // radians
        if (child instanceof ParallelStage) {
            ring.setAngleMethod(angleMethodOf(str(node, "angleMethod", "relative")));
        }
        Map<String, Object> position = obj(node, "position");
        if (position != null) {
            child.setAxialMethod(axialMethodOf(str(position, "method", "bottom")));
            child.setAxialOffset(dbl(position, "offset", 0));
        }
        if (child instanceof ParallelStage) {
            // A ParallelStage separates — reuse OrkEngine's stage-separation
            // writer (same package, package-private).
            OrkEngine.applySeparationConfig((AxialStage) child, node);
        }
    }

    private static RadiusMethod radiusMethodOf(String name) {
        switch (name.toLowerCase()) {
            case "free": return RadiusMethod.FREE;
            case "surface": return RadiusMethod.SURFACE;
            case "coaxial": return RadiusMethod.COAXIAL;
            case "relative":
            default: return RadiusMethod.RELATIVE;
        }
    }

    private static AngleMethod angleMethodOf(String name) {
        switch (name.toLowerCase()) {
            case "fixed": return AngleMethod.FIXED;
            case "relative":
            default: return AngleMethod.RELATIVE;
        }
    }

    private static Transition.Shape shapeOf(String name) {
        switch (name.toLowerCase()) {
            case "conical": return Transition.Shape.CONICAL;
            case "ellipsoid": return Transition.Shape.ELLIPSOID;
            case "power": return Transition.Shape.POWER;
            case "parabolic": return Transition.Shape.PARABOLIC;
            case "haack": return Transition.Shape.HAACK;
            case "ogive":
            default: return Transition.Shape.OGIVE;
        }
    }

    private static FinSet.CrossSection crossSectionOf(String name) {
        switch (name.toLowerCase()) {
            case "rounded": return FinSet.CrossSection.ROUNDED;
            case "airfoil": return FinSet.CrossSection.AIRFOIL;
            case "square":
            default: return FinSet.CrossSection.SQUARE;
        }
    }

    private static AxialMethod axialMethodOf(String name) {
        switch (name.toLowerCase()) {
            case "absolute": return AxialMethod.ABSOLUTE;
            case "middle": return AxialMethod.MIDDLE;
            case "bottom": return AxialMethod.BOTTOM;
            case "top":
            default: return AxialMethod.TOP;
        }
    }
}
