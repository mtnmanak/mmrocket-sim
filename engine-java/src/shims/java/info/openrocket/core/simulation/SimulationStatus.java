package info.openrocket.core.simulation;

import java.util.Collection;

import info.openrocket.core.rocketcomponent.FlightConfiguration;

/**
 * TEMPORARY SHIM: compile-time stand-in for the real SimulationStatus so
 * MassCalculator's in-flight entry points compile. P1.4 carves the real
 * class and DELETES this file. Only the members MassCalculator references
 * are declared; nothing in P1.2 differential tests exercises these paths.
 */
public class SimulationStatus {

    public FlightConfiguration getConfiguration() {
        throw new UnsupportedOperationException("SimulationStatus shim — replaced by real class in P1.4");
    }

    public double getSimulationTime() {
        throw new UnsupportedOperationException("SimulationStatus shim — replaced by real class in P1.4");
    }

    public Collection<MotorClusterState> getActiveMotors() {
        throw new UnsupportedOperationException("SimulationStatus shim — replaced by real class in P1.4");
    }
}
