package info.openrocket.core.startup;

import info.openrocket.core.formatting.RocketDescriptor;
import info.openrocket.core.rocketcomponent.FlightConfigurationId;
import info.openrocket.core.rocketcomponent.Rocket;

/**
 * SHIM: minimal RocketDescriptor (upstream's RocketDescriptorImpl is a Guice
 * plugin host for name-template substitutors). Returns the stored name as-is;
 * affects display strings only, never physics.
 */
public class ShimRocketDescriptor implements RocketDescriptor {

    @Override
    public String format(Rocket rocket, FlightConfigurationId fcid) {
        return format(rocket.getFlightConfiguration(fcid).getNameRaw(), rocket, fcid);
    }

    @Override
    public String format(String name, Rocket rocket, FlightConfigurationId fcid) {
        return name;
    }
}
