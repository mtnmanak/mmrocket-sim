package info.openrocket.core.database;

import info.openrocket.core.material.Material;
import info.openrocket.core.material.MaterialGroup;

/**
 * SHIM replacing OpenRocket's material database (which loads from resources
 * via Guice at startup). Provides findMaterial for the built-in materials the
 * carved kernel references by name. Densities are copied verbatim from
 * upstream database/Databases.java's built-in material list.
 */
public final class Databases {

    private Databases() {}

    public static Material findMaterial(Material.Type type, String name) {
        return Material.newMaterial(type, name, densityFor(type, name), false);
    }

    public static Material findMaterial(Material.Type type, String baseName, double density) {
        return findMaterial(type, baseName, density, null);
    }

    public static Material findMaterial(Material.Type type, String baseName, double density, MaterialGroup group) {
        if (group != null) {
            return Material.newMaterial(type, baseName, density, group, false);
        }
        return Material.newMaterial(type, baseName, density, false);
    }

    private static double densityFor(Material.Type type, String name) {
        // Values copied from upstream Databases.java built-in materials.
        switch (name) {
            case "Cardboard": return 680;                              // BULK
            case "Delrin": return 1420;                                // BULK
            case "Balsa": return 170;                                  // BULK
            case "Plywood (birch)": return 630;                        // BULK
            case "Fiberglass": return 1850;                            // BULK
            case "Polystyrene": return 1050;                           // BULK
            case "Ripstop nylon": return 0.067;                        // SURFACE
            case "Elastic cord (round 2 mm, 1/16 in)": return 0.0018;  // LINE
            default:
                throw new IllegalArgumentException(
                        "Shim Databases: unknown material '" + name + "' (" + type + ")");
        }
    }
}
