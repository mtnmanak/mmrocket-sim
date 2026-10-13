package harness;

import java.lang.reflect.Method;
import org.junit.jupiter.api.Test;

/** The golden's behavioural assertions complement the JVM/TeaVM comparison. */
class TransitionDisjunctTest {
    @Test void eachTransitionGateIsExercisedAlone() throws Exception {
        Method scenarios = GoldenMain.class.getDeclaredMethod("transitionScenarios");
        scenarios.setAccessible(true);
        scenarios.invoke(null);
    }
}
