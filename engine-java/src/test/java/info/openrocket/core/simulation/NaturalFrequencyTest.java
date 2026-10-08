package info.openrocket.core.simulation;

import static org.junit.jupiter.api.Assertions.*;
import static info.openrocket.core.simulation.EventThrustTest.*;
import java.util.Arrays;
import org.junit.jupiter.api.Test;
import info.openrocket.core.aerodynamics.AerodynamicForces;
import info.openrocket.core.aerodynamics.BarrowmanCalculator;
import info.openrocket.core.aerodynamics.FlightConditions;
import info.openrocket.core.logging.WarningSet;
import info.openrocket.core.masscalc.RigidBody;
import info.openrocket.core.models.atmosphere.AtmosphericConditions;
import info.openrocket.core.motor.IgnitionEvent;
import info.openrocket.core.motor.Motor;
import info.openrocket.core.rocketcomponent.MassComponent;
import info.openrocket.core.simulation.SimulationStatus.TumbleDetector;
import info.openrocket.core.unit.UnitGroup;
import info.openrocket.core.util.Coordinate;

/** OR #3002: exercise storeData, not a duplicate implementation of its producer. */
class NaturalFrequencyTest {
    private static void near(double expected, double actual) {
        assertEquals(expected, actual, 1e-12 + 1e-10 * Math.abs(expected), "omega, rad/s");
    }

    @Test void typeIsAngularStabilitySeriesInCatalogOrder() {
        // Mutations: Hz unit group, wrong symbol/group, missing ALL_TYPES entry.
        FlightDataType type = FlightDataType.TYPE_NATURAL_FREQUENCY;
        assertEquals("\u03c9n", type.getSymbol());
        assertSame(UnitGroup.UNITS_ROLL, type.getUnitGroup());
        assertSame(FlightDataTypeGroup.STABILITY, type.getGroup());
        assertFalse(type.getName().isBlank());
        int stability = Arrays.asList(FlightDataType.ALL_TYPES).indexOf(FlightDataType.TYPE_STABILITY);
        assertTrue(stability >= 0);
        assertSame(type, FlightDataType.ALL_TYPES[stability + 1]);
    }

    private static final class Sample {
        final Fixture fixture = reference();
        final SimulationStatus status = new SimulationStatus(fixture.rocket.getSelectedConfiguration(), conditions(fixture, 0.01));
        final AbstractSimulationStepper.DataStore store = new AbstractSimulationStepper.DataStore();
        Sample() {
            status.setFlightDataBranch(new FlightDataBranch("Frequency", FlightDataType.TYPE_TIME));
            status.setLaunchRodCleared(true);
            FlightConditions fc = new FlightConditions(fixture.rocket.getSelectedConfiguration());
            fc.setRefLength(Math.sqrt(0.04 / Math.PI));
            fc.setAtmosphericConditions(new AtmosphericConditions(288.15, 1.2 * AtmosphericConditions.R * 288.15));
            fc.setVelocity(50);
            fc.setAOA(0);
            store.flightConditions = fc;
            // Longitudinal = Iyy, NOT Ixx (roll) or Izz. Distinct values expose swaps.
            store.rocketMass = new RigidBody(new Coordinate(0.5, 0, 0, 1), 0.0002, 0.02, 0.08);
            store.forces = new AerodynamicForces();
            store.forces.setCP(new Coordinate(0.8, 0, 0, 4));
        }
        double record() {
            status.getFlightDataBranch().addPoint();
            store.storeData(status);
            return status.getFlightDataBranch().getLast(FlightDataType.TYPE_NATURAL_FREQUENCY);
        }
    }

    @Test void syntheticOracleAndVelocityInertiaScaling() {
        // Mutations: omit sqrt; divide by 2*pi (Hz); use rotational inertia; missing producer.
        Sample s = new Sample();
        double area = s.store.flightConditions.getRefArea();
        near(0.01, area);
        double expected = Math.sqrt(0.5 * 1.2 * 50 * 50 * area * 4 * (0.8 - 0.5) / 0.02);
        near(expected, s.record());
        s.store.flightConditions.setVelocity(100);
        near(2 * expected, s.record());
        s.store.flightConditions.setVelocity(50);
        s.store.rocketMass = new RigidBody(new Coordinate(0.5, 0, 0, 1), 0.0002, 4 * 0.02, 0.08);
        near(expected / 2, s.record());
    }

    @Test void railNeutralAndNegativeStiffness() {
        // Mutations: remove launch-guide gate, abs(negative stiffness), neutral treated as invalid.
        Sample s = new Sample();
        s.status.setLaunchRodCleared(false);
        assertEquals(0, s.record());
        s.store.forces = null;
        assertEquals(0, s.record(), "rail takes precedence over missing inputs");
        s = new Sample();
        s.store.forces.setCP(new Coordinate(0.5, 0, 0, 4));
        assertEquals(0, s.record());
        s.store.forces.setCP(new Coordinate(0.4, 0, 0, 4));
        assertTrue(Double.isNaN(s.record()));
    }

    @Test void invalidInputsStayUndefined() {
        // Mutations: remove each finite/positive guard; silently substitute zero for missing data.
        for (double inertia : new double[] {0, -0.02, Double.NaN, Double.POSITIVE_INFINITY}) {
            Sample s = new Sample();
            // RigidBody rejects negative constructor inertia. Override only the getter
            // to reach the producer's defensive negative-input branch without reflection.
            s.store.rocketMass = new RigidBody(new Coordinate(0.5, 0, 0, 1), 0.0002, 0.02, 0.08) {
                @Override public double getLongitudinalInertia() { return inertia; }
            };
            assertTrue(Double.isNaN(s.record()), "inertia " + inertia);
        }
        for (double bad : new double[] {Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY}) {
            for (String field : new String[] {"rho", "v", "area", "aoa", "cp", "cna", "cg"}) {
                assertInvalid(field, bad);
            }
        }
        for (String field : new String[] {"rho", "v", "area"}) assertInvalid(field, -1);
        assertInvalid("area", 0);
        // Review fix: with CP FORWARD of CG a negative rho, area or inertia makes the
        // ratio POSITIVE, so only the sign guard itself returns NaN (with the
        // positive arm above, the final ratio < 0 check would mask its removal).
        // Mutations: drop rho < 0, area <= 0, inertia <= 0.
        for (String field : new String[] {"rho", "area"}) assertInvalidWithForwardCp(field, -1);
        Sample fwd = new Sample();
        fwd.store.forces.setCP(new Coordinate(0.2, 0, 0, 4));
        fwd.store.rocketMass = new RigidBody(new Coordinate(0.5, 0, 0, 1), 0.0002, 0.02, 0.08) {
            @Override public double getLongitudinalInertia() { return -0.02; }
        };
        assertTrue(Double.isNaN(fwd.record()), "negative inertia with forward CP");
        for (int missing = 0; missing < 4; missing++) {
            Sample s = new Sample();
            if (missing == 0) s.store.forces = null;
            if (missing == 1) s.store.rocketMass = null;
            if (missing == 2) s.store.flightConditions = null;
            if (missing == 3) s.store.forces = new AerodynamicForces() {
                @Override public Coordinate getCP() { return null; }
            };
            assertTrue(Double.isNaN(s.record()), "missing input " + missing);
        }
    }

    private static void assertInvalidWithForwardCp(String field, double value) {
        assertInvalid(field, value, 0.2);
    }

    private static void assertInvalid(String field, double value) {
        assertInvalid(field, value, 0.8);
    }

    private static void assertInvalid(String field, double value, double xcp) {
        Sample s = new Sample();
        s.store.forces.setCP(new Coordinate(xcp, 0, 0, 4));
        FlightConditions good = s.store.flightConditions;
        // Setters clamp invalid speed/AOA; getter overrides reach the producer
        // guard itself. Valid synthetic/flight tests above still use real setters.
        s.store.flightConditions = new FlightConditions(s.fixture.rocket.getSelectedConfiguration()) {
            @Override public double getVelocity() { return field.equals("v") ? value : good.getVelocity(); }
            @Override public double getRefArea() { return field.equals("area") ? value : good.getRefArea(); }
            @Override public double getAOA() { return field.equals("aoa") ? value : good.getAOA(); }
            @Override public AtmosphericConditions getAtmosphericConditions() {
                return new AtmosphericConditions() {
                    @Override public double getDensity() { return field.equals("rho") ? value : 1.2; }
                };
            }
        };
        if (field.equals("cp")) s.store.forces.setReportedCP(new Coordinate(value, 0, 0, 4));
        if (field.equals("cna")) s.store.forces.setReportedCP(new Coordinate(0.8, 0, 0, value));
        if (field.equals("cg")) s.store.rocketMass = new RigidBody(new Coordinate(value, 0, 0, 1), 0.0002, 0.02, 0.08);
        assertTrue(Double.isNaN(s.record()), field + "=" + value);
    }

    @Test void reportedCpControlsFrequencyAndThereforeDwell() {
        // Mutation: frequency reads getDerivativeCP() instead of the reported CP.
        Sample s = new Sample();
        s.store.flightConditions.setAOA(Math.toRadians(60));
        s.store.forces.setCP(new Coordinate(0.8, 0, 0, 4));
        s.store.forces.setReportedCP(new Coordinate(0.4, 0, 0, 4));
        assertTrue(s.store.forces.getDerivativeCP().x > 0.5);
        double undefined = s.record();
        assertTrue(Double.isNaN(undefined));
        s.store.forces.setCP(new Coordinate(0.4, 0, 0, 4));
        s.store.forces.setReportedCP(new Coordinate(0.8, 0, 0, 4));
        double omega = s.record();
        assertTrue(Double.isFinite(omega) && omega > 0);
        assertEquals(TumbleDetector.MIN_TIME_CONSTANT, TumbleDetector.timeConstant(undefined));
        assertTrue(TumbleDetector.timeConstant(omega) > TumbleDetector.MIN_TIME_CONSTANT);
    }

    @Test void realFlightRowsMatchIndependentRecordedFieldOracle() {
        // Mutations: missing producer, stale RK substep inputs, wrong inertia/CP/units.
        Fixture f = reference();
        // 10 g nose ballast: about 2 cal static margin, so the restoring arm is
        // clearly positive (the bare fixture's margin is within a millimetre of 0).
        f.stage.getChild(0).addChild(new MassComponent(0.02, 0.008, 0.010));
        installMotor(f, f.mount, TIMES, THRUSTS, IgnitionEvent.LAUNCH, Motor.PLUGGED_DELAY);
        FlightDataBranch b = fly(conditions(f, 0.01), new MainListener()).getBranch(0);
        double rail = events(b, FlightEvent.Type.LAUNCHROD).get(0).getTime();
        double apogee = events(b, FlightEvent.Type.APOGEE).get(0).getTime();
        double burnout = events(b, FlightEvent.Type.BURNOUT).get(0).getTime();
        int checked = 0, railRows = 0;
        for (int i = 0; i < b.getLength(); i++) {
            double t = b.get(FlightDataType.TYPE_TIME).get(i);
            double omega = b.get(FlightDataType.TYPE_NATURAL_FREQUENCY).get(i);
            if (t < rail) { assertEquals(0, omega, "rail omega at " + t); railRows++; continue; }
            // Choose the powered ascent by event times ONLY (review fix: never skip a
            // row by the value under test - a producer recording 0/NaN on part of
            // the ascent must fail). Near apogee v tends to zero, so stop at burnout.
            if (t >= Math.min(apogee, burnout)) continue;
            FlightConditions fc = new FlightConditions(f.rocket.getSelectedConfiguration());
            fc.setMach(b.get(FlightDataType.TYPE_MACH_NUMBER).get(i));
            fc.setAOA(b.get(FlightDataType.TYPE_AOA).get(i));
            double cna = new BarrowmanCalculator().getCP(f.rocket.getSelectedConfiguration(), fc, new WarningSet()).weight;
            double rho = b.get(FlightDataType.TYPE_AIR_DENSITY).get(i);
            double v = fc.getMach() * b.get(FlightDataType.TYPE_SPEED_OF_SOUND).get(i);
            double area = b.get(FlightDataType.TYPE_REFERENCE_AREA).get(i);
            double arm = b.get(FlightDataType.TYPE_CP_LOCATION).get(i) - b.get(FlightDataType.TYPE_CG_LOCATION).get(i);
            double inertia = b.get(FlightDataType.TYPE_LONGITUDINAL_INERTIA).get(i);
            double ratio = 0.5 * rho * v * v * area * cna * arm / inertia;
            if (!(ratio >= 0)) {
                // Independently predicted negative stiffness: the producer must say NaN.
                assertTrue(Double.isNaN(omega), "negative predicted stiffness must be NaN at " + t + " s: " + omega);
                continue;
            }
            double expected = Math.sqrt(ratio);
            // Fresh getCP has default theta/rates, unlike the force evaluation;
            // 3 symmetric rounded fins remove material theta dependence. 1e-6
            // relative allows the independent CNa path's normalization roundoff.
            assertEquals(expected, omega, 1e-12 + 1e-6 * Math.abs(expected), "recorded omega at " + t + " s");
            // Count only independently predicted nontrivial rows toward the
            // required population. A small positive restoring arm can genuinely
            // give omega <1 even during powered ascent; still check its identity.
            if (expected > 1) {
                assertTrue(omega > 1, "nontrivial post-rail ascent frequency at " + t + " s: " + omega + " rad/s");
                checked++;
            }
        }
        assertTrue(railRows > 0);
        assertTrue(checked >= 20, "must exercise at least 20 finite positive ascent rows; got " + checked);
    }
}
