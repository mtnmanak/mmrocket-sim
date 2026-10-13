package info.openrocket.core.models.atmosphere;

import static org.junit.jupiter.api.Assertions.*;
import org.junit.jupiter.api.Test;

/** OR #2731: the site is geometric, the ISA layer table is geopotential. */
class GeopotentialISATest {
    private static double z(double h) {
        return 6356766.0 * h / (6356766.0 - h);
    }

    @Test void publishedLayersUseGeopotentialHeight() {
        // NASA-TM-X-74335 (US Standard Atmosphere 1976), lower-atmosphere
        // equations and layer table: https://ntrs.nasa.gov/citations/19770009539.
        // Pressure evaluated with OR's rounded gas constant 287.053;
        // 0.005 Pa allows rounding these independently derived values.
        double[][] layers = {{11000, 216.65, 22632.06}, {20000, 216.65, 5474.885},
                {32000, 228.65, 868.02}, {47000, 270.65, 110.91}};
        ExtendedISAModel corrected = new ExtendedISAModel(true);
        for (double[] row : layers) {
            AtmosphericConditions c = corrected.getExactConditions(z(row[0]));
            assertEquals(row[1], c.getTemperature(), 1e-9);
            assertEquals(row[2], c.getPressure(), 0.005);
            assertTrue(corrected.getConditions(row[0]).getPressure()
                    > new ExtendedISAModel().getConditions(row[0]).getPressure());
        }
    }

    @Test void classicExplicitGateIsBitIdenticalAndInstancesDoNotLeak() {
        ExtendedISAModel legacy = new ExtendedISAModel();
        ExtendedISAModel classic = new ExtendedISAModel(false);
        ExtendedISAModel corrected = new ExtendedISAModel(true);
        // Published tropospheric lapse in Classic's geometric coordinate:
        // an accidentally unconditional conversion must fail this assertion.
        assertEquals(255.65, classic.getConditions(5000).getTemperature(), 1e-9);
        for (double altitude : new double[] {-100, 0, 250, 1190, 11000, 20000, 32000, 47000, 80000, 100000}) {
            corrected.getConditions(altitude);
            AtmosphericConditions before = legacy.getConditions(altitude);
            AtmosphericConditions after = classic.getConditions(altitude);
            assertEquals(Double.doubleToLongBits(before.getTemperature()), Double.doubleToLongBits(after.getTemperature()));
            assertEquals(Double.doubleToLongBits(before.getPressure()), Double.doubleToLongBits(after.getPressure()));
        }
    }

    @Test void customSiteConvertsOnceAndLapsesToTheGeopotentialTropopause() {
        for (double altitude : new double[] {1400, 2682, 10000}) {
            ExtendedISAModel corrected = new ExtendedISAModel(altitude, 305.37, 85500, true);
            AtmosphericConditions site = corrected.getExactConditions(altitude);
            assertEquals(305.37, site.getTemperature(), 1e-10);
            assertEquals(85500, site.getPressure(), 1e-8);
            double hs = 6356766.0 * altitude / (6356766.0 + altitude);
            double lapse = (216.65 - 305.37) / (11000 - hs);
            double p11 = 85500 * Math.pow(216.65 / 305.37, -9.80665 / (lapse * AtmosphericConditions.R));
            AtmosphericConditions top = corrected.getExactConditions(z(11000));
            assertEquals(216.65, top.getTemperature(), 1e-9);
            assertEquals(p11, top.getPressure(), 1e-8);
            ExtendedISAModel legacy = new ExtendedISAModel(altitude, 305.37, 85500);
            ExtendedISAModel classic = new ExtendedISAModel(altitude, 305.37, 85500, false);
            assertEquals(legacy.getConditions(30000).getPressure(), classic.getConditions(30000).getPressure());
        }
    }

    @Test void standardCustomAnchorReconstructsTheStandardProfile() {
        ExtendedISAModel std = new ExtendedISAModel(true);
        AtmosphericConditions anchor = std.getExactConditions(2682);
        ExtendedISAModel custom = new ExtendedISAModel(2682, anchor.getTemperature(), anchor.getPressure(), true);
        for (double altitude : new double[] {0, 2682, 6000, z(11000), 20000, 32000, 80000}) {
            assertEquals(std.getExactConditions(altitude).getTemperature(), custom.getExactConditions(altitude).getTemperature(), 1e-9);
            assertEquals(std.getExactConditions(altitude).getPressure(), custom.getExactConditions(altitude).getPressure(), 1e-7);
        }
    }

    @Test void upperLayerClampsRemainFiniteInGeometricMetres() {
        ExtendedISAModel corrected = new ExtendedISAModel(true);
        AtmosphericConditions exact = corrected.getExactConditions(z(84852));
        assertEquals(186.95, exact.getTemperature(), 1e-9);
        assertTrue(Double.isFinite(exact.getPressure()) && exact.getPressure() > 0);
        assertTrue(corrected.getMaxAltitude() > 84852);
        assertEquals(exact.getPressure(), corrected.getConditions(100000).getPressure(), 1e-12);
        assertEquals(corrected.getConditions(100000).getPressure(), corrected.getConditions(200000).getPressure());
    }
}
