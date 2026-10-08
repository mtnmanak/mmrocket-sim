package info.openrocket.core.simulation;

import static org.junit.jupiter.api.Assertions.*;
import static info.openrocket.core.simulation.EventThrustTest.*;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import info.openrocket.core.aerodynamics.AerodynamicForces;
import info.openrocket.core.aerodynamics.FlightConditions;
import info.openrocket.core.logging.MessagePriority;
import info.openrocket.core.logging.SimulationAbort;
import info.openrocket.core.logging.Warning;
import info.openrocket.core.masscalc.MassCalculator;
import info.openrocket.core.motor.IgnitionEvent;
import info.openrocket.core.motor.Motor;
import info.openrocket.core.rocketcomponent.*;
import info.openrocket.core.simulation.SimulationStatus.TumbleDetector;
import info.openrocket.core.util.Coordinate;

/** Real accepted-step/event-loop tests for OR #3183, using the T2 rounded-fin fixture. */
class TumbleReleaseIntegrationTest {
    private static Fixture powered() {
        Fixture f = reference();
        installMotor(f, f.mount, TIMES, THRUSTS, IgnitionEvent.LAUNCH, Motor.PLUGGED_DELAY);
        return f;
    }

    private static int largeWarnings(FlightDataBranch b) {
        int count = 0;
        for (FlightEvent e : events(b, FlightEvent.Type.SIM_WARN)) {
            if (e.getData() instanceof Warning.LargeAOA w) {
                // Mutation: restore NORMAL priority.
                assertSame(MessagePriority.LOW, w.getPriority());
                count++;
            }
        }
        return count;
    }

    /** Values copied at postStep, BEFORE the real event loop updates its detector. */
    private record Row(double time, boolean cleared, double aoa, double speed, double rho,
            double omega, double sampleTime, double cp, double cg, boolean warnings) {
        static Row from(SimulationStatus s) {
            FlightDataBranch b = s.getFlightDataBranch();
            return new Row(s.getSimulationTime(), s.isLaunchRodCleared(), b.getLast(FlightDataType.TYPE_AOA),
                    b.getLast(FlightDataType.TYPE_MACH_NUMBER) * b.getLast(FlightDataType.TYPE_SPEED_OF_SOUND),
                    b.getLast(FlightDataType.TYPE_AIR_DENSITY), b.getLast(FlightDataType.TYPE_NATURAL_FREQUENCY),
                    b.getLast(FlightDataType.TYPE_TIME), b.getLast(FlightDataType.TYPE_CP_LOCATION),
                    b.getLast(FlightDataType.TYPE_CG_LOCATION), s.recordWarnings());
        }
    }

    private enum Window { GUST, POWERED, COAST, DESCENT }

    private static final class Trace {
        final List<Row> rows = new ArrayList<>();
        double start = Double.NaN, tumble = Double.NaN, thrustAtTumble = Double.NaN, firstForced = Double.NaN;
        int tumbleCallbacks;
        boolean tumblingAtGround;
    }

    private static final class Forced extends MainListener {
        final Window window;
        final boolean separated;
        final Trace trace;
        Forced(Window window, boolean separated, Trace trace) {
            this.window = window; this.separated = separated; this.trace = trace;
        }
        @Override public void startSimulation(SimulationStatus s) {
            super.startSimulation(s);
            if (!coast && separated) s.setSeparatedStage(true);
        }
        boolean forced(double t) {
            return Double.isFinite(trace.start) && t >= trace.start
                    && (window != Window.GUST || t < trace.start + 0.020);
        }
        @Override public FlightConditions postFlightConditions(SimulationStatus s, FlightConditions fc) {
            if (!coast && forced(s.getSimulationTime())) {
                fc.setAOA(Math.toRadians(window == Window.GUST ? 150 : 120));
                return fc;
            }
            return null;
        }
        @Override public AerodynamicForces postAerodynamicCalculation(SimulationStatus s, AerodynamicForces forces) {
            if (!coast && window != Window.GUST && forced(s.getSimulationTime())) {
                double cg = MassCalculator.calculateStructure(s.getConfiguration()).add(MassCalculator.calculateMotor(s)).getCM().x;
                // Aft CP deliberately defeats the OLD cg > cp comparator. The
                // force coefficients remain those calculated at the forced AOA.
                forces.setReportedCP(new Coordinate(cg + 0.05, 0, 0, forces.getCP().weight));
                return forces;
            }
            return null;
        }
        @Override public void postStep(SimulationStatus s) {
            if (!coast && !s.isTumbling() && !s.isLanded() && s.getDeployedRecoveryDevices().isEmpty()) {
                trace.rows.add(Row.from(s));
            }
        }
        @Override public boolean handleFlightEvent(SimulationStatus s, FlightEvent e) {
            if (coast) return true;
            if (e.getType() == FlightEvent.Type.LAUNCHROD && (window == Window.GUST || window == Window.POWERED)) {
                // Powered ascent gives a well-conditioned q and permits warnings
                // after the 0.25 s suppression interval, unlike an apogee gust.
                trace.start = s.getSimulationTime() + 0.35;
            }
            if (e.getType() == FlightEvent.Type.BURNOUT && window == Window.COAST) trace.start = s.getSimulationTime() + 0.1;
            if (e.getType() == FlightEvent.Type.APOGEE && window == Window.DESCENT) trace.start = s.getSimulationTime();
            if (e.getType() == FlightEvent.Type.TUMBLE) {
                trace.tumbleCallbacks++;
                trace.tumble = s.getSimulationTime();
                assertEquals(e.getTime(), trace.tumble, 1e-12, "TUMBLE status/event time, s");
                trace.thrustAtTumble = 0;
                for (MotorClusterState motor : s.getActiveMotors()) trace.thrustAtTumble += motor.getThrust(s.getSimulationTime());
            }
            if (e.getType() == FlightEvent.Type.GROUND_HIT) trace.tumblingAtGround = s.isTumbling();
            return true;
        }
    }

    private static FlightDataBranch gust(double step, boolean separated) {
        Fixture f = powered();
        // Recovery at apogee separates this transient ascent test from the
        // legitimate high-AOA, unrecovered descent tested below.
        addChute(f, DeploymentConfiguration.DeployEvent.APOGEE);
        Trace trace = new Trace();
        Forced listener = new Forced(Window.GUST, separated, trace);
        FlightDataBranch b = fly(conditions(f, step), listener).getBranch(0);
        int forcedRows = 0, oldWouldTumble = 0;
        for (Row row : trace.rows) if (listener.forced(row.sampleTime)) {
            forcedRows++;
            assertEquals(Math.toRadians(150), row.aoa, 1e-12);
            if (row.aoa > calculator("classic").getStallAngle() && row.cg > row.cp && row.warnings) oldWouldTumble++;
        }
        assertTrue(forcedRows >= 2, "brief gust must cover several accepted rows");
        assertTrue(oldWouldTumble > 0, "OLD comparator precondition: recorded AOA > stall AND CG > CP with warnings enabled");
        assertTrue(events(b, FlightEvent.Type.TUMBLE).isEmpty(), "brief gust must not tumble");
        assertEquals(0, trace.tumbleCallbacks, "brief gust must not even queue an under-thrust TUMBLE");
        assertTrue(events(b, FlightEvent.Type.SIM_ABORT).isEmpty());
        assertFalse(events(b, FlightEvent.Type.APOGEE).isEmpty());
        assertFalse(events(b, FlightEvent.Type.GROUND_HIT).isEmpty());
        if (separated) assertEquals(0, largeWarnings(b));
        else assertTrue(largeWarnings(b) > 0, "transient must retain informative LargeAOA warning");
        return b;
    }

    @Test void briefGustWarnsAtLowPriorityAndCompletesAtTwoSteps() {
        // Mutations: restore instantaneous cg > cp TUMBLE; restore NORMAL warning.
        for (double step : new double[] {0.005, 0.0025}) gust(step, false);
    }

    private static Trace sustained(Window window, boolean separated, double step) {
        Fixture f = powered(); // No recovery device: descent detection remains observable.
        Trace trace = new Trace();
        Forced listener = new Forced(window, separated, trace);
        FlightDataBranch b = fly(conditions(f, step), listener).getBranch(0);
        assertTrue(Double.isFinite(trace.start), "forcing trigger was never reached");
        assertEquals(1, trace.tumbleCallbacks, "sustained high AOA must queue exactly one TUMBLE");
        int forcedRows = 0;
        double firstForced = Double.NaN, eligibleStart = Double.NaN;
        for (Row row : trace.rows) if (listener.forced(row.sampleTime)) {
            forcedRows++;
            if (Double.isNaN(firstForced)) firstForced = row.time;
            assertEquals(Math.toRadians(120), row.aoa, 1e-12);
            assertTrue(row.cp > row.cg, "OLD comparator must miss EVERY forced row: CP aft of CG, m");
            if (0.5 * row.rho * row.speed * row.speed >= 1 && Double.isNaN(eligibleStart)) eligibleStart = row.time;
            if (Double.isFinite(eligibleStart)) assertTrue(0.5 * row.rho * row.speed * row.speed >= 1,
                    "analytic upper bound needs continuous observable q after its first eligible row");
        }
        assertTrue(forcedRows > 1);
        trace.firstForced = firstForced;
        assertTrue(trace.tumble > firstForced, "not an instantaneous first-row departure");
        assertTrue(trace.tumble > trace.start + TumbleDetector.MIN_TIME_CONSTANT * Math.log(2) - step,
                "minimum dwell lower bound, seconds");
        // For constant 120 deg starting from any nonnegative filter value,
        // tau <= 2 s crosses 60 deg by 2*ln(2), plus ONE accepted step.
        // Descent can start at negligible q: add its measured unobservable
        // interval, not a guessed apogee time or a five-step tolerance.
        assertTrue(Double.isFinite(eligibleStart));
        double lowQDelay = Math.max(0, eligibleStart - trace.start);
        assertTrue(trace.tumble <= trace.start + lowQDelay + TumbleDetector.MAX_TIME_CONSTANT * Math.log(2) + step + 1e-9);
        assertReplay(trace);
        if (window == Window.POWERED) {
            assertTrue(trace.thrustAtTumble > 0.01, "powered fixture must still burn at detection");
            assertTrue(aborted(b, SimulationAbort.Cause.TUMBLE_UNDER_THRUST));
            assertTrue(events(b, FlightEvent.Type.TUMBLE).isEmpty(), "abort must not enter tumble stepper");
            assertEquals(trace.tumble, events(b, FlightEvent.Type.SIM_ABORT).get(0).getTime(), 1e-12);
        } else {
            assertEquals(0, trace.thrustAtTumble, 1e-12);
            assertTrue(events(b, FlightEvent.Type.SIM_ABORT).isEmpty());
            assertEquals(1, events(b, FlightEvent.Type.TUMBLE).size());
            assertEquals(trace.tumble, events(b, FlightEvent.Type.TUMBLE).get(0).getTime(), 1e-12);
            assertFalse(events(b, FlightEvent.Type.GROUND_HIT).isEmpty());
            assertTrue(trace.tumblingAtGround, "ground hit must use the tumble stepper");
        }
        System.out.println("tumble window=" + window + " step=" + step + " start=" + trace.start
                + " detected=" + trace.tumble + " eligible=" + eligibleStart + " s");
        return trace;
    }

    private static void assertReplay(Trace trace) {
        // Mutations: share branch detector with RK trial states; wrong event-loop
        // time, AOA, air-relative speed, density or frequency inputs.
        TumbleDetector replay = new TumbleDetector();
        double first = Double.NaN;
        for (Row row : trace.rows) {
            if (replay.update(row.time, row.cleared, row.aoa, row.speed, row.rho, row.omega)) {
                first = row.time;
                break;
            }
        }
        assertTrue(Double.isFinite(first), "fresh detector never replayed the crossing");
        assertEquals(first, trace.tumble, 1e-12 + 1e-10 * Math.abs(first), "first replay/kernel decision status time, s");
    }

    @Test void sustainedCoastDetectionTimeConvergesWithStepAndKeepsOneStepSampleLag() {
        // Review fix (DESIGN 7 timing limitation, DESIGN 9 criteria): the engine's
        // detection time must converge as the step shrinks - each halving moves it by
        // at most one accepted step of the coarser run - and the retained upstream lag
        // between the end-of-step status time and the k1 row it judges is at most one
        // accepted step. This pins the DESIGN 9 timing criterion; it is not the guard
        // for the detector's constants (Hz, minimum tau: TumbleDetectorTest kills those;
        // measured, the Hz mutation still converges here).
        // Measured from the FIRST FORCED accepted row, not absolute time: the forcing
        // window opens on the step grid, so its start itself moves by up to a step.
        double[] steps = {0.005, 0.0025, 0.00125};
        double[] detected = new double[steps.length];
        for (int k = 0; k < steps.length; k++) {
            Trace trace = sustained(Window.COAST, false, steps[k]);
            detected[k] = trace.tumble - trace.firstForced;
            Row last = null;
            for (Row row : trace.rows) if (row.time <= trace.tumble + 1e-12) last = row;
            assertNotNull(last);
            assertEquals(trace.tumble, last.time, 1e-12, "detection is at the status time of the judged row, s");
            double lag = last.time - last.sampleTime;
            assertTrue(lag > 0 && lag <= steps[k] + 1e-9, "k1-row lag must be within one accepted step: " + lag + " s");
            System.out.println("tumble convergence step=" + steps[k] + " firstForced=" + trace.firstForced
                    + " detected=" + trace.tumble + " dwell=" + detected[k] + " lag=" + lag + " s");
        }
        assertTrue(Math.abs(detected[0] - detected[1]) <= steps[0] + 1e-9, "0.005 vs 0.0025 s dwell, s");
        assertTrue(Math.abs(detected[1] - detected[2]) <= steps[1] + 1e-9, "0.0025 vs 0.00125 s dwell, s");
    }

    @Test void sustainedDepartureWithAftCpAbortsUnderThrustAndTumblesInCoastAndDescent() {
        // Mutation: restore OLD cg > cp comparator, or gate detector to ascent only.
        for (Window window : new Window[] {Window.POWERED, Window.COAST, Window.DESCENT}) sustained(window, false, 0.005);
    }

    private static final class WindTrace extends MainListener {
        final double speed;
        final List<Row> rows = new ArrayList<>();
        WindTrace(double speed) { this.speed = speed; }
        @Override public Coordinate preWindModel(SimulationStatus s) { return new Coordinate(speed, 0, 0); }
        @Override public void postStep(SimulationStatus s) { if (!coast) rows.add(Row.from(s)); }
    }

    /**
     * The reference fixture with 10 g of nose ballast: statically stable at low AOA
     * (about 2 cal at rail exit in calm air), so it weathercocks and recovers. The
     * bare reference fixture is NOT used here: measured, its CP sits forward of its
     * CG from about 11 deg AOA (body lift), so in a 6 m/s crosswind it genuinely
     * departs (AOA past 120 deg under thrust) and aborting is the right outcome.
     */
    private static Fixture ballastedStable() {
        Fixture f = powered();
        f.stage.getChild(0).addChild(new MassComponent(0.02, 0.008, 0.010));
        return f;
    }

    @Test void steadyCrosswindStableRocketCompletesWhereOldComparatorAborted() {
        // OR #3183's scenario adapted (upstream: Alpha III, steady 6 m/s, aborted every
        // run). Here: 0.5 m rod, steady 8 m/s, rail exit AOA about 30 deg, where the
        // force-consistent CP (66(b)) sits just forward of the CG, so the OLD
        // instantaneous comparator fires at rail exit (TUMBLE_UNDER_THRUST abort). The
        // 6 m/s case is a CONTROL (old comparator never fires there either).
        // Mutations: restore instantaneous comparator (8 m/s aborts); always minimum
        // tau (calm finite-dwell path).
        double calmApogee = Double.NaN;
        for (double speed : new double[] {0, 6, 8}) {
            Fixture f = ballastedStable();
            WindTrace listener = new WindTrace(speed);
            SimulationConditions c = conditions(f, 0.01);
            c.setLaunchRodLength(0.5);
            FlightDataBranch b = fly(c, listener).getBranch(0);
            double apogee = b.getMaximum(FlightDataType.TYPE_ALTITUDE);
            if (speed == 0) calmApogee = apogee;
            double maxAOA = 0, oldComparatorAt = Double.NaN;
            int finiteDwell = 0;
            for (Row row : listener.rows) {
                // Free flight (on the guide a crosswind reads 90 deg), powered ascent
                // and early coast only (near apogee q vanishes).
                if (row.cleared && Double.isFinite(row.aoa) && row.time < 1.5) maxAOA = Math.max(maxAOA, row.aoa);
                if (row.cleared && Double.isFinite(row.omega) && row.omega > 0
                        && TumbleDetector.timeConstant(row.omega) > TumbleDetector.MIN_TIME_CONSTANT) finiteDwell++;
                // Before the first TUMBLE/abort decision both kernels fly identical
                // rows, so this is exactly where the OLD block would have fired.
                if (Double.isNaN(oldComparatorAt) && row.cleared && row.time < 1.0
                        && row.aoa > calculator("classic").getStallAngle() && row.cg > row.cp) oldComparatorAt = row.time;
            }
            if (speed == 0) assertTrue(finiteDwell > 0, "stable reference must take finite-frequency, nonminimum dwell path");
            System.out.println("steady wind=" + speed + " m/s apogee=" + apogee + " m tumble="
                    + !events(b, FlightEvent.Type.TUMBLE).isEmpty() + " maxAOA=" + maxAOA
                    + " rad LargeAOA=" + largeWarnings(b) + " oldComparatorAt=" + oldComparatorAt
                    + " abort=" + events(b, FlightEvent.Type.SIM_ABORT));
            if (speed == 8) assertTrue(Double.isFinite(oldComparatorAt),
                    "precondition: the OLD comparator must fire on this flight's ascent rows");
            if (speed == 6) assertTrue(Double.isNaN(oldComparatorAt), "6 m/s is the control: old comparator silent");
            assertTrue(events(b, FlightEvent.Type.SIM_ABORT).isEmpty(), "stable rocket in steady crosswind aborted at " + speed + " m/s");
            assertFalse(events(b, FlightEvent.Type.APOGEE).isEmpty());
            assertTrue(maxAOA < Math.toRadians(45), "stable rocket must recover, not depart: max ascent AOA " + maxAOA + " rad");
            // Only a sanity bound, NOT upstream's 10% accuracy claim or flight validation.
            assertTrue(apogee > 0.5 * calmApogee);
        }
    }

    @Test void finlessRocketStillDepartsWithNegativeStiffnessFallback() {
        // Mutations: disable detector, suppress NaN fallback, take abs(stiffness).
        Fixture f = powered();
        for (RocketComponent child : new ArrayList<>(f.body.getChildren())) if (child instanceof FinSet) f.body.removeChild(child);
        WindTrace listener = new WindTrace(2);
        FlightDataBranch b = fly(conditions(f, 0.01), listener).getBranch(0);
        assertTrue(!events(b, FlightEvent.Type.TUMBLE).isEmpty() || aborted(b, SimulationAbort.Cause.TUMBLE_UNDER_THRUST));
        int unstable = 0;
        for (Row row : listener.rows) {
            if (!row.cleared || !Double.isFinite(row.aoa) || !Double.isFinite(row.cp) || !Double.isFinite(row.cg)) continue;
            if (row.cp < row.cg) {
                unstable++;
                assertTrue(Double.isNaN(row.omega), "negative stiffness must select fallback");
            } else if (row.cp > row.cg) assertTrue(Double.isFinite(row.omega), "positive stiffness must remain finite");
        }
        assertTrue(unstable > 0, "fixture must genuinely have post-rail CP forward of CG");
    }

    @Test void separatedFlagSuppressesOnlyWarningNotDetection() {
        // Mutation: drop !isSeparatedStage() in warning condition, or apply it to detection.
        gust(0.005, false);
        gust(0.005, true);
        sustained(Window.COAST, true, 0.005);
    }

    @Test void boosterIsSeparatedFromItsFirstObservedEventAndSustainerNeverIs() {
        // Mutation: drop separated flag at booster creation; accidentally flag sustainer.
        Fixture f = reference();
        f.stage.setName("Sustainer");
        TrapezoidFinSet fins = (TrapezoidFinSet) f.body.getChild(0);
        fins.setSweep(0.071); fins.setTipChord(0.055);
        installMotor(f, f.mount, TIMES, THRUSTS, IgnitionEvent.BURNOUT, 1);
        addChute(f, DeploymentConfiguration.DeployEvent.EJECTION);
        AxialStage booster = new AxialStage();
        booster.setName("CHAD booster"); f.rocket.addChild(booster);
        booster.getSeparationConfigurations().getDefault().setSeparationEvent(StageSeparationConfiguration.SeparationEvent.BURNOUT);
        booster.getSeparationConfigurations().getDefault().setSeparationDelay(0);
        BodyTube body = new BodyTube(0.07, 0.009, 0);
        booster.addChild(body); body.setMotorMount(true);
        installMotor(f, body, TIMES, THRUSTS, IgnitionEvent.LAUNCH, Motor.PLUGGED_DELAY);
        Map<String, List<Boolean>> flags = new LinkedHashMap<>();
        FlightData data = fly(conditions(f, 0.01), new MainListener() {
            void observe(SimulationStatus s) {
                if (!coast) flags.computeIfAbsent(s.getFlightDataBranch().getName(), name -> new ArrayList<>()).add(s.isSeparatedStage());
            }
            @Override public void postStep(SimulationStatus s) { observe(s); }
            @Override public boolean handleFlightEvent(SimulationStatus s, FlightEvent e) { observe(s); return true; }
        });
        assertEquals(2, data.getBranchCount());
        assertFalse(events(branchNamed(data, "Sustainer"), FlightEvent.Type.STAGE_SEPARATION).isEmpty());
        for (String name : new String[] {"Sustainer", "CHAD booster"}) {
            assertNotNull(flags.get(name), "missing observed branch " + name);
            assertFalse(flags.get(name).isEmpty());
            for (boolean separated : flags.get(name)) assertEquals(name.equals("CHAD booster"), separated, name);
        }
    }

    @Test void statusCopyAndCloneInheritButDoNotShareAndPartialCopyExcludesHistory() {
        // Mutations: copy/clone shares detector; omit history/separated flag;
        // copy in copyProperties (which is only a kinematics transfer).
        Fixture f = powered();
        SimulationConditions c = conditions(f, 0.01);
        SimulationStatus orig = new SimulationStatus(f.rocket.getSelectedConfiguration(), c);
        orig.setSeparatedStage(true);
        orig.getTumbleDetector().update(1, true, 2, 20, 1.2, 10);
        orig.getTumbleDetector().update(1.2, true, 2, 20, 1.2, 10);
        assertTrue(orig.getTumbleDetector().getFilteredAOA() > 0);
        for (SimulationStatus copy : new SimulationStatus[] {new SimulationStatus(orig), orig.clone()}) {
            assertTrue(copy.isSeparatedStage());
            assertNotSame(orig.getTumbleDetector(), copy.getTumbleDetector());
            assertEquals(orig.getTumbleDetector().getFilteredAOA(), copy.getTumbleDetector().getFilteredAOA());
            assertEquals(orig.getTumbleDetector().getLastTime(), copy.getTumbleDetector().getLastTime());
        }
        SimulationStatus copied = new SimulationStatus(orig), cloned = orig.clone();
        double before = orig.getTumbleDetector().getFilteredAOA();
        copied.getTumbleDetector().update(1.3, true, 2, 20, 1.2, 10);
        cloned.getTumbleDetector().update(1.4, true, 0, 20, 1.2, 10);
        assertEquals(before, orig.getTumbleDetector().getFilteredAOA());
        double copyValue = copied.getTumbleDetector().getFilteredAOA(), cloneValue = cloned.getTumbleDetector().getFilteredAOA();
        orig.getTumbleDetector().update(1.5, true, 1, 20, 1.2, 10);
        assertEquals(copyValue, copied.getTumbleDetector().getFilteredAOA());
        assertEquals(cloneValue, cloned.getTumbleDetector().getFilteredAOA());
        assertEquals(1.3, copied.getTumbleDetector().getLastTime());
        assertEquals(1.4, cloned.getTumbleDetector().getLastTime());
        SimulationStatus partial = new SimulationStatus(f.rocket.getSelectedConfiguration(), c);
        partial.copyProperties(orig);
        assertEquals(0, partial.getTumbleDetector().getFilteredAOA());
        assertTrue(Double.isNaN(partial.getTumbleDetector().getLastTime()));
        assertFalse(partial.isSeparatedStage());
    }
}
