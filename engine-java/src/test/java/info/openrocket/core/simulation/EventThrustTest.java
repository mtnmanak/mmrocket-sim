package info.openrocket.core.simulation;

import static org.junit.jupiter.api.Assertions.*;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

import info.openrocket.core.aerodynamics.BarrowmanCalculator;
import info.openrocket.core.document.Simulation;
import info.openrocket.core.logging.SimulationAbort;
import info.openrocket.core.masscalc.MassCalculator;
import info.openrocket.core.material.Material;
import info.openrocket.core.models.atmosphere.AtmosphericConditions;
import info.openrocket.core.models.atmosphere.ExtendedISAModel;
import info.openrocket.core.models.gravity.WGSGravityModel;
import info.openrocket.core.models.wind.PinkNoiseWindModel;
import info.openrocket.core.motor.*;
import info.openrocket.core.rocketcomponent.*;
import info.openrocket.core.rocketcomponent.position.AxialMethod;
import info.openrocket.core.simulation.listeners.AbstractSimulationListener;
import info.openrocket.core.simulation.exception.SimulationException;
import info.openrocket.core.simulation.listeners.system.OptimumCoastListener;
import info.openrocket.core.util.Coordinate;
import info.openrocket.core.util.GeodeticComputationStrategy;
import info.openrocket.core.util.MathUtil;
import info.openrocket.core.util.WorldCoordinate;

/** OR #3375: event-time thrust, plus controls for the existing thrust policy. */
class EventThrustTest {
    static final double[] TIMES = {0, 0.1, 0.3, 0.5, 1, 1.5, 1.85, 2};
    static final double[] THRUSTS = {0, 12, 6, 5.1, 4.9, 4.8, 4.5, 0};

    @Test void staleHighSampleDoesNotAbortCoastingRocket() {
        for (double step : new double[] {0.05, 0.025}) seededFlight(2.5, THRUSTS[1], false, step, false);
    }

    @Test void staleLowSampleStillAbortsBurningRocket() {
        for (double step : new double[] {0.05, 0.025}) seededFlight(0.75, 0, true, step, false);
    }

    @Test void tailBeforeBurnoutStillAbortsDespiteRecordedZero() {
        for (double step : new double[] {0.005, 0.0025}) seededFlight(1.975, 0, true, step, true);
    }

    @Test void afterBurnoutTumblesDespiteRecordedPoweredSample() {
        for (double step : new double[] {0.005, 0.0025}) seededFlight(2.005, THRUSTS[1], false, step, true);
    }

    private static void seededFlight(double trigger, double seed, boolean burning, double step, boolean boundary) {
        Fixture f = reference();
        installMotor(f, f.mount, TIMES, THRUSTS, IgnitionEvent.LAUNCH, Motor.PLUGGED_DELAY);
        EventCounts counts = new EventCounts();
        SeedTumble listener = new SeedTumble(counts, trigger, seed, burning, boundary);
        FlightDataBranch b = fly(f, step, listener).getBranch(0);
        assertEquals(1, counts.injected, "event thrust: injection must happen once in the main run");
        assertEquals(1, counts.handled, "event thrust: injected TUMBLE must be handled once");
        assertEquals(counts.queuedTime, counts.eventTime, 1e-12, "event thrust: queued timestamp changed (s)");
        assertEquals(counts.eventTime, counts.statusTime, 1e-12, "event thrust: immediate event handled at another status time (s)");
        assertTrue(counts.statusTime >= trigger && counts.statusTime <= trigger + step + 1e-9,
                "event thrust: trigger outside one accepted step (s)");
        System.out.println("event thrust trigger=" + trigger + " event=" + counts.eventTime
                + " status=" + counts.statusTime + " curve=" + counts.curveThrust);
        if (burning) {
            assertTrue(aborted(b, SimulationAbort.Cause.TUMBLE_UNDER_THRUST),
                    "event thrust: stale-low sample let a burning rocket tumble");
            assertTrue(events(b, FlightEvent.Type.TUMBLE).isEmpty(), "event thrust: burning rocket entered tumble stepper");
        } else {
            assertEquals(1, events(b, FlightEvent.Type.TUMBLE).size(),
                    "event thrust: stale-high sample aborted a coasting rocket");
            assertTrue(events(b, FlightEvent.Type.SIM_ABORT).isEmpty(),
                    "event thrust: stale-high sample aborted a coasting rocket");
            assertEquals(1, events(b, FlightEvent.Type.GROUND_HIT).size(), "event thrust: tumbling descent did not reach ground");
            assertTrue(counts.tumblingAtGround, "event thrust: descent did not use tumbling state");
        }
    }

    @Test void finlessSeparatedBoosterUsesCurrentThrustWithoutSeeding() {
        Fixture f = reference();
        f.stage.setName("Sustainer");
        // The extra aft motor moves CG aft. As in the upstream CHAD fixture,
        // enlarge/sweep the SUSTAINER fins so it reaches booster separation.
        TrapezoidFinSet fins = (TrapezoidFinSet) f.body.getChild(0);
        fins.setSweep(0.071);
        fins.setTipChord(0.055);
        installMotor(f, f.mount, TIMES, THRUSTS, IgnitionEvent.BURNOUT, 1);
        addChute(f, DeploymentConfiguration.DeployEvent.EJECTION);
        AxialStage booster = new AxialStage();
        booster.setName("CHAD booster");
        f.rocket.addChild(booster);
        booster.getSeparationConfigurations().getDefault().setSeparationEvent(
                StageSeparationConfiguration.SeparationEvent.BURNOUT);
        booster.getSeparationConfigurations().getDefault().setSeparationDelay(0);
        // No nose or fins: isolated cylinder has zero CP weight and checkGeometry queues TUMBLE.
        BodyTube body = new BodyTube(0.07, 0.009, 0);
        booster.addChild(body);
        body.setMotorMount(true);
        installMotor(f, body, TIMES, THRUSTS, IgnitionEvent.LAUNCH, Motor.PLUGGED_DELAY);
        EventCounts counts = new EventCounts();
        FlightData data = fly(f, 0.05, new MainListener() {
            @Override public boolean handleFlightEvent(SimulationStatus s, FlightEvent e) {
                if (!coast && e.getType() == FlightEvent.Type.TUMBLE && "CHAD booster".equals(s.getFlightDataBranch().getName())) {
                    counts.handled++;
                    counts.seedAtHandling = s.getFlightDataBranch().getLast(FlightDataType.TYPE_THRUST_FORCE);
                    counts.eventTime = e.getTime();
                    counts.statusTime = s.getSimulationTime();
                    for (MotorClusterState m : s.getActiveMotors()) counts.curveThrust += m.getThrust(s.getSimulationTime());
                }
                return true;
            }
        });
        assertEquals(2, data.getBranchCount(), "event thrust CHAD: separation did not create two branches: " + data.getBranch(0).getEvents());
        FlightDataBranch b = branchNamed(data, "CHAD booster");
        assertEquals(1, counts.handled, "event thrust CHAD: natural geometry TUMBLE missing");
        assertTrue(counts.seedAtHandling > 0.01, "event thrust CHAD: copied parent sample must naturally be powered");
        assertEquals(0, counts.curveThrust, 1e-12, "event thrust CHAD: separated motor must be burnt out (N)");
        assertEquals(counts.eventTime, counts.statusTime, 1e-12, "event thrust CHAD: event/status time (s)");
        System.out.println("event thrust CHAD event=" + counts.eventTime + " status=" + counts.statusTime
                + " copied thrust=" + counts.seedAtHandling);
        assertEquals(1, events(b, FlightEvent.Type.TUMBLE).size(), "event thrust CHAD: stale parent thrust aborted booster");
        assertFalse(aborted(b, SimulationAbort.Cause.TUMBLE_UNDER_THRUST), "event thrust CHAD: coasting booster aborted");
        FlightDataBranch sustainer = branchNamed(data, "Sustainer");
        assertTrue(events(sustainer, FlightEvent.Type.SIM_ABORT).isEmpty(), "event thrust CHAD: sustainer aborted");
        boolean sustainerIgnited = false;
        for (FlightEvent e : events(sustainer, FlightEvent.Type.IGNITION)) {
            if (e.getSource().getID().equals(f.mount.getID())) {
                sustainerIgnited = true;
                assertEquals(counts.eventTime, e.getTime(), 0.05 + 1e-9, "event thrust CHAD: ignition at separation (s)");
            }
        }
        assertTrue(sustainerIgnited, "event thrust CHAD: sustainer did not ignite");
    }

    @Test void pressureArithmeticControlsCoverModelsAltitudeAreaAndRepeatedInstances() throws Exception {
        // Controls for existing pressure arithmetic, now reached through the new event helper.
        for (String model : new String[] {"classic", "kbf", "supersonic", "hybrid"}) {
            for (double site : new double[] {0, 1500}) checkPressure(model, 0.012, site, 1000, false, false);
        }
        checkPressure("kbf", 0, 0, 1000, false, false);
        checkPressure("kbf", 0.12, -500, 0, true, false);
        checkPressure("kbf", 0.012, 0, 1000, false, true);
    }

    private static void checkPressure(String model, double diameter, double site, double z,
            boolean highPressure, boolean repeated) throws Exception {
        Fixture f = reference();
        AxialStage motorStage = f.stage;
        MotorMount mount = f.mount;
        if (repeated) {
            ParallelStage pair = new ParallelStage();
            f.body.addChild(pair);
            pair.setInstanceCount(2);
            BodyTube body = new BodyTube(0.10, 0.012, 0.0003);
            pair.addChild(body);
            body.setMotorMount(true);
            motorStage = pair;
            mount = body;
        }
        motorStage.setNozzleExitDiameter(diameter);
        double plateau = 0.005;
        installMotor(f, mount, new double[] {0, 0.1, 1.9, 2}, new double[] {0, plateau, plateau, 0},
                IgnitionEvent.LAUNCH, Motor.PLUGGED_DELAY);
        SimulationConditions c = conditions(f, 0.05);
        c.setAerodynamicCalculator(calculator(model));
        c.setLaunchSite(new WorldCoordinate(28.61, -80.60, site));
        // InterpolatingAtmosphericModel clamps negative altitude to its 0 m layer.
        // A negative site alone does NOT make standard ISA pressure exceed 101325 Pa.
        if (highPressure) c.setAtmosphericModel(new ExtendedISAModel(288.15, 105000));
        Probe probe = new Probe();
        c.getSimulationListenerList().add(probe);
        SimulationStatus s = new SimulationStatus(f.rocket.getSelectedConfiguration(), c);
        s.setSimulationTime(0.5);
        s.setRocketPosition(new Coordinate(0, 0, z));
        List<MotorClusterState> motors = new ArrayList<>(s.getActiveMotors());
        assertEquals(1, motors.size(), "event pressure: one configured motor cluster");
        MotorClusterState motor = motors.get(0);
        motor.ignite(0);
        int instances = repeated ? 2 : 1;
        assertEquals(instances, motorStage.getComponentLocations().length, "event pressure: physical stage instance count");
        double curve = instances * plateau;
        assertEquals(curve, motor.getThrust(s.getSimulationTime()), 1e-12, "event pressure: active plateau curve (N)");
        double pressure = c.getAtmosphericModel().getConditions(z + site).getPressure();
        double correction = instances * Math.PI * Math.pow(diameter / 2, 2) * (101325 - pressure);
        double expected = "classic".equals(model) ? curve : Math.max(0, curve + correction);
        if (highPressure) {
            assertTrue(pressure > 101325 && curve + correction < 0, "event pressure: zero-floor fixture must be negative before clamp");
        } else if (!"classic".equals(model) && diameter > 0 && !repeated) {
            assertTrue(curve < 0.01 && expected > 0.01, "event pressure: correction must cross TUMBLE threshold (N)");
        }
        ThrustState state = motor.currentState;
        double ignition = motor.getIgnitionTime(), cutoff = motor.getCutOffTime(), ejection = motor.ejectionTime;
        RK4SimulationStepper stepper = new RK4SimulationStepper();
        double first = stepper.calculateEventThrust(s);
        // 1e-12 relative + 1e-12 N absolute: roundoff, not physical uncertainty.
        assertEquals(expected, first, Math.abs(expected) * 1e-12 + 1e-12, "event pressure: model/altitude/area/instance arithmetic " + model);
        assertEquals(first, stepper.calculateEventThrust(s), "event pressure: repeat query changed thrust");
        if ("classic".equals(model) || diameter == 0) assertEquals(curve, first, "event pressure control: off path must be exact");
        assertEquals(0, probe.wind, "event pressure: helper sampled wind");
        assertTrue(probe.atmosphere >= 2, "event pressure: helper bypassed atmosphere hooks");
        assertSame(state, motor.currentState, "event pressure: helper advanced motor state");
        assertEquals(ignition, motor.getIgnitionTime(), "event pressure: ignition time changed");
        assertEquals(cutoff, motor.getCutOffTime(), "event pressure: cutoff time changed");
        assertEquals(ejection, motor.ejectionTime, "event pressure: ejection time changed");
        assertEquals(0.5, s.getSimulationTime(), "event pressure: helper advanced time");
        if (repeated) {
            s.getConfiguration().setOnlyStage(f.stage.getStageNumber());
            assertTrue(s.getActiveMotors().isEmpty(), "event pressure: inactive-stage control needs no active motor");
            assertEquals(0, stepper.calculateEventThrust(s), 1e-12, "event pressure: inactive stage contributed thrust");
        }
    }

    @Test void thrustListenerOverrideControlsReachEventHelper() throws Exception {
        for (boolean pre : new boolean[] {true, false}) {
            Fixture f = reference();
            installMotor(f, f.mount, TIMES, THRUSTS, IgnitionEvent.LAUNCH, Motor.PLUGGED_DELAY);
            SimulationConditions c = conditions(f, 0.05);
            c.getSimulationListenerList().add(new AbstractSimulationListener() {
                @Override public double preSimpleThrustCalculation(SimulationStatus s) { return pre ? 123 : Double.NaN; }
                @Override public double postSimpleThrustCalculation(SimulationStatus s, double thrust) { return thrust + 7; }
            });
            SimulationStatus s = new SimulationStatus(f.rocket.getSelectedConfiguration(), c);
            s.setFlightDataBranch(new FlightDataBranch("Listener control", FlightDataType.TYPE_TIME));
            s.setSimulationTime(0.75);
            MotorClusterState m = s.getActiveMotors().iterator().next();
            m.ignite(0);
            double expected = pre ? 123 : interpolate(TIMES, THRUSTS, 0.75) + 7;
            assertEquals(expected, new RK4SimulationStepper().calculateEventThrust(s), 1e-12,
                    "event thrust listener control: " + (pre ? "pre override (bypasses post)" : "post override"));
        }
    }

    @Test void recoveryUnderTinyCurveThrustRemainsAnEpsilonPolicyControl() {
        // Control: upstream #3382's summed > 0.01 N policy would NOT abort here.
        // Keep 24.12's any-active-motor > EPSILON deployment policy intentionally.
        Fixture f = reference();
        double tiny = 0.005;
        double[] times = {0, 0.1, 0.5, 0.6, 1.5, 2};
        double[] thrust = {0, 12, 6, tiny, tiny, 0};
        installMotor(f, f.mount, times, thrust, IgnitionEvent.LAUNCH, Motor.PLUGGED_DELAY);
        addChute(f, DeploymentConfiguration.DeployEvent.NEVER);
        EventCounts counts = new EventCounts();
        FlightDataBranch b = fly(f, 0.01, new MainListener() {
            @Override public void postStep(SimulationStatus s) throws SimulationException {
                if (coast || counts.injected > 0 || s.getSimulationTime() < 0.8) return;
                counts.injected++;
                double actual = s.getActiveMotors().iterator().next().getThrust(s.getSimulationTime());
                assertEquals(tiny, actual, 1e-12, "recovery policy control: tiny curve plateau (N)");
                assertTrue(actual > MathUtil.EPSILON && actual < 0.01, "recovery policy control: thresholds must disagree");
                for (RocketComponent component : s.getConfiguration().getActiveComponents()) {
                    if (component instanceof Parachute) s.addEvent(new FlightEvent(
                            FlightEvent.Type.RECOVERY_DEVICE_DEPLOYMENT, s.getSimulationTime(), component));
                }
            }
        }).getBranch(0);
        assertEquals(1, counts.injected, "recovery policy control: deployment not injected");
        assertTrue(aborted(b, SimulationAbort.Cause.DEPLOY_UNDER_THRUST), "recovery policy control: EPSILON policy changed to 0.01 N");
    }

    static class MainListener extends AbstractSimulationListener {
        boolean coast;
        @Override public void startSimulation(SimulationStatus s) {
            coast = s.getSimulationConditions().getSimulationListenerList().contains(OptimumCoastListener.INSTANCE);
        }
    }

    private static final class Probe extends AbstractSimulationListener {
        int wind, atmosphere;
        @Override public Coordinate preWindModel(SimulationStatus s) { wind++; return null; }
        @Override public AtmosphericConditions preAtmosphericModel(SimulationStatus s) { atmosphere++; return null; }
    }

    private static final class EventCounts {
        int injected, handled;
        double queuedTime, eventTime, statusTime, curveThrust, seedAtHandling;
        boolean tumblingAtGround;
    }

    private static final class SeedTumble extends MainListener {
        final EventCounts counts;
        final double trigger, seed;
        final boolean burning, boundary;
        SeedTumble(EventCounts counts, double trigger, double seed, boolean burning, boolean boundary) {
            this.counts = counts; this.trigger = trigger; this.seed = seed; this.burning = burning; this.boundary = boundary;
        }
        @Override public void postStep(SimulationStatus s) throws SimulationException {
            if (coast || counts.injected > 0 || s.getSimulationTime() < trigger) return;
            counts.injected++;
            counts.queuedTime = s.getSimulationTime();
            counts.curveThrust = interpolate(TIMES, THRUSTS, s.getSimulationTime());
            if (burning) {
                assertTrue(counts.curveThrust > 0.01, "event thrust: actual injection must still be powered (N)");
                if (boundary) assertTrue(s.getSimulationTime() > TIMES[TIMES.length - 2]
                        && s.getSimulationTime() < TIMES[TIMES.length - 1], "event thrust: actual injection missed linear tail");
            } else assertEquals(0, counts.curveThrust, 1e-12, "event thrust: actual injection must follow burnout (N)");
            double active = 0;
            for (MotorClusterState m : s.getActiveMotors()) active += m.getThrust(s.getSimulationTime());
            assertEquals(counts.curveThrust, active, 1e-12, "event thrust: motor state disagrees with independent curve interpolation");
            FlightDataBranch b = s.getFlightDataBranch();
            int rows = b.getLength();
            b.setValue(FlightDataType.TYPE_THRUST_FORCE, seed);
            assertEquals(seed, b.getLast(FlightDataType.TYPE_THRUST_FORCE), "event thrust: seed did not replace last sample");
            assertEquals(rows, b.getLength(), "event thrust: seeding appended a row");
            s.addEvent(new FlightEvent(FlightEvent.Type.TUMBLE, s.getSimulationTime()));
        }
        @Override public boolean handleFlightEvent(SimulationStatus s, FlightEvent e) {
            if (!coast && e.getType() == FlightEvent.Type.TUMBLE) {
                counts.handled++;
                counts.eventTime = e.getTime(); counts.statusTime = s.getSimulationTime();
                assertEquals(seed, s.getFlightDataBranch().getLast(FlightDataType.TYPE_THRUST_FORCE),
                        "event thrust: seeded sample lost before TUMBLE decision");
            }
            if (!coast && e.getType() == FlightEvent.Type.GROUND_HIT) counts.tumblingAtGround = s.isTumbling();
            return true;
        }
    }

    static final class Fixture {
        final Rocket rocket = new Rocket();
        final AxialStage stage = new AxialStage();
        final FlightConfigurationId fcid = new FlightConfigurationId("00003375-0001-4001-8001-000000000001");
        BodyTube body;
        InnerTube mount;
    }

    static Fixture reference() {
        Fixture f = new Fixture();
        f.stage.setName("Core");
        f.rocket.addChild(f.stage);
        NoseCone nose = new NoseCone(Transition.Shape.OGIVE, 0.07, 0.012);
        nose.setThickness(0.002);
        f.stage.addChild(nose);
        f.body = new BodyTube(0.30, 0.012, 0.0003);
        f.body.setMaterial(Material.newMaterial(Material.Type.BULK, "Kraft phenolic", 950, false));
        f.stage.addChild(f.body);
        TrapezoidFinSet fins = new TrapezoidFinSet(3, 0.05, 0.03, 0.02, 0.03);
        fins.setThickness(0.003);
        fins.setCrossSection(FinSet.CrossSection.ROUNDED);
        f.body.addChild(fins);
        f.mount = new InnerTube();
        f.mount.setLength(0.07); f.mount.setOuterRadius(0.0095); f.mount.setThickness(0.0005);
        f.mount.setMotorMount(true);
        f.body.addChild(f.mount);
        f.mount.setAxialMethod(AxialMethod.BOTTOM); f.mount.setAxialOffset(0);
        f.rocket.createFlightConfiguration(f.fcid);
        f.rocket.setSelectedConfiguration(f.fcid);
        f.rocket.enableEvents();
        return f;
    }

    static void addChute(Fixture f, DeploymentConfiguration.DeployEvent event) {
        Parachute chute = new Parachute();
        chute.setDiameter(0.30);
        chute.getDeploymentConfigurations().getDefault().setDeployEvent(event);
        chute.getDeploymentConfigurations().getDefault().setDeployDelay(0);
        f.body.addChild(chute);
    }

    static void installMotor(Fixture f, MotorMount mount, double[] times, double[] thrust,
            IgnitionEvent ignition, double delay) {
        Coordinate[] cg = new Coordinate[times.length];
        for (int i = 0; i < cg.length; i++) cg[i] = new Coordinate(0.035, 0, 0,
                0.024 - 0.0108 * times[i] / times[times.length - 1]);
        ThrustCurveMotor motor = new ThrustCurveMotor.Builder()
                .setManufacturer(Manufacturer.getManufacturer("Estes"))
                .setDesignation("T2").setCommonName("T2").setMotorType(Motor.Type.SINGLE)
                .setStandardDelays(new double[] {0, 1, 3}).setDiameter(0.018).setLength(0.07)
                .setTimePoints(times).setThrustPoints(thrust).setCGPoints(cg).setDigest("event-thrust-t2").build();
        MotorConfiguration mc = new MotorConfiguration(mount, f.fcid);
        mc.setMotor(motor); mc.setEjectionDelay(delay); mc.setIgnitionEvent(ignition); mc.setIgnitionDelay(0);
        mount.setMotorConfig(mc, f.fcid);
    }

    static BarrowmanCalculator calculator(String model) {
        if ("hybrid".equals(model)) return BarrowmanCalculator.hybrid(0.8, 1.2);
        BarrowmanCalculator c = new BarrowmanCalculator();
        if ("kbf".equals(model)) c.setRogersKbf(true);
        if ("supersonic".equals(model)) c.setSupersonicAero(true);
        return c;
    }

    static SimulationConditions conditions(Fixture f, double step) {
        // Direct MotorMount.setMotorConfig does not refresh the configuration's
        // motor cache; the event engine's clone normally performs that refresh.
        f.rocket.getSelectedConfiguration().update();
        f.rocket.getSelectedConfiguration().setAllStages();
        SimulationConditions c = new SimulationConditions();
        c.setSimulation(new Simulation(f.rocket, f.fcid));
        c.setLaunchRodLength(1); c.setLaunchRodAngle(0); c.setLaunchRodDirection(Math.PI / 2);
        c.setLaunchSite(new WorldCoordinate(28.61, -80.60, 0));
        c.setGeodeticComputation(GeodeticComputationStrategy.SPHERICAL);
        c.setAtmosphericModel(new ExtendedISAModel()); c.setGravityModel(new WGSGravityModel());
        PinkNoiseWindModel wind = new PinkNoiseWindModel();
        wind.setAverage(0); wind.setStandardDeviation(0); c.setWindModel(wind);
        c.setAerodynamicCalculator(new BarrowmanCalculator()); c.setMassCalculator(new MassCalculator());
        c.setTimeStep(step); c.setMaxSimulationTime(1200); c.setRandomSeed(0x3375);
        return c;
    }

    static FlightData fly(Fixture f, double step, AbstractSimulationListener listener) {
        return fly(conditions(f, step), listener);
    }

    static FlightData fly(SimulationConditions c, AbstractSimulationListener listener) {
        return assertTimeoutPreemptively(Duration.ofSeconds(30), () -> {
            c.getSimulationListenerList().add(listener);
            BasicEventSimulationEngine engine = new BasicEventSimulationEngine();
            engine.simulate(c);
            assertTrue(engine.getFlightData().getBranchCount() > 0, "event regression: no flight branch");
            return engine.getFlightData();
        });
    }

    static double interpolate(double[] times, double[] values, double t) {
        if (t >= times[times.length - 1]) return 0;
        for (int i = 1; i < times.length; i++) {
            if (t <= times[i]) return values[i - 1] + (values[i] - values[i - 1])
                    * (t - times[i - 1]) / (times[i] - times[i - 1]);
        }
        throw new AssertionError("curve fixture: unbracketed time");
    }

    static List<FlightEvent> events(FlightDataBranch b, FlightEvent.Type type) {
        List<FlightEvent> result = new ArrayList<>();
        for (FlightEvent e : b.getEvents()) if (e.getType() == type) result.add(e);
        return result;
    }

    static boolean aborted(FlightDataBranch b, SimulationAbort.Cause cause) {
        for (FlightEvent e : events(b, FlightEvent.Type.SIM_ABORT)) {
            if (((SimulationAbort) e.getData()).getCause() == cause) return true;
        }
        return false;
    }

    static FlightDataBranch branchNamed(FlightData data, String name) {
        for (int i = 0; i < data.getBranchCount(); i++) if (name.equals(data.getBranch(i).getName())) return data.getBranch(i);
        return fail("event thrust: missing branch " + name);
    }
}
