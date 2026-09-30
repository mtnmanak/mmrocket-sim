package api;

import java.util.IdentityHashMap;
import java.util.Map;

import info.openrocket.core.rocketcomponent.FlightConfiguration;
import info.openrocket.core.simulation.FlightDataBranch;
import info.openrocket.core.simulation.FlightEvent;
import info.openrocket.core.simulation.SimulationStatus;
import info.openrocket.core.simulation.listeners.AbstractSimulationListener;

/** Recovery-free telemetry. Cloned listeners deliberately share the branch map. */
final class DelayProbeListener extends AbstractSimulationListener {
    final Map<FlightDataBranch, FlightConfiguration> configurations = new IdentityHashMap<>();

    private void observe(SimulationStatus status) {
        // Keep the live configuration: separation changes its active-stage mask
        // after handleFlightEvent, even when no subsequent step is possible.
        configurations.put(status.getFlightDataBranch(), status.getConfiguration());
    }

    @Override
    public boolean isSystemListener() { return true; }

    @Override
    public void startSimulation(SimulationStatus status) { observe(status); }

    @Override
    public boolean preStep(SimulationStatus status) { observe(status); return true; }

    @Override
    public void postStep(SimulationStatus status) { observe(status); }

    @Override
    public boolean handleFlightEvent(SimulationStatus status, FlightEvent event) {
        observe(status);
        return event.getType() != FlightEvent.Type.RECOVERY_DEVICE_DEPLOYMENT;
    }
}
