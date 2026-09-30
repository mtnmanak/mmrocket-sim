package api;

import java.util.List;
import java.util.Map;

/** Standalone JVM checks; the orchestrator may also call run() from the golden harness. */
public final class AutoDelayProbeChecks {
    private AutoDelayProbeChecks() {}

    private static final double[] TIMES = {0, 0.1, 0.3, 0.5, 1, 1.5, 1.85, 2};
    private static final double[] THRUST = {0, 12, 6, 5.1, 4.9, 4.8, 4.5, 0};
    private static final double[] MASS = {0.024, 0.0231, 0.0215, 0.0202, 0.0174, 0.0147, 0.0133, 0.0132};

    private static String mount(String id) {
        return "{\"type\":\"innertube\",\"id\":\"" + id + "\",\"name\":\"Duplicate mount\","
                + "\"length\":0.07,\"outerRadius\":0.0095,\"thickness\":0.0005,\"motorMount\":true,"
                + "\"position\":{\"method\":\"bottom\",\"offset\":0}}";
    }

    private static String fins(String section) {
        return "{\"type\":\"freeformfinset\",\"finCount\":3,\"thickness\":0.003,"
                + "\"crossSection\":\"" + section + "\",\"points\":[[0,0],[0.02,0.035],[0.05,0.035],[0.07,0]]}";
    }

    private static String tube(String children, double length) {
        return "{\"type\":\"bodytube\",\"length\":" + length + ",\"outerRadius\":0.012,"
                + "\"thickness\":0.0003,\"density\":950,\"children\":[" + children + "]}";
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> object(Map<String, Object> map, String key) {
        Object value = map.get(key);
        require(value instanceof Map, "Missing object: " + key);
        return (Map<String, Object>) value;
    }

    public static void main(String[] args) { run(); }

    public static void run() {
        for (String section : new String[] {"rounded", "airfoil"}) {
            for (boolean staged : new boolean[] {false, true}) {
                String core = "{\"type\":\"stage\",\"name\":\"Duplicate branch\",\"children\":["
                        + "{\"type\":\"nosecone\",\"length\":0.07,\"aftRadius\":0.012,\"thickness\":0.002},"
                        + tube(fins(section) + "," + mount("a") + (staged ? "" : "," + mount("b"))
                        + ",{\"type\":\"parachute\",\"diameter\":0.3,\"deployEvent\":\"ejection\"}", 0.3) + "]}";
                String lower = staged ? ",{\"type\":\"stage\",\"name\":\"Duplicate branch\","
                        + "\"separationEvent\":\"burnout\",\"children\":["
                        + tube(fins(section) + "," + mount("b"), 0.12) + "]}" : "";
                int handle = OrkEngine.buildRocket("{\"components\":[" + core + lower + "]}");
                for (String id : new String[] {"a", "b"}) {
                    OrkEngine.setMotorById(handle, id, "C6", 0.018, 0.07, TIMES, THRUST, MASS, 0.035, 0);
                }
                OrkEngine.setMotorIgnitionById(handle, staged ? "a" : "b", staged ? "burnout" : "launch", staged ? 1 : 0.4);
                Map<String, Object> result = JsonLite.parseObject(OrkEngine.simulateJson(handle, "{\"delayProbe\":true}"));
                Map<String, Object> probe = object(result, "delayProbe");
                require(JsonLite.dbl(probe, "version", 0) == 1, "Probe version");
                List<Map<String, Object>> branches = JsonLite.objList(probe, "branches");
                require(branches.size() == (staged ? 2 : 1), "Carrier count");
                for (String id : new String[] {"a", "b"}) {
                    int carriers = 0;
                    for (Map<String, Object> branch : branches) {
                        if (((List<?>) branch.get("mountIds")).contains(id)) carriers++;
                    }
                    require(carriers == 1, "Unique carrier for " + id);
                }
                for (Map<String, Object> branch : branches) {
                    boolean ground = false;
                    for (Map<String, Object> event : JsonLite.objList(branch, "events")) {
                        String type = JsonLite.str(event, "type", "");
                        require(!"RECOVERY_DEVICE_DEPLOYMENT".equals(type), "Probe deployed recovery");
                        require(!"SIM_ABORT".equals(type), "Probe aborted");
                        if ("GROUND_HIT".equals(type)) ground = true;
                        if ("BURNOUT".equals(type) || "EJECTION_CHARGE".equals(type)) {
                            require(event.get("motorMountId") instanceof String, "Motor event identity");
                        }
                    }
                    require(ground, "Completed carrier flight");
                }
                if (staged) require(branches.get(1).get("parentId").equals(branches.get(0).get("id")), "Parent identity");
                // Raw simulation values allow the existing differential harness to
                // compare runtimes without hard-coded trajectory expectations.
                Map<String, Object> summary = object(result, "summary");
                System.out.println("autodelay." + section + "." + staged + "|"
                        + summary.get("maxAltitude") + "|" + summary.get("timeToApogee"));
            }
        }
    }
}
