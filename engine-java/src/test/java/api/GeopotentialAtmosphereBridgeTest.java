package api;

import static org.junit.jupiter.api.Assertions.*;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import info.openrocket.core.aerodynamics.*;
import info.openrocket.core.logging.WarningSet;
import info.openrocket.core.models.atmosphere.ExtendedISAModel;

/** OR #2731: each rocket model reaches both atmospheric bridge consumers. */
class GeopotentialAtmosphereBridgeTest {
    private static int rocket(int model) {
        int handle = OrkEngine.buildRocket("""
            {"name":"ISA bridge","components":[
              {"type":"nosecone","shape":"ogive","length":0.07,"aftRadius":0.012,"thickness":0.002,"overrideMass":0.03},
              {"type":"bodytube","length":0.30,"outerRadius":0.012,"thickness":0.0003,"density":950,"children":[
                {"type":"trapezoidfinset","finCount":3,"rootChord":0.05,"tipChord":0.03,"sweep":0.02,"height":0.03,"thickness":0.003,"crossSection":"rounded"},
                {"type":"innertube","id":"mount","length":0.07,"outerRadius":0.0095,"thickness":0.0005,"motorMount":true,"position":{"method":"bottom","offset":0}}
              ]}
            ]}
            """);
        OrkEngine.setRogersModifiedBarrowman(handle, model == 1);
        OrkEngine.setSupersonicAero(handle, model == 2);
        OrkEngine.setHybridAero(handle, model == 3);
        OrkEngine.setMotorById(handle, "mount", "ISA-test", 0.018, 0.07,
                new double[] {0, 0.1, 0.3, 2}, new double[] {0, 12, 6, 0},
                new double[] {0.024, 0.023, 0.022, 0.013}, 0.035, 5);
        return handle;
    }

    @SuppressWarnings("unchecked")
    private static double first(Map<String, Object> object, String container, String key) {
        Map<String, Object> columns = (Map<String, Object>) object.get(container);
        return ((Number) ((List<?>) columns.get(key)).get(0)).doubleValue();
    }

    @Test void standardAndCustomFlightAirFollowEachIndependentModelFlag() {
        for (int model = 0; model < 4; model++) {
            int handle = rocket(model);
            for (boolean custom : new boolean[] {false, true}) {
                String options = "{\"launchAltitude\":2682,\"windAverage\":0,\"windStdDeviation\":0,"
                        + "\"maxTime\":0.2,\"series\":\"full\""
                        + (custom ? ",\"temperature\":305.37,\"pressure\":85500" : "") + "}";
                Map<String, Object> result = JsonLite.parseObject(OrkEngine.simulateJson(handle, options));
                ExtendedISAModel expected = custom
                        ? new ExtendedISAModel(2682, 305.37, 85500, model != 0)
                        : new ExtendedISAModel(model != 0);
                assertEquals(expected.getConditions(2682).getPressure(), first(result, "series", "P"), 1e-7, "model " + model);
                assertEquals(expected.getConditions(2682).getTemperature(), first(result, "series", "T"), 1e-9, "model " + model);
            }
        }
    }

    @Test void machAltitudeReynoldsMatchingUsesTheSameAtmosphere() {
        for (int model = 0; model < 4; model++) {
            int handle = rocket(model);
            Map<String, Object> sweep = JsonLite.parseObject(OrkEngine.getDragSweep(handle,
                    "{\"machMin\":0.3,\"machMax\":0.3,\"machStep\":0.1,\"machAlt\":[[0.3,32000]]}"));
            var config = OrkEngine.getRocketForTesting(handle).getSelectedConfiguration();
            config.update();
            FlightConditions conditions = new FlightConditions(config);
            conditions.setAtmosphericConditions(new ExtendedISAModel(model != 0).getConditions(32000));
            conditions.setMach(0.3);
            conditions.setAOA(0);
            BarrowmanCalculator calc = model == 3 ? BarrowmanCalculator.hybrid(0.8, 1.2) : new BarrowmanCalculator();
            calc.setRogersKbf(model == 1);
            calc.setSupersonicAero(model == 2);
            double expected = calc.getAerodynamicForces(config, conditions, new WarningSet()).getFrictionCD();
            assertEquals(expected, first(sweep, "powerOff", "friction"), 1e-12, "model " + model);
        }
    }
}
