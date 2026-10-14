package api;

import info.openrocket.core.aerodynamics.FlightConditions;
import info.openrocket.core.simulation.FlightDataType;
import info.openrocket.core.simulation.SimulationStatus;
import info.openrocket.core.simulation.listeners.AbstractSimulationListener;
import info.openrocket.core.unit.UnitGroup;

/** N042: record geometry beside the sample it qualifies, without changing forces. */
final class ActiveLengthListener extends AbstractSimulationListener {
    static final FlightDataType LENGTH = FlightDataType.getType(
            "Active aerodynamic length", "activeLength", UnitGroup.UNITS_LENGTH);
    private double length = Double.NaN;
    private int initialSamples;

    @Override
    public boolean isSystemListener() { return true; }

    @Override
    public boolean preStep(SimulationStatus status) {
        // Events have already changed this branch's stage mask. A cloned
        // booster listener observes its own mask; copied rows keep their
        // original lengths through FlightDataBranch's ordinary copy.
        length = status.getConfiguration().getLengthAerodynamic();
        initialSamples = status.getFlightDataBranch().getLength();
        return true;
    }

    @Override
    public void postStep(SimulationStatus status) {
        record(status);
    }

    @Override
    public FlightConditions postFlightConditions(SimulationStatus status, FlightConditions conditions) {
        // Impact records a final sample outside the normal postStep loop.
        // Returning null keeps the kernel's flight conditions unchanged.
        record(status);
        return null;
    }

    private void record(SimulationStatus status) {
        // A landed/skipped step may add no row. Do not overwrite the last
        // copied row with this branch's now-different configuration.
        if (status.getFlightDataBranch().getLength() > initialSamples) {
            status.getFlightDataBranch().setValue(LENGTH, length);
        }
    }
}
