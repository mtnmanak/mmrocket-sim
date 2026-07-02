package harness;

import info.openrocket.core.models.atmosphere.AtmosphericConditions;
import info.openrocket.core.models.atmosphere.ExtendedISAModel;
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
