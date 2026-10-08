package info.openrocket.core.simulation;

import static org.junit.jupiter.api.Assertions.*;
import static info.openrocket.core.simulation.EventThrustTest.*;

import org.junit.jupiter.api.Test;
import info.openrocket.core.aerodynamics.AerodynamicCalculator;
import info.openrocket.core.aerodynamics.FlightConditions;
import info.openrocket.core.logging.Warning;
import info.openrocket.core.logging.WarningSet;
import info.openrocket.core.motor.IgnitionEvent;
import info.openrocket.core.motor.Motor;
import info.openrocket.core.logging.SimulationAbort;
import info.openrocket.core.simulation.exception.SimulationException;

/** OR #3093: last calculator evaluation must not decide an accepted step's stall. */
class RecordedStallAngleTest {
    // Match the kernel expression, including its arithmetic order at equality.
    private static final double STALL = 17.5 * Math.PI / 180;

    @Test void stallAngleIsIndependentOfEveryQueryAndNewInstanceForAllModels() {
        Fixture f = reference();
        for (String model : new String[] {"classic", "kbf", "supersonic", "hybrid"}) {
            AerodynamicCalculator calc = calculator(model);
            assertAngle(calc, model + " before any evaluation");
            for (double mach : new double[] {0.3, 1.0, 1.5}) {
                for (double aoa : new double[] {30 * Math.PI / 180, 0}) {
                    FlightConditions fc = new FlightConditions(f.rocket.getSelectedConfiguration());
                    fc.setMach(mach); fc.setAOA(aoa);
                    calc.getCP(f.rocket.getSelectedConfiguration(), fc, new WarningSet());
                    assertAngle(calc, model + " after getCP");
                    calc.getWorstCP(f.rocket.getSelectedConfiguration(), fc, new WarningSet());
                    assertAngle(calc, model + " after getWorstCP");
                    // getWorstCP is allowed to change theta; AOA remains the requested test input.
                    fc.setAOA(aoa);
                    calc.getAerodynamicForces(f.rocket.getSelectedConfiguration(), fc, new WarningSet());
                    assertAngle(calc, model + " after forces at AOA " + aoa);
                    assertAngle(calc.newInstance(), model + " newInstance");
                }
            }
        }
    }

    private static void assertAngle(AerodynamicCalculator calc, String context) {
        assertEquals(STALL, calc.getStallAngle(), 1e-15, "stall angle: mutable calculator state leaked into " + context);
    }

    @Test void poisonedHighCalculatorCannotWarnOrTumbleAtRecordedLowAoa() {
        for (double step : new double[] {0.01, 0.005}) {
            StallCounts counts = new StallCounts();
            FlightData data = flyWindow(Double.NaN, 30 * Math.PI / 180, step, counts);
            FlightDataBranch b = data.getBranch(0);
            assertTrue(counts.poisoned > 0, "recorded stall: high poison never ran with warnings enabled");
            double max = 0;
            for (double aoa : b.get(FlightDataType.TYPE_AOA)) if (Double.isFinite(aoa)) max = Math.max(max, aoa);
            assertTrue(max < STALL, "recorded stall fixture: unforced recorded max AOA must stay below stall (rad): " + max);
            assertEquals(0, largeWarnings(data), "recorded stall: stale high calculator emitted LargeAOA for recorded low AOA");
            assertTrue(events(b, FlightEvent.Type.TUMBLE).isEmpty(), "recorded stall: stale high calculator tumbled stable rocket");
            assertTrue(events(b, FlightEvent.Type.SIM_ABORT).isEmpty(), "recorded stall: poisoned flight aborted");
        }
    }

    @Test void recordedHighAoaIsDetectedAfterCalculatorIsResetLow() {
        for (double step : new double[] {0.005, 0.0025}) assertWindow(30 * Math.PI / 180, 0, true, step);
    }

    @Test void recordedAoaJustBelowStallIgnoresPoisonedHighCalculator() {
        assertWindow(STALL - 1e-9, 30 * Math.PI / 180, false, 0.005);
    }

    @Test void recordedAoaExactlyAtStallIgnoresPoisonedHighCalculator() {
        assertWindow(STALL, 30 * Math.PI / 180, false, 0.005);
    }

    @Test void recordedAoaJustAboveStallIsDetectedDespitePoisonedLowCalculator() {
        assertWindow(STALL + 1e-9, 0, true, 0.005);
    }

    private static void assertWindow(double forced, double poison, boolean expectedStall, double step) {
        StallCounts counts = new StallCounts();
        FlightData data = flyWindow(forced, poison, step, counts);
        FlightDataBranch b = data.getBranch(0);
        assertTrue(counts.recorded > 0, "recorded stall: forced window produced no accepted k1 rows");
        assertTrue(counts.poisoned >= counts.recorded, "recorded stall: calculator not poisoned after every forced row");
        assertTrue(counts.windowWarningsEnabled, "recorded stall: window must occur after warning delay and before low-speed inhibition");
        assertTrue(Double.isFinite(counts.cp) && Double.isFinite(counts.cg), "recorded stall: CP/CG row must be finite (m)");
        boolean tumbled = !events(b, FlightEvent.Type.TUMBLE).isEmpty();
        if (expectedStall) {
            // Pin the branch selected by the RECORDED row, not the poison evaluation.
            if (counts.cg > counts.cp) {
                // Under power the TUMBLE event can abort rather than enter the tumble stepper.
                assertTrue(counts.tumbleCallbacks > 0, "recorded stall: recorded CG > CP did not queue TUMBLE");
                assertTrue(tumbled || aborted(b, SimulationAbort.Cause.TUMBLE_UNDER_THRUST),
                        "recorded stall: queued TUMBLE neither transitioned nor aborted under thrust");
            } else {
                assertTrue(largeWarnings(data) > 0, "recorded stall: stale low calculator suppressed recorded high AOA warning");
                boolean warningAtDecision = false;
                // SimulationStatus.addWarning writes SIM_WARN straight to the
                // branch, so handleFlightEvent does not observe these warnings.
                for (FlightEvent e : events(b, FlightEvent.Type.SIM_WARN)) {
                    if (e.getData() instanceof Warning.LargeAOA && Math.abs(e.getTime() - counts.decisionTime) <= 1e-12) {
                        warningAtDecision = true;
                    }
                }
                assertTrue(warningAtDecision, "recorded stall: LargeAOA did not correspond to the forced accepted row");
            }
        } else {
            assertEquals(0, largeWarnings(data), "recorded stall: margin < 0 boundary incorrectly warned at/below stall");
            assertFalse(tumbled, "recorded stall: margin < 0 boundary incorrectly tumbled at/below stall");
            assertEquals(0, counts.tumbleCallbacks, "recorded stall: boundary queued TUMBLE (possibly aborted under thrust)");
            assertTrue(events(b, FlightEvent.Type.SIM_ABORT).isEmpty(), "recorded stall: boundary experiment aborted");
        }
    }

    private static FlightData flyWindow(double forced, double poison, double step, StallCounts counts) {
        Fixture f = reference();
        installMotor(f, f.mount, TIMES, THRUSTS, IgnitionEvent.LAUNCH, Motor.PLUGGED_DELAY);
        SimulationConditions c = conditions(f, step);
        // An ascent-only experiment isolates the accepted-step decision from real
        // high AOA near apogee/descent. Forced experiments end after their first
        // accepted window row has been assessed: sustained artificial forces
        // otherwise drive a real departure later (observed near 0.635 s).
        c.setMaxSimulationTime(0.85);
        return fly(c, new StallListener(counts, forced, poison));
    }

    private static int largeWarnings(FlightData data) {
        int count = 0;
        for (Warning w : data.getWarningSet()) if (w instanceof Warning.LargeAOA) count++;
        return count;
    }

    private static final class StallCounts {
        int poisoned, recorded, tumbleCallbacks;
        double cp = Double.NaN, cg = Double.NaN, decisionTime;
        boolean windowWarningsEnabled;
    }

    private static final class StallListener extends MainListener {
        final StallCounts counts; // shared through shallow listener clones
        final double forced, poison;
        double clearance = Double.NaN;
        StallListener(StallCounts counts, double forced, double poison) {
            this.counts = counts; this.forced = forced; this.poison = poison;
        }
        boolean inWindow(double t) { return !Double.isNaN(clearance) && t >= clearance + 0.35 && t <= clearance + 0.37; }
        @Override public FlightConditions postFlightConditions(SimulationStatus s, FlightConditions fc) {
            if (!coast && Double.isFinite(forced) && inWindow(s.getSimulationTime())) {
                fc.setAOA(forced);
                return fc;
            }
            return null;
        }
        @Override public void postStep(SimulationStatus s) throws SimulationException {
            if (coast || !s.isLaunchRodCleared() || s.getSimulationTime() < clearance + 0.3 || !s.recordWarnings()) return;
            FlightDataBranch b = s.getFlightDataBranch();
            if (Double.isFinite(forced) && inWindow(b.getLast(FlightDataType.TYPE_TIME))) {
                assertEquals(forced, b.getLast(FlightDataType.TYPE_AOA), 1e-15, "recorded stall: postFlightConditions did not reach accepted k1 row (rad)");
                counts.recorded++;
                counts.windowWarningsEnabled = true;
                if (Double.isNaN(counts.cp)) {
                    counts.cp = b.getLast(FlightDataType.TYPE_CP_LOCATION);
                    counts.cg = b.getLast(FlightDataType.TYPE_CG_LOCATION);
                    counts.decisionTime = s.getSimulationTime();
                }
                // The engine assesses stall AFTER postStep and drains ALL due
                // events on the next iteration, even after SIMULATION_END. Thus
                // a TUMBLE queued by this accepted row still executes normally.
                s.addEvent(new FlightEvent(FlightEvent.Type.SIMULATION_END, s.getSimulationTime()));
            }
            FlightConditions poisonConditions = new FlightConditions(s.getConfiguration());
            poisonConditions.setMach(0.3); poisonConditions.setAOA(poison);
            s.getSimulationConditions().getAerodynamicCalculator().getAerodynamicForces(
                    s.getConfiguration(), poisonConditions, new WarningSet());
            counts.poisoned++;
        }
        @Override public boolean handleFlightEvent(SimulationStatus s, FlightEvent e) {
            if (coast) return true;
            if (e.getType() == FlightEvent.Type.LAUNCHROD) clearance = s.getSimulationTime();
            if (e.getType() == FlightEvent.Type.TUMBLE) counts.tumbleCallbacks++;
            return true;
        }
    }
}
