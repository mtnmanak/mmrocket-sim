package info.openrocket.core.aerodynamics;

import static org.junit.jupiter.api.Assertions.*;
import static info.openrocket.core.aerodynamics.AbstractAerodynamicCalculator.*;

import api.OrkEngine;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Map;
import java.util.function.DoubleFunction;
import org.junit.jupiter.api.Test;
import info.openrocket.core.document.Simulation;
import info.openrocket.core.logging.WarningSet;
import info.openrocket.core.masscalc.MassCalculator;
import info.openrocket.core.models.atmosphere.ExtendedISAModel;
import info.openrocket.core.models.gravity.WGSGravityModel;
import info.openrocket.core.models.wind.PinkNoiseWindModel;
import info.openrocket.core.rocketcomponent.FlightConfiguration;
import info.openrocket.core.rocketcomponent.Rocket;
import info.openrocket.core.rocketcomponent.RocketComponent;
import info.openrocket.core.simulation.*;
import info.openrocket.core.util.Coordinate;
import info.openrocket.core.util.GeodeticComputationStrategy;
import info.openrocket.core.util.ModID;
import info.openrocket.core.util.WorldCoordinate;

/** Decision 66(b): reported lever arm is output-only; derivative CNa stays intact. */
class ForceConsistentCPTest {
    private static final String[] FIXTURES = {"arcas-short", "basic-finner"};
    private static final String[] MODELS = {"classic", "kbf", "supersonic", "hybrid"};

    private static Rocket fixture(String name) throws Exception {
        // Gradle Test defaults to engine-java; also support invocation from repo root.
        Path cwd = Path.of("").toAbsolutePath();
        for (Path base = cwd; base != null; base = base.getParent()) {
            Path path = base.resolve("validation/fixtures/" + name + ".json");
            if (Files.isRegularFile(path)) return OrkEngine.getRocketForTesting(
                    OrkEngine.buildRocket(Files.readString(path)));
        }
        throw new IllegalStateException("Missing fixture " + name + " from " + cwd);
    }

    private static BarrowmanCalculator calculator(String model) {
        if (model.equals("hybrid")) return BarrowmanCalculator.hybrid(0.8, 1.2);
        BarrowmanCalculator c = new BarrowmanCalculator();
        c.setRogersKbf(!model.equals("classic"));
        c.setSupersonicAero(model.equals("supersonic"));
        return c;
    }

    private static double rad(double deg) { return deg * Math.PI / 180; }
    private static FlightConditions conditions(Rocket r, double mach, double aoa) {
        FlightConditions fc = new FlightConditions(r.getSelectedConfiguration());
        fc.setMach(mach); fc.setAOA(aoa); fc.setTheta(0);
        return fc;
    }
    private static FlightConditions rates(FlightConditions fc) {
        FlightConditions moving = fc.clone();
        moving.setPitchRate(0.7); moving.setYawRate(0.4); moving.setRollRate(0.9);
        return moving;
    }
    private static AerodynamicForces forces(AerodynamicCalculator c, Rocket r, FlightConditions fc) {
        return c.getAerodynamicForces(r.getSelectedConfiguration(), fc, new WarningSet());
    }
    private static Coordinate cp(AerodynamicCalculator c, Rocket r, FlightConditions fc) {
        return c.getCP(r.getSelectedConfiguration(), fc, new WarningSet());
    }
    private static Map<RocketComponent, AerodynamicForces> analysis(AerodynamicCalculator c, Rocket r, FlightConditions fc) {
        // getRawForceAnalysis adds drag but does not apply damping or change CN/Cm.
        // Its public wrapper only assigns reportedCP. The returned CN/Cm are thus
        // an independent normal-force oracle (about the tip, not flight CG).
        return c.getForceAnalysis(r.getSelectedConfiguration(), fc, new WarningSet());
    }
    private static void near(double expected, double actual) {
        assertTrue(Double.isFinite(expected) && Double.isFinite(actual), "finite arithmetic operands");
        assertEquals(expected, actual, 1e-12 + 1e-10 * Math.abs(expected));
    }
    private static void same(Coordinate a, Coordinate b) {
        assertEquals(Double.doubleToLongBits(a.x), Double.doubleToLongBits(b.x), "CP x bits");
        assertEquals(Double.doubleToLongBits(a.y), Double.doubleToLongBits(b.y), "CP y bits");
        assertEquals(Double.doubleToLongBits(a.z), Double.doubleToLongBits(b.z), "CP z bits");
        assertEquals(Double.doubleToLongBits(a.weight), Double.doubleToLongBits(b.weight), "CNa bits");
    }
    private static void identity(Coordinate cp, AerodynamicForces raw, double d) {
        assertTrue(Math.abs(raw.getCN()) > 1e-8, "identity needs usable CN");
        near(raw.getCm() * d, cp.x * raw.getCN());
        // Flat and recursive component sums can differ by one ulp.
        near(raw.getDerivativeCP().weight, cp.weight);
    }

    @Test void registerReproductionRetainsDerivativeCpAndWeight() throws Exception {
        // Guards: revert getCP/total correction, or overwrite derivative CP/CNa.
        // Values measured on TeaVM, not JVM: relative 1e-9 accommodates runtime rounding.
        double[] reported = {10.4317407349, 6.4961848984};
        double[] derivative = {12.0030834497, 7.3501185135};
        double[] diameters = {0.05715, 0.030};
        for (int i = 0; i < FIXTURES.length; i++) {
            Rocket r = fixture(FIXTURES[i]);
            BarrowmanCalculator c = calculator("kbf");
            FlightConditions fc = conditions(r, 0.3, rad(45));
            assertEquals(diameters[i], fc.getRefLength(), 1e-15);
            AerodynamicForces f = forces(c, r, fc);
            AerodynamicForces raw = analysis(c, r, fc).get(r);
            for (Coordinate out : new Coordinate[] {cp(c, r, fc), f.getCP()}) {
                assertEquals(reported[i], out.x / fc.getRefLength(), reported[i] * 1e-9);
                identity(out, raw, fc.getRefLength());
            }
            assertEquals(derivative[i], f.getDerivativeCP().x / fc.getRefLength(), derivative[i] * 1e-9);
            assertEquals(f.getDerivativeCP().weight, f.getCP().weight, 0);
        }
    }

    @Test void exactTwentyDegreeBoundaryPreservesEveryDerivativeOutput() throws Exception {
        // Guards: threshold moved to 17.5 degrees or >= instead of strictly > 20.
        for (String name : FIXTURES) for (String model : MODELS) {
            Rocket r = fixture(name);
            BarrowmanCalculator c = calculator(model);
            for (double aoa : new double[] {0, rad(2), rad(10), rad(17.5), rad(18), rad(19), rad(19.99), FORCE_CONSISTENT_CP_AOA}) {
                FlightConditions fc = conditions(r, 0.3, aoa);
                AerodynamicForces f = forces(c, r, fc);
                assertFalse(f.hasReportedCP(), name + " " + model + " at " + aoa);
                same(f.getDerivativeCP(), cp(c, r, fc));
                for (AerodynamicForces entry : analysis(c, r, fc).values()) assertFalse(entry.hasReportedCP());
            }
            for (double aoa : new double[] {FORCE_CONSISTENT_CP_AOA + 1e-9, rad(20.01), rad(25)}) {
                assertTrue(forces(c, r, conditions(r, 0.3, aoa)).hasReportedCP());
            }
        }
    }

    @Test void highAngleLeverArmUsesZeroRateNormalForceForEveryModel() throws Exception {
        // Guards: derivative fallback above threshold, CN substituted for derivative weight.
        for (String name : FIXTURES) for (String model : new String[] {"classic", "kbf", "supersonic"}) {
            Rocket r = fixture(name);
            BarrowmanCalculator c = calculator(model);
            for (double deg : new double[] {25, 30, 45, 60, 90}) {
                FlightConditions fc = conditions(r, 0.3, rad(deg));
                AerodynamicForces raw = analysis(c, r, fc).get(r);
                AerodynamicForces total = forces(c, r, fc);
                identity(cp(c, r, fc), raw, fc.getRefLength());
                identity(total.getCP(), raw, fc.getRefLength());
                assertEquals(total.getDerivativeCP().weight, total.getCP().weight, 0);
                if (deg == 45) assertTrue(Math.abs(total.getCP().x - total.getDerivativeCP().x) > 1e-4);
            }
        }
    }

    @Test void ratesChangePhysicalDampingButNeverReportedCpOrCallerConditions() throws Exception {
        // Guards: damping/random torque included in CP, rates zeroed in-place, CP fed back into Cm.
        for (String model : MODELS) {
            Rocket r = fixture("arcas-short");
            BarrowmanCalculator c = calculator(model);
            FlightConditions zero = conditions(r, 0.3, rad(45));
            FlightConditions moving = rates(zero);
            AerodynamicForces a = forces(c, r, zero), b = forces(c, r, moving);
            assertEquals(a.getCP().x, b.getCP().x, 0);
            assertEquals(a.getCN(), b.getCN(), 0);
            assertNotEquals(a.getCm(), b.getCm());
            AerodynamicForces raw = analysis(calculator(model), r, moving).get(r);
            near(raw.getCm() - b.getPitchDampingMoment(), b.getCm());
            near(raw.getCyaw() - b.getYawDampingMoment(), b.getCyaw());
            near(raw.getCN(), b.getCN()); near(raw.getCside(), b.getCside()); near(raw.getCroll(), b.getCroll());
            near(raw.getCD(), b.getCD()); near(raw.getCDaxial(), b.getCDaxial());
            near(raw.getFrictionCD(), b.getFrictionCD()); near(raw.getPressureCD(), b.getPressureCD());
            near(raw.getBaseCD(), b.getBaseCD()); near(raw.getOverrideCD(), b.getOverrideCD());
            assertEquals(0.7, moving.getPitchRate(), 0);
            assertEquals(0.4, moving.getYawRate(), 0);
            assertEquals(0.9, moving.getRollRate(), 0);
        }
    }

    @Test void ratioGuardsAndSignedDerivativeMetadata() {
        // Guards: missing |CN| cutoff, sign loss, missing finite/ref-length/overflow checks, weight reset.
        for (double weight : new double[] {0, -3, 5}) {
            Coordinate derivative = new Coordinate(2, 3, -4, weight);
            double[][] invalid = {{1e-8, 1, 1}, {-1e-8, 1, 1}, {0, 1, 1},
                {Double.NaN, 1, 1}, {Double.POSITIVE_INFINITY, 1, 1}, {Double.NEGATIVE_INFINITY, 1, 1},
                {1, Double.NaN, 1}, {1, Double.POSITIVE_INFINITY, 1}, {1, Double.NEGATIVE_INFINITY, 1},
                {1, 1, 0}, {1, 1, -1}, {1, 1, Double.NaN}, {1, 1, Double.POSITIVE_INFINITY},
                {2e-8, 1e300, 1e10}};
            for (double[] row : invalid) {
                Coordinate out = forceConsistentCP(derivative, row[0], row[1], row[2]);
                assertTrue(Double.isNaN(out.x));
                assertEquals(derivative.y, out.y, 0); assertEquals(derivative.z, out.z, 0);
                assertEquals(weight, out.weight, 0);
            }
            for (double cn : new double[] {1.000001e-8, -1.000001e-8, -2}) {
                Coordinate out = forceConsistentCP(derivative, cn, 3, 0.5);
                near(1.5 / cn, out.x);
                assertEquals(3, out.y, 0); assertEquals(-4, out.z, 0); assertEquals(weight, out.weight, 0);
            }
        }
    }

    @Test void outputOverrideNeverCorruptsTheFirstMomentAccumulator() {
        // Guards: override erased by setCm/clone, survives setCP/merge/zero, NaN collapses to ZERO.
        AerodynamicForces f = new AerodynamicForces().zero();
        Coordinate derivative = new Coordinate(2, 3, 4, 5);
        Coordinate reported = new Coordinate(7, 3, 4, 5);
        f.setCP(derivative); f.setReportedCP(reported);
        same(reported, f.getCP()); same(derivative, f.getDerivativeCP());
        f.setCm(17); same(reported, f.getCP()); same(reported, f.clone().getCP());
        ModID old = f.getModID();
        f.setCP(derivative);
        assertFalse(f.hasReportedCP()); assertNotSame(old, f.getModID()); same(derivative, f.getCP());
        f.setReportedCP(reported); f.setCP(new Coordinate(1, 0, 0, 2));
        assertFalse(f.hasReportedCP());
        f.setCP(derivative); f.setReportedCP(reported);
        AerodynamicForces other = new AerodynamicForces().zero();
        other.setCP(new Coordinate(4, 1, 2, 3)); other.setReportedCP(new Coordinate(99, 0, 0, 3));
        f.merge(other);
        assertFalse(f.hasReportedCP());
        same(new Coordinate(22.0 / 8, 18.0 / 8, 26.0 / 8, 8), f.getDerivativeCP());
        f.setReportedCP(reported); f.zero(); assertFalse(f.hasReportedCP()); same(Coordinate.ZERO, f.getCP());
        f.setReportedCP(new Coordinate(Double.NaN, 0, 0, 0));
        assertTrue(Double.isNaN(f.getCP().x)); assertTrue(Double.isNaN(f.clone().getCP().x));
    }

    @Test void eachForceAnalysisEntryUsesItsOwnRawNormalForce() throws Exception {
        // Guards: correction omitted from analysis, aggregate used for leaves, NaN sanitized back to tip.
        Rocket r = fixture("arcas-short");
        BarrowmanCalculator c = calculator("kbf");
        FlightConditions fc = conditions(r, 0.3, rad(45));
        Map<RocketComponent, AerodynamicForces> map = analysis(c, r, fc);
        int valid = 0, invalid = 0;
        for (AerodynamicForces f : map.values()) {
            assertTrue(f.hasReportedCP());
            if (Math.abs(f.getCN()) > 1e-8) { identity(f.getCP(), f, fc.getRefLength()); valid++; }
            else { assertTrue(Double.isNaN(f.getCP().x)); invalid++; }
        }
        assertTrue(valid > 0);
        // No fixture promise of a zero-CN component; cutoff/NaN cases have a dedicated unit guard.
        assertEquals(map.size(), valid + invalid);
        near(cp(c, r, fc).x, map.get(r).getCP().x);
        // Drag has no pre-correction public oracle; total-vs-raw-map checks are in the rates test.
    }

    @Test void forceAnalysisAfterGeometryEditPairsCpWithItsOwnForces() throws Exception {
        // Guard (review finding, 2026-10-08): the reported CP of each force-analysis entry
        // must come from the SAME calculator cache state as that entry's CN/Cm. The raw
        // 24.12 analysis does not checkCache; a zero-rate map that did would pair stale
        // coefficients with a fresh lever arm after a geometry edit.
        Rocket r = fixture("arcas-short");
        BarrowmanCalculator c = calculator("kbf");
        FlightConditions fc = conditions(r, 0.3, rad(45));
        analysis(c, r, fc); // build the calculator's cache
        boolean edited = false;
        for (RocketComponent comp : r) {
            if (comp instanceof info.openrocket.core.rocketcomponent.NoseCone) {
                info.openrocket.core.rocketcomponent.NoseCone nose = (info.openrocket.core.rocketcomponent.NoseCone) comp;
                nose.setLength(nose.getLength() * 1.6);
                edited = true;
            }
        }
        assertTrue(edited, "fixture has a nose cone to edit");
        int checked = 0;
        for (AerodynamicForces f : analysis(c, r, fc).values()) {
            if (Math.abs(f.getCN()) > 1e-8) { identity(f.getCP(), f, fc.getRefLength()); checked++; }
        }
        assertTrue(checked > 0);
    }

    @Test void hybridBlendsRawNormalMomentsBeforeDividingAndDampsOnlyOnce() throws Exception {
        // Guards: CNa-weighted corrected positions, missing Hybrid output correction, double damping.
        // Basic Finner separates the wrong blend by ~28 um (ARCAS is below 1 um).
        Rocket r = fixture("basic-finner");
        BarrowmanCalculator k = calculator("kbf"), s = calculator("supersonic"), h = calculator("hybrid");
        FlightConditions fc = conditions(r, 1, rad(45));
        AerodynamicForces a = analysis(k, r, fc).get(r), b = analysis(s, r, fc).get(r);
        double expected = fc.getRefLength() * (0.5 * a.getCm() + 0.5 * b.getCm())
                / (0.5 * a.getCN() + 0.5 * b.getCN());
        near(expected, cp(h, r, fc).x);
        near(expected, forces(h, r, fc).getCP().x);
        near(expected, forces(h, r, rates(fc)).getCP().x);
        near(expected, analysis(h, r, fc).get(r).getCP().x);
        Coordinate acp = a.getCP(), bcp = b.getCP();
        double wrong = (acp.x * acp.weight + bcp.x * bcp.weight) / (acp.weight + bcp.weight);
        assertTrue(Math.abs(expected - wrong) > 1e-6, "fixture must distinguish the wrong CNa blend");
        // Guard (mixForces blending reported positions): the Hybrid result's DERIVATIVE
        // CP stays the CNa-weighted blend of the endpoints' DERIVATIVE CPs.
        Coordinate ad = forces(k, r, fc).getDerivativeCP(), bd = forces(s, r, fc).getDerivativeCP();
        double derivBlend = (ad.x * ad.weight + bd.x * bd.weight) / (ad.weight + bd.weight);
        assertTrue(Math.abs(derivBlend - wrong) > 1e-6, "fixture must distinguish derivative from reported blend");
        near(derivBlend, forces(h, r, fc).getDerivativeCP().x);
        near(derivBlend, analysis(h, r, fc).get(r).getDerivativeCP().x);
        FlightConditions moving = rates(fc);
        near(0.5 * forces(k, r, moving).getCm() + 0.5 * forces(s, r, moving).getCm(), forces(h, r, moving).getCm());
        for (double mach : new double[] {0.5, 1.5}) {
            FlightConditions end = conditions(r, mach, rad(45));
            BarrowmanCalculator endpoint = mach < 1 ? k : s;
            same(cp(endpoint, r, end), cp(h, r, end));
            same(forces(endpoint, r, end).getCP(), forces(h, r, end).getCP());
            same(analysis(endpoint, r, end).get(r).getCP(), analysis(h, r, end).get(r).getCP());
        }
        FlightConditions low = conditions(r, 1, rad(10));
        Coordinate ka = cp(k, r, low), sb = cp(s, r, low);
        double cna = 0.5 * ka.weight + 0.5 * sb.weight;
        double x = (0.5 * ka.x * ka.weight + 0.5 * sb.x * sb.weight) / cna;
        assertEquals(x, cp(h, r, low).x, Math.abs(x) * 1e-15);
        assertEquals(cna, cp(h, r, low).weight, 0);
        assertFalse(forces(h, r, low).hasReportedCP());
    }

    private static final class PlaneCalculator extends AbstractAerodynamicCalculator {
        private final DoubleFunction<Coordinate> plane;
        PlaneCalculator(DoubleFunction<Coordinate> plane) { this.plane = plane; }
        @Override public Coordinate getCP(FlightConfiguration c, FlightConditions fc, WarningSet w) { return plane.apply(fc.getTheta()); }
        @Override public AerodynamicForces getAerodynamicForces(FlightConfiguration c, FlightConditions fc, WarningSet w) { throw new UnsupportedOperationException(); }
        @Override public Map<RocketComponent, AerodynamicForces> getForceAnalysis(FlightConfiguration c, FlightConditions fc, WarningSet w) { throw new UnsupportedOperationException(); }
        @Override public double getStallAngle() { return rad(17.5); }
        @Override public AerodynamicCalculator newInstance() { return new PlaneCalculator(plane); }
        @Override public void checkGeometry(FlightConfiguration c, RocketComponent r, WarningSet w) { }
        @Override public ModID getModID() { return ModID.ZERO; }
    }

    @Test void worstCpSkipsInvalidPlanesAndPreservesTheLowAngleSentinel() throws Exception {
        // Guards: missing finite filter, high-AOA Double.MAX_VALUE fallback, low-angle sentinel changed.
        Rocket r = fixture("arcas-short");
        FlightConditions high = conditions(r, 0.3, rad(45));
        PlaneCalculator invalid = new PlaneCalculator(theta -> new Coordinate(Double.NaN, 0, 0, 2));
        Coordinate absent = invalid.getWorstCP(r.getSelectedConfiguration(), high, new WarningSet());
        assertTrue(Double.isNaN(absent.x)); assertTrue(Double.isNaN(absent.weight));
        PlaneCalculator zero = new PlaneCalculator(theta -> Coordinate.ZERO);
        assertEquals(Double.MAX_VALUE, zero.getWorstCP(r.getSelectedConfiguration(), conditions(r, 0.3, rad(10)), new WarningSet()).x, 0);
        // -Infinity would win over every finite plane without the explicit finite filter.
        PlaneCalculator mixed = new PlaneCalculator(theta -> new Coordinate(theta < 0.1 ? Double.NEGATIVE_INFINITY
                : theta < 0.2 ? Double.NaN : 2 + Math.cos(theta), 0, 0, 3));
        assertEquals(1, mixed.getWorstCP(r.getSelectedConfiguration(), high, new WarningSet()).x, 0);
        BarrowmanCalculator real = calculator("kbf");
        double min = Double.POSITIVE_INFINITY;
        for (int i = 0; i < 360; i++) {
            high.setTheta(2 * Math.PI * i / 360);
            Coordinate current = cp(real, r, high);
            if (Double.isFinite(current.x) && current.weight > 1e-8) min = Math.min(min, current.x);
        }
        near(min, real.getWorstCP(r.getSelectedConfiguration(), high, new WarningSet()).x);
    }

    @Test void newInstanceRetainsEveryHighAngleModel() throws Exception {
        // Guard: calculator cloning loses the correction or the model flags.
        Rocket r = fixture("arcas-short");
        for (String model : new String[] {"kbf", "supersonic", "hybrid"}) {
            BarrowmanCalculator c = calculator(model);
            FlightConditions fc = conditions(r, 1, rad(45));
            same(cp(c, r, fc), cp(c.newInstance(), r, fc));
        }
    }

    @Test void acceptedFlightRowsRecordCorrectedCpAndStabilityWithLowAngleControls() {
        // Guard: revert correction only in recorded CP/stability; displays alone are insufficient.
        assertTimeoutPreemptively(Duration.ofSeconds(30), () -> {
            // Same 3-fin rounded, uncanted fixture as the bridge regression. 30 g
            // nose mass keeps the powered crosswind flight stable after rod clearance.
            // Clock 0.2 rad away from a single fin's zero-weight normalization cutoff;
            // otherwise low-angle CP can differ at ~1e-10 m between roll planes.
            int handle = OrkEngine.buildRocket("""
                {"name":"CP crosswind control","components":[
                  {"type":"nosecone","shape":"ogive","length":0.07,"aftRadius":0.012,"thickness":0.002,"overrideMass":0.03},
                  {"type":"bodytube","length":0.30,"outerRadius":0.012,"thickness":0.0003,"density":950,"children":[
                    {"type":"trapezoidfinset","finCount":3,"rotation":0.2,"rootChord":0.05,"tipChord":0.03,"sweep":0.02,"height":0.03,"thickness":0.003,"crossSection":"rounded"},
                    {"type":"innertube","id":"mount","length":0.07,"outerRadius":0.0095,"thickness":0.0005,"motorMount":true,"position":{"method":"bottom","offset":0}}
                  ]}
                ]}
                """);
            double[] times = {0, 0.1, 0.3, 0.5, 1, 1.5, 1.85, 2};
            double[] thrust = {0, 12, 6, 5.1, 4.9, 4.8, 4.5, 0};
            double[] masses = new double[times.length];
            for (int i = 0; i < times.length; i++) masses[i] = 0.024 - 0.0108 * times[i] / 2;
            OrkEngine.setMotorById(handle, "mount", "CP-test", 0.018, 0.07, times, thrust, masses, 0.035, 1000);
            Rocket r = OrkEngine.getRocketForTesting(handle);
            FlightConfiguration config = r.getSelectedConfiguration();
            config.update(); config.setAllStages();
            SimulationConditions c = new SimulationConditions();
            c.setSimulation(new Simulation(r, config.getId()));
            c.setLaunchRodLength(0.5); c.setLaunchRodAngle(0); c.setLaunchRodDirection(Math.PI / 2);
            c.setLaunchSite(new WorldCoordinate(28.61, -80.60, 0));
            c.setGeodeticComputation(GeodeticComputationStrategy.SPHERICAL);
            c.setAtmosphericModel(new ExtendedISAModel()); c.setGravityModel(new WGSGravityModel());
            PinkNoiseWindModel wind = new PinkNoiseWindModel();
            wind.setAverage(8); wind.setStandardDeviation(0); c.setWindModel(wind);
            c.setAerodynamicCalculator(calculator("kbf")); c.setMassCalculator(new MassCalculator());
            c.setTimeStep(0.01); c.setMaxSimulationTime(0.8); c.setRandomSeed(0x66b);
            BasicEventSimulationEngine engine = new BasicEventSimulationEngine();
            engine.simulate(c);
            FlightDataBranch b = engine.getFlightData().getBranch(0);
            for (FlightEvent e : b.getEvents()) assertNotEquals(FlightEvent.Type.SIM_ABORT, e.getType());
            int high = 0, low = 0;
            for (int i = 0; i < b.getLength(); i++) {
                double aoa = b.get(FlightDataType.TYPE_AOA).get(i);
                double recorded = b.get(FlightDataType.TYPE_CP_LOCATION).get(i);
                if (!Double.isFinite(aoa) || !Double.isFinite(recorded)) continue;
                double mach = b.get(FlightDataType.TYPE_MACH_NUMBER).get(i);
                FlightConditions fc = conditions(r, mach, aoa);
                BarrowmanCalculator fresh = calculator("kbf");
                double derivative = forces(fresh, r, fc).getDerivativeCP().x;
                if (aoa > rad(20.5)) {
                    near(cp(fresh, r, fc).x, recorded);
                    assertTrue(Math.abs(recorded - derivative) > 1e-5, "recorded CP differs from derivative (m)");
                    double cg = b.get(FlightDataType.TYPE_CG_LOCATION).get(i);
                    near((recorded - cg) / fc.getRefLength(), b.get(FlightDataType.TYPE_STABILITY).get(i));
                    assertTrue(recorded > cg, "stable high-AOA row (m)");
                    high++;
                } else if (aoa < rad(19.5)) {
                    assertEquals(derivative, recorded, 1e-12 + 1e-10 * Math.abs(derivative),
                            "low control t=" + b.get(FlightDataType.TYPE_TIME).get(i) + " aoa=" + aoa + " mach=" + mach);
                    low++;
                }
            }
            assertTrue(high >= 3, "need >=3 recorded high-AOA rows, got " + high);
            assertTrue(low > 0, "need recorded low-angle controls");
        });
    }
}
