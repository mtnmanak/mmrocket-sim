package info.openrocket.core.document;

import info.openrocket.core.rocketcomponent.FlightConfigurationId;
import info.openrocket.core.rocketcomponent.Rocket;

/**
 * SHIM: minimal parent-simulation holder. SimulationConditions delegates
 * getRocket()/getId() here, which the simulation engine reads. The real
 * document model arrives with .ork I/O work (P1.8).
 */
public class Simulation {

    private final Rocket rocket;
    private final FlightConfigurationId fcid;

    public Simulation(Rocket rocket, FlightConfigurationId fcid) {
        this.rocket = rocket;
        this.fcid = fcid;
    }

    public Rocket getRocket() {
        return rocket;
    }

    public FlightConfigurationId getId() {
        return fcid;
    }
}
