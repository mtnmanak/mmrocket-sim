package info.openrocket.core.simulation;

import static org.junit.jupiter.api.Assertions.*;
import org.junit.jupiter.api.Test;
import info.openrocket.core.simulation.SimulationStatus.TumbleDetector;

/** OR #3183: time is seconds, angles radians, omega rad/s, q Pa. */
class TumbleDetectorTest {
    private static final double HIGH = Math.toRadians(120);
    private static final double RHO = 1.225;

    private static void near(double expected, double actual) {
        assertEquals(expected, actual, 1e-12 + 1e-10 * Math.abs(expected));
    }

    @Test void angularPeriodAndFallbackClamps() {
        // Mutations: Hz conversion, one rather than two periods, always minimum tau.
        near(4 * Math.PI / 10, TumbleDetector.timeConstant(10));
        assertEquals(0.05, TumbleDetector.timeConstant(1e10));
        assertEquals(2.0, TumbleDetector.timeConstant(0.01));
        for (double omega : new double[] {0, -1, Double.NaN, Double.POSITIVE_INFINITY,
                Double.NEGATIVE_INFINITY}) assertEquals(0.05, TumbleDetector.timeConstant(omega));
        near(Math.PI / 3, TumbleDetector.TUMBLE_THRESHOLD);
        assertEquals(1.0, TumbleDetector.MIN_DYNAMIC_PRESSURE);
        assertEquals(2.0, TumbleDetector.DWELL_PERIODS);
    }

    /** Returns the FIRST crossing; checks the exact solution after EVERY step. */
    private static double crossing(double... steps) {
        TumbleDetector d = new TumbleDetector();
        double t0 = 7, t = t0, first = Double.NaN;
        double tau = 4 * Math.PI / 10;
        d.update(t0, true, HIGH, 20, RHO, 10);
        for (int i = 0; t < t0 + 3; i++) {
            double dt = steps[i % steps.length];
            t += dt;
            boolean crossed = d.update(t, true, HIGH, 20, RHO, 10);
            near(HIGH * (1 - Math.exp(-(t - t0) / tau)), d.getFilteredAOA());
            if (crossed && Double.isNaN(first)) {
                first = t;
                assertTrue(first > t0 + tau * Math.log(2), "strict 60-degree threshold");
                assertTrue(first <= t0 + tau * Math.log(2) + dt + 1e-12,
                        "crossing must be within the actual accepted step, seconds");
            }
        }
        assertTrue(Double.isFinite(first));
        return first;
    }

    @Test void exponentialRecurrenceAndCrossingAtFixedAndVariableSteps() {
        // Mutations: Euler gain dt/tau, instantaneous threshold, wrong time/angle units.
        for (double dt : new double[] {0.005, 0.01, 0.05}) crossing(dt);
        crossing(0.01, 0.04);
    }

    @Test void firstSampleOnlyEstablishesTime() {
        // Mutation: integrating from time zero before the first sample.
        for (double angle : new double[] {0, HIGH, Math.PI, Double.NaN}) {
            TumbleDetector d = new TumbleDetector();
            assertTrue(Double.isNaN(d.getLastTime()));
            assertFalse(d.update(123, true, angle, 20, RHO, 10));
            assertEquals(0, d.getFilteredAOA());
            assertEquals(123, d.getLastTime());
        }
    }

    private static double drive(TumbleDetector d, double t, double duration, double angle,
            double speed, boolean mustStayBelow) {
        double end = t + duration;
        while (t < end) {
            t = Math.min(end, t + 0.01);
            d.update(t, true, Math.toRadians(angle), speed, RHO, 10);
            if (mustStayBelow) assertFalse(d.isTumbling(), "transient crossed at " + t + " s");
        }
        return t;
    }

    @Test void briefGustAndSingleSpikeNeverTumble() {
        // Mutation: restore an instantaneous AOA threshold instead of dwell.
        TumbleDetector d = new TumbleDetector();
        d.update(0, true, 0, 60, RHO, 10);
        double t = drive(d, 0, 1, 2, 60, true);
        t = drive(d, t, (2 * Math.PI / 10) / 10, 150, 60, true);
        drive(d, t, 1, 2, 60, true);
        d = new TumbleDetector();
        d.update(0, true, 0, 20, RHO, 10);
        t = drive(d, 0, 1, 3, 20, true);
        drive(d, t, 0.01, 179, 20, true);
    }

    @Test void sustainedAndDescentAnglesTumble() {
        // Mutation: raising the threshold or disabling detection below 120 degrees.
        for (double angle : new double[] {120, 95}) {
            TumbleDetector d = new TumbleDetector();
            d.update(0, true, 0, 20, RHO, 10);
            drive(d, 0, 5, angle, angle == 120 ? 20 : 15, false);
            assertTrue(d.isTumbling(), "sustained " + angle + " deg");
        }
    }

    @Test void railAndPressureBoundaryHoldOrIntegrate() {
        // Mutations: remove q/rail gate; change strict q < 1 into q <= 1.
        TumbleDetector rail = new TumbleDetector();
        for (int i = 0; i <= 500; i++) {
            rail.update(i * 0.01, false, HIGH, 20, RHO, 10);
            assertEquals(0, rail.getFilteredAOA());
        }
        for (double q : new double[] {0.999, 1, 1.001}) {
            TumbleDetector d = new TumbleDetector();
            // rho=2 makes the exact q=1 boundary exactly representable (v=1).
            double v = Math.sqrt(q);
            d.update(0, true, HIGH, v, 2, 10);
            d.update(0.01, true, HIGH, v, 2, 10);
            if (q < 1) assertEquals(0, d.getFilteredAOA());
            else near(HIGH * (1 - Math.exp(-0.01 / (4 * Math.PI / 10))), d.getFilteredAOA());
        }
    }

    @Test void lowPressureHoldsWithoutResetAndGapDoesNotAccumulate() {
        // Mutations: reset on low q; return before advancing lastTime on a held sample.
        TumbleDetector d = new TumbleDetector();
        d.update(0, true, HIGH, 20, RHO, 10);
        double t = drive(d, 0, 5, 120, 20, false);
        assertTrue(d.isTumbling());
        double before = d.getFilteredAOA();
        for (int i = 1; i <= 200; i++) {
            d.update(t + i * 0.01, true, 0, 0.5, RHO, 10);
            assertEquals(before, d.getFilteredAOA());
            assertTrue(d.isTumbling());
        }
        d = new TumbleDetector();
        d.update(0, true, HIGH, 20, RHO, 10);
        d.update(0.1, true, HIGH, 20, RHO, 10);
        assertFalse(d.isTumbling());
        before = d.getFilteredAOA();
        d.update(10.1, true, HIGH, 0.5, RHO, 10);
        assertEquals(before, d.getFilteredAOA());
        d.update(10.11, true, HIGH, 20, RHO, 10);
        near(before + (1 - Math.exp(-0.01 / (4 * Math.PI / 10))) * (HIGH - before), d.getFilteredAOA());
        assertFalse(d.isTumbling());
    }

    @Test void invalidInputsAndNonpositiveStepsHoldState() {
        // Mutations: drop any finite/nonnegative input guard, or integrate nonpositive dt.
        double[][] invalid = {{Double.NaN, 20, RHO}, {Double.POSITIVE_INFINITY, 20, RHO},
                {HIGH, Double.NaN, RHO}, {HIGH, Double.POSITIVE_INFINITY, RHO}, {HIGH, -20, RHO},
                {HIGH, 20, Double.NaN}, {HIGH, 20, Double.POSITIVE_INFINITY}, {HIGH, 20, -1},
                {HIGH, Double.MAX_VALUE, RHO}};
        TumbleDetector d = new TumbleDetector();
        d.update(0, true, HIGH, 20, RHO, 10);
        d.update(0.2, true, HIGH, 20, RHO, 10);
        double before = d.getFilteredAOA(), t = 0.2;
        for (double[] input : invalid) {
            t += 0.1;
            d.update(t, true, input[0], input[1], input[2], 10);
            assertEquals(before, d.getFilteredAOA());
            assertEquals(t, d.getLastTime());
        }
        d.update(t, true, HIGH, 20, RHO, 10);
        assertEquals(before, d.getFilteredAOA());
        d.update(t - 0.1, true, HIGH, 20, RHO, 10);
        assertEquals(before, d.getFilteredAOA());
        assertEquals(t - 0.1, d.getLastTime());
        for (double time : new double[] {Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY}) {
            d.update(time, true, HIGH, 20, RHO, 10);
            assertEquals(before, d.getFilteredAOA());
            assertEquals(t - 0.1, d.getLastTime());
        }
    }

    @Test void copyInheritsHistoryAndUpdatesIndependently() {
        // Mutation: omit either copied field (or share filter history).
        TumbleDetector d = new TumbleDetector();
        d.update(1, true, HIGH, 20, RHO, 10);
        d.update(1.4, true, HIGH, 20, RHO, 10);
        TumbleDetector copy = new TumbleDetector(d);
        assertEquals(d.getFilteredAOA(), copy.getFilteredAOA());
        assertEquals(d.getLastTime(), copy.getLastTime());
        double original = d.getFilteredAOA();
        copy.update(1.5, true, HIGH, 20, RHO, 10);
        assertEquals(original, d.getFilteredAOA());
        double copied = copy.getFilteredAOA();
        d.update(1.6, true, 0, 20, RHO, 10);
        assertEquals(copied, copy.getFilteredAOA());
        assertEquals(1.5, copy.getLastTime());
        assertNotEquals(d.getFilteredAOA(), copy.getFilteredAOA());
    }
}
