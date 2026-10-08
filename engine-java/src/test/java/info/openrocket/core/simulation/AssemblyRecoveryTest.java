package info.openrocket.core.simulation;

import static org.junit.jupiter.api.Assertions.*;

import java.time.Duration;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.List;
import org.junit.jupiter.api.Test;

import info.openrocket.core.aerodynamics.BarrowmanCalculator;
import info.openrocket.core.document.Simulation;
import info.openrocket.core.masscalc.MassCalculator;
import info.openrocket.core.material.Material;
import info.openrocket.core.models.atmosphere.ExtendedISAModel;
import info.openrocket.core.models.gravity.WGSGravityModel;
import info.openrocket.core.models.wind.PinkNoiseWindModel;
import info.openrocket.core.motor.IgnitionEvent;
import info.openrocket.core.motor.Manufacturer;
import info.openrocket.core.motor.Motor;
import info.openrocket.core.motor.MotorConfiguration;
import info.openrocket.core.motor.ThrustCurveMotor;
import info.openrocket.core.rocketcomponent.*;
import info.openrocket.core.rocketcomponent.position.AxialMethod;
import info.openrocket.core.rocketcomponent.position.RadiusMethod;
import info.openrocket.core.simulation.listeners.AbstractSimulationListener;
import info.openrocket.core.simulation.listeners.system.OptimumCoastListener;
import info.openrocket.core.util.Coordinate;
import info.openrocket.core.util.GeodeticComputationStrategy;
import info.openrocket.core.util.WorldCoordinate;

/** Assembly ownership and both independent deployment guards from OR #2092. */
class AssemblyRecoveryTest {
    private static final Duration WALK_TIMEOUT = Duration.ofSeconds(5);
    private static final Duration FLIGHT_TIMEOUT = Duration.ofSeconds(30);

    @Test
    void podAssemblyReturnsItselfWithoutWalkingPastIt() {
        PodSet pod = new PodSet();
        assertAssembly(pod, pod);
    }

    @Test
    void axialStageAssemblyReturnsItself() {
        AxialStage stage = new AxialStage();
        assertAssembly(stage, stage);
    }

    @Test
    void coreBodyWalkAdvancesToStage() {
        Fixture f = reference();
        assertAssembly(f.stage, f.body);
    }

    @Test
    void podBodyAndInnerTubeResolveInnermostAssembly() {
        Fixture f = reference();
        BodyTube body = podBody(f.body, "Pod");
        InnerTube mount = mount(body, "PodMount", true);
        assertAssembly((PodSet) body.getParent(), body);
        assertAssembly((PodSet) body.getParent(), mount);
    }

    @Test
    void nestedPodWalkStopsAtInnerPod() {
        Fixture f = reference();
        BodyTube outer = podBody(f.body, "Outer");
        BodyTube inner = podBody(outer, "Inner");
        InnerTube mount = mount(inner, "InnerMount", true);
        assertAssembly((PodSet) inner.getParent(), inner);
        assertAssembly((PodSet) inner.getParent(), mount);
    }

    @Test
    void detachedBodyThrowsInsteadOfLoopingForever() {
        BodyTube detached = new BodyTube();
        assertTimeoutPreemptively(WALK_TIMEOUT,
                () -> assertThrows(IllegalStateException.class, detached::getAssembly));
    }

    @Test
    void childOfDetachedBodyThrowsInsteadOfLoopingForever() {
        BodyTube detached = new BodyTube();
        InnerTube child = new InnerTube();
        detached.addChild(child);
        assertTimeoutPreemptively(WALK_TIMEOUT,
                () -> assertThrows(IllegalStateException.class, child::getAssembly));
    }

    @Test
    void podChargeDeploysOnlyPodChuteAndCoreChargeOnlyCoreChute() {
        // Repeat at half the maximum step to check the 1 ms scheduling rule
        // independently of integrator resolution; each run has its own timeout.
        for (double step : new double[] {0.05, 0.025}) {
            Fixture f = reference();
            motor(f, f.mount, false, 3);
            BodyTube pod = podBody(f.body, "Pod");
            InnerTube podMount = mount(pod, "PodMount", true);
            motor(f, podMount, true, 2);
            chute(f, pod, "PodChute", 0.08);
            FlightData data = fly(f, step);
            assertEquals(1, data.getBranchCount(), "ownership: a pod must not separate");
            FlightDataBranch b = data.getBranch(0);
            assertEquals(2, events(b, FlightEvent.Type.RECOVERY_DEVICE_DEPLOYMENT).size(), "ownership: deployment count");
            double podCharge = chargeTime(b, podMount);
            double coreCharge = chargeTime(b, f.mount);
            assertTrue(podCharge < coreCharge, "ownership fixture: pod charge precedes core charge");
            deployedAt(b, "PodChute", podCharge + 0.001, "ownership: core charge deployed PodChute");
            deployedAt(b, "CoreChute", coreCharge + 0.001, "ownership: pod charge deployed CoreChute");
        }
    }

    @Test
    void nestedPodChargeCannotDeployOuterPodOrCoreChute() {
        Fixture f = reference();
        motor(f, f.mount, false, 3);
        BodyTube outer = podBody(f.body, "Outer");
        chute(f, outer, "OuterChute", 0.08);
        BodyTube inner = podBody(outer, "Inner");
        InnerTube innerMount = mount(inner, "InnerMount", true);
        motor(f, innerMount, true, 2);
        chute(f, inner, "InnerChute", 0.08);
        FlightDataBranch b = fly(f, 0.05).getBranch(0);
        assertEquals(2, events(b, FlightEvent.Type.RECOVERY_DEVICE_DEPLOYMENT).size(), "nested ownership: only inner/core deploy");
        assertTrue(deployments(b, "OuterChute").isEmpty(), "nested ownership: a foreign charge deployed OuterChute");
        deployedAt(b, "InnerChute", chargeTime(b, innerMount) + 0.001, "nested ownership: inner charge");
        deployedAt(b, "CoreChute", chargeTime(b, f.mount) + 0.001, "nested ownership: inner charge deployed core");
    }

    @Test
    void missingMotorPayloadFallsBackToStageNumber() {
        Fixture f = reference();
        AxialStage lower = new AxialStage();
        f.rocket.addChild(lower);
        BodyTube lowerBody = new BodyTube(0.12, 0.012, 0.0003);
        lower.addChild(lowerBody);
        Parachute lowerChute = chute(f, lowerBody, "LowerChute", 0.25);
        Parachute coreChute = (Parachute) f.body.getChild(f.body.getChildCount() - 1);
        assertNotEquals(f.stage.getStageNumber(), lower.getStageNumber(), "fallback fixture needs two stages");
        DeploymentConfiguration config = new DeploymentConfiguration();
        FlightEvent missing = new FlightEvent(FlightEvent.Type.EJECTION_CHARGE, 2, lower, null);
        assertFallback(config, missing, lowerChute, coreChute);
        // 24.12 validates constructor payloads: a non-MotorClusterState is
        // rejected. Use a synthetic getter to reach the defensive fallback
        // without disabling validation or modifying production code.
        assertThrows(IllegalStateException.class,
                () -> new FlightEvent(FlightEvent.Type.EJECTION_CHARGE, 2, lower, "legacy payload"));
        FlightEvent legacy = new FlightEvent(FlightEvent.Type.EJECTION_CHARGE, 2, lower, null) {
            @Override public Object getData() { return "legacy payload"; }
        };
        assertFallback(config, legacy, lowerChute, coreChute);
        assertFalse(DeploymentConfiguration.DeployEvent.EJECTION.isActivationEvent(config,
                new FlightEvent(FlightEvent.Type.APOGEE, 2, lower), lowerChute), "fallback must still filter event type");
    }

    @Test
    void simultaneousChargesExecuteOnceButBothQueuedCallbacksRemainVisible() {
        duplicateChargeFlight(1, 2);
    }

    @Test
    void laterChargeIsNotScheduledAndCannotOverwriteFirstDeploymentVelocity() {
        duplicateChargeFlight(3, 1);
    }

    @Test
    void twoDistinctChutesStillEachDeployOnce() {
        Fixture f = reference();
        motor(f, f.mount, false, 1);
        chute(f, f.body, "SecondChute", 0.25);
        FlightDataBranch b = fly(f, 0.05).getBranch(0);
        List<FlightEvent> deployments = events(b, FlightEvent.Type.RECOVERY_DEVICE_DEPLOYMENT);
        assertEquals(2, deployments.size(), "device guard must not suppress another physical chute");
        assertNotEquals(deployments.get(0).getSource().getID(), deployments.get(1).getSource().getID(),
                "distinct devices must be recorded as distinct sources");
        double time = chargeTime(b, f.mount) + 0.001;
        deployedAt(b, "CoreChute", time, "distinct device: core");
        deployedAt(b, "SecondChute", time, "distinct device: second");
    }

    @Test
    void separatedInactiveBoosterChuteIsRecordedOnlyInBoosterBranch() {
        // Pure Java equivalent of GoldenMain.runStagingScenario("auto").
        Fixture f = reference();
        f.stage.setName("Sustainer");
        f.body.getChild(f.body.getChildCount() - 1).setName("SustainerChute");
        f.mount.setAxialMethod(AxialMethod.BOTTOM);
        f.mount.setAxialOffset(0);
        motor(f, f.mount, false, 5);
        AxialStage booster = new AxialStage();
        booster.setName("Booster");
        f.rocket.addChild(booster);
        StageSeparationConfiguration separation = booster.getSeparationConfigurations().getDefault();
        separation.setSeparationEvent(StageSeparationConfiguration.SeparationEvent.EJECTION);
        separation.setSeparationDelay(0);
        BodyTube body = new BodyTube(0.12, 0.012, 0.0003);
        body.setMaterial(Material.newMaterial(Material.Type.BULK, "Kraft phenolic", 950, false));
        booster.addChild(body);
        TrapezoidFinSet fins = new TrapezoidFinSet(3, 0.05, 0.03, 0.025, 0.035);
        fins.setThickness(0.003);
        body.addChild(fins);
        InnerTube boosterMount = mount(body, "BoosterMount", false);
        motor(f, boosterMount, false, 0);
        chute(f, body, "BoosterChute", 0.25);
        FlightData data = fly(f, 0.05);
        assertEquals(2, data.getBranchCount(), "inactive-stage fixture must actually separate");
        FlightDataBranch sustainer = branchNamed(data, "Sustainer");
        FlightDataBranch separated = branchNamed(data, "Booster");
        assertFalse(events(sustainer, FlightEvent.Type.STAGE_SEPARATION).isEmpty(), "inactive-stage fixture separation missing");
        assertTrue(deployments(sustainer, "BoosterChute").isEmpty(), "stage guard: inactive BoosterChute deployed in sustainer");
        assertEquals(1, deployments(separated, "BoosterChute").size(), "stage guard: booster chute must deploy exactly once");
        assertEquals(1, deployments(sustainer, "SustainerChute").size(), "stage control: sustainer chute must deploy");
    }

    private static void duplicateChargeFlight(double secondDelay, int expectedCallbacks) {
        for (double step : new double[] {0.05, 0.025}) {
            Fixture f = reference();
            motor(f, f.mount, false, 1);
            InnerTube second = mount(f.body, "SecondMount", false);
            motor(f, second, false, secondDelay);
            FlightData data = fly(f, step);
            FlightDataBranch b = data.getBranch(0);
            double firstCharge = chargeTime(b, f.mount), secondCharge = chargeTime(b, second);
            assertEquals(secondDelay - 1, secondCharge - firstCharge, 1e-9, "duplicate fixture: charge spacing (s)");
            List<FlightEvent> deployments = events(b, FlightEvent.Type.RECOVERY_DEVICE_DEPLOYMENT);
            assertEquals(1, deployments.size(), "execution guard: same device recorded more than once");
            deployedAt(b, "CoreChute", firstCharge + 0.001, "first charge must own deployment time");
            assertTrue(firstCharge + 0.001 < data.getTimeToApogee(), "duplicate fixture must deploy BEFORE apogee");
            double velocity = interpolate(b, firstCharge + 0.001);
            assertTrue(Double.isFinite(velocity), "first deployment velocity must be finite");
            assertEquals(velocity, data.getDeploymentVelocity(), Math.abs(velocity) * 1e-9,
                    "execution guard: deployment velocity overwritten by later event (m/s)");
            assertEquals(1, f.counts.coastRuns, "execution guard: optimum-coast run repeated");
            assertEquals(1, f.counts.mainRuns, "listener fixture: exactly one main run");
            assertEquals(2, f.counts.count(FlightEvent.Type.EJECTION_CHARGE), "listener fixture: both main-run charges seen");
            // DESIGN section 4: handleFlightEvent/recoveryDeviceDeployment run
            // BEFORE the execution guard. Two already-queued simultaneous
            // duplicates therefore both reach callbacks, but only one records.
            // With delayed charges, ONE callback independently pins scheduling.
            assertEquals(expectedCallbacks, f.counts.count(FlightEvent.Type.RECOVERY_DEVICE_DEPLOYMENT),
                    secondDelay == 1 ? "execution guard, not queue de-dup: both callbacks required"
                            : "scheduling guard: already-deployed device was queued again");
        }
    }

    private static void assertAssembly(ComponentAssembly expected, RocketComponent component) {
        assertTimeoutPreemptively(WALK_TIMEOUT,
                () -> assertSame(expected, component.getAssembly(), "ancestor walk: wrong innermost assembly"));
    }

    private static void assertFallback(DeploymentConfiguration config, FlightEvent event,
            Parachute sameStage, Parachute otherStage) {
        assertTrue(DeploymentConfiguration.DeployEvent.EJECTION.isActivationEvent(config, event, sameStage),
                "payload fallback: matching stage must deploy");
        assertFalse(DeploymentConfiguration.DeployEvent.EJECTION.isActivationEvent(config, event, otherStage),
                "payload fallback: other stage must not deploy");
    }

    private static List<FlightEvent> events(FlightDataBranch b, FlightEvent.Type type) {
        List<FlightEvent> result = new ArrayList<>();
        for (FlightEvent event : b.getEvents()) if (event.getType() == type) result.add(event);
        return result;
    }

    private static List<FlightEvent> deployments(FlightDataBranch b, String source) {
        List<FlightEvent> result = new ArrayList<>();
        for (FlightEvent event : events(b, FlightEvent.Type.RECOVERY_DEVICE_DEPLOYMENT)) {
            if (source.equals(event.getSource().getName())) result.add(event);
        }
        return result;
    }

    private static void deployedAt(FlightDataBranch b, String source, double expected, String message) {
        List<FlightEvent> found = deployments(b, source);
        assertEquals(1, found.size(), message + ": exactly one " + source);
        assertEquals(expected, found.get(0).getTime(), 1e-9, message + ": time (s)");
    }

    private static double chargeTime(FlightDataBranch b, InnerTube mount) {
        List<FlightEvent> found = new ArrayList<>();
        for (FlightEvent e : events(b, FlightEvent.Type.EJECTION_CHARGE)) {
            assertInstanceOf(MotorClusterState.class, e.getData(), "flight charge must retain motor payload");
            // Simulation clones the rocket. Match stable mount IDs, not Java identity.
            MotorMount source = ((MotorClusterState) e.getData()).getMount();
            if (((RocketComponent) source).getID().equals(mount.getID())) found.add(e);
        }
        assertEquals(1, found.size(), "charge missing/duplicated for " + mount.getName());
        return found.get(0).getTime();
    }

    private static double interpolate(FlightDataBranch b, double time) {
        List<Double> times = b.get(FlightDataType.TYPE_TIME);
        List<Double> speeds = b.get(FlightDataType.TYPE_VELOCITY_TOTAL);
        for (int i = 1; i < times.size(); i++) {
            if (times.get(i) >= time && times.get(i) > times.get(i - 1)) {
                double fraction = (time - times.get(i - 1)) / (times.get(i) - times.get(i - 1));
                return speeds.get(i - 1) + fraction * (speeds.get(i) - speeds.get(i - 1));
            }
        }
        fail("deployment time is not bracketed by velocity samples");
        return Double.NaN;
    }

    private static FlightDataBranch branchNamed(FlightData data, String name) {
        for (int i = 0; i < data.getBranchCount(); i++) {
            if (name.equals(data.getBranch(i).getName())) return data.getBranch(i);
        }
        return fail("missing branch " + name);
    }

    private static final class Counts {
        final EnumMap<FlightEvent.Type, Integer> events = new EnumMap<>(FlightEvent.Type.class);
        int mainRuns;
        int coastRuns;
        int count(FlightEvent.Type type) { return events.getOrDefault(type, 0); }
    }

    private static final class Counter extends AbstractSimulationListener {
        // AbstractSimulationListener.clone() is shallow: every clone shares this
        // object, while coastRun is per listener and inherited by branch clones.
        final Counts counts;
        boolean coastRun;
        Counter(Counts counts) { this.counts = counts; }
        @Override public void startSimulation(SimulationStatus status) {
            coastRun = status.getSimulationConditions().getSimulationListenerList().contains(OptimumCoastListener.INSTANCE);
            if (coastRun) counts.coastRuns++;
            else counts.mainRuns++;
        }
        @Override public boolean handleFlightEvent(SimulationStatus status, FlightEvent event) {
            if (!coastRun) counts.events.merge(event.getType(), 1, Integer::sum);
            return true;
        }
    }

    private static final class Fixture {
        final Rocket rocket = new Rocket();
        final AxialStage stage = new AxialStage();
        final FlightConfigurationId fcid = new FlightConfigurationId("00002092-0001-4001-8001-000000000001");
        final Counts counts = new Counts();
        BodyTube body;
        InnerTube mount;
    }

    private static Fixture reference() {
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
        f.body.addChild(fins);
        f.mount = mount(f.body, "CoreMount", false);
        f.rocket.createFlightConfiguration(f.fcid);
        f.rocket.setSelectedConfiguration(f.fcid);
        chute(f, f.body, "CoreChute", 0.30);
        f.rocket.enableEvents();
        return f;
    }

    private static BodyTube podBody(BodyTube parent, String name) {
        PodSet pod = new PodSet();
        pod.setName(name);
        pod.setInstanceCount(1);
        parent.addChild(pod);
        pod.setAxialMethod(AxialMethod.BOTTOM);
        pod.setAxialOffset(0);
        pod.setRadiusMethod(RadiusMethod.RELATIVE);
        pod.setRadiusOffset(0);
        NoseCone nose = new NoseCone(Transition.Shape.OGIVE, 0.03, 0.0075);
        nose.setThickness(0.0003);
        pod.addChild(nose);
        BodyTube body = new BodyTube(0.06, 0.0075, 0.0003);
        body.setName(name + "Body");
        pod.addChild(body);
        return body;
    }

    private static InnerTube mount(BodyTube body, String name, boolean small) {
        InnerTube mount = new InnerTube();
        mount.setName(name);
        mount.setLength(small ? 0.045 : 0.07);
        mount.setOuterRadius(small ? 0.0065 : 0.0095);
        mount.setThickness(small ? 0.0003 : 0.0005);
        mount.setMotorMount(true);
        body.addChild(mount);
        mount.setAxialMethod(AxialMethod.BOTTOM);
        mount.setAxialOffset(0);
        return mount;
    }

    private static Parachute chute(Fixture f, BodyTube body, String name, double diameter) {
        Parachute chute = new Parachute();
        chute.setName(name);
        chute.setDiameter(diameter);
        DeploymentConfiguration d = chute.getDeploymentConfigurations().getDefault();
        d.setDeployEvent(DeploymentConfiguration.DeployEvent.EJECTION);
        d.setDeployDelay(0);
        chute.getDeploymentConfigurations().set(f.fcid, d.clone());
        body.addChild(chute);
        return chute;
    }

    private static void motor(Fixture f, InnerTube mount, boolean small, double delay) {
        double[] times = small ? new double[] {0, 0.05, 0.15, 0.4, 0.5}
                : new double[] {0, 0.1, 0.3, 0.5, 1, 1.5, 1.85, 2};
        double[] thrusts = small ? new double[] {0, 3, 2, 1.5, 0}
                : new double[] {0, 12, 6, 5.1, 4.9, 4.8, 4.5, 0};
        double[] masses = small ? new double[] {0.006, 0.0058, 0.0054, 0.0045, 0.004}
                : new double[] {0.0240, 0.0231, 0.0215, 0.0202, 0.0174, 0.0147, 0.0133, 0.0132};
        Coordinate[] cg = new Coordinate[masses.length];
        for (int i = 0; i < cg.length; i++) cg[i] = new Coordinate(small ? 0.0225 : 0.035, 0, 0, masses[i]);
        ThrustCurveMotor motor = new ThrustCurveMotor.Builder()
                .setManufacturer(Manufacturer.getManufacturer("Estes"))
                .setDesignation(small ? "Pod" : "C6").setCommonName(small ? "Pod" : "C6")
                .setMotorType(Motor.Type.SINGLE).setStandardDelays(new double[] {0, 1, 2, 3, 5})
                .setDiameter(small ? 0.013 : 0.018).setLength(small ? 0.045 : 0.07)
                .setTimePoints(times).setThrustPoints(thrusts).setCGPoints(cg)
                .setDigest(small ? "assembly-pod" : "assembly-c6").build();
        MotorConfiguration mc = new MotorConfiguration(mount, f.fcid);
        mc.setMotor(motor);
        mc.setEjectionDelay(delay);
        mc.setIgnitionEvent(IgnitionEvent.AUTOMATIC);
        mc.setIgnitionDelay(0);
        mount.setMotorConfig(mc, f.fcid);
    }

    private static FlightData fly(Fixture f, double step) {
        return assertTimeoutPreemptively(FLIGHT_TIMEOUT, () -> {
            SimulationConditions c = new SimulationConditions();
            c.setSimulation(new Simulation(f.rocket, f.fcid));
            c.setLaunchRodLength(1);
            c.setLaunchRodAngle(0);
            c.setLaunchRodDirection(Math.PI / 2);
            c.setLaunchSite(new WorldCoordinate(28.61, -80.60, 0));
            c.setGeodeticComputation(GeodeticComputationStrategy.SPHERICAL);
            c.setAtmosphericModel(new ExtendedISAModel());
            c.setGravityModel(new WGSGravityModel());
            PinkNoiseWindModel wind = new PinkNoiseWindModel();
            wind.setAverage(0);
            wind.setStandardDeviation(0);
            c.setWindModel(wind);
            c.setAerodynamicCalculator(new BarrowmanCalculator());
            c.setMassCalculator(new MassCalculator());
            c.setTimeStep(step);
            c.setMaxSimulationTime(1200);
            c.setRandomSeed(0x2092);
            c.getSimulationListenerList().add(new Counter(f.counts));
            BasicEventSimulationEngine engine = new BasicEventSimulationEngine();
            engine.simulate(c);
            FlightData data = engine.getFlightData();
            assertTrue(data.getBranchCount() > 0, "recovery flight produced no branch");
            for (int i = 0; i < data.getBranchCount(); i++) {
                assertTrue(events(data.getBranch(i), FlightEvent.Type.SIM_ABORT).isEmpty(),
                        "recovery flight aborted in branch " + data.getBranch(i).getName());
            }
            return data;
        });
    }
}
