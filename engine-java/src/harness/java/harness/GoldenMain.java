package harness;

import info.openrocket.core.masscalc.MassCalculator;
import info.openrocket.core.masscalc.RigidBody;
import info.openrocket.core.material.Material;
import info.openrocket.core.models.atmosphere.AtmosphericConditions;
import info.openrocket.core.models.atmosphere.ExtendedISAModel;
import info.openrocket.core.rocketcomponent.AxialStage;
import info.openrocket.core.rocketcomponent.BodyTube;
import info.openrocket.core.rocketcomponent.FlightConfiguration;
import info.openrocket.core.rocketcomponent.InnerTube;
import info.openrocket.core.rocketcomponent.NoseCone;
import info.openrocket.core.rocketcomponent.Parachute;
import info.openrocket.core.rocketcomponent.Rocket;
import info.openrocket.core.rocketcomponent.Transition;
import info.openrocket.core.rocketcomponent.TrapezoidFinSet;
import info.openrocket.core.util.Coordinate;
import info.openrocket.core.util.Quaternion;

/**
 * Golden-scenario harness. Runs identical scenarios on the JVM and under
 * TeaVM-JS; every line of output must match BIT-FOR-BIT between the two
 * (Double.toString of the raw values — no rounding, no formatting locale).
 *
 * Scenarios grow with each carve slice (P1.2 mass/CG, P1.3 CP/CD, P1.4 flight).
 */
public final class GoldenMain {
    public static void main(String[] args) {
        atmosphereScenarios();
        quaternionScenarios();
        massScenarios();
        aeroScenarios();
        randomScenarios();
        flightScenarios();
    }

    /** java.util.Random is algorithm-specified (LCG) — verify TeaVM matches. */
    private static void randomScenarios() {
        java.util.Random r = new java.util.Random(42);
        line("random.seeded42", r.nextDouble(), r.nextDouble(), r.nextGaussian(), r.nextGaussian());
    }

    /** P1.4: full 6DOF flight — C6-class motor, no wind, ISA, WGS gravity. */
    private static void flightScenarios() {
        Rocket rocket = buildReferenceRocket();
        // Dedicated flight configuration (motors cannot attach to the default config).
        info.openrocket.core.rocketcomponent.FlightConfigurationId fcid =
                new info.openrocket.core.rocketcomponent.FlightConfigurationId(
                        "00000001-0001-4001-8001-000000000001");
        rocket.createFlightConfiguration(fcid);
        rocket.setSelectedConfiguration(fcid);

        // C6-class motor built from explicit data points (deterministic; no db).
        info.openrocket.core.motor.ThrustCurveMotor motor =
                new info.openrocket.core.motor.ThrustCurveMotor.Builder()
                        .setManufacturer(info.openrocket.core.motor.Manufacturer.getManufacturer("Estes"))
                        .setDesignation("C6")
                        .setCommonName("C6")
                        .setMotorType(info.openrocket.core.motor.Motor.Type.SINGLE)
                        .setStandardDelays(new double[] { 3, 5, 7 })
                        .setDiameter(0.018)
                        .setLength(0.070)
                        .setTimePoints(new double[] { 0, 0.1, 0.3, 0.5, 1.0, 1.5, 1.85, 2.0 })
                        .setThrustPoints(new double[] { 0, 12.0, 6.0, 5.1, 4.9, 4.8, 4.5, 0 })
                        .setCGPoints(new Coordinate[] {
                                new Coordinate(0.035, 0, 0, 0.0240), new Coordinate(0.035, 0, 0, 0.0231),
                                new Coordinate(0.035, 0, 0, 0.0215), new Coordinate(0.035, 0, 0, 0.0202),
                                new Coordinate(0.035, 0, 0, 0.0174), new Coordinate(0.035, 0, 0, 0.0147),
                                new Coordinate(0.035, 0, 0, 0.0133), new Coordinate(0.035, 0, 0, 0.0132) })
                        .setDigest("harness-c6")
                        .build();

        // Attach to the inner-tube mount.
        InnerTube mount = null;
        for (info.openrocket.core.rocketcomponent.RocketComponent c
                : rocket.getSelectedConfiguration().getAllComponents()) {
            if (c instanceof InnerTube) {
                mount = (InnerTube) c;
            }
        }
        mount.setMotorMount(true);
        info.openrocket.core.motor.MotorConfiguration mc =
                new info.openrocket.core.motor.MotorConfiguration(mount, fcid);
        mc.setMotor(motor);
        mc.setEjectionDelay(5.0);
        mount.setMotorConfig(mc, fcid);

        info.openrocket.core.simulation.SimulationConditions conditions =
                new info.openrocket.core.simulation.SimulationConditions();
        conditions.setSimulation(new info.openrocket.core.document.Simulation(rocket, fcid));
        conditions.setLaunchRodLength(1.0);
        conditions.setLaunchRodAngle(0.0);
        conditions.setLaunchRodDirection(Math.PI / 2);
        conditions.setLaunchSite(new info.openrocket.core.util.WorldCoordinate(28.61, -80.60, 0));
        conditions.setGeodeticComputation(info.openrocket.core.util.GeodeticComputationStrategy.SPHERICAL);
        conditions.setAtmosphericModel(new ExtendedISAModel());
        conditions.setGravityModel(new info.openrocket.core.models.gravity.WGSGravityModel());
        info.openrocket.core.models.wind.PinkNoiseWindModel wind =
                new info.openrocket.core.models.wind.PinkNoiseWindModel();
        wind.setAverage(0.0);
        wind.setStandardDeviation(0.0);
        conditions.setWindModel(wind);
        conditions.setAerodynamicCalculator(new info.openrocket.core.aerodynamics.BarrowmanCalculator());
        conditions.setMassCalculator(new MassCalculator());
        conditions.setTimeStep(0.05);
        conditions.setMaxSimulationTime(1200);
        conditions.setRandomSeed(42);

        try {
            info.openrocket.core.simulation.BasicEventSimulationEngine engine =
                    new info.openrocket.core.simulation.BasicEventSimulationEngine();
            engine.simulate(conditions);
            info.openrocket.core.simulation.FlightData data = engine.getFlightData();

            line("flight.summary", data.getMaxAltitude(), data.getMaxVelocity(),
                    data.getMaxAcceleration(), data.getTimeToApogee(),
                    data.getFlightTime(), data.getGroundHitVelocity(), data.getBranchCount());

            info.openrocket.core.simulation.FlightDataBranch branch = data.getBranch(0);
            for (info.openrocket.core.simulation.FlightEvent ev : branch.getEvents()) {
                line("flight.event." + ev.getType().name(), ev.getTime());
                if (ev.getData() != null) {
                    System.out.println("flight.eventdata|" + ev.getType().name() + "|" + ev.getData());
                }
            }

            java.util.List<Double> t = branch.get(
                    info.openrocket.core.simulation.FlightDataType.TYPE_TIME);
            java.util.List<Double> alt = branch.get(
                    info.openrocket.core.simulation.FlightDataType.TYPE_ALTITUDE);
            java.util.List<Double> vel = branch.get(
                    info.openrocket.core.simulation.FlightDataType.TYPE_VELOCITY_TOTAL);
            java.util.List<Double> acc = branch.get(
                    info.openrocket.core.simulation.FlightDataType.TYPE_ACCELERATION_TOTAL);
            line("flight.rows", t.size());
            if (alt != null && vel != null && acc != null) {
                for (int i = 0; i < t.size(); i += 25) {
                    line("flight.sample." + i, t.get(i), alt.get(i), vel.get(i), acc.get(i));
                }
            }
        } catch (info.openrocket.core.simulation.exception.SimulationException e) {
            line("flight.exception", -1);
            System.out.println("EXCEPTION: " + e);
        }
    }

    /** P1.3: Extended-Barrowman CP and force coefficients across Mach and AoA. */
    private static void aeroScenarios() {
        Rocket rocket = buildReferenceRocket();
        FlightConfiguration config = rocket.getSelectedConfiguration();
        info.openrocket.core.aerodynamics.BarrowmanCalculator calc =
                new info.openrocket.core.aerodynamics.BarrowmanCalculator();
        info.openrocket.core.logging.WarningSet warnings =
                new info.openrocket.core.logging.WarningSet();

        double[] machs = { 0.1, 0.3, 0.5, 0.8, 0.95, 1.05, 1.5, 2.0 };
        double[] aoasDeg = { 0, 2, 5, 15 };

        for (double mach : machs) {
            for (double aoaDeg : aoasDeg) {
                info.openrocket.core.aerodynamics.FlightConditions conditions =
                        new info.openrocket.core.aerodynamics.FlightConditions(config);
                conditions.setMach(mach);
                conditions.setAOA(Math.toRadians(aoaDeg));

                warnings.clear();
                Coordinate cp = calc.getCP(config, conditions, warnings);
                info.openrocket.core.aerodynamics.AerodynamicForces forces =
                        calc.getAerodynamicForces(config, conditions, warnings);

                line("aero.cp", mach, aoaDeg, cp.x, cp.weight);
                line("aero.forces", mach, aoaDeg,
                        forces.getCN(), forces.getCm(), forces.getCD(),
                        forces.getCDaxial(), forces.getPressureCD(),
                        forces.getBaseCD(), forces.getFrictionCD());
            }
        }
        line("aero.warnings", warnings.size());

        // Static helper functions (pure math, worth pinning).
        for (double m : machs) {
            line("aero.staticCD", m,
                    info.openrocket.core.aerodynamics.BarrowmanCalculator.calculateStagnationCD(m),
                    info.openrocket.core.aerodynamics.BarrowmanCalculator.calculateBaseCD(m));
        }
    }

    /**
     * Reference rocket (Alpha-III class): ogive nose, body tube, 3 trapezoid
     * fins, inner-tube motor mount, parachute. Mix of default materials
     * (exercises the shimmed preference defaults, identical both sides) and
     * explicit materials.
     */
    private static Rocket buildReferenceRocket() {
        Rocket rocket = new Rocket();
        AxialStage stage = new AxialStage();
        rocket.addChild(stage);

        NoseCone nose = new NoseCone(Transition.Shape.OGIVE, 0.07, 0.012);
        nose.setThickness(0.002);
        stage.addChild(nose);

        BodyTube body = new BodyTube(0.30, 0.012, 0.0003);
        body.setMaterial(Material.newMaterial(Material.Type.BULK, "Kraft phenolic", 950, false));
        stage.addChild(body);

        TrapezoidFinSet fins = new TrapezoidFinSet(3, 0.05, 0.03, 0.02, 0.03);
        fins.setThickness(0.003);
        body.addChild(fins);

        InnerTube mount = new InnerTube();
        mount.setLength(0.07);
        mount.setOuterRadius(0.0095);
        mount.setThickness(0.0005);
        body.addChild(mount);

        Parachute chute = new Parachute();
        chute.setDiameter(0.30);
        body.addChild(chute);

        rocket.enableEvents();
        return rocket;
    }

    private static void massScenarios() {
        Rocket rocket = buildReferenceRocket();
        FlightConfiguration config = rocket.getSelectedConfiguration();

        // Direct per-class calls to the bounds API. These are real golden values
        // AND they force TeaVM's dependency analyzer to link every implementation
        // (it under-links impls reached only via map-key virtual dispatch).
        int bi = 0;
        for (info.openrocket.core.rocketcomponent.RocketComponent c : config.getAllComponents()) {
            double boundsSize = c.getComponentBounds().size();
            double instBox = (c instanceof info.openrocket.core.rocketcomponent.BoxBounded)
                    ? ((info.openrocket.core.rocketcomponent.BoxBounded) c).getInstanceBoundingBox().span().x
                    : -1;
            line("comp.bounds." + (bi++), boundsSize, instBox);
        }

        // Structural counts — golden values AND the first divergence tripwire.
        line("tree.counts", rocket.getChildCount(), config.getAllComponents().size(),
                config.getActiveComponents().size(), config.getActiveStages().size(),
                config.getStageCount(), config.getActiveInstances().size());

        // Per-component masses — localizes any mass divergence to a component.
        // (Indexed tag, not getSimpleName(): TeaVM strips class name metadata.)
        int ci = 0;
        for (info.openrocket.core.rocketcomponent.RocketComponent c : config.getAllComponents()) {
            line("comp.mass." + (ci++), c.getMass(), c.getLength());
        }

        // Instance-context counts — masses aggregate through these transforms.
        // Sorted (HashMap iteration order differs between JVM and TeaVM).
        java.util.List<Integer> ctxCounts = new java.util.ArrayList<>();
        for (java.util.ArrayList<info.openrocket.core.rocketcomponent.InstanceContext> v
                : config.getActiveInstances().values()) {
            ctxCounts.add(v.size());
        }
        java.util.Collections.sort(ctxCounts);
        double[] sortedCounts = new double[ctxCounts.size()];
        for (int i = 0; i < ctxCounts.size(); i++) {
            sortedCounts[i] = ctxCounts.get(i);
        }
        line("tree.ctx.sorted", sortedCounts);

        // Direct probes at the JVM/JS divergence point (fin instance expansion).
        TrapezoidFinSet finProbe = null;
        for (info.openrocket.core.rocketcomponent.RocketComponent c : config.getAllComponents()) {
            if (c instanceof TrapezoidFinSet) {
                finProbe = (TrapezoidFinSet) c;
            }
        }
        line("fins.instances", finProbe.getFinCount(), finProbe.getInstanceCount(),
                finProbe.getInstanceAngles().length, finProbe.getInstanceOffsets().length);

        // Virtual dispatch check: the tree walk calls getInstanceCount() through
        // a RocketComponent-typed reference — must hit FinSet's override (=3).
        info.openrocket.core.rocketcomponent.RocketComponent rcRef = finProbe;
        line("fins.virtual", rcRef.getInstanceCount(), rcRef.getInstanceAngles().length);

        // ConcurrentHashMap emplace probe: repeated emplace on the same key must
        // append (list grows), not replace. InstanceMap extends ConcurrentHashMap.
        info.openrocket.core.rocketcomponent.InstanceMap im =
                new info.openrocket.core.rocketcomponent.InstanceMap();
        im.emplace(finProbe, 0, info.openrocket.core.util.Transformation.IDENTITY);
        im.emplace(finProbe, 1, info.openrocket.core.util.Transformation.IDENTITY);
        im.emplace(finProbe, 2, info.openrocket.core.util.Transformation.IDENTITY);
        line("im.count", im.count(finProbe), im.size());

        // Does an explicit post-enableEvents change event rebuild the contexts?
        line("fins.ctx.before", config.getActiveInstances().count(finProbe));
        finProbe.setFinCount(4);
        line("fins.ctx.after4", config.getActiveInstances().count(finProbe));
        finProbe.setFinCount(3);
        line("fins.ctx.after3", config.getActiveInstances().count(finProbe));

        RigidBody structure = MassCalculator.calculateStructure(config);
        line("mass.structure", structure.getMass(),
                structure.getCM().x, structure.getCM().y, structure.getCM().z,
                structure.getIxx(), structure.getIyy(), structure.getIzz(),
                structure.getLongitudinalInertia(), structure.getRotationalInertia());

        RigidBody burnout = MassCalculator.calculateBurnout(config);
        line("mass.burnout", burnout.getMass(),
                burnout.getCM().x, burnout.getCM().y, burnout.getCM().z,
                burnout.getLongitudinalInertia(), burnout.getRotationalInertia());

        line("rocket.length", rocket.getLength());
    }

    private static void atmosphereScenarios() {
        ExtendedISAModel std = new ExtendedISAModel();
        // Altitudes probing layer boundaries, interpolation midpoints, clamps.
        double[] alts = { -100, 0, 1, 250, 499, 500, 501, 1234.56, 5000, 10999, 11000,
                11001, 15000, 20000, 32000, 47000, 51000, 71000, 84852, 90000 };
        for (double alt : alts) {
            AtmosphericConditions c = std.getConditions(alt);
            line("isa.std", alt, c.getTemperature(), c.getPressure(), c.getDensity(),
                    c.getMachSpeed(), c.getKinematicViscosity());
        }
        // Custom launch-site model (plan: base configurable at site altitude).
        ExtendedISAModel site = new ExtendedISAModel(1400, 285.15, 86000);
        for (double alt : new double[] { 0, 1400, 1401, 3000, 11000, 20000 }) {
            AtmosphericConditions c = site.getConditions(alt);
            line("isa.site1400", alt, c.getTemperature(), c.getPressure(), c.getDensity());
        }
    }

    private static void quaternionScenarios() {
        double[][] rotVecs = {
                { Math.PI / 2, 0, 0 }, { 0, Math.PI / 2, 0 }, { 0, 0, Math.PI / 2 },
                { 0.1, -0.2, 0.3 }, { 1e-9, 0, 0 }, { Math.PI, Math.PI / 3, -Math.PI / 5 },
        };
        Coordinate[] vecs = {
                new Coordinate(1, 0, 0), new Coordinate(0, 1, 0), new Coordinate(0, 0, 1),
                new Coordinate(1.5, -2.5, 3.5),
        };
        for (double[] rv : rotVecs) {
            Quaternion q = Quaternion.rotation(new Coordinate(rv[0], rv[1], rv[2]));
            for (Coordinate v : vecs) {
                Coordinate r = q.rotate(v);
                line("quat.rot", rv[0], rv[1], rv[2], v.x, v.y, v.z, r.x, r.y, r.z);
            }
        }
    }

    /** Canonical output: tag then raw Double.toString values, '|'-separated. */
    private static void line(String tag, double... values) {
        StringBuilder sb = new StringBuilder(tag);
        for (double v : values) {
            sb.append('|').append(v);
        }
        System.out.println(sb);
    }

    private GoldenMain() {}
}
