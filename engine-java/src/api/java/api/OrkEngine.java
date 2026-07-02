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
import info.openrocket.core.motor.Manufacturer;
import info.openrocket.core.motor.Motor;
import info.openrocket.core.motor.MotorConfiguration;
import info.openrocket.core.motor.ThrustCurveMotor;
import info.openrocket.core.rocketcomponent.AxialStage;
import info.openrocket.core.rocketcomponent.BodyTube;
import info.openrocket.core.rocketcomponent.FlightConfigurationId;
import info.openrocket.core.rocketcomponent.InnerTube;
import info.openrocket.core.rocketcomponent.NoseCone;
import info.openrocket.core.rocketcomponent.Parachute;
import info.openrocket.core.rocketcomponent.Rocket;
import info.openrocket.core.rocketcomponent.RocketComponent;
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
        AxialStage stage = new AxialStage();
        rocket.addChild(stage);
        FlightConfigurationId fcid = new FlightConfigurationId();
        rocket.createFlightConfiguration(fcid);
        rocket.setSelectedConfiguration(fcid);

        RocketCtx ctx = new RocketCtx(rocket, stage, fcid);
        // The root node's "components" behave like children of the stage.
        Map<String, Object> stageNode = new java.util.LinkedHashMap<>();
        stageNode.put("children", tree.get("components"));
        ComponentFactory.attachChildren(stage, stageNode, ctx.ids);

        rocket.enableEvents();
        return register(ctx);
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

    // ---------- Analysis ----------

    /** Static design info: length, mass, CG, CP (at Mach 0.3, AoA 0), stability margin in calibers. */
    @JSExport
    public static String getStaticInfo(int rocketHandle) {
        RocketCtx ctx = (RocketCtx) get(rocketHandle);
        RigidBody structure = MassCalculator.calculateLaunch(ctx.rocket.getSelectedConfiguration());

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

    // ---------- Simulation ----------

    /**
     * Runs a full flight simulation. Returns JSON:
     * { summary:{...}, events:[{type,time}...], series:{time[],altitude[],velocity[],acceleration[]} }
     */
    @JSExport
    public static String simulate(int rocketHandle, double launchRodLength, double launchRodAngle,
            double windAverage, double windStdDeviation, double launchAltitude, double timeStep) {
        RocketCtx ctx = (RocketCtx) get(rocketHandle);

        SimulationConditions conditions = new SimulationConditions();
        conditions.setSimulation(new Simulation(ctx.rocket, ctx.fcid));
        conditions.setLaunchRodLength(launchRodLength);
        conditions.setLaunchRodAngle(launchRodAngle);
        conditions.setLaunchRodDirection(Math.PI / 2);
        conditions.setLaunchSite(new WorldCoordinate(28.61, -80.60, launchAltitude));
        conditions.setGeodeticComputation(GeodeticComputationStrategy.SPHERICAL);
        conditions.setAtmosphericModel(new ExtendedISAModel());
        conditions.setGravityModel(new WGSGravityModel());
        PinkNoiseWindModel wind = new PinkNoiseWindModel();
        wind.setAverage(windAverage);
        wind.setStandardDeviation(windStdDeviation);
        conditions.setWindModel(wind);
        conditions.setAerodynamicCalculator(new BarrowmanCalculator());
        conditions.setMassCalculator(new MassCalculator());
        conditions.setTimeStep(timeStep > 0 ? timeStep : 0.05);
        conditions.setMaxSimulationTime(1200);
        conditions.setRandomSeed(42);

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
        num(sb, "timeToApogee", data.getTimeToApogee()).append(',');
        num(sb, "flightTime", data.getFlightTime()).append(',');
        num(sb, "groundHitVelocity", data.getGroundHitVelocity());
        sb.append("},\"events\":[");

        FlightDataBranch branch = data.getBranch(0);
        boolean first = true;
        for (FlightEvent ev : branch.getEvents()) {
            if (!first) sb.append(',');
            first = false;
            sb.append("{\"type\":\"").append(ev.getType().name()).append("\",\"time\":")
                    .append(ev.getTime()).append('}');
        }
        sb.append("],\"series\":{");
        appendSeries(sb, "time", branch.get(FlightDataType.TYPE_TIME)).append(',');
        appendSeries(sb, "altitude", branch.get(FlightDataType.TYPE_ALTITUDE)).append(',');
        appendSeries(sb, "velocity", branch.get(FlightDataType.TYPE_VELOCITY_TOTAL)).append(',');
        appendSeries(sb, "acceleration", branch.get(FlightDataType.TYPE_ACCELERATION_TOTAL));
        return sb.append("}}").toString();
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
