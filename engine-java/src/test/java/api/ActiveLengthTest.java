package api;

import static org.junit.jupiter.api.Assertions.*;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import info.openrocket.core.simulation.FlightDataBranch;
import info.openrocket.core.simulation.FlightDataType;
import info.openrocket.core.simulation.SimulationConditions;
import info.openrocket.core.simulation.SimulationStatus;
import info.openrocket.core.rocketcomponent.AxialStage;
import info.openrocket.core.rocketcomponent.BodyTube;
import info.openrocket.core.rocketcomponent.Rocket;

/** N042: sample-aligned geometry, including the copied booster history. */
class ActiveLengthTest {
    private static final String STAGES = """
        {"name":"Length test","components":[
          {"type":"stage","name":"Same","children":[
            {"type":"nosecone","length":0.07,"aftRadius":0.012,"thickness":0.002},
            {"type":"bodytube","length":0.3,"outerRadius":0.012,"thickness":0.0003,"density":950,"children":[
              {"type":"freeformfinset","finCount":3,"points":[[0,0],[0.02,0.025],[0.05,0.025],[0.05,0]],"thickness":0.003,"crossSection":"rounded"},
              {"type":"innertube","id":"smount","length":0.07,"outerRadius":0.0095,"thickness":0.0005,"motorMount":true,"position":{"method":"bottom","offset":0}},
              {"type":"parachute","diameter":0.35}
            ]}
          ]},
          {"type":"stage","name":"Same","separationEvent":"burnout","children":[
            {"type":"bodytube","length":0.12,"outerRadius":0.012,"thickness":0.0003,"density":950,"children":[
              {"type":"freeformfinset","finCount":3,"points":[[0,0],[0.025,0.035],[0.05,0.035],[0.05,0]],"thickness":0.003,"crossSection":"airfoil"},
              {"type":"innertube","id":"bmount","length":0.07,"outerRadius":0.0095,"thickness":0.0005,"motorMount":true,"position":{"method":"bottom","offset":0}},
              {"type":"parachute","diameter":0.25}
            ]}
          ]}
        ]}
        """;

    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Object value) { return (Map<String, Object>) value; }
    private static List<?> column(Map<String, Object> result, String key) { return (List<?>) map(result.get("series")).get(key); }
    private static double number(Object value) { return ((Number) value).doubleValue(); }

    @Test void aSkippedStepDoesNotRelabelTheLastCopiedSample() {
        Rocket rocket = new Rocket();
        AxialStage stage = new AxialStage(); rocket.addChild(stage);
        stage.addChild(new BodyTube(0.49, 0.012, 0.001));
        SimulationStatus status = new SimulationStatus(rocket.getSelectedConfiguration(), new SimulationConditions());
        FlightDataBranch branch = new FlightDataBranch("Copied", FlightDataType.TYPE_TIME);
        branch.addPoint(); branch.setValue(FlightDataType.TYPE_TIME, 0);
        branch.setValue(ActiveLengthListener.LENGTH, 0.123);
        status.setFlightDataBranch(branch);
        ActiveLengthListener listener = new ActiveLengthListener();
        listener.preStep(status); listener.postStep(status);
        assertEquals(0.123, branch.getLast(ActiveLengthListener.LENGTH), 1e-12, "no new row means no new geometry");
    }

    @Test void singleStageUsesAerodynamicBoundsIncludingCantedFreeformOverhangButNotInternalParts() {
        int handle = OrkEngine.buildRocket("""
            {"name":"Bounds","components":[
              {"type":"nosecone","length":0.07,"aftRadius":0.012,"thickness":0.002},
              {"type":"bodytube","length":0.3,"outerRadius":0.012,"thickness":0.0003,"density":950,"children":[
                {"type":"freeformfinset","finCount":3,"points":[[0,0],[0.1,0.04],[0.12,0.02],[0.05,0]],"cantAngle":0.02,"thickness":0.003,"crossSection":"airfoil"},
                {"type":"innertube","id":"smount","length":0.8,"outerRadius":0.0095,"thickness":0.0005,"motorMount":true,"position":{"method":"top","offset":0.3}}
              ]}
            ]}
            """);
        OrkEngine.setMotorById(handle, "smount", "Length-test", 0.018, 0.07,
                new double[] {0, 0.1, 0.3, 2}, new double[] {0, 12, 6, 0},
                new double[] {0.024, 0.023, 0.022, 0.013}, 0.035, 5);
        Map<String, Object> info = JsonLite.parseObject(OrkEngine.getStaticInfo(handle));
        double length = number(info.get("lengthAerodynamic"));
        assertTrue(length > 0.37, "the fin's swept tip extends beyond the body");
        assertTrue(number(info.get("length")) > length, "internal overhang is excluded from the percent denominator");
        Map<String, Object> result = JsonLite.parseObject(OrkEngine.simulateJson(handle, "{\"maxTime\":0.2,\"windAverage\":0,\"windStdDeviation\":0}"));
        assertEquals(length, number(column(result, "activeLength").get(0)), 1e-12, "geometry arithmetic rounding only");
        assertNull(result.get("branches"), "single-stage recording");
    }

    @Test void separatesTheDenominatorAndPreservesCopiedSamplesInSummaryAndFull() {
        int handle = OrkEngine.buildRocket(STAGES);
        for (String mount : new String[] {"smount", "bmount"}) {
            OrkEngine.setMotorById(handle, mount, "Length-test", 0.018, 0.07,
                    new double[] {0, 0.1, 0.3, 2}, new double[] {0, 12, 6, 0},
                    new double[] {0.024, 0.023, 0.022, 0.013}, 0.035, mount.equals("smount") ? 5 : 0);
        }
        OrkEngine.setMotorIgnitionById(handle, "smount", "burnout", 1);
        double staticLength = number(JsonLite.parseObject(OrkEngine.getStaticInfo(handle)).get("lengthAerodynamic"));
        for (String mode : new String[] {"summary", "full"}) {
            Map<String, Object> result = JsonLite.parseObject(OrkEngine.simulateJson(handle,
                    "{\"windAverage\":0,\"windStdDeviation\":0,\"series\":\"" + mode + "\"}"));
            List<?> branches = (List<?>) result.get("branches");
            assertNotNull(branches);
            assertEquals(2, branches.size());
            Map<String, Object> booster = map(branches.get(1));
            List<?> stackLength = column(result, "activeLength"), boosterLength = column(booster, "activeLength");
            assertNotNull(stackLength);
            assertEquals(column(result, "time").size(), stackLength.size());
            assertEquals(column(booster, "time").size(), boosterLength.size());
            assertTrue(stackLength.stream().allMatch(v -> v instanceof Number), "terminal aerodynamic sample keeps its length");
            assertTrue(boosterLength.stream().allMatch(v -> v instanceof Number), "terminal booster sample keeps its length");
            assertEquals(staticLength, number(stackLength.get(0)), 1e-12, "static and flight use the same aerodynamic bounds");
            assertEquals(stackLength.get(0), boosterLength.get(0), "copied history keeps the stack length");
            assertTrue(stackLength.stream().filter(v -> v instanceof Number).anyMatch(v -> Math.abs(number(v) - 0.37) < 1e-12), "sustainer length after separation");
            assertTrue(boosterLength.stream().filter(v -> v instanceof Number).anyMatch(v -> Math.abs(number(v) - 0.12) < 1e-12), "booster length after separation");
        }
    }
}
