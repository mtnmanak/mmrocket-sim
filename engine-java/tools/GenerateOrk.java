import java.io.File;
import java.io.FileInputStream;

import com.google.inject.Guice;
import com.google.inject.Injector;

import info.openrocket.core.document.OpenRocketDocument;
import info.openrocket.core.document.OpenRocketDocumentFactory;
import info.openrocket.core.document.StorageOptions;
import info.openrocket.core.file.GeneralRocketLoader;
import info.openrocket.core.file.GeneralRocketSaver;
import info.openrocket.core.masscalc.MassCalculator;
import info.openrocket.core.masscalc.RigidBody;
import info.openrocket.core.material.Material;
import info.openrocket.core.motor.Manufacturer;
import info.openrocket.core.motor.Motor;
import info.openrocket.core.motor.MotorConfiguration;
import info.openrocket.core.motor.ThrustCurveMotor;
import info.openrocket.core.plugin.PluginModule;
import info.openrocket.core.rocketcomponent.AxialStage;
import info.openrocket.core.rocketcomponent.BodyTube;
import info.openrocket.core.rocketcomponent.FlightConfigurationId;
import info.openrocket.core.rocketcomponent.InnerTube;
import info.openrocket.core.rocketcomponent.NoseCone;
import info.openrocket.core.rocketcomponent.Parachute;
import info.openrocket.core.rocketcomponent.Rocket;
import info.openrocket.core.rocketcomponent.Transition;
import info.openrocket.core.rocketcomponent.TrapezoidFinSet;
import info.openrocket.core.startup.Application;
import info.openrocket.core.startup.CoreModule;
import info.openrocket.core.util.Coordinate;

/**
 * Headless tool run against the REAL OpenRocket 24.12 fat JAR:
 *   generate <out.ork>  — build the reference rocket and save a genuine .ork
 *   validate <in.ork>   — load a .ork with the real GeneralRocketLoader and
 *                         print the component tree + mass (desktop-compat check)
 */
public final class GenerateOrk {

    public static void main(String[] args) throws Exception {
        CoreModule coreModule = new CoreModule();
        // Override the lazy-loading motor/preset database providers with empty
        // instances (headless use; motors in files resolve to warnings).
        com.google.inject.Module overrides = new com.google.inject.AbstractModule() {
            @Override
            protected void configure() {
                bind(info.openrocket.core.database.motor.ThrustCurveMotorSetDatabase.class)
                        .toInstance(new info.openrocket.core.database.motor.ThrustCurveMotorSetDatabase());
                bind(info.openrocket.core.database.ComponentPresetDatabase.class)
                        .toInstance(new info.openrocket.core.database.ComponentPresetDatabase());
            }
        };
        Injector injector = Guice.createInjector(
                com.google.inject.util.Modules.override(coreModule).with(overrides),
                new PluginModule());
        Application.setInjector(injector);

        if (args.length == 2 && args[0].equals("generate")) {
            generate(new File(args[1]));
        } else if (args.length == 2 && args[0].equals("validate")) {
            validate(new File(args[1]));
        } else {
            System.err.println("usage: GenerateOrk generate <out.ork> | validate <in.ork>");
            System.exit(2);
        }
    }

    private static void generate(File out) throws Exception {
        OpenRocketDocument doc = OpenRocketDocumentFactory.createNewRocket();
        Rocket rocket = doc.getRocket();
        rocket.setName("Reference Rocket");
        AxialStage stage = (AxialStage) rocket.getChild(0);

        NoseCone nose = new NoseCone(Transition.Shape.OGIVE, 0.07, 0.012);
        nose.setThickness(0.002);
        stage.addChild(nose);

        BodyTube body = new BodyTube(0.30, 0.012, 0.0003);
        body.setMaterial(Material.newMaterial(Material.Type.BULK, "custom", 950, true));
        stage.addChild(body);

        TrapezoidFinSet fins = new TrapezoidFinSet(3, 0.05, 0.03, 0.02, 0.03);
        fins.setThickness(0.003);
        body.addChild(fins);

        InnerTube mount = new InnerTube();
        mount.setLength(0.07);
        mount.setOuterRadius(0.0095);
        mount.setThickness(0.0005);
        body.addChild(mount);
        mount.setMotorMount(true);

        Parachute chute = new Parachute();
        chute.setDiameter(0.30);
        body.addChild(chute);

        FlightConfigurationId fcid = new FlightConfigurationId();
        rocket.createFlightConfiguration(fcid);
        rocket.setSelectedConfiguration(fcid);

        ThrustCurveMotor motor = new ThrustCurveMotor.Builder()
                .setManufacturer(Manufacturer.getManufacturer("custom"))
                .setDesignation("C6")
                .setCommonName("C6")
                .setMotorType(Motor.Type.SINGLE)
                .setStandardDelays(new double[] { 5 })
                .setDiameter(0.018)
                .setLength(0.070)
                .setTimePoints(new double[] { 0, 0.1, 0.3, 0.5, 1.0, 1.5, 1.85, 2.0 })
                .setThrustPoints(new double[] { 0, 12.0, 6.0, 5.1, 4.9, 4.8, 4.5, 0 })
                .setCGPoints(new Coordinate[] {
                        new Coordinate(0.035, 0, 0, 0.0240), new Coordinate(0.035, 0, 0, 0.0231),
                        new Coordinate(0.035, 0, 0, 0.0215), new Coordinate(0.035, 0, 0, 0.0202),
                        new Coordinate(0.035, 0, 0, 0.0174), new Coordinate(0.035, 0, 0, 0.0147),
                        new Coordinate(0.035, 0, 0, 0.0133), new Coordinate(0.035, 0, 0, 0.0132) })
                .setDigest("gen-c6")
                .build();
        MotorConfiguration mc = new MotorConfiguration(mount, fcid);
        mc.setMotor(motor);
        mc.setEjectionDelay(5.0);
        mount.setMotorConfig(mc, fcid);

        rocket.enableEvents();

        StorageOptions opts = doc.getDefaultStorageOptions();
        opts.setSaveSimulationData(false);
        new GeneralRocketSaver().save(out, doc, opts);
        System.out.println("saved: " + out.getAbsolutePath() + " (" + out.length() + " bytes)");
    }

    private static void validate(File in) throws Exception {
        GeneralRocketLoader loader = new GeneralRocketLoader(in);
        OpenRocketDocument doc = loader.load();
        Rocket rocket = doc.getRocket();
        System.out.println("LOADED OK: " + rocket.getName());
        printTree(rocket, 0);
        RigidBody structure = MassCalculator.calculateStructure(rocket.getSelectedConfiguration());
        System.out.println("structureMass=" + structure.getMass() + " cg=" + structure.getCM().x
                + " length=" + rocket.getLength());
        System.out.println("warnings=" + loader.getWarnings().size() + " " + loader.getWarnings());
    }

    private static void printTree(info.openrocket.core.rocketcomponent.RocketComponent c, int depth) {
        System.out.println("  ".repeat(depth) + "- " + c.getClass().getSimpleName()
                + " len=" + c.getLength());
        for (info.openrocket.core.rocketcomponent.RocketComponent child : c.getChildren()) {
            printTree(child, depth + 1);
        }
    }
}
