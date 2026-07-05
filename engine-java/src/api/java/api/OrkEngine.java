package api;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

import org.teavm.jso.JSExport;

import info.openrocket.core.aerodynamics.AerodynamicForces;
import info.openrocket.core.aerodynamics.BarrowmanCalculator;
import info.openrocket.core.aerodynamics.FlightConditions;
import info.openrocket.core.document.Simulation;
import info.openrocket.core.logging.WarningSet;
import info.openrocket.core.masscalc.MassCalculator;
import info.openrocket.core.masscalc.RigidBody;
import info.openrocket.core.models.atmosphere.ExtendedISAModel;
import info.openrocket.core.models.gravity.WGSGravityModel;
import info.openrocket.core.models.wind.PinkNoiseWindModel;
import info.openrocket.core.motor.IgnitionEvent;
import info.openrocket.core.motor.Manufacturer;
import info.openrocket.core.motor.Motor;
import info.openrocket.core.motor.MotorConfiguration;
import info.openrocket.core.motor.ThrustCurveMotor;
import info.openrocket.core.rocketcomponent.AxialStage;
import info.openrocket.core.rocketcomponent.BodyTube;
import info.openrocket.core.rocketcomponent.ComponentAssembly;
import info.openrocket.core.rocketcomponent.FlightConfiguration;
import info.openrocket.core.rocketcomponent.FlightConfigurationId;
import info.openrocket.core.rocketcomponent.InnerTube;
import info.openrocket.core.rocketcomponent.NoseCone;
import info.openrocket.core.rocketcomponent.Parachute;
import info.openrocket.core.rocketcomponent.Rocket;
import info.openrocket.core.rocketcomponent.RocketComponent;
import info.openrocket.core.rocketcomponent.StageSeparationConfiguration;
import info.openrocket.core.rocketcomponent.Transition;
import info.openrocket.core.rocketcomponent.TrapezoidFinSet;
import info.openrocket.core.simulation.BasicEventSimulationEngine;
import info.openrocket.core.simulation.FlightData;
import info.openrocket.core.simulation.FlightDataBranch;
import info.openrocket.core.simulation.FlightDataType;
import info.openrocket.core.simulation.FlightEvent;
import info.openrocket.core.simulation.SimulationConditions;
import info.openrocket.core.simulation.exception.SimulationException;
import info.openrocket.core.material.Material;
import info.openrocket.core.util.Coordinate;
import info.openrocket.core.util.GeodeticComputationStrategy;
import info.openrocket.core.util.WorldCoordinate;

/**
 * JS-facing engine facade (@JSExport). Handle-based API: components live in
 * a registry and are addressed by integer handles; parameters are primitives
 * or arrays; results are JSON strings (built by hand — no JSON library in
 * the kernel). All values SI (meters, kilograms, seconds, newtons), angles
 * in radians — conversions belong to the caller.
 */
public final class OrkEngine {

    private static final Map<Integer, Object> HANDLES = new HashMap<>();
    private static int nextHandle = 1;

    private OrkEngine() {}

    /**
     * Entry point: delegates to the golden harness (differential testing).
     * Having OrkEngine as mainClass makes it reachable so the @JSExport
     * statics survive TeaVM's dead-code elimination.
     */
    public static void main(String[] args) {
        harness.GoldenMain.main(args);
    }

    private static int register(Object o) {
        int h = nextHandle++;
        HANDLES.put(h, o);
        return h;
    }

    private static Object get(int handle) {
        Object o = HANDLES.get(handle);
        if (o == null) {
            throw new IllegalArgumentException("Unknown handle: " + handle);
        }
        return o;
    }

    /** Testing hook: the underlying Rocket for a rocket handle (harness use). */
    public static Rocket getRocketForTesting(int rocketHandle) {
        return ((RocketCtx) get(rocketHandle)).rocket;
    }

    /** Frees every handle (rockets, components, motors). */
    @JSExport
    public static void reset() {
        HANDLES.clear();
        nextHandle = 1;
    }

    // ---------- Rocket construction ----------

    /** Creates a rocket with one stage and a dedicated flight configuration. Returns rocket handle. */
    @JSExport
    public static int newRocket() {
        Rocket rocket = new Rocket();
        AxialStage stage = new AxialStage();
        rocket.addChild(stage);
        FlightConfigurationId fcid = new FlightConfigurationId();
        rocket.createFlightConfiguration(fcid);
        rocket.setSelectedConfiguration(fcid);
        rocket.enableEvents();
        return register(new RocketCtx(rocket, stage, fcid));
    }

    /**
     * Builds a complete rocket from a JSON component tree (P2.1 API):
     * { "name": "...", "components": [ {"type": "nosecone", "id": "n1", ...,
     *   "children": [...]}, ... ] }
     *
     * Multi-stage (P3): the top level may instead be STAGE nodes —
     * { "components": [ {"type":"stage", "name":"Sustainer", "children":[...]},
     *   {"type":"stage", "name":"Booster", "separationEvent":"ejection",
     *    "separationDelay":0, "children":[...]} ] }
     * Stage 0 is the top (sustainer); order matches the desktop. A top level
     * WITHOUT stage nodes keeps the legacy meaning: children of one implicit
     * stage. Mixing stage and component nodes at the top level is an error.
     * separationEvent: launch|ignition|burnout|ejection|upperignition|
     * altitudeascending|apogee|altitudedescending|never (desktop default:
     * ejection).
     *
     * Components with an "id" can be addressed later (setMotorById).
     * Returns rocket handle; throws with a descriptive message on bad input.
     */
    @JSExport
    public static int buildRocket(String treeJson) {
        Map<String, Object> tree = JsonLite.parseObject(treeJson);
        Rocket rocket = new Rocket();
        String name = JsonLite.str(tree, "name", null);
        if (name != null) {
            rocket.setName(name);
        }

        Object comps = tree.get("components");
        List<?> topLevel = comps instanceof List ? (List<?>) comps : java.util.Collections.emptyList();
        boolean staged = false;
        for (Object o : topLevel) {
            if (o instanceof Map && "stage".equals(((Map<?, ?>) o).get("type"))) {
                staged = true;
                break;
            }
        }

        Map<String, RocketComponent> ids = new HashMap<>();
        AxialStage firstStage = null;
        if (staged) {
            for (Object o : topLevel) {
                if (!(o instanceof Map) || !"stage".equals(((Map<?, ?>) o).get("type"))) {
                    throw new IllegalArgumentException(
                            "Top level mixes stage and component nodes — with stages, EVERY top-level node must be a stage");
                }
                @SuppressWarnings("unchecked")
                Map<String, Object> stageNode = (Map<String, Object>) o;
                AxialStage stage = new AxialStage();
                String stageName = JsonLite.str(stageNode, "name", null);
                if (stageName != null) {
                    stage.setName(stageName);
                }
                rocket.addChild(stage);
                if (firstStage == null) {
                    firstStage = stage;
                }
                String stageId = JsonLite.str(stageNode, "id", null);
                if (stageId != null) {
                    ids.put(stageId, stage);
                }
                applySeparationConfig(stage, stageNode);
                ComponentFactory.attachChildren(stage, stageNode, ids);
            }
            if (firstStage == null) {
                throw new IllegalArgumentException("Staged rocket has no stages");
            }
        } else {
            firstStage = new AxialStage();
            rocket.addChild(firstStage);
        }

        FlightConfigurationId fcid = new FlightConfigurationId();
        rocket.createFlightConfiguration(fcid);
        rocket.setSelectedConfiguration(fcid);

        RocketCtx ctx = new RocketCtx(rocket, firstStage, fcid);
        ctx.ids.putAll(ids);
        if (!staged) {
            // The root node's "components" behave like children of the stage.
            Map<String, Object> stageNode = new java.util.LinkedHashMap<>();
            stageNode.put("children", tree.get("components"));
            ComponentFactory.attachChildren(firstStage, stageNode, ctx.ids);
        }

        rocket.enableEvents();
        return register(ctx);
    }

    /**
     * Per-stage separation trigger/delay (defaults preserved when absent).
     * Package-private so ComponentFactory can reuse it for a parallelstage
     * (ParallelStage IS an AxialStage) — no duplication.
     */
    static void applySeparationConfig(AxialStage stage, Map<String, Object> stageNode) {
        // RASAero power-on base-drag: per-stage nozzle exit diameter (metres).
        // Applies to every stage (incl. the sustainer), so read it before the
        // separation-only early return below. Absent/0 => power-off (no effect).
        double nozzleExitDiameter = JsonLite.dbl(stageNode, "nozzleExitDiameter", Double.NaN);
        if (!Double.isNaN(nozzleExitDiameter)) {
            stage.setNozzleExitDiameter(nozzleExitDiameter);
        }

        String event = JsonLite.str(stageNode, "separationEvent", null);
        double delay = JsonLite.dbl(stageNode, "separationDelay", Double.NaN);
        double altitude = JsonLite.dbl(stageNode, "separationAltitude", Double.NaN);
        if (event == null && Double.isNaN(delay) && Double.isNaN(altitude)) {
            return;
        }
        StageSeparationConfiguration sep = new StageSeparationConfiguration();
        if (event != null) {
            sep.setSeparationEvent(separationEventOf(event));
        }
        if (!Double.isNaN(delay)) {
            sep.setSeparationDelay(delay);
        }
        if (!Double.isNaN(altitude)) {
            sep.setSeparationAltitude(altitude);
        }
        // Default (not per-fcid): applies to the flight configuration created
        // right after the stages, and to any future one.
        stage.getSeparationConfigurations().setDefault(sep);
    }

    private static StageSeparationConfiguration.SeparationEvent separationEventOf(String name) {
        switch (name.toLowerCase().replace("_", "")) {
            case "launch": return StageSeparationConfiguration.SeparationEvent.LAUNCH;
            case "ignition": return StageSeparationConfiguration.SeparationEvent.IGNITION;
            case "burnout": return StageSeparationConfiguration.SeparationEvent.BURNOUT;
            case "ejection": return StageSeparationConfiguration.SeparationEvent.EJECTION;
            case "upperignition": return StageSeparationConfiguration.SeparationEvent.UPPER_IGNITION;
            case "altitudeascending": return StageSeparationConfiguration.SeparationEvent.ALTITUDE_ASCENDING;
            case "apogee": return StageSeparationConfiguration.SeparationEvent.APOGEE;
            case "altitudedescending": return StageSeparationConfiguration.SeparationEvent.ALTITUDE_DESCENDING;
            case "never": return StageSeparationConfiguration.SeparationEvent.NEVER;
            default:
                throw new IllegalArgumentException("Unknown separation event: " + name);
        }
    }

    /** Attaches a motor to the identified mount component (see buildRocket ids). */
    @JSExport
    public static void setMotorById(int rocketHandle, String componentId, String designation,
            double diameter, double length, double[] times, double[] thrusts,
            double[] masses, double cgX, double ejectionDelay) {
        RocketCtx ctx = (RocketCtx) get(rocketHandle);
        RocketComponent comp = ctx.ids.get(componentId);
        if (!(comp instanceof InnerTube)) {
            throw new IllegalArgumentException(
                    "Component id '" + componentId + "' is not an inner-tube motor mount");
        }
        int mountHandle = register(comp);
        setMotor(rocketHandle, mountHandle, designation, diameter, length,
                times, thrusts, masses, cgX, ejectionDelay);
    }

    /** shape: "ogive" | "conical" | "ellipsoid" | "power" | "parabolic" | "haack". Returns component handle. */
    @JSExport
    public static int addNoseCone(int rocketHandle, double length, double aftRadius,
            double thickness, String shape, double materialDensity) {
        RocketCtx ctx = (RocketCtx) get(rocketHandle);
        NoseCone nose = new NoseCone(shapeOf(shape), length, aftRadius);
        nose.setThickness(thickness);
        setBulkMaterial(nose, materialDensity);
        ctx.stage.addChild(nose);
        return register(nose);
    }

    /** Returns component handle (children like fins/mounts attach to it). */
    @JSExport
    public static int addBodyTube(int rocketHandle, double length, double outerRadius,
            double thickness, double materialDensity) {
        RocketCtx ctx = (RocketCtx) get(rocketHandle);
        BodyTube tube = new BodyTube(length, outerRadius, thickness);
        setBulkMaterial(tube, materialDensity);
        ctx.stage.addChild(tube);
        return register(tube);
    }

    @JSExport
    public static int addTrapezoidFins(int parentHandle, int finCount, double rootChord,
            double tipChord, double sweep, double height, double thickness, double materialDensity) {
        RocketComponent parent = (RocketComponent) get(parentHandle);
        TrapezoidFinSet fins = new TrapezoidFinSet(finCount, rootChord, tipChord, sweep, height);
        fins.setThickness(thickness);
        setBulkMaterial(fins, materialDensity);
        parent.addChild(fins);
        return register(fins);
    }

    /** Motor mount tube. Returns mount handle for setMotor(). */
    @JSExport
    public static int addInnerTube(int parentHandle, double length, double outerRadius,
            double thickness, double materialDensity) {
        RocketComponent parent = (RocketComponent) get(parentHandle);
        InnerTube tube = new InnerTube();
        tube.setLength(length);
        tube.setOuterRadius(outerRadius);
        tube.setThickness(thickness);
        setBulkMaterial(tube, materialDensity);
        parent.addChild(tube);
        tube.setMotorMount(true);
        return register(tube);
    }

    @JSExport
    public static int addParachute(int parentHandle, double diameter, double dragCoefficient) {
        RocketComponent parent = (RocketComponent) get(parentHandle);
        Parachute chute = new Parachute();
        chute.setDiameter(diameter);
        if (dragCoefficient > 0) {
            chute.setCD(dragCoefficient);
        }
        parent.addChild(chute);
        return register(chute);
    }

    // ---------- Motor ----------

    /**
     * Defines a motor from raw thrust-curve data and attaches it to a mount.
     * masses[] pairs with times[] (motor mass at each time point); cgX is the
     * (constant) CG position from the motor's nose.
     */
    @JSExport
    public static void setMotor(int rocketHandle, int mountHandle, String designation,
            double diameter, double length, double[] times, double[] thrusts,
            double[] masses, double cgX, double ejectionDelay) {
        RocketCtx ctx = (RocketCtx) get(rocketHandle);
        InnerTube mount = (InnerTube) get(mountHandle);

        Coordinate[] cgPoints = new Coordinate[times.length];
        for (int i = 0; i < times.length; i++) {
            cgPoints[i] = new Coordinate(cgX, 0, 0, masses[i]);
        }
        ThrustCurveMotor motor = new ThrustCurveMotor.Builder()
                .setManufacturer(Manufacturer.getManufacturer("custom"))
                .setDesignation(designation)
                .setCommonName(designation)
                .setMotorType(Motor.Type.SINGLE)
                .setStandardDelays(new double[] { ejectionDelay })
                .setDiameter(diameter)
                .setLength(length)
                .setTimePoints(times)
                .setThrustPoints(thrusts)
                .setCGPoints(cgPoints)
                .setDigest("api-" + designation)
                .build();

        MotorConfiguration mc = new MotorConfiguration(mount, ctx.fcid);
        mc.setMotor(motor);
        mc.setEjectionDelay(ejectionDelay);
        mount.setMotorConfig(mc, ctx.fcid);
    }

    /**
     * Overrides WHEN the identified mount's motor ignites (call after
     * setMotorById). Default is "automatic": launch-stage motors light at
     * launch, upper-stage motors on the ejection charge of the stage below —
     * the low/mid-power pattern. High-power sustainers use electronics:
     * "burnout" or "launch" plus a timer delay.
     * ignitionEvent: automatic|launch|ejectioncharge|burnout|never.
     */
    @JSExport
    public static void setMotorIgnitionById(int rocketHandle, String componentId,
            String ignitionEvent, double ignitionDelay) {
        RocketCtx ctx = (RocketCtx) get(rocketHandle);
        RocketComponent comp = ctx.ids.get(componentId);
        if (!(comp instanceof InnerTube)) {
            throw new IllegalArgumentException(
                    "Component id '" + componentId + "' is not an inner-tube motor mount");
        }
        MotorConfiguration mc = ((InnerTube) comp).getMotorConfig(ctx.fcid);
        if (mc == null || mc.getMotor() == null) {
            throw new IllegalArgumentException(
                    "No motor loaded on mount '" + componentId + "' — call setMotorById first");
        }
        mc.setIgnitionEvent(ignitionEventOf(ignitionEvent));
        mc.setIgnitionDelay(ignitionDelay);
    }

    private static IgnitionEvent ignitionEventOf(String name) {
        switch (name.toLowerCase().replace("_", "")) {
            case "automatic": return IgnitionEvent.AUTOMATIC;
            case "launch": return IgnitionEvent.LAUNCH;
            case "ejectioncharge": return IgnitionEvent.EJECTION_CHARGE;
            case "burnout": return IgnitionEvent.BURNOUT;
            case "never": return IgnitionEvent.NEVER;
            default:
                throw new IllegalArgumentException("Unknown ignition event: " + name);
        }
    }

    // ---------- Analysis ----------

    /**
     * Static design info: length, mass, CG, CP (at Mach 0.3, AoA 0), stability
     * margin in calibers. "mass"/"cg" are launch values (motors loaded when
     * set); "massEmpty"/"cgEmpty" are the dry structure.
     */
    @JSExport
    public static String getStaticInfo(int rocketHandle) {
        RocketCtx ctx = (RocketCtx) get(rocketHandle);
        RigidBody structure = MassCalculator.calculateLaunch(ctx.rocket.getSelectedConfiguration());
        RigidBody empty = MassCalculator.calculateStructure(ctx.rocket.getSelectedConfiguration());

        BarrowmanCalculator calc = new BarrowmanCalculator();
        FlightConditions conditions = new FlightConditions(ctx.rocket.getSelectedConfiguration());
        conditions.setMach(0.3);
        conditions.setAOA(0);
        WarningSet warnings = new WarningSet();
        Coordinate cp = calc.getCP(ctx.rocket.getSelectedConfiguration(), conditions, warnings);

        double refDiameter = 2 * conditions.getRefLength() / 2; // refLength IS the reference diameter
        double cg = structure.getCM().x;
        double stabilityCal = (cp.x - cg) / conditions.getRefLength();

        StringBuilder sb = new StringBuilder("{");
        num(sb, "length", ctx.rocket.getLength()).append(',');
        num(sb, "mass", structure.getMass()).append(',');
        num(sb, "massEmpty", empty.getMass()).append(',');
        num(sb, "cgEmpty", empty.getCM().x).append(',');
        num(sb, "cg", cg).append(',');
        num(sb, "cp", cp.x).append(',');
        num(sb, "cna", cp.weight).append(',');
        num(sb, "stabilityCalibers", stabilityCal).append(',');
        num(sb, "refDiameter", refDiameter).append(',');
        num(sb, "warnings", warnings.size()).append(',');
        sb.append("\"warningTexts\":[");
        boolean first = true;
        for (info.openrocket.core.logging.Warning w : warnings) {
            if (!first) sb.append(',');
            first = false;
            sb.append('"').append(escape(String.valueOf(w))).append('"');
        }
        sb.append(']');
        return sb.append('}').toString();
    }

    /**
     * Per-component info for a buildRocket() id: length, own mass (override-
     * aware; a fin set's mass covers ALL its fins), subtree mass including
     * children, CG from the component's own front, and the component's
     * absolute position from the rocket nose (first instance).
     */
    @JSExport
    public static String getComponentInfo(int rocketHandle, String componentId) {
        RocketCtx ctx = (RocketCtx) get(rocketHandle);
        RocketComponent c = ctx.ids.get(componentId);
        if (c == null) {
            throw new IllegalArgumentException("Unknown component id: '" + componentId + "'");
        }
        Coordinate[] locations = c.getComponentLocations();
        double absX = locations.length > 0 ? locations[0].x : Double.NaN;
        StringBuilder sb = new StringBuilder("{");
        num(sb, "length", c.getLength()).append(',');
        num(sb, "mass", c.getMass()).append(',');
        num(sb, "sectionMass", c.getSectionMass()).append(',');
        num(sb, "cgX", c.getCG().x).append(',');
        num(sb, "positionX", absX);
        return sb.append('}').toString();
    }

    /**
     * Drag polar sweep (RASAero-style Aero Plots). For each Mach across the
     * requested range it returns total CD plus the friction / pressure / base
     * split, for BOTH power-off (coast) and power-on (all stages thrusting —
     * the nozzle-exit base-drag reduction from feature #2), and a per-component
     * power-off CD breakdown. Zero-alpha by default. This is a static design
     * property (no flight needed).
     *
     * Options JSON: { machMin=0.05, machMax=3.0, machStep=0.05, aoaDeg=0 }.
     * Returns: { machs:[], hasNozzle:bool,
     *            powerOff:{total[],friction[],pressure[],base[]},
     *            powerOn:{...}, components:[{name,cd[]}...] }.
     * NOTE: the underlying method is Extended Barrowman — accurate subsonic/
     * transonic, degrading above ~Mach 1.5-2 (full supersonic fidelity is
     * feature #1). The UI labels the supersonic region accordingly.
     */
    @JSExport
    public static String getDragSweep(int rocketHandle, String optionsJson) {
        RocketCtx ctx = (RocketCtx) get(rocketHandle);
        FlightConfiguration config = ctx.rocket.getSelectedConfiguration();
        Map<String, Object> o = JsonLite.parseObject(optionsJson);
        double machMin = JsonLite.dbl(o, "machMin", 0.05);
        double machMax = JsonLite.dbl(o, "machMax", 3.0);
        double machStep = JsonLite.dbl(o, "machStep", 0.05);
        double aoa = Math.toRadians(JsonLite.dbl(o, "aoaDeg", 0));
        if (machStep <= 0) {
            machStep = 0.05;
        }

        java.util.List<Double> machList = new java.util.ArrayList<>();
        for (double m = machMin; m <= machMax + 1e-9; m += machStep) {
            machList.add(m);
        }
        int n = machList.size();

        // Every stage number -> the power-on thrusting set; note if any nozzle set.
        java.util.Set<Integer> allStages = new java.util.HashSet<>();
        boolean hasNozzle = false;
        for (RocketComponent c : ctx.rocket) {
            if (c instanceof AxialStage) {
                allStages.add(((AxialStage) c).getStageNumber());
                if (((AxialStage) c).getNozzleExitDiameter() > 0) {
                    hasNozzle = true;
                }
            }
        }

        BarrowmanCalculator calc = new BarrowmanCalculator();
        WarningSet warnings = new WarningSet();

        double[] offTotal = new double[n], offFric = new double[n], offPress = new double[n], offBase = new double[n];
        double[] onTotal = new double[n], onFric = new double[n], onPress = new double[n], onBase = new double[n];
        java.util.LinkedHashMap<String, double[]> byComp = new java.util.LinkedHashMap<>();

        for (int i = 0; i < n; i++) {
            double mach = machList.get(i);

            FlightConditions off = new FlightConditions(config);
            off.setMach(mach);
            off.setAOA(aoa);
            AerodynamicForces fOff = calc.getAerodynamicForces(config, off, warnings);
            offTotal[i] = fOff.getCD();
            offFric[i] = fOff.getFrictionCD();
            offPress[i] = fOff.getPressureCD();
            offBase[i] = fOff.getBaseCD();

            FlightConditions on = new FlightConditions(config);
            on.setMach(mach);
            on.setAOA(aoa);
            on.setThrustingStages(new java.util.HashSet<>(allStages));
            AerodynamicForces fOn = calc.getAerodynamicForces(config, on, warnings);
            onTotal[i] = fOn.getCD();
            onFric[i] = fOn.getFrictionCD();
            onPress[i] = fOn.getPressureCD();
            onBase[i] = fOn.getBaseCD();

            // Per-component power-off breakdown (skip the aggregate assembly nodes).
            Map<RocketComponent, AerodynamicForces> offMap = calc.getForceAnalysis(config, off, warnings);
            for (Map.Entry<RocketComponent, AerodynamicForces> e : offMap.entrySet()) {
                RocketComponent c = e.getKey();
                if (!c.isAerodynamic() || c instanceof ComponentAssembly) {
                    continue;
                }
                double cd = e.getValue().getCD();
                if (Double.isNaN(cd)) {
                    cd = 0;
                }
                double[] row = byComp.get(c.getName());
                if (row == null) {
                    row = new double[n];
                    byComp.put(c.getName(), row);
                }
                row[i] += cd;
            }
        }

        double[] machArr = new double[n];
        for (int i = 0; i < n; i++) {
            machArr[i] = machList.get(i);
        }

        StringBuilder sb = new StringBuilder("{\"machs\":");
        nums(sb, machArr);
        sb.append(",\"hasNozzle\":").append(hasNozzle);
        sb.append(",\"powerOff\":");
        dragBlock(sb, offTotal, offFric, offPress, offBase);
        sb.append(",\"powerOn\":");
        dragBlock(sb, onTotal, onFric, onPress, onBase);
        sb.append(",\"components\":[");
        boolean first = true;
        for (Map.Entry<String, double[]> e : byComp.entrySet()) {
            if (!first) sb.append(',');
            first = false;
            sb.append("{\"name\":\"").append(escape(e.getKey())).append("\",\"cd\":");
            nums(sb, e.getValue());
            sb.append('}');
        }
        sb.append("]}");
        return sb.toString();
    }

    private static void dragBlock(StringBuilder sb, double[] total, double[] fric, double[] press, double[] base) {
        sb.append("{\"total\":");
        nums(sb, total);
        sb.append(",\"friction\":");
        nums(sb, fric);
        sb.append(",\"pressure\":");
        nums(sb, press);
        sb.append(",\"base\":");
        nums(sb, base);
        sb.append('}');
    }

    private static StringBuilder nums(StringBuilder sb, double[] values) {
        sb.append('[');
        for (int i = 0; i < values.length; i++) {
            if (i > 0) sb.append(',');
            double v = values[i];
            sb.append((Double.isNaN(v) || Double.isInfinite(v)) ? "null" : Double.toString(v));
        }
        return sb.append(']');
    }

    // ---------- Simulation ----------

    /**
     * Runs a full flight simulation. Returns JSON:
     * { summary:{...}, events:[{type,time}...], series:{time[],altitude[],velocity[],acceleration[]} }
     */
    @JSExport
    public static String simulate(int rocketHandle, double launchRodLength, double launchRodAngle,
            double windAverage, double windStdDeviation, double launchAltitude, double timeStep) {
        return simulateJson(rocketHandle, "{"
                + "\"rodLength\":" + launchRodLength + ",\"rodAngle\":" + launchRodAngle
                + ",\"windAverage\":" + windAverage + ",\"windStdDeviation\":" + windStdDeviation
                + ",\"launchAltitude\":" + launchAltitude + ",\"timeStep\":" + timeStep + "}");
    }

    /**
     * Full-featured simulation entry point. Options JSON (all optional):
     * { rodLength, rodAngle, rodDirection, windAverage, windStdDeviation,
     *   launchAltitude, launchLatitude, launchLongitude,
     *   temperature (K, launch-site), pressure (Pa, launch-site),
     *   timeStep, maxTime, randomSeed }
     * Custom temperature/pressure switch the atmosphere to an ISA model based
     * at the launch site; otherwise standard ISA is used.
     */
    @JSExport
    public static String simulateJson(int rocketHandle, String optionsJson) {
        RocketCtx ctx = (RocketCtx) get(rocketHandle);
        Map<String, Object> o = JsonLite.parseObject(optionsJson);

        double launchAltitude = JsonLite.dbl(o, "launchAltitude", 0);
        double temperature = JsonLite.dbl(o, "temperature", Double.NaN);
        double pressure = JsonLite.dbl(o, "pressure", Double.NaN);
        double timeStep = JsonLite.dbl(o, "timeStep", 0.05);

        SimulationConditions conditions = new SimulationConditions();
        conditions.setSimulation(new Simulation(ctx.rocket, ctx.fcid));
        conditions.setLaunchRodLength(JsonLite.dbl(o, "rodLength", 1.0));
        conditions.setLaunchRodAngle(JsonLite.dbl(o, "rodAngle", 0));
        conditions.setLaunchRodDirection(JsonLite.dbl(o, "rodDirection", Math.PI / 2));
        conditions.setLaunchSite(new WorldCoordinate(
                JsonLite.dbl(o, "launchLatitude", 28.61),
                JsonLite.dbl(o, "launchLongitude", -80.60),
                launchAltitude));
        conditions.setGeodeticComputation(GeodeticComputationStrategy.SPHERICAL);
        if (!Double.isNaN(temperature) || !Double.isNaN(pressure)) {
            conditions.setAtmosphericModel(new ExtendedISAModel(
                    launchAltitude,
                    Double.isNaN(temperature) ? ExtendedISAModel.STANDARD_TEMPERATURE : temperature,
                    Double.isNaN(pressure) ? ExtendedISAModel.STANDARD_PRESSURE : pressure));
        } else {
            conditions.setAtmosphericModel(new ExtendedISAModel());
        }
        conditions.setGravityModel(new WGSGravityModel());
        int randomSeed = (int) JsonLite.dbl(o, "randomSeed", 42);
        // Seeded explicitly: the no-arg PinkNoiseWindModel constructor seeds
        // from new Random().nextInt() — nondeterministic across runs.
        PinkNoiseWindModel wind = new PinkNoiseWindModel(randomSeed);
        wind.setAverage(JsonLite.dbl(o, "windAverage", 0));
        wind.setStandardDeviation(JsonLite.dbl(o, "windStdDeviation", 0));
        conditions.setWindModel(wind);
        conditions.setAerodynamicCalculator(new BarrowmanCalculator());
        conditions.setMassCalculator(new MassCalculator());
        conditions.setTimeStep(timeStep > 0 ? timeStep : 0.05);
        conditions.setMaxSimulationTime(JsonLite.dbl(o, "maxTime", 1200));
        conditions.setRandomSeed(randomSeed);

        try {
            BasicEventSimulationEngine engine = new BasicEventSimulationEngine();
            engine.simulate(conditions);
            FlightData data = engine.getFlightData();
            return flightDataToJson(data);
        } catch (SimulationException e) {
            return "{\"error\":\"" + escape(String.valueOf(e.getMessage())) + "\"}";
        }
    }

    // ---------- helpers ----------

    private static final class RocketCtx {
        final Rocket rocket;
        final AxialStage stage;
        final FlightConfigurationId fcid;
        final Map<String, RocketComponent> ids = new HashMap<>();

        RocketCtx(Rocket rocket, AxialStage stage, FlightConfigurationId fcid) {
            this.rocket = rocket;
            this.stage = stage;
            this.fcid = fcid;
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

    private static void setBulkMaterial(RocketComponent c, double density) {
        if (density <= 0) {
            return; // keep the component's default material
        }
        Material m = Material.newMaterial(Material.Type.BULK, "custom", density, true);
        if (c instanceof info.openrocket.core.rocketcomponent.ExternalComponent) {
            ((info.openrocket.core.rocketcomponent.ExternalComponent) c).setMaterial(m);
        } else if (c instanceof info.openrocket.core.rocketcomponent.StructuralComponent) {
            ((info.openrocket.core.rocketcomponent.StructuralComponent) c).setMaterial(m);
        }
    }

    private static String flightDataToJson(FlightData data) {
        StringBuilder sb = new StringBuilder("{\"summary\":{");
        num(sb, "maxAltitude", data.getMaxAltitude()).append(',');
        num(sb, "maxVelocity", data.getMaxVelocity()).append(',');
        num(sb, "maxAcceleration", data.getMaxAcceleration()).append(',');
        num(sb, "maxMachNumber", data.getMaxMachNumber()).append(',');
        num(sb, "timeToApogee", data.getTimeToApogee()).append(',');
        num(sb, "flightTime", data.getFlightTime()).append(',');
        num(sb, "groundHitVelocity", data.getGroundHitVelocity()).append(',');
        num(sb, "launchRodVelocity", data.getLaunchRodVelocity()).append(',');
        num(sb, "deploymentVelocity", data.getDeploymentVelocity()).append(',');
        num(sb, "optimumDelay", data.getOptimumDelay());
        sb.append("},\"events\":");
        appendEvents(sb, data.getBranch(0));
        sb.append(",\"series\":");
        appendBranchSeries(sb, data.getBranch(0));
        // Staged flights: EVERY branch (sustainer = branch 0, then each
        // separated booster's own descent), each with name, events, series.
        // Omitted for single-branch flights — no payload change.
        if (data.getBranchCount() > 1) {
            sb.append(",\"branches\":[");
            for (int i = 0; i < data.getBranchCount(); i++) {
                if (i > 0) sb.append(',');
                FlightDataBranch b = data.getBranch(i);
                sb.append("{\"name\":\"").append(escape(String.valueOf(b.getName())))
                        .append("\",\"events\":");
                appendEvents(sb, b);
                sb.append(",\"series\":");
                appendBranchSeries(sb, b);
                sb.append('}');
            }
            sb.append(']');
        }
        return sb.append('}').toString();
    }

    private static void appendEvents(StringBuilder sb, FlightDataBranch branch) {
        sb.append('[');
        boolean first = true;
        for (FlightEvent ev : branch.getEvents()) {
            if (!first) sb.append(',');
            first = false;
            sb.append("{\"type\":\"").append(ev.getType().name()).append("\",\"time\":")
                    .append(ev.getTime());
            // Source component name — tells dual-deployment rockets apart
            // (WHICH recovery device deployed: drogue vs main).
            RocketComponent src = ev.getSource();
            if (src != null && src.getName() != null) {
                sb.append(",\"source\":\"").append(escape(src.getName())).append('"');
            }
            sb.append('}');
        }
        sb.append(']');
    }

    private static void appendBranchSeries(StringBuilder sb, FlightDataBranch branch) {
        sb.append('{');
        appendSeries(sb, "time", branch.get(FlightDataType.TYPE_TIME)).append(',');
        appendSeries(sb, "altitude", branch.get(FlightDataType.TYPE_ALTITUDE)).append(',');
        appendSeries(sb, "velocity", branch.get(FlightDataType.TYPE_VELOCITY_TOTAL)).append(',');
        appendSeries(sb, "acceleration", branch.get(FlightDataType.TYPE_ACCELERATION_TOTAL)).append(',');
        appendSeries(sb, "mass", branch.get(FlightDataType.TYPE_MASS)).append(',');
        appendSeries(sb, "thrust", branch.get(FlightDataType.TYPE_THRUST_FORCE)).append(',');
        appendSeries(sb, "drag", branch.get(FlightDataType.TYPE_DRAG_FORCE)).append(',');
        appendSeries(sb, "mach", branch.get(FlightDataType.TYPE_MACH_NUMBER)).append(',');
        appendSeries(sb, "stability", branch.get(FlightDataType.TYPE_STABILITY)).append(',');
        appendSeries(sb, "cpLocation", branch.get(FlightDataType.TYPE_CP_LOCATION)).append(',');
        appendSeries(sb, "cgLocation", branch.get(FlightDataType.TYPE_CG_LOCATION)).append(',');
        appendSeries(sb, "aoa", branch.get(FlightDataType.TYPE_AOA));
        sb.append('}');
    }

    private static StringBuilder appendSeries(StringBuilder sb, String name, List<Double> values) {
        sb.append('"').append(name).append("\":[");
        if (values != null) {
            for (int i = 0; i < values.size(); i++) {
                if (i > 0) sb.append(',');
                Double v = values.get(i);
                sb.append(v == null || v.isNaN() ? "null" : v.toString());
            }
        }
        return sb.append(']');
    }

    private static StringBuilder num(StringBuilder sb, String key, double value) {
        sb.append('"').append(key).append("\":");
        if (Double.isNaN(value) || Double.isInfinite(value)) {
            return sb.append("null");
        }
        return sb.append(value);
    }

    private static String escape(String s) {
        return s.replace("\\", "\\\\").replace("\"", "\\\"");
    }
}
