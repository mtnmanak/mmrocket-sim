package info.openrocket.core.rocketcomponent;

import static org.junit.jupiter.api.Assertions.*;

import java.time.Duration;
import java.util.function.DoubleUnaryOperator;
import org.junit.jupiter.api.Test;

import info.openrocket.core.aerodynamics.BarrowmanCalculator;
import info.openrocket.core.document.Simulation;
import info.openrocket.core.masscalc.MassCalculator;
import info.openrocket.core.masscalc.RigidBody;
import info.openrocket.core.material.Material;
import info.openrocket.core.models.atmosphere.ExtendedISAModel;
import info.openrocket.core.models.gravity.WGSGravityModel;
import info.openrocket.core.models.wind.PinkNoiseWindModel;
import info.openrocket.core.motor.Manufacturer;
import info.openrocket.core.motor.Motor;
import info.openrocket.core.motor.MotorConfiguration;
import info.openrocket.core.motor.ThrustCurveMotor;
import info.openrocket.core.simulation.BasicEventSimulationEngine;
import info.openrocket.core.simulation.FlightData;
import info.openrocket.core.simulation.FlightEvent;
import info.openrocket.core.simulation.SimulationConditions;
import info.openrocket.core.util.Coordinate;
import info.openrocket.core.util.GeodeticComputationStrategy;
import info.openrocket.core.util.MathUtil;
import info.openrocket.core.util.WorldCoordinate;

/** Geometry-derived regressions for OR #3161; lengths are metres throughout. */
class ZeroSliceCentroidTest {
    @Test
    void bansheeZeroMaterialSliceHasFiniteCentroidAndInertias() {
        Fixture f = banshee();
        NoseCone tail = f.tail;
        double length = 0.001, radius = 0.011, thickness = 0.002;
        double l = length / 128;
        assertEquals(radius, tail.getRadius(0), 1e-15, "POWER cylinder start");
        assertEquals(radius, tail.getRadius(length / 2), 1e-15, "POWER cylinder middle");
        assertEquals(radius, tail.getRadius(126 * l), 1e-15, "last cylinder endpoint");
        assertEquals(0, tail.getRadius(127 * l), 0, "empty slice start");
        assertEquals(0, tail.getRadius(length), 0, "empty slice end");
        assertTrue(thickness * Math.hypot(radius, l) / l > radius,
                "cone slice inner radius must clamp to zero");

        // DIVISIONS=128: 126 hollow cylinders (R, R-t), then a solid R->0
        // cone, then an empty slice. Integrate those profiles, not kernel output.
        double cylinderVolume = Math.PI * (radius * radius - Math.pow(radius - thickness, 2)) * 126 * l;
        double coneVolume = Math.PI * radius * radius * l / 3;
        double volume = cylinderVolume + coneVolume;
        double trueCG = (cylinderVolume * 63 * l + coneVolume * (126 * l + l / 4)) / volume;
        // calculateCG uses l/2 for a frustum's unscaled volume < EPSILON.
        // Only the cone has a noncentral true centroid in this fixture. Its
        // resulting whole-tail error is bounded by (Vcone/V)*(l/4), plus 1e-12 m.
        assertTrue(l * radius * radius < MathUtil.EPSILON, "cone midpoint approximation applies");
        finiteComponent(tail);
        assertTrue(tail.getComponentCG().x >= 0 && tail.getComponentCG().x <= length,
                "zero-slice guard: tail CG must lie within its length");
        near(volume, tail.getComponentVolume(), 1e-18, "tail volume (m^3)");
        assertEquals(trueCG, tail.getComponentCG().x, coneVolume / volume * l / 4 + 1e-12,
                "zero-slice guard: analytic tail first moment (m)");
    }

    @Test
    void bansheeAssemblyMassCenterAndInertiasRemainFinite() {
        RigidBody mass = MassCalculator.calculateStructure(banshee().rocket.getSelectedConfiguration());
        finite(mass.getMass(), "assembled mass (kg)");
        finite(mass.getCM().x, "assembled CM.x (m)");
        finite(mass.getCM().y, "assembled CM.y (m)");
        finite(mass.getCM().z, "assembled CM.z (m)");
        finite(mass.getLongitudinalInertia(), "assembled longitudinal inertia (kg m^2)");
        finite(mass.getRotationalInertia(), "assembled rotational inertia (kg m^2)");
    }

    @Test
    void bansheeFlightReachesApogeeWithoutAbortOrNaN() {
        assertTimeoutPreemptively(Duration.ofSeconds(30), () -> {
            Fixture f = banshee();
            BasicEventSimulationEngine engine = new BasicEventSimulationEngine();
            assertDoesNotThrow(() -> engine.simulate(conditions(f)), "zero-slice flight must not throw");
            FlightData data = engine.getFlightData();
            assertTrue(data.getBranchCount() > 0, "zero-slice flight has no branch");
            boolean apogee = false;
            for (FlightEvent event : data.getBranch(0).getEvents()) {
                assertNotEquals(FlightEvent.Type.SIM_ABORT, event.getType(), "zero-slice flight aborted: " + event);
                apogee |= event.getType() == FlightEvent.Type.APOGEE;
            }
            assertTrue(apogee, "zero-slice flight must reach APOGEE");
            finite(data.getMaxAltitude(), "flight max altitude (m)");
            assertTrue(data.getMaxAltitude() > 0, "zero-slice flight must leave the pad");
        });
    }

    @Test
    void filledConicalFrustumMatchesAnalyticMassAndQuadratureInertias() {
        Transition t = frustum(0, true);
        double volume = frustumVolume(0.1, 0.02, 0.04);
        double cg = frustumCG(0.1, 0.02, 0.04);
        // Absolute floors: volume 1e-18 m^3, centroid 1e-12 m, unit MOI 1e-14 m^2.
        near(volume, t.getComponentVolume(), 1e-18, "filled frustum volume (m^3)");
        near(cg, t.getComponentCG().x, 1e-12, "filled frustum centroid (m)");
        // Ixx is about the axial x axis; Iyy is about a transverse axis through
        // the component CG, both per unit mass. A disk has Ixx/m=r^2/2,
        // Iyy/m=r^2/4. Integrate the exact linear radius with 20000 Simpson panels.
        double rotational = simpson(x -> {
            double r = 0.02 + 0.2 * x;
            return Math.PI * Math.pow(r, 4) / 2;
        }, 0.1) / volume;
        double longitudinal = simpson(x -> {
            double r = 0.02 + 0.2 * x;
            return Math.PI * r * r * ((x - cg) * (x - cg) + r * r / 4);
        }, 0.1) / volume;
        near(rotational, t.getRotationalUnitInertia(), 1e-14, "filled frustum axial unit inertia (m^2)");
        near(longitudinal, t.getLongitudinalUnitInertia(), 1e-14, "filled frustum transverse unit inertia (m^2)");
    }

    @Test
    void thinPositiveShellKeepsTrueCentroidInsteadOfSliceMidpoints() {
        Transition t = frustum(1e-5, false);
        double length = 0.1, r1 = 0.02, r2 = 0.04;
        double h = 1e-5 * Math.sqrt(1 + Math.pow((r2 - r1) / length, 2));
        double outer = frustumVolume(length, r1, r2);
        double inner = frustumVolume(length, r1 - h, r2 - h);
        double volume = outer - inner;
        double cg = (outer * frustumCG(length, r1, r2)
                - inner * frustumCG(length, r1 - h, r2 - h)) / volume;
        // The annular area A(x)=pi*h*(2*r(x)-h) is linear. Replacing every
        // nonzero slice centroid with l/2 loses A' * L * l^2 / (12*V)
        // in the overall centroid: approximately 3.39e-7 m for this fixture.
        // The allowed error is ~5.56e-11 m (rel 1e-9 + 1e-12 m floor),
        // so the erroneous dV<EPSILON fix cannot pass.
        double l = length / 128;
        double midpointError = (2 * Math.PI * h * (r2 - r1) / length) * length * l * l / (12 * volume);
        double maxUnscaledSliceVolume = 3 * Math.PI * h * (2 * r2 - h) * l / Math.PI;
        assertTrue(maxUnscaledSliceVolume < MathUtil.EPSILON, "thin shell must exercise dV<EPSILON");
        assertTrue(midpointError > 100 * (1e-12 + 1e-9 * Math.abs(cg)), "oracle must reject midpoint mutation");
        // Absolute floors: 1e-18 m^3 and 1e-12 m; relative tolerance 1e-9.
        near(volume, t.getComponentVolume(), 1e-18, "positive shell volume (m^3)");
        near(cg, t.getComponentCG().x, 1e-12, "positive shell true centroid (m)");
    }

    @Test
    void zeroThicknessHollowFrustumHasZeroMassAndFiniteZeroInertias() {
        Transition t = frustum(0, false);
        finiteComponent(t);
        assertEquals(0, t.getComponentVolume(), 0, "empty volume (m^3)");
        assertEquals(0, t.getComponentMass(), 0, "empty mass (kg)");
        assertEquals(0, t.getLongitudinalUnitInertia(), 0, "empty transverse unit inertia");
        assertEquals(0, t.getRotationalUnitInertia(), 0, "empty axial unit inertia");
    }

    @Test
    void ordinaryOgiveIsAFiniteOnlyControl() {
        NoseCone nose = new NoseCone(Transition.Shape.OGIVE, 0.1, 0.02);
        nose.setThickness(0.002);
        attach(nose);
        // Finite-only control, not an analytic accuracy claim for the ogive.
        finiteComponent(nose);
        assertTrue(nose.getComponentCG().x > 0 && nose.getComponentCG().x < 0.1,
                "ordinary ogive CG lies strictly inside its length");
    }

    private static Transition frustum(double thickness, boolean filled) {
        Transition t = new Transition();
        t.setShapeType(Transition.Shape.CONICAL);
        t.setLength(0.1);
        t.setForeRadiusAutomatic(false);
        t.setAftRadiusAutomatic(false);
        t.setForeRadius(0.02);
        t.setAftRadius(0.04);
        t.setForeShoulderLength(0);
        t.setAftShoulderLength(0);
        t.setThickness(thickness);
        t.setFilled(filled);
        attach(t);
        return t;
    }

    private static void attach(RocketComponent component) {
        Rocket rocket = new Rocket();
        AxialStage stage = new AxialStage();
        rocket.addChild(stage);
        stage.addChild(component);
        rocket.enableEvents();
    }

    private static double frustumVolume(double length, double a, double b) {
        return Math.PI * length * (a * a + a * b + b * b) / 3;
    }

    private static double frustumCG(double length, double a, double b) {
        return length * (a * a + 2 * a * b + 3 * b * b) / (4 * (a * a + a * b + b * b));
    }

    private static double simpson(DoubleUnaryOperator f, double length) {
        int n = 20000;
        double dx = length / n, sum = f.applyAsDouble(0) + f.applyAsDouble(length);
        for (int i = 1; i < n; i++) sum += (i % 2 == 0 ? 2 : 4) * f.applyAsDouble(i * dx);
        return sum * dx / 3;
    }

    private static void near(double expected, double actual, double floor, String label) {
        assertEquals(expected, actual, floor + 1e-9 * Math.abs(expected), label);
    }

    private static void finite(double value, String label) {
        assertTrue(Double.isFinite(value), label + " must be finite: " + value);
    }

    private static void finiteComponent(SymmetricComponent component) {
        finite(component.getComponentVolume(), "component volume");
        finite(component.getComponentCG().x, "component CG.x");
        finite(component.getComponentMass(), "component mass");
        finite(component.getLongitudinalUnitInertia(), "component longitudinal unit inertia");
        finite(component.getRotationalUnitInertia(), "component rotational unit inertia");
    }

    private static final class Fixture {
        final Rocket rocket = new Rocket();
        final FlightConfigurationId fcid = new FlightConfigurationId("00003161-0001-4001-8001-000000000001");
        NoseCone tail;
    }

    private static Fixture banshee() {
        Fixture f = new Fixture();
        AxialStage stage = new AxialStage();
        f.rocket.addChild(stage);
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
        mount.setMotorMount(true);
        body.addChild(mount);
        Parachute chute = new Parachute();
        chute.setDiameter(0.30);
        chute.getDeploymentConfigurations().getDefault().setDeployEvent(DeploymentConfiguration.DeployEvent.EJECTION);
        chute.getDeploymentConfigurations().getDefault().setDeployDelay(0);
        body.addChild(chute);
        PodSet pod = new PodSet();
        pod.setInstanceCount(1);
        body.addChild(pod);
        NoseCone podNose = new NoseCone(Transition.Shape.HAACK, 0.15, 0.011);
        podNose.setShapeParameter(0);
        pod.addChild(podNose);
        f.tail = new NoseCone(Transition.Shape.POWER, 0.001, 0.011);
        f.tail.setShapeParameter(0);
        f.tail.setThickness(0.002);
        f.tail.setFlipped(true);
        pod.addChild(f.tail);
        f.rocket.createFlightConfiguration(f.fcid);
        f.rocket.setSelectedConfiguration(f.fcid);
        double[] masses = {0.0240, 0.0231, 0.0215, 0.0202, 0.0174, 0.0147, 0.0133, 0.0132};
        Coordinate[] cg = new Coordinate[masses.length];
        for (int i = 0; i < cg.length; i++) cg[i] = new Coordinate(0.035, 0, 0, masses[i]);
        ThrustCurveMotor motor = new ThrustCurveMotor.Builder()
                .setManufacturer(Manufacturer.getManufacturer("Estes")).setDesignation("C6").setCommonName("C6")
                .setMotorType(Motor.Type.SINGLE).setStandardDelays(new double[] {3, 5, 7})
                .setDiameter(0.018).setLength(0.070)
                .setTimePoints(new double[] {0, 0.1, 0.3, 0.5, 1, 1.5, 1.85, 2})
                .setThrustPoints(new double[] {0, 12, 6, 5.1, 4.9, 4.8, 4.5, 0})
                .setCGPoints(cg).setDigest("zeroslice-c6").build();
        MotorConfiguration mc = new MotorConfiguration(mount, f.fcid);
        mc.setMotor(motor);
        mc.setEjectionDelay(5);
        mount.setMotorConfig(mc, f.fcid);
        f.rocket.enableEvents();
        return f;
    }

    private static SimulationConditions conditions(Fixture f) {
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
        c.setTimeStep(0.05);
        c.setMaxSimulationTime(1200);
        c.setRandomSeed(0x3161);
        return c;
    }
}
