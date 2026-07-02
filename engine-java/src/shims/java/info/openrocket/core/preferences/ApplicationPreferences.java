package info.openrocket.core.preferences;

import info.openrocket.core.database.Databases;
import info.openrocket.core.material.Material;
import info.openrocket.core.models.atmosphere.ExtendedISAModel;
import info.openrocket.core.models.wind.PinkNoiseWindModel;
import info.openrocket.core.rocketcomponent.FlightConfiguration;
import info.openrocket.core.rocketcomponent.RocketComponent;
import info.openrocket.core.simulation.RK4SimulationStepper;
import info.openrocket.core.util.GeodeticComputationStrategy;

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

    // ---- Generic accessors: no persisted store in the web engine, so the
    // ---- caller-supplied default IS the value (matches an empty prefs store).

    public double getDouble(String key, double defaultValue) {
        return defaultValue;
    }

    public boolean getBoolean(String key, boolean defaultValue) {
        return defaultValue;
    }

    public String getString(String key, String defaultValue) {
        return defaultValue;
    }

    // ---- Preference key constants (SimulationOptions references these) ----

    public static final String LAUNCH_ROD_LENGTH = "LaunchRodLength";
    public static final String LAUNCH_INTO_WIND = "LaunchIntoWind";
    public static final String LAUNCH_ROD_ANGLE = "LaunchRodAngle";
    public static final String LAUNCH_ROD_DIRECTION = "LaunchRodDirection";
    public static final String WIND_DIRECTION = "WindDirection";

    // ---- Launch / simulation defaults (values copied from upstream) ----

    private PinkNoiseWindModel averageWindModel;

    public double getLaunchRodLength() {
        return 1;
    }

    public double getLaunchRodAngle() {
        return 0;
    }

    public double getLaunchRodDirection() {
        return Math.PI / 2;
    }

    public double getLaunchAltitude() {
        return 0;
    }

    public double getLaunchLatitude() {
        return 28.61;
    }

    public double getLaunchLongitude() {
        return -80.60;
    }

    public boolean isISAAtmosphere() {
        return true;
    }

    public double getLaunchTemperature() {
        return ExtendedISAModel.STANDARD_TEMPERATURE;
    }

    public double getLaunchPressure() {
        return ExtendedISAModel.STANDARD_PRESSURE;
    }

    public GeodeticComputationStrategy getGeodeticComputation() {
        return GeodeticComputationStrategy.SPHERICAL;
    }

    public double getTimeStep() {
        return RK4SimulationStepper.RECOMMENDED_TIME_STEP;
    }

    public double getMaxSimulationTime() {
        return RK4SimulationStepper.RECOMMENDED_MAX_TIME;
    }

    public PinkNoiseWindModel getAverageWindModel() {
        if (averageWindModel == null) {
            averageWindModel = new PinkNoiseWindModel();
        }
        return averageWindModel;
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
