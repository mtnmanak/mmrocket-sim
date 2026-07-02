package info.openrocket.core.preferences;

import info.openrocket.core.database.Databases;
import info.openrocket.core.material.Material;
import info.openrocket.core.rocketcomponent.FlightConfiguration;
import info.openrocket.core.rocketcomponent.RocketComponent;

/**
 * SHIM replacing OpenRocket's 1600-line desktop ApplicationPreferences (which
 * drags the OBJ-export subsystem and java.util.prefs). Exposes only the
 * surface the carved kernel calls, returning OpenRocket's stock defaults —
 * default values copied verbatim from upstream. Grown on demand as carve
 * slices expand; the compiler tells us what's used.
 */
public class ApplicationPreferences {

    /** OpenRocket default: Mach number used for override-CD computations. */
    public double getDefaultMach() {
        return 0.3;
    }

    /** Upstream default: true. */
    public boolean getMotorNameColumn() {
        return true;
    }

    /** Upstream default: FlightConfiguration.DEFAULT_CONFIG_NAME (no stored pref here). */
    public String getDefaultFlightConfigName() {
        return FlightConfiguration.DEFAULT_CONFIG_NAME;
    }

    /**
     * Upstream defaults (no stored per-component preference in the web engine):
     * LINE → elastic cord, SURFACE → ripstop nylon, BULK → cardboard.
     */
    public Material getDefaultComponentMaterial(
            Class<? extends RocketComponent> componentClass,
            Material.Type type) {
        switch (type) {
            case LINE:
                return Databases.findMaterial(Material.Type.LINE, "Elastic cord (round 2 mm, 1/16 in)");
            case SURFACE:
                return Databases.findMaterial(Material.Type.SURFACE, "Ripstop nylon");
            case BULK:
                return Databases.findMaterial(Material.Type.BULK, "Cardboard");
            default:
                throw new IllegalArgumentException("Unknown material type: " + type);
        }
    }
}
