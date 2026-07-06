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
                c = fins;
                break;
            }
            case "innertube": {
                InnerTube tube = new InnerTube();
                tube.setLength(dbl(node, "length", 0.07));
                tube.setOuterRadius(dbl(node, "outerRadius", 0.0095));
                tube.setThickness(dbl(node, "thickness", 0.0005));
                tube.setMotorMount(bool(node, "motorMount", false));
                tube.setMotorOverhang(dbl(node, "motorOverhang", 0));
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
                tc.setThickness(dbl(node, "thickness", 0.0005));
                c = tc;
                break;
            }
            case "centeringring": {
                CenteringRing ring = new CenteringRing();
                ring.setLength(dbl(node, "length", 0.002));
                double or = dbl(node, "outerRadius", Double.NaN);
                if (!Double.isNaN(or)) {
                    ring.setOuterRadius(or);
                }
                double ir = dbl(node, "innerRadius", Double.NaN);
                if (!Double.isNaN(ir)) {
                    ring.setInnerRadius(ir);
                }
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
                eb.setThickness(dbl(node, "thickness", 0.00095));
                c = eb;
                break;
            }
            case "launchlug": {
                LaunchLug lug = new LaunchLug();
                lug.setLength(dbl(node, "length", 0.05));
                lug.setOuterRadius(dbl(node, "outerRadius", 0.0022));
                lug.setThickness(dbl(node, "thickness", 0.0003));
                c = lug;
                break;
            }
            case "railbutton": {
                RailButton rb = new RailButton();
                double od = dbl(node, "outerDiameter", Double.NaN);
                if (!Double.isNaN(od)) {
                    rb.setOuterDiameter(od);
                }
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
        // Mass / CG / CD overrides — absent key means "not overridden".
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
     * PodSet / ParallelStage placement — MUST run AFTER parent.addChild(child):
     * setRadiusMethod/setAxialMethod read getParent() and NPE with no parent.
     * Radial uses OFFSET/GAP semantics (setRadiusMethod + setRadiusOffset), NEVER
     * setRadius(method,value) (which is radius-from-centerline and double-subtracts
     * the parent radius). PodSet.setAngleMethod is a no-op (pods are always
     * RELATIVE), so angleMethod is applied for parallelstage only. AFTER axial
     * method is downgraded by the kernel — the app never offers it.
     */
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
