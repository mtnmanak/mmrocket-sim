package harness;

import info.openrocket.core.masscalc.MassCalculator;
import info.openrocket.core.masscalc.RigidBody;
import info.openrocket.core.material.Material;
import info.openrocket.core.models.atmosphere.AtmosphericConditions;
import info.openrocket.core.models.atmosphere.ExtendedISAModel;
import info.openrocket.core.rocketcomponent.AxialStage;
import info.openrocket.core.rocketcomponent.BodyTube;
import info.openrocket.core.rocketcomponent.FlightConfiguration;
import info.openrocket.core.rocketcomponent.InnerTube;
import info.openrocket.core.rocketcomponent.NoseCone;
import info.openrocket.core.rocketcomponent.Parachute;
import info.openrocket.core.rocketcomponent.Rocket;
import info.openrocket.core.rocketcomponent.Transition;
import info.openrocket.core.rocketcomponent.TrapezoidFinSet;
import info.openrocket.core.util.Coordinate;
import info.openrocket.core.util.Quaternion;

/**
 * Golden-scenario harness. Runs identical scenarios on the JVM and under
 * TeaVM-JS; every line of output must match BIT-FOR-BIT between the two
 * (Double.toString of the raw values — no rounding, no formatting locale).
 *
 * Scenarios grow with each carve slice (P1.2 mass/CG, P1.3 CP/CD, P1.4 flight).
 */
public final class GoldenMain {
    public static void main(String[] args) {
        atmosphereScenarios();
        quaternionScenarios();
        massScenarios();
        aeroScenarios();
        randomScenarios();
        flightScenarios();
        treeApiScenarios();
        conditionsScenarios();
        finVariantScenarios();
        dualDeployScenarios();
        clusterScenarios();
        stagingScenarios();
        podScenarios();
        nozzleBaseDragScenarios();
        dragSweepScenarios();
        rogersKbfScenarios();
        minDiameterScenarios();
        supersonicAeroScenarios();
        massOverrideScenarios();
        lineInstanceScenarios();
        bodyRatioOverrideScenarios();
    }

    /**
     * BODY-PROPORTIONAL CD OVERRIDE (`overrideCDBodyRatio`) — the first golden to
     * exercise ANY CD override at all. Before this, `grep -n overrideCD
     * engine-java/src/harness` found nothing: difftest would not have touched the new
     * branch in BarrowmanCalculator.calculateOverrideCD, so a TeaVM/JVM divergence in it
     * could have shipped unseen.
     *
     * APPENDED AT THE END OF THE ROSTER ON PURPOSE — difftest.mjs compares the two
     * runtimes' output BY LINE INDEX; see massOverrideScenarios.
     *
     * WHAT EACH COLUMN IS FOR. Per Mach the line carries, in order: the rocket carrying a
     * WITH-BASE ratio override, the same rocket with a NO-BASE one, the same rocket with a
     * plain SCALAR override, the stripped body's total CD, and the stripped body's base
     * CD. That is enough to check the arithmetic by hand rather than merely notice a
     * number moved:
     *   withBase - scalarRocket's non-override part  ==  ratio x bodyTotal
     *   noBase   - the same                          ==  ratio x (bodyTotal - bodyBase)
     * and the SCALAR column must be Mach-flat above the same baseline, which is the
     * scope-leak detector — every `.ork` <overridecd> and every plate-class protuberance
     * takes that branch and must stay bit-identical to upstream.
     *
     * The Mach grid straddles the transonic rise (0.3 / 0.7 / 1.1 / 1.5) because that is
     * where a frozen scalar and a body-tracking one disagree most: measured on the ARCAS
     * airframe the honest increment peaks at M1.10 and falls to 2/3 of the frozen value by
     * M2.00.
     */
    private static void bodyRatioOverrideScenarios() {
        final double ratio = 0.08;
        final String sweepOpts = "{\"machMin\":0.3,\"machMax\":1.5,\"machStep\":0.4}";
        // nose + 50 mm tube, three fins at the tube bottom (so stripping them does not
        // shorten getLengthAerodynamic and move Re), and a RailButton carrier — exactly
        // the shape the app's protuberance lowering emits.
        String fins = "{\"type\":\"trapezoidfinset\",\"finCount\":3,\"rootChord\":0.08,\"tipChord\":0.04,"
                + "\"sweep\":0.03,\"height\":0.05,\"thickness\":0.003,"
                + "\"position\":{\"method\":\"bottom\",\"offset\":0}}";
        String json = "{\"components\":[{\"type\":\"stage\",\"name\":\"S\",\"children\":["
                + "{\"type\":\"nosecone\",\"length\":0.15,\"aftRadius\":0.025,\"thickness\":0.002},"
                + "{\"type\":\"bodytube\",\"length\":0.50,\"outerRadius\":0.025,\"thickness\":0.001,\"density\":680,"
                + "  \"children\":[";
        String tail = "]}]}]}";
        String button = "{\"type\":\"railbutton\",\"name\":\"Bump\",\"outerDiameter\":0.014,"
                + "\"position\":{\"method\":\"middle\",\"offset\":0},\"overrideMass\":0";

        int withBase = api.OrkEngine.buildRocket(json + fins + ","
                + button + ",\"overrideCD\":0.03,\"overrideCDBodyRatio\":" + ratio
                + ",\"overrideCDBodyIncludesBase\":true}" + tail);
        int noBase = api.OrkEngine.buildRocket(json + fins + ","
                + button + ",\"overrideCD\":0.03,\"overrideCDBodyRatio\":" + ratio
                + ",\"overrideCDBodyIncludesBase\":false}" + tail);
        int scalar = api.OrkEngine.buildRocket(json + fins + ","
                + button + ",\"overrideCD\":0.03}" + tail);
        int bodyOnly = api.OrkEngine.buildRocket(json + tail);

        java.util.List<?> wbTotal = sweepTotals(withBase, sweepOpts, "total");
        java.util.List<?> nbTotal = sweepTotals(noBase, sweepOpts, "total");
        java.util.List<?> scTotal = sweepTotals(scalar, sweepOpts, "total");
        java.util.List<?> boTotal = sweepTotals(bodyOnly, sweepOpts, "total");
        java.util.List<?> boBase = sweepTotals(bodyOnly, sweepOpts, "base");
        java.util.List<?> machs = sweepMachs(withBase, sweepOpts);
        for (int i = 0; i < machs.size(); i++) {
            line("cdratio." + i, (Double) machs.get(i),
                    (Double) wbTotal.get(i), (Double) nbTotal.get(i), (Double) scTotal.get(i),
                    (Double) boTotal.get(i), (Double) boBase.get(i));
        }
    }

    /** One power-off series out of a drag sweep, for bodyRatioOverrideScenarios. */
    private static java.util.List<?> sweepTotals(int handle, String opts, String series) {
        java.util.Map<String, Object> parsed =
                api.JsonLite.parseObject(api.OrkEngine.getDragSweep(handle, opts));
        return (java.util.List<?>) asMap(parsed.get("powerOff")).get(series);
    }

    /** The Mach grid of a drag sweep, for bodyRatioOverrideScenarios. */
    private static java.util.List<?> sweepMachs(int handle, String opts) {
        return (java.util.List<?>) api.JsonLite
                .parseObject(api.OrkEngine.getDragSweep(handle, opts)).get("machs");
    }

    /**
     * Rail-button / launch-lug LINE INSTANCES (v0.089) — the bridge now reads
     * instanceCount/instanceSeparation, so a desktop design's pair of buttons
     * stops flying as one. Appended at the END of the roster (difftest compares
     * by line index; see massOverrideScenarios).
     *
     * What each line pins: mass must scale exactly with the count (the kernel
     * multiplies the component volume), and the drag-bearing figures come from
     * the same staticInfo the app shows. A missing-keys case guards the
     * bridge's key-presence gate: a node that says nothing about instances must
     * be bit-identical to the pre-v0.089 kernel.
     */
    private static void lineInstanceScenarios() {
        lineInstanceCase("none", "");
        lineInstanceCase("rb2", ",\"instanceCount\":2,\"instanceSeparation\":0.3");
        lineInstanceCase("rb3", ",\"instanceCount\":3,\"instanceSeparation\":0.15");
        // Clamp guards: 0 must behave as 1, and an absurd count must clamp
        // rather than allocate a Coordinate array per instance in the browser.
        lineInstanceCase("rb0", ",\"instanceCount\":0");
        lineInstanceCase("rbhuge", ",\"instanceCount\":100000000,\"instanceSeparation\":0.001");
        // Count WITHOUT separation: must fly at 0 spacing, matching what every
        // drawing and the .ork writer show — not the kernel constructor's own
        // outerDiameter*6 default.
        lineInstanceCase("rb2nosep", ",\"instanceCount\":2");
    }

    private static void lineInstanceCase(String name, String extra) {
        int r = api.OrkEngine.buildRocket(
                "{\"name\":\"Line\",\"components\":[{\"type\":\"stage\",\"children\":["
                + "{\"type\":\"nosecone\",\"length\":0.1,\"aftRadius\":0.025,\"thickness\":0.002},"
                + "{\"type\":\"bodytube\",\"length\":0.6,\"outerRadius\":0.025,\"thickness\":0.001,\"density\":950,\"children\":["
                + "  {\"type\":\"trapezoidfinset\",\"finCount\":3,\"rootChord\":0.08,\"tipChord\":0.04,\"sweep\":0.03,\"height\":0.05,\"thickness\":0.003},"
                + "  {\"type\":\"railbutton\",\"outerDiameter\":0.0097" + extra + ","
                + "   \"position\":{\"method\":\"middle\",\"offset\":0}}"
                + "]}]}]}");
        java.util.Map<String, Object> info = api.JsonLite.parseObject(api.OrkEngine.getStaticInfo(r));
        line("line.instances." + name,
                api.JsonLite.dbl(info, "massEmpty", Double.NaN),
                api.JsonLite.dbl(info, "cgEmpty", Double.NaN),
                api.JsonLite.dbl(info, "cp", Double.NaN),
                api.JsonLite.dbl(info, "longitudinalInertiaEmpty", Double.NaN));
    }

    /**
     * Mass overrides on an assembly — the FIRST golden to exercise one, added
     * 2026-08-31 expressly so the v0.088 inertia fix had an oracle to move
     * against. Before it, `grep -rn setOverride engine-java/src/harness` found
     * nothing: two years of goldens and not one covered the case where a user
     * says "this stage weighs 900 g, I put it on a scale".
     *
     * APPENDED AT THE END OF THE ROSTER ON PURPOSE. difftest.mjs compares the
     * two runtimes' output BY LINE INDEX, so a scenario inserted mid-roster
     * shifts every later line and reports hundreds of false differences. New
     * scenarios go last, always.
     *
     * It goes through `buildRocket` + `getStaticInfo` rather than assembling
     * kernel objects directly, because that is the route a real `.ork` takes:
     * the override keys are read in ComponentFactory.applyOverrides, and the
     * inertia is read back through the same bridge fields the app now shows.
     *
     * The cases are chosen for what each one can catch:
     *   k1/k2/k5  — three DIFFERENT override factors on the booster stage. The
     *               booster subtree's geometric mass is 0.012498 kg (recover it
     *               from these very lines: massEmpty(unflagged) − massEmpty(k2).
     *               The override cancels — unflagged is sustainer + booster +
     *               0.0454 and k2 is sustainer + 0.0454), so the three
     *               overrides are k = 1.816 / 3.633 /
     *               9.082. Three points, not one, because the defect made roll
     *               inertia CONSTANT in k — a fix that merely moved the number
     *               would pass a single-point test. With three, the invariant
     *               is checkable by hand: on the centreline roll has no
     *               transport term, so Ixx must be exactly A + k·B. Solving A
     *               and B from k1/k2 predicts k5 to 1.8e-16, and A + B
     *               reproduces the pre-fix value 1.2522450621924655E-5 to
     *               4.1e-16 — i.e. the change is exactly "scale by k" and the
     *               k = 1 case is untouched.
     *   unflagged — `overrideMass` with NO subcomponents flag. This is a
     *               DIFFERENT, self-consistent behaviour that upstream and two
     *               shipped JS tests depend on. It must not move. It is the
     *               scope-leak detector, and it did not move when this landed.
     *   offaxis   — the same override on a POD SET. On the centreline the
     *               spurious transport term lands only on pitch; off the axis
     *               it corrupts ROLL too, and a centreline-only golden would
     *               never see it.
     */
    private static void massOverrideScenarios() {
        // Absolute override masses, not computed factors: a golden records an
        // input that must not drift when a density is tweaked elsewhere.
        massOverrideCase("k1", 0.0227, true, false);
        massOverrideCase("k2", 0.0454, true, false);
        massOverrideCase("k5", 0.1135, true, false);
        massOverrideCase("unflagged", 0.0454, false, false);
        massOverrideCase("offaxis", 0.0454, true, true);
    }

    private static void massOverrideCase(String name, double overrideMass,
            boolean subcomponents, boolean offAxis) {
        String over = ",\"overrideMass\":" + overrideMass
                + (subcomponents ? ",\"overrideSubcomponentsMass\":true" : "");
        String finned = "{\"type\":\"bodytube\",\"length\":0.12,\"outerRadius\":0.012,\"thickness\":0.0003,\"density\":950,\"children\":["
                + "  {\"type\":\"trapezoidfinset\",\"finCount\":3,\"rootChord\":0.05,\"tipChord\":0.03,\"sweep\":0.025,\"height\":0.035,\"thickness\":0.003},"
                + "  {\"type\":\"innertube\",\"id\":\"bmount\",\"length\":0.07,\"outerRadius\":0.0095,\"thickness\":0.0005,\"motorMount\":true,"
                + "   \"position\":{\"method\":\"bottom\",\"offset\":0}}"
                + "]}";
        // The overridden assembly is either the booster STAGE (on the
        // centreline) or a POD SET hung off the side of it.
        String lower = offAxis
                ? "{\"type\":\"stage\",\"name\":\"Booster\",\"children\":["
                    + "{\"type\":\"bodytube\",\"length\":0.12,\"outerRadius\":0.012,\"thickness\":0.0003,\"density\":950,\"children\":["
                    + "  {\"type\":\"podset\",\"name\":\"Pod\",\"instanceCount\":2,\"radiusOffset\":0.01,"
                    + "   \"radiusMethod\":\"relative\",\"angleOffset\":0" + over + ",\"children\":["
                    + "     {\"type\":\"bodytube\",\"length\":0.08,\"outerRadius\":0.006,\"thickness\":0.0003,\"density\":950}"
                    + "  ]}"
                    + "]}]}"
                : "{\"type\":\"stage\",\"name\":\"Booster\"" + over + ",\"children\":[" + finned + "]}";
        String sustainer = "{\"type\":\"stage\",\"name\":\"Sustainer\",\"children\":["
                + "{\"type\":\"nosecone\",\"length\":0.07,\"aftRadius\":0.012,\"thickness\":0.002},"
                + "{\"type\":\"bodytube\",\"length\":0.30,\"outerRadius\":0.012,\"thickness\":0.0003,\"density\":950,\"children\":["
                + "  {\"type\":\"trapezoidfinset\",\"finCount\":3,\"rootChord\":0.05,\"tipChord\":0.03,\"sweep\":0.02,\"height\":0.025,\"thickness\":0.003}"
                + "]}]}";
        int r = api.OrkEngine.buildRocket(
                "{\"name\":\"OverrideProbe\",\"components\":[" + sustainer + "," + lower + "]}");
        java.util.Map<String, Object> info = api.JsonLite.parseObject(api.OrkEngine.getStaticInfo(r));
        line("mass.override." + name,
                api.JsonLite.dbl(info, "massEmpty", Double.NaN),
                api.JsonLite.dbl(info, "cgEmpty", Double.NaN),
                api.JsonLite.dbl(info, "rotationalInertiaEmpty", Double.NaN),
                api.JsonLite.dbl(info, "longitudinalInertiaEmpty", Double.NaN));
    }

    /**
     * Opt-in supersonic aerodynamics (RASAero feature #1, Phase 1). With the
     * flag ON: corrected supersonic fin normal force (2D Busemann level with
     * finite-span correction — roughly doubles the clamped classic value),
     * exact NACA-1307 body-fin interference, Mach-dependent nose CNa growth,
     * and no M4.9 grid clamp. Locks CP/CNa at transonic, supersonic and
     * hypersonic Mach for both flag states — flag OFF must stay identical to
     * the classic values (also covered by existing goldens).
     */
    private static void supersonicAeroScenarios() {
        Rocket rocket = buildReferenceRocket();
        info.openrocket.core.rocketcomponent.FlightConfiguration config =
                rocket.getSelectedConfiguration();
        info.openrocket.core.logging.WarningSet w =
                new info.openrocket.core.logging.WarningSet();
        double[] machs = { 1.2, 2.0, 4.0, 8.0 };
        for (double mach : machs) {
            info.openrocket.core.aerodynamics.BarrowmanCalculator off =
                    new info.openrocket.core.aerodynamics.BarrowmanCalculator();
            info.openrocket.core.aerodynamics.FlightConditions cOff =
                    new info.openrocket.core.aerodynamics.FlightConditions(config);
            cOff.setMach(mach);
            cOff.setAOA(Math.toRadians(2));
            Coordinate cpOff = off.getCP(config, cOff, w);

            info.openrocket.core.aerodynamics.BarrowmanCalculator on =
                    new info.openrocket.core.aerodynamics.BarrowmanCalculator();
            on.setSupersonicAero(true);
            info.openrocket.core.aerodynamics.FlightConditions cOn =
                    new info.openrocket.core.aerodynamics.FlightConditions(config);
            cOn.setMach(mach);
            cOn.setAOA(Math.toRadians(2));
            Coordinate cpOn = on.getCP(config, cOn, w);

            line("ssaero." + mach, cpOff.x, cpOff.weight, cpOn.x, cpOn.weight);

            // Phase 2: lock the flag-on drag decomposition too (fin wave drag,
            // boattail wave, nose extension, base cap, fin interference).
            info.openrocket.core.aerodynamics.AerodynamicForces fOn =
                    on.getAerodynamicForces(config, cOn, w);
            line("ssaerocd." + mach, fOn.getCD(), fOn.getFrictionCD(),
                    fOn.getPressureCD(), fOn.getBaseCD());
        }

        junctionSubsonicScenarios();
        airfoilSectionScenarios();
        phase5AeroScenarios();
        phase6AeroScenarios();
        transitionScenarios();
        modelBoundaryScenarios();
    }

    /**
     * Boundary-layer transition (2026-08-25). OpenRocket's partial-laminar
     * friction branch — {@code Rocket.perfectFinish}, dead code in the desktop
     * release — is now reachable through the bridge
     * ({@code OrkEngine.setPerfectFinish}) and gated to the non-parity models by
     * {@code BarrowmanCalculator.partialLaminar}. Nothing pinned it before,
     * because nothing could reach it.
     * <p>
     * Three things are RECORDED, at four Mach numbers spanning both of the
     * branch's regimes. Recorded, not locked: difftest.mjs compares a JVM run
     * against a TeaVM run of this same harness with no stored baseline, so a
     * change that moved both runs together — a leak into the parity model, say
     * — would leave every line below bit-identical and the differential green.
     * These lines guard the COMPILER, not the physics. The behavioural guard is
     * "perfectFinish (partial-laminar friction) is engine-API only, and inert
     * in the parity model" in packages/engine/src/orkEngine.test.ts, which runs
     * under npm test and needs no Java.
     * <ol>
     * <li><b>The gate.</b> With both model flags off the setting is inert —
     *     the classic pair of columns is equal at every Mach.</li>
     * <li><b>The laminar-run credit</b>, subsonic, where the branch REMOVES
     *     friction (the 1700/Re term).</li>
     * <li><b>The compressibility swap</b>, supersonic, where it ADDS a great
     *     deal — the branch carries a laminar-like correction
     *     (1+0.045 M²)^-0.25 in place of the turbulent (1+0.15 M²)^-0.58, worth
     *     ~1.7x on Cf by M4. That is the reason the setting is NOT on by
     *     default in any model; see
     *     validation/scorecard-transition-2026-08-25.md.</li>
     * </ol>
     * The reference rocket is only 0.37 m long, so at M0.30 it sits at
     * Re ≈ 2.5e6 — inside the band where the credit is largest relative to Cf,
     * which is what makes it a useful canary.
     */
    private static void transitionScenarios() {
        info.openrocket.core.logging.WarningSet w =
                new info.openrocket.core.logging.WarningSet();
        // Two surfaces, because they exercise DIFFERENT code. On the default
        // regular-paint finish the roughness-limited Cf wins in BOTH branches
        // once Re > 1e6, so the setting is a no-op subsonically — that is why
        // the LEM-IV tester flight moves by 0.002 m with it on, and it needs
        // pinning as much as the branch itself. Only a POLISHED surface lets
        // the laminar-run arithmetic (Blasius / the -1700/Re credit) actually
        // reach the answer.
        for (int polished = 0; polished < 2; polished++) {
            for (double mach : new double[] { 0.30, 0.85, 1.50, 4.00 }) {
                double[] v = new double[6];
                int k = 0;
                // classic / Kbf / Supersonic, each with the setting off then on.
                for (int model = 0; model < 3; model++) {
                    for (int finish = 0; finish < 2; finish++) {
                        Rocket rocket = buildReferenceRocket();
                        rocket.setPerfectFinish(finish == 1);
                        if (polished == 1) {
                            for (info.openrocket.core.rocketcomponent.RocketComponent c
                                    : rocket.getSelectedConfiguration().getAllComponents()) {
                                if (c instanceof info.openrocket.core.rocketcomponent.ExternalComponent) {
                                    ((info.openrocket.core.rocketcomponent.ExternalComponent) c).setFinish(
                                            info.openrocket.core.rocketcomponent.ExternalComponent.Finish.POLISHED);
                                }
                            }
                        }
                        info.openrocket.core.rocketcomponent.FlightConfiguration config =
                                rocket.getSelectedConfiguration();
                        info.openrocket.core.aerodynamics.BarrowmanCalculator calc =
                                new info.openrocket.core.aerodynamics.BarrowmanCalculator();
                        calc.setRogersKbf(model >= 1);
                        calc.setSupersonicAero(model == 2);
                        info.openrocket.core.aerodynamics.FlightConditions c =
                                new info.openrocket.core.aerodynamics.FlightConditions(config);
                        c.setMach(mach);
                        c.setAOA(0);
                        v[k++] = calc.getAerodynamicForces(config, c, w).getFrictionCD();
                    }
                }
                line("transition." + (polished == 1 ? "polished." : "paint.") + mach,
                        v[0], v[1], v[2], v[3], v[4], v[5]);
            }
        }
    }

    /**
     * The parity boundary itself, 2026-08-25. Two extensions used to be
     * INPUT-gated — present in every model, including
     * "OpenRocket — Extended Barrowman", which promises desktop's exact
     * physics — and the owner's standing ruling made moving them out of the
     * parity model a bug fix. Each boundary is sampled in all THREE models:
     * <ul>
     * <li><b>fin airfoilSection</b> (feature #4). Classic must now answer from
     *     the three-valued {@code CrossSection} alone, so the SQUARE column must
     *     be identical with and without a doublewedge section named; Kbf must
     *     still take the section model. Sampled at M1.80, where the difference
     *     was measured at ~1.5x on total CD.</li>
     * <li><b>nozzle-exit power-on base drag</b> (feature #2). Classic power-ON
     *     base CD must now equal its power-OFF value (desktop has no nozzle-exit
     *     aerodynamics at all); Kbf must still get the reduction.</li>
     * </ul>
     * Both gates are DISJUNCTIONS — {@code airfoilSection != null &&
     * (rogersKbf || supersonicAero)} in FinSetCalc.calculatePressureCD, and
     * {@code (rogersKbf || supersonicAero) && stage != null} in
     * BarrowmanCalculator.calculateBaseCD — so a classic/Kbf pair of columns
     * would leave the supersonicAero disjunct unexecuted under both backends.
     * Hence the third column, which sets supersonicAero ALONE: a column with
     * Kbf also on would not move if supersonicAero were dropped from the gate.
     * <p>
     * <b>What these lines can and cannot catch.</b> There is no stored golden
     * file. scripts/difftest.mjs runs this harness on the JVM and under TeaVM
     * and compares the two RUNS against each other, so what is pinned here is
     * JVM↔TeaVM fidelity of these code paths — nothing more. An edit that let
     * one of these extensions back into the parity model would move both runs
     * identically and the differential would still pass. The behavioural guard
     * lives in packages/engine's vitest suite (no Java needed, runs in
     * {@code npm test}): see "fin airfoil sections ..." and "nozzle-exit
     * power-on base drag is gated to the non-parity models" in
     * packages/engine/src/orkEngine.test.ts, which assert the gates themselves.
     */
    private static void modelBoundaryScenarios() {
        info.openrocket.core.logging.WarningSet w =
                new info.openrocket.core.logging.WarningSet();
        double mach = 1.80;
        double[] v = new double[6];
        int k = 0;
        // classic, then Kbf, then Supersonic (supersonicAero alone — see the
        // javadoc: with Kbf also on the column would survive the disjunct
        // being deleted, which is the edit these columns exist to expose).
        for (int model = 0; model < 3; model++) {
            for (int section = 0; section < 2; section++) { // plain SQUARE, then + doublewedge
                Rocket rocket = buildReferenceRocket();
                BodyTube body = (BodyTube) rocket.getChild(0).getChild(1);
                TrapezoidFinSet fins = (TrapezoidFinSet) body.getChild(0);
                fins.setCrossSection(info.openrocket.core.rocketcomponent.FinSet.CrossSection.SQUARE);
                if (section == 1) {
                    fins.setAirfoilSection("doublewedge");
                }
                info.openrocket.core.rocketcomponent.FlightConfiguration config =
                        rocket.getSelectedConfiguration();
                info.openrocket.core.aerodynamics.BarrowmanCalculator calc =
                        new info.openrocket.core.aerodynamics.BarrowmanCalculator();
                calc.setRogersKbf(model == 1);
                calc.setSupersonicAero(model == 2);
                info.openrocket.core.aerodynamics.FlightConditions c =
                        new info.openrocket.core.aerodynamics.FlightConditions(config);
                c.setMach(mach);
                c.setAOA(0);
                v[k++] = calc.getAerodynamicForces(config, c, w).getPressureCD();
            }
        }
        line("parity.airfoilsection", v[0], v[1], v[2], v[3], v[4], v[5]);

        double[] b = new double[6];
        k = 0;
        for (int model = 0; model < 3; model++) {   // classic, Kbf, Supersonic
            Rocket rocket = buildReferenceRocket();
            AxialStage stage = (AxialStage) rocket.getChild(0);
            stage.setNozzleExitDiameter(0.016);
            info.openrocket.core.rocketcomponent.FlightConfiguration config =
                    rocket.getSelectedConfiguration();
            info.openrocket.core.aerodynamics.BarrowmanCalculator calc =
                    new info.openrocket.core.aerodynamics.BarrowmanCalculator();
            calc.setRogersKbf(model == 1);
            calc.setSupersonicAero(model == 2);
            info.openrocket.core.aerodynamics.FlightConditions off =
                    new info.openrocket.core.aerodynamics.FlightConditions(config);
            off.setMach(0.90);
            off.setAOA(0);
            b[k++] = calc.getAerodynamicForces(config, off, w).getBaseCD();
            info.openrocket.core.aerodynamics.FlightConditions on =
                    new info.openrocket.core.aerodynamics.FlightConditions(config);
            on.setMach(0.90);
            on.setAOA(0);
            java.util.Set<Integer> thrusting = new java.util.HashSet<>();
            thrusting.add(stage.getStageNumber());
            on.setThrustingStages(thrusting);
            b[k++] = calc.getAerodynamicForces(config, on, w).getBaseCD();
        }
        line("parity.nozzlebase", b[0], b[1], b[2], b[3], b[4], b[5]);
    }

    /**
     * The fin-in-presence-of-body interference factor
     * (FinSetCalc.calculateFrictionCD, x1.8 flag-on) is Mach-FLAT, so the
     * regime it actually changes for most users is subsonic - and every
     * ssaerocd sample above sits at M1.2 or higher, so nothing in the
     * differential pinned it there. These lines do, in both flag states, at
     * three subsonic Mach numbers, for the reference rocket (three SQUARE
     * cross-section fins, so the Phase-2 AIRFOIL pressure change cannot
     * contaminate the comparison and the off->on friction ratio is this term
     * alone). Written 2026-08-25 with
     * validation/scorecard-junction-2026-08-25.md, which measures what
     * removing or rescaling the factor would cost; the point of the goldens is
     * that any future change to it shows up as a differential line, JVM and
     * TeaVM alike, instead of only in a scorecard.
     */
    private static void junctionSubsonicScenarios() {
        Rocket rocket = buildReferenceRocket();
        info.openrocket.core.rocketcomponent.FlightConfiguration config =
                rocket.getSelectedConfiguration();
        info.openrocket.core.logging.WarningSet w =
                new info.openrocket.core.logging.WarningSet();
        for (double mach : new double[] { 0.30, 0.60, 0.85 }) {
            info.openrocket.core.aerodynamics.BarrowmanCalculator off =
                    new info.openrocket.core.aerodynamics.BarrowmanCalculator();
            info.openrocket.core.aerodynamics.FlightConditions cOff =
                    new info.openrocket.core.aerodynamics.FlightConditions(config);
            cOff.setMach(mach);
            cOff.setAOA(0);
            info.openrocket.core.aerodynamics.AerodynamicForces fOff =
                    off.getAerodynamicForces(config, cOff, w);

            info.openrocket.core.aerodynamics.BarrowmanCalculator on =
                    new info.openrocket.core.aerodynamics.BarrowmanCalculator();
            on.setSupersonicAero(true);
            info.openrocket.core.aerodynamics.FlightConditions cOn =
                    new info.openrocket.core.aerodynamics.FlightConditions(config);
            cOn.setMach(mach);
            cOn.setAOA(0);
            info.openrocket.core.aerodynamics.AerodynamicForces fOn =
                    on.getAerodynamicForces(config, cOn, w);

            line("ssjunction." + mach, fOff.getCD(), fOff.getFrictionCD(),
                    fOn.getCD(), fOn.getFrictionCD());
        }
    }

    /**
     * RASAero feature #1 Phase 6. The fin thickness-wave transonic shape
     * (FinSetCalc.thicknessWave / betaEffThickness) replaces a linear M0.9-1.2
     * ramp with rise -&gt; peak at M1.05 -&gt; decay on the branch, and introduces
     * one new numeric operation in the kernel: the cube root
     * pow((gamma+1) M^2 tau, 1/3) of the transonic-similarity floor. Nothing
     * else exercises it — the Phase-5 fin goldens all sample M &gt;= 1.5, where
     * the floor never binds — so it gets its own canary, sampled at
     * M0.85 (below onset, must be 0), M0.95 (mid-smoothstep), M1.05 (the peak),
     * M1.10 (inside the floored band) and M1.30 (plain 1/beta branch, which
     * must be bit-identical to Phase 5).
     * <p>
     * Both flag-on call sites are covered: the feature-#4 section path
     * (hexbluntbase) and the plain AIRFOIL cross-section path. Fins are
     * UNSWEPT in both so sweepWaveFactor is identically 1 and the samples
     * isolate the thickness term.
     */
    private static void phase6AeroScenarios() {
        String tmpl = "{\"components\":[{\"type\":\"stage\",\"name\":\"S\",\"children\":["
                + "{\"type\":\"nosecone\",\"shape\":\"conical\",\"length\":0.09,\"aftRadius\":0.015,\"thickness\":0.0015},"
                + "{\"type\":\"bodytube\",\"length\":0.25,\"outerRadius\":0.015,\"thickness\":0.0015,\"children\":["
                + "  {\"type\":\"trapezoidfinset\",\"finCount\":4,\"rootChord\":0.06,\"tipChord\":0.03,\"sweep\":0,"
                + "\"height\":0.04,\"thickness\":0.0024,%FIN%"
                + "\"position\":{\"method\":\"bottom\",\"offset\":0}}"
                + "]}]}]}";
        // machMin 0.85 step 0.05 -> indices 0=0.85, 2=0.95, 4=1.05, 5=1.10, 9=1.30
        int[] idx = { 0, 2, 4, 5, 9 };
        String opts = "{\"machMin\":0.85,\"machMax\":1.30,\"machStep\":0.05}";

        int section = api.OrkEngine.buildRocket(tmpl.replace("%FIN%",
                "\"airfoilSection\":\"hexbluntbase\",\"airfoilLeDiamond\":0.015,"));
        api.OrkEngine.setSupersonicAero(section, true);
        emitSweep("ssphase6.finwave", section, opts, idx);

        int airfoil = api.OrkEngine.buildRocket(tmpl.replace("%FIN%",
                "\"crossSection\":\"airfoil\","));
        api.OrkEngine.setSupersonicAero(airfoil, true);
        emitSweep("ssphase6.airfoilwave", airfoil, opts, idx);
    }

    /**
     * RASAero feature #1 Phase 5. Two new flag-on code paths whose arithmetic is
     * NOT exercised anywhere else, so they get their own goldens:
     * <p>
     * (a) <b>boattail</b> — the Prandtl-Meyer boat-tail wave drag, sampled
     * across all four bands of the replacement curve (classic below M0.90, the
     * smoothstep rise, the M1.05-1.20 plateau, exact PM above). This is the one
     * that matters most for JVM/TeaVM fidelity: pmExpansionCp inverts nu(M) by a
     * FIXED-COUNT bisection, so any divergence in Math.sqrt/atan between the two
     * backends shows up here as a diverging bisection path, not as ULP noise.
     * <p>
     * (b) <b>finsweep</b> — a 60-degree-swept fin with a hexagonal blunt-base
     * section, sampled below, inside and above the LE-sonic band (Mn = M cos
     * Gamma crosses 0.9 at M1.8 and 1.05 at M2.1), locking sweepWaveFactor's
     * three branches. Its unswept twin locks the invariance claim: sweep 0 must
     * reproduce the pre-Phase-5 cos^2 = 1 numbers exactly.
     */
    private static void phase5AeroScenarios() {
        String boattail = "{\"components\":[{\"type\":\"stage\",\"name\":\"S\",\"children\":["
                + "{\"type\":\"nosecone\",\"shape\":\"conical\",\"length\":0.12,\"aftRadius\":0.03,\"thickness\":0.002},"
                + "{\"type\":\"bodytube\",\"length\":0.40,\"outerRadius\":0.03,\"thickness\":0.001},"
                + "{\"type\":\"transition\",\"shape\":\"conical\",\"length\":0.05,\"foreRadius\":0.03,\"aftRadius\":0.017,\"thickness\":0.001}"
                + "]}]}";
        int bt = api.OrkEngine.buildRocket(boattail);
        api.OrkEngine.setSupersonicAero(bt, true);
        // 0.95 / 1.05 / 1.15 / 1.5 / 2.0 — one sample per band edge.
        emitSweep("ssphase5.boattail", bt,
                "{\"machMin\":0.95,\"machMax\":2.0,\"machStep\":0.05}",
                new int[] { 0, 2, 4, 11, 21 });

        String finTmpl = "{\"components\":[{\"type\":\"stage\",\"name\":\"S\",\"children\":["
                + "{\"type\":\"nosecone\",\"shape\":\"conical\",\"length\":0.09,\"aftRadius\":0.015,\"thickness\":0.0015},"
                + "{\"type\":\"bodytube\",\"length\":0.25,\"outerRadius\":0.015,\"thickness\":0.0015,\"children\":["
                + "  {\"type\":\"trapezoidfinset\",\"finCount\":4,\"rootChord\":0.06,\"tipChord\":0.03,\"sweep\":%SWEEP%,"
                + "\"height\":0.04,\"thickness\":0.0024,\"airfoilSection\":\"hexbluntbase\",\"airfoilLeDiamond\":0.015,"
                + "\"position\":{\"method\":\"bottom\",\"offset\":0}}"
                + "]}]}]}";
        // tan(Gamma_LE) = sweep/height = 0.06928/0.04 = sqrt(3) -> Gamma = 60 deg.
        int swept = api.OrkEngine.buildRocket(finTmpl.replace("%SWEEP%", "0.06928203230275509"));
        api.OrkEngine.setSupersonicAero(swept, true);
        emitSweep("ssphase5.finsweep", swept,
                "{\"machMin\":1.5,\"machMax\":5.0,\"machStep\":0.5}",
                new int[] { 0, 1, 2, 4, 7 });
        int unswept = api.OrkEngine.buildRocket(finTmpl.replace("%SWEEP%", "0"));
        api.OrkEngine.setSupersonicAero(unswept, true);
        emitSweep("ssphase5.finstraight", unswept,
                "{\"machMin\":1.5,\"machMax\":5.0,\"machStep\":0.5}",
                new int[] { 0, 1, 2, 4, 7 });
    }

    /** Emits total/pressure/base CD at the requested sweep indices. */
    private static void emitSweep(String tag, int rocket, String opts, int[] indices) {
        java.util.Map<String, Object> parsed =
                api.JsonLite.parseObject(api.OrkEngine.getDragSweep(rocket, opts));
        java.util.List<?> machs = (java.util.List<?>) parsed.get("machs");
        java.util.Map<String, Object> off = asMap(parsed.get("powerOff"));
        java.util.List<?> total = (java.util.List<?>) off.get("total");
        java.util.List<?> press = (java.util.List<?>) off.get("pressure");
        java.util.List<?> base = (java.util.List<?>) off.get("base");
        for (int i : indices) {
            line(tag + "." + i,
                    ((Number) machs.get(i)).doubleValue(),
                    ((Number) total.get(i)).doubleValue(),
                    ((Number) press.get(i)).doubleValue(),
                    ((Number) base.get(i)).doubleValue());
        }
    }

    /**
     * RASAero feature #4: fin airfoil cross-sections. Input-gated (no flag):
     * a single-wedge section (thickness wave + fin base drag) and a hexagonal
     * section with an explicit LE radius, locked at subsonic/supersonic Mach.
     * The same tree WITHOUT airfoilSection is covered by existing goldens
     * (absent input = bit-identical classic).
     */
    private static void airfoilSectionScenarios() {
        String base = "{\"components\":[{\"type\":\"stage\",\"name\":\"S\",\"children\":["
                + "{\"type\":\"nosecone\",\"shape\":\"conical\",\"length\":0.085,\"aftRadius\":0.015,\"thickness\":0.0015},"
                + "{\"type\":\"bodytube\",\"length\":0.215,\"outerRadius\":0.015,\"thickness\":0.0015,\"children\":["
                + "  {\"type\":\"trapezoidfinset\",\"finCount\":4,\"rootChord\":0.03,\"tipChord\":0.03,\"sweep\":0,\"height\":0.03,\"thickness\":0.0024,%FIN%"
                + "\"position\":{\"method\":\"bottom\",\"offset\":0}}"
                + "]}]}]}";
        String[][] variants = {
                { "wedge", "\"airfoilSection\":\"singlewedge\"," },
                { "hexle", "\"airfoilSection\":\"hexagonal\",\"airfoilLeDiamond\":0.008,\"airfoilTeDiamond\":0.008,\"finLeRadius\":0.0004," },
        };
        for (String[] v : variants) {
            int r = api.OrkEngine.buildRocket(base.replace("%FIN%", v[1]));
            String sweep = api.OrkEngine.getDragSweep(r, "{\"machMin\":0.5,\"machMax\":3.5,\"machStep\":1.0}");
            java.util.Map<String, Object> parsed = api.JsonLite.parseObject(sweep);
            java.util.Map<String, Object> off = asMap(parsed.get("powerOff"));
            java.util.List<?> total = (java.util.List<?>) off.get("total");
            java.util.List<?> press = (java.util.List<?>) off.get("pressure");
            line("finsection." + v[0],
                    ((Number) total.get(0)).doubleValue(), ((Number) press.get(0)).doubleValue(),
                    ((Number) total.get(2)).doubleValue(), ((Number) press.get(2)).doubleValue());
        }
    }

    /**
     * Minimum-diameter rocket: the BODY TUBE itself is the motor mount (no
     * inner tube) — kernel BodyTube implements MotorMount, and setMotorById
     * must accept it. 24 mm airframe flying a 18 mm C6 loaded directly in the
     * tube, with a nozzle exit near the body diameter (the power-on base-drag
     * case min-diameter rockets exist for). Locks static info + flight summary.
     */
    private static void minDiameterScenarios() {
        String json = "{\"name\":\"MinDia\",\"components\":[{\"type\":\"stage\",\"name\":\"S\",\"nozzleExitDiameter\":0.014,\"children\":["
                + "{\"type\":\"nosecone\",\"length\":0.10,\"aftRadius\":0.012,\"thickness\":0.002},"
                + "{\"type\":\"bodytube\",\"id\":\"body\",\"length\":0.45,\"outerRadius\":0.012,\"thickness\":0.0005,\"density\":950,\"motorMount\":true,\"motorOverhang\":0.006,\"children\":["
                + "  {\"type\":\"trapezoidfinset\",\"finCount\":3,\"rootChord\":0.05,\"tipChord\":0.03,\"sweep\":0.02,\"height\":0.025,\"thickness\":0.003},"
                + "  {\"type\":\"parachute\",\"diameter\":0.30}"
                + "]}]}]}";
        int r = api.OrkEngine.buildRocket(json);
        api.OrkEngine.setMotorById(r, "body", "C6", 0.018, 0.070,
                new double[] { 0, 0.1, 0.3, 0.5, 1.0, 1.5, 1.85, 2.0 },
                new double[] { 0, 12.0, 6.0, 5.1, 4.9, 4.8, 4.5, 0 },
                new double[] { 0.0240, 0.0231, 0.0215, 0.0202, 0.0174, 0.0147, 0.0133, 0.0132 },
                0.035, 5.0);
        lineStaticInfo("mindia.info", api.OrkEngine.getStaticInfo(r));

        String result = api.OrkEngine.simulateJson(r, "{\"rodLength\":1.0}");
        java.util.Map<String, Object> parsed = api.JsonLite.parseObject(result);
        java.util.Map<String, Object> summary = asMap(parsed.get("summary"));
        line("flight.mindia",
                api.JsonLite.dbl(summary, "maxAltitude", Double.NaN),
                api.JsonLite.dbl(summary, "maxVelocity", Double.NaN),
                api.JsonLite.dbl(summary, "timeToApogee", Double.NaN));
    }

    /**
     * Opt-in Rogers Modified Barrowman body-fin interference (feature #3). With
     * the flag ON the fin set adds the Kbf body carryover (τ·cna at the fin root
     * quarter-chord), so total CNα rises and CP moves slightly AFT (more
     * conservative margin) vs classic Barrowman. Flag OFF must reproduce the
     * plain-Barrowman CP exactly (covered by the existing aero.cp goldens; here
     * we assert on≠off and the direction). Both JVM and JS run the patched calc.
     */
    private static void rogersKbfScenarios() {
        Rocket rocket = buildReferenceRocket();
        info.openrocket.core.rocketcomponent.FlightConfiguration config =
                rocket.getSelectedConfiguration();
        info.openrocket.core.logging.WarningSet w =
                new info.openrocket.core.logging.WarningSet();
        double[] machs = { 0.3, 0.8 };
        for (double mach : machs) {
            info.openrocket.core.aerodynamics.BarrowmanCalculator off =
                    new info.openrocket.core.aerodynamics.BarrowmanCalculator();
            info.openrocket.core.aerodynamics.FlightConditions cOff =
                    new info.openrocket.core.aerodynamics.FlightConditions(config);
            cOff.setMach(mach);
            cOff.setAOA(Math.toRadians(2));
            Coordinate cpOff = off.getCP(config, cOff, w);

            info.openrocket.core.aerodynamics.BarrowmanCalculator on =
                    new info.openrocket.core.aerodynamics.BarrowmanCalculator();
            on.setRogersKbf(true);
            info.openrocket.core.aerodynamics.FlightConditions cOn =
                    new info.openrocket.core.aerodynamics.FlightConditions(config);
            cOn.setMach(mach);
            cOn.setAOA(Math.toRadians(2));
            Coordinate cpOn = on.getCP(config, cOn, w);

            line("rogerskbf." + mach, cpOff.x, cpOff.weight, cpOn.x, cpOn.weight);
        }
    }

    /**
     * Drag polar sweep bridge method (feature #5). Exercises getDragSweep over a
     * small Mach grid on a rocket with a stage nozzle set — power-off vs power-on
     * total/base CD must match JVM↔JS, and power-on base CD must be lower.
     */
    private static void dragSweepScenarios() {
        String json = "{\"components\":[{\"type\":\"stage\",\"name\":\"S\",\"nozzleExitDiameter\":0.016,\"children\":["
                + "{\"type\":\"nosecone\",\"length\":0.07,\"aftRadius\":0.012,\"thickness\":0.002},"
                + "{\"type\":\"bodytube\",\"length\":0.30,\"outerRadius\":0.012,\"thickness\":0.0005,\"density\":950,\"children\":["
                + "  {\"type\":\"trapezoidfinset\",\"finCount\":3,\"rootChord\":0.05,\"tipChord\":0.03,\"sweep\":0.02,\"height\":0.03,\"thickness\":0.003}"
                + "]}]}]}";
        int r = api.OrkEngine.buildRocket(json);
        String sweep = api.OrkEngine.getDragSweep(r, "{\"machMin\":0.3,\"machMax\":1.5,\"machStep\":0.6}");
        java.util.Map<String, Object> parsed = api.JsonLite.parseObject(sweep);
        java.util.List<?> machs = (java.util.List<?>) parsed.get("machs");
        java.util.Map<String, Object> off = asMap(parsed.get("powerOff"));
        java.util.Map<String, Object> on = asMap(parsed.get("powerOn"));
        java.util.List<?> offTotal = (java.util.List<?>) off.get("total");
        java.util.List<?> onTotal = (java.util.List<?>) on.get("total");
        java.util.List<?> offBase = (java.util.List<?>) off.get("base");
        java.util.List<?> onBase = (java.util.List<?>) on.get("base");
        for (int i = 0; i < machs.size(); i++) {
            line("dragsweep." + i,
                    (Double) machs.get(i),
                    (Double) offTotal.get(i), (Double) onTotal.get(i),
                    (Double) offBase.get(i), (Double) onBase.get(i));
        }
        java.util.List<?> comps = (java.util.List<?>) parsed.get("components");
        System.out.println("dragsweep.compcount|" + comps.size());
    }

    /**
     * RASAero power-on base-drag reduction (feature #2). The reference rocket's
     * body tube has an exposed aft base; setting a stage nozzle exit diameter
     * must LOWER the base CD (and total CD) while that stage's motor is thrusting
     * (power-on), and leave it unchanged during coast (power-off). Power-off must
     * exactly equal the no-nozzle base CD. Both JVM and JS run the patched
     * calculator, so the values must match bit-for-bit.
     */
    private static void nozzleBaseDragScenarios() {
        Rocket rocket = buildReferenceRocket();
        AxialStage stage = (AxialStage) rocket.getChild(0);
        // 16 mm nozzle vs the 24 mm body base diameter — a large-nozzle case.
        stage.setNozzleExitDiameter(0.016);
        FlightConfiguration config = rocket.getSelectedConfiguration();
        info.openrocket.core.aerodynamics.BarrowmanCalculator calc =
                new info.openrocket.core.aerodynamics.BarrowmanCalculator();
        info.openrocket.core.logging.WarningSet w =
                new info.openrocket.core.logging.WarningSet();

        double[] machs = { 0.3, 0.9, 1.5 };
        for (double mach : machs) {
            // Power-off (coast): no thrusting stages.
            info.openrocket.core.aerodynamics.FlightConditions off =
                    new info.openrocket.core.aerodynamics.FlightConditions(config);
            off.setMach(mach);
            off.setAOA(0);
            info.openrocket.core.aerodynamics.AerodynamicForces fOff =
                    calc.getAerodynamicForces(config, off, w);

            // Power-on (boost): stage 0's motor thrusting.
            info.openrocket.core.aerodynamics.FlightConditions on =
                    new info.openrocket.core.aerodynamics.FlightConditions(config);
            on.setMach(mach);
            on.setAOA(0);
            java.util.Set<Integer> thrusting = new java.util.HashSet<>();
            thrusting.add(0);
            on.setThrustingStages(thrusting);
            info.openrocket.core.aerodynamics.AerodynamicForces fOn =
                    calc.getAerodynamicForces(config, on, w);

            line("nozzle.basecd." + mach,
                    fOff.getBaseCD(), fOn.getBaseCD(), fOff.getCD(), fOn.getCD());
        }
    }

    /**
     * Off-axis assemblies (PodSet / ParallelStage) through the tree API — the
     * newly-reachable ComponentAssemblyCalc / off-axis MassCalculation paths.
     * A symmetric 2-pod ring keeps CG on-axis but gains transverse/roll inertia
     * (parallel-axis term); a 1-instance pod shifts CG laterally (CM.y != 0);
     * a separating ParallelStage must spawn an extra flight branch.
     */
    private static void podScenarios() {
        // --- (A) Symmetric 2-pod set: on-axis CG, off-axis inertia ---
        String podJson = "{\"name\":\"Pod\",\"components\":[{\"type\":\"stage\",\"name\":\"Core\",\"children\":["
                + "{\"type\":\"nosecone\",\"length\":0.07,\"aftRadius\":0.012,\"thickness\":0.002},"
                + "{\"type\":\"bodytube\",\"length\":0.30,\"outerRadius\":0.012,\"thickness\":0.0003,\"density\":950,\"children\":["
                + "  {\"type\":\"podset\",\"id\":\"pod\",\"instanceCount\":2,\"radiusMethod\":\"relative\",\"radiusOffset\":0.005,"
                + "   \"angleOffset\":0,\"position\":{\"method\":\"bottom\",\"offset\":0},\"children\":["
                + "    {\"type\":\"bodytube\",\"length\":0.10,\"outerRadius\":0.008,\"thickness\":0.0003,\"density\":950,\"children\":["
                + "      {\"type\":\"trapezoidfinset\",\"finCount\":3,\"rootChord\":0.03,\"tipChord\":0.02,\"sweep\":0.01,\"height\":0.02,\"thickness\":0.002}"
                + "    ]}"
                + "  ]}"
                + "]}]}]}";
        int r = api.OrkEngine.buildRocket(podJson);

        info.openrocket.core.rocketcomponent.Rocket rocket =
                (info.openrocket.core.rocketcomponent.Rocket) getRocketFromInfo(r);
        info.openrocket.core.rocketcomponent.PodSet pod = null;
        for (info.openrocket.core.rocketcomponent.RocketComponent comp : rocket) {
            if (comp instanceof info.openrocket.core.rocketcomponent.PodSet) {
                pod = (info.openrocket.core.rocketcomponent.PodSet) comp;
            }
        }
        Coordinate[] offs = pod.getInstanceOffsets();
        double[] geom = new double[2 + offs.length * 2];
        geom[0] = pod.getInstanceCount();
        geom[1] = pod.getAngleOffset();
        for (int i = 0; i < offs.length; i++) {
            geom[2 + i * 2] = offs[i].y;
            geom[3 + i * 2] = offs[i].z;
        }
        line("pod.geometry", geom);
        lineStaticInfo("pod.info", api.OrkEngine.getStaticInfo(r));
        lineComponentInfo("pod.comp", api.OrkEngine.getComponentInfo(r, "pod"));

        RigidBody podStruct = MassCalculator.calculateStructure(rocket.getSelectedConfiguration());
        line("mass.pod.structure", podStruct.getMass(),
                podStruct.getCM().x, podStruct.getCM().y, podStruct.getCM().z,
                podStruct.getIxx(), podStruct.getIyy(), podStruct.getIzz(),
                podStruct.getLongitudinalInertia(), podStruct.getRotationalInertia());

        // --- (B) Asymmetric 1-instance pod: lateral CG shift (CM.y != 0) ---
        int r1 = api.OrkEngine.buildRocket(podJson.replace("\"instanceCount\":2", "\"instanceCount\":1"));
        RigidBody s1 = MassCalculator.calculateStructure(
                ((info.openrocket.core.rocketcomponent.Rocket) getRocketFromInfo(r1)).getSelectedConfiguration());
        line("mass.pod1.offaxis", s1.getMass(), s1.getCM().x, s1.getCM().y, s1.getCM().z,
                s1.getIxx(), s1.getIyy(), s1.getIzz());

        // --- (C) Separating ParallelStage booster -> extra flight branch ---
        String boosterJson = "{\"name\":\"Booster\",\"components\":[{\"type\":\"stage\",\"name\":\"Core\",\"children\":["
                + "{\"type\":\"nosecone\",\"length\":0.07,\"aftRadius\":0.012,\"thickness\":0.002},"
                + "{\"type\":\"bodytube\",\"length\":0.30,\"outerRadius\":0.012,\"thickness\":0.0003,\"density\":950,\"children\":["
                + "  {\"type\":\"trapezoidfinset\",\"finCount\":3,\"rootChord\":0.05,\"tipChord\":0.03,\"sweep\":0.02,\"height\":0.03,\"thickness\":0.003},"
                + "  {\"type\":\"innertube\",\"id\":\"cmount\",\"length\":0.07,\"outerRadius\":0.0095,\"thickness\":0.0005,\"motorMount\":true,\"position\":{\"method\":\"bottom\",\"offset\":0}},"
                + "  {\"type\":\"parachute\",\"diameter\":0.30},"
                + "  {\"type\":\"parallelstage\",\"id\":\"boost\",\"instanceCount\":2,\"radiusMethod\":\"relative\",\"radiusOffset\":0,"
                + "   \"angleOffset\":0,\"angleMethod\":\"relative\",\"separationEvent\":\"burnout\",\"separationDelay\":0,\"position\":{\"method\":\"bottom\",\"offset\":0},\"children\":["
                + "    {\"type\":\"bodytube\",\"length\":0.12,\"outerRadius\":0.010,\"thickness\":0.0003,\"density\":950,\"children\":["
                + "      {\"type\":\"trapezoidfinset\",\"finCount\":3,\"rootChord\":0.04,\"tipChord\":0.02,\"sweep\":0.02,\"height\":0.03,\"thickness\":0.003},"
                + "      {\"type\":\"innertube\",\"id\":\"bmount\",\"length\":0.07,\"outerRadius\":0.0095,\"thickness\":0.0005,\"motorMount\":true,\"position\":{\"method\":\"bottom\",\"offset\":0}}"
                + "    ]}"
                + "  ]}"
                + "]}]}]}";
        int rb = api.OrkEngine.buildRocket(boosterJson);
        double[] times = { 0, 0.1, 0.3, 0.5, 1.0, 1.5, 1.85, 2.0 };
        double[] thrusts = { 0, 12.0, 6.0, 5.1, 4.9, 4.8, 4.5, 0 };
        double[] masses = { 0.0240, 0.0231, 0.0215, 0.0202, 0.0174, 0.0147, 0.0133, 0.0132 };
        api.OrkEngine.setMotorById(rb, "cmount", "C6", 0.018, 0.070, times, thrusts, masses, 0.035, 5.0);
        api.OrkEngine.setMotorById(rb, "bmount", "C6", 0.018, 0.070, times, thrusts, masses, 0.035, 0.0);
        lineStaticInfo("para.info", api.OrkEngine.getStaticInfo(rb));

        // maxTime cap: turbulent-descent ULP row-count drift (same reasoning as
        // conditions/staging). Assert branch COUNT + names EXACTLY; summary at tol.
        String result = api.OrkEngine.simulateJson(rb, "{\"rodLength\":1.2,\"maxTime\":6}");
        java.util.Map<String, Object> parsed = api.JsonLite.parseObject(result);
        Object branchesObj = parsed.get("branches");
        StringBuilder names = new StringBuilder("para.branches|");
        if (branchesObj instanceof java.util.List) {
            java.util.List<?> branches = (java.util.List<?>) branchesObj;
            names.append(branches.size());
            for (Object b : branches) names.append('|').append(asMap(b).get("name"));
        } else {
            names.append("MISSING");
        }
        System.out.println(names);
        java.util.Map<String, Object> summary = asMap(parsed.get("summary"));
        line("flight.para.summary",
                api.JsonLite.dbl(summary, "maxAltitude", Double.NaN),
                api.JsonLite.dbl(summary, "maxVelocity", Double.NaN),
                api.JsonLite.dbl(summary, "timeToApogee", Double.NaN));
    }

    /**
     * Serial two-stage flights through the tree API. Two patterns from the
     * field (the owner's rules):
     * - "auto": low/mid-power gap staging — booster motor's ejection charge
     *   (delay 0) separates the booster AND lights the sustainer
     *   (IgnitionEvent.AUTOMATIC). Chuteless booster falls on its own branch.
     * - "timed": the high-power pattern — separation at booster burnout,
     *   sustainer lit by electronics (burnout + 1 s); booster recovers under
     *   its own chute on its own branch.
     * Locks: branch count/names, per-branch event sequences, per-branch
     * apogee/end-time (the sustainer must fly ~2 stages high; the booster
     * branch must end on its own GROUND_HIT).
     */
    private static void stagingScenarios() {
        runStagingScenario("auto", null, 0.0, false);
        runStagingScenario("timed", "burnout", 1.0, true);
    }

    private static void runStagingScenario(String name, String sustainerIgnition,
            double ignitionDelay, boolean boosterChute) {
        String sustainer = "{\"type\":\"stage\",\"name\":\"Sustainer\",\"children\":["
                + "{\"type\":\"nosecone\",\"length\":0.07,\"aftRadius\":0.012,\"thickness\":0.002},"
                + "{\"type\":\"bodytube\",\"length\":0.30,\"outerRadius\":0.012,\"thickness\":0.0003,\"density\":950,\"children\":["
                + "  {\"type\":\"trapezoidfinset\",\"finCount\":3,\"rootChord\":0.05,\"tipChord\":0.03,\"sweep\":0.02,\"height\":0.025,\"thickness\":0.003},"
                + "  {\"type\":\"innertube\",\"id\":\"smount\",\"length\":0.07,\"outerRadius\":0.0095,\"thickness\":0.0005,\"motorMount\":true,"
                + "   \"position\":{\"method\":\"bottom\",\"offset\":0}},"
                + "  {\"type\":\"parachute\",\"name\":\"SustainerChute\",\"diameter\":0.35}"
                + "]}]}";
        String booster = "{\"type\":\"stage\",\"name\":\"Booster\","
                + "\"separationEvent\":\"" + (sustainerIgnition == null ? "ejection" : "burnout") + "\",\"children\":["
                + "{\"type\":\"bodytube\",\"length\":0.12,\"outerRadius\":0.012,\"thickness\":0.0003,\"density\":950,\"children\":["
                + "  {\"type\":\"trapezoidfinset\",\"finCount\":3,\"rootChord\":0.05,\"tipChord\":0.03,\"sweep\":0.025,\"height\":0.035,\"thickness\":0.003},"
                + "  {\"type\":\"innertube\",\"id\":\"bmount\",\"length\":0.07,\"outerRadius\":0.0095,\"thickness\":0.0005,\"motorMount\":true,"
                + "   \"position\":{\"method\":\"bottom\",\"offset\":0}}"
                + (boosterChute ? ",{\"type\":\"parachute\",\"name\":\"BoosterChute\",\"diameter\":0.25}" : "")
                + "]}]}";
        int r = api.OrkEngine.buildRocket(
                "{\"name\":\"TwoStage\",\"components\":[" + sustainer + "," + booster + "]}");

        double[] times = { 0, 0.1, 0.3, 0.5, 1.0, 1.5, 1.85, 2.0 };
        double[] thrusts = { 0, 12.0, 6.0, 5.1, 4.9, 4.8, 4.5, 0 };
        double[] masses = { 0.0240, 0.0231, 0.0215, 0.0202, 0.0174, 0.0147, 0.0133, 0.0132 };
        api.OrkEngine.setMotorById(r, "smount", "C6", 0.018, 0.070, times, thrusts, masses, 0.035, 5.0);
        api.OrkEngine.setMotorById(r, "bmount", "C6", 0.018, 0.070, times, thrusts, masses, 0.035, 0.0);
        if (sustainerIgnition != null) {
            api.OrkEngine.setMotorIgnitionById(r, "smount", sustainerIgnition, ignitionDelay);
        }

        String result = api.OrkEngine.simulateJson(r, "{\"rodLength\":1.0}");
        java.util.Map<String, Object> parsed = api.JsonLite.parseObject(result);
        Object branchesObj = parsed.get("branches");
        if (!(branchesObj instanceof java.util.List)) {
            System.out.println("staging." + name + ".branches|MISSING");
            return;
        }
        java.util.List<?> branches = (java.util.List<?>) branchesObj;
        StringBuilder names = new StringBuilder("staging." + name + ".branches|" + branches.size());
        for (Object b : branches) {
            names.append('|').append(asMap(b).get("name"));
        }
        System.out.println(names);

        for (int i = 0; i < branches.size(); i++) {
            java.util.Map<String, Object> b = asMap(branches.get(i));
            StringBuilder evs = new StringBuilder("staging." + name + ".b" + i + ".events");
            for (Object e : (java.util.List<?>) b.get("events")) {
                java.util.Map<String, Object> ev = asMap(e);
                evs.append('|').append(ev.get("type"));
                Object src = ev.get("source");
                if (src != null) evs.append('@').append(src);
            }
            System.out.println(evs);

            java.util.Map<String, Object> series = asMap(b.get("series"));
            java.util.List<?> alt = (java.util.List<?>) series.get("altitude");
            double maxAlt = 0;
            for (Object v : alt) {
                if (v instanceof Double && (Double) v > maxAlt) maxAlt = (Double) v;
            }
            // Apogee + separation time only: the END of a ~3-minute chute
            // descent accumulates transcendental ULP noise (end time drifts
            // ~1e-6 rel, sample count ±1) — same class as the turbulent-
            // scenario cap. The event SEQUENCES above are exact strings.
            double sepTime = Double.NaN;
            for (Object e : (java.util.List<?>) b.get("events")) {
                java.util.Map<String, Object> ev = asMap(e);
                if ("STAGE_SEPARATION".equals(ev.get("type"))) {
                    sepTime = api.JsonLite.dbl(ev, "time", Double.NaN);
                    break;
                }
            }
            line("flight.staging." + name + ".b" + i, maxAlt, sepTime);
        }
    }

    /**
     * Clustered motor mount: identical airframe flown with a single mount vs
     * a 3-ring cluster of the same motor. The kernel fires the cluster as
     * thrust×count with mass/inertia at the cluster geometry points — the
     * cluster flight must show ~3× the loaded-motor mass delta and a much
     * higher max acceleration. Also asserts the cluster geometry itself
     * (count + tube offsets) so a silently-ignored cluster param can't pass.
     */
    private static void clusterScenarios() {
        for (String pattern : new String[] { null, "3-ring" }) {
            String name = pattern == null ? "single" : "ring3";
            String clusterAttrs = pattern == null ? ""
                    : ",\"cluster\":\"" + pattern + "\",\"clusterScale\":1.0,\"clusterRotation\":0.5235987755982988";
            String json = "{\"name\":\"Cluster\",\"components\":["
                    + "{\"type\":\"nosecone\",\"length\":0.12,\"aftRadius\":0.033,\"thickness\":0.002},"
                    + "{\"type\":\"bodytube\",\"length\":0.45,\"outerRadius\":0.033,\"thickness\":0.001,\"density\":950,\"children\":["
                    + "  {\"type\":\"trapezoidfinset\",\"finCount\":3,\"rootChord\":0.09,\"tipChord\":0.05,\"sweep\":0.04,\"height\":0.06,\"thickness\":0.003},"
                    + "  {\"type\":\"innertube\",\"id\":\"mount\",\"length\":0.075,\"outerRadius\":0.0095,\"thickness\":0.0005,\"motorMount\":true"
                    + clusterAttrs + ",\"position\":{\"method\":\"bottom\",\"offset\":0}},"
                    + "  {\"type\":\"parachute\",\"diameter\":0.45}"
                    + "]}]}";
            int r = api.OrkEngine.buildRocket(json);

            // Geometry assertion straight off the kernel component.
            info.openrocket.core.rocketcomponent.Rocket rocket =
                    (info.openrocket.core.rocketcomponent.Rocket) getRocketFromInfo(r);
            info.openrocket.core.rocketcomponent.InnerTube mount = null;
            for (info.openrocket.core.rocketcomponent.RocketComponent comp : rocket) {
                if (comp instanceof info.openrocket.core.rocketcomponent.InnerTube) {
                    mount = (info.openrocket.core.rocketcomponent.InnerTube) comp;
                }
            }
            Coordinate[] offsets = mount.getInstanceOffsets();
            double[] geom = new double[1 + offsets.length * 2];
            geom[0] = mount.getInstanceCount();
            for (int i = 0; i < offsets.length; i++) {
                geom[1 + i * 2] = offsets[i].y;
                geom[2 + i * 2] = offsets[i].z;
            }
            line("cluster." + name + ".geometry", geom);

            api.OrkEngine.setMotorById(r, "mount", "C6", 0.018, 0.070,
                    new double[] { 0, 0.1, 0.3, 0.5, 1.0, 1.5, 1.85, 2.0 },
                    new double[] { 0, 12.0, 6.0, 5.1, 4.9, 4.8, 4.5, 0 },
                    new double[] { 0.0240, 0.0231, 0.0215, 0.0202, 0.0174, 0.0147, 0.0133, 0.0132 },
                    0.035, 4.0);
            lineStaticInfo("cluster." + name + ".info", api.OrkEngine.getStaticInfo(r));

            String result = api.OrkEngine.simulateJson(r, "{\"rodLength\":1.0}");
            java.util.Map<String, Object> parsed = api.JsonLite.parseObject(result);
            java.util.Map<String, Object> summary = asMap(parsed.get("summary"));
            line("flight.cluster." + name,
                    api.JsonLite.dbl(summary, "maxAltitude", Double.NaN),
                    api.JsonLite.dbl(summary, "maxVelocity", Double.NaN),
                    api.JsonLite.dbl(summary, "maxAcceleration", Double.NaN),
                    api.JsonLite.dbl(summary, "timeToApogee", Double.NaN),
                    api.JsonLite.dbl(summary, "flightTime", Double.NaN));
        }
    }

    /**
     * Dual deployment: drogue at apogee + main at 150 m AGL. Events must
     * carry their SOURCE component name so the app can tell WHICH device
     * deployed (drogue vs main) — safety thresholds differ per stage.
     */
    private static void dualDeployScenarios() {
        String rocket = "{\"name\":\"DualDeploy\",\"components\":["
                + "{\"type\":\"nosecone\",\"length\":0.07,\"aftRadius\":0.012,\"thickness\":0.002},"
                + "{\"type\":\"bodytube\",\"length\":0.30,\"outerRadius\":0.012,\"thickness\":0.0003,\"density\":950,\"children\":["
                + "  {\"type\":\"trapezoidfinset\",\"finCount\":3,\"rootChord\":0.05,\"tipChord\":0.03,\"sweep\":0.02,\"height\":0.03,\"thickness\":0.003},"
                + "  {\"type\":\"innertube\",\"id\":\"mount\",\"length\":0.07,\"outerRadius\":0.0095,\"thickness\":0.0005,\"motorMount\":true},"
                + "  {\"type\":\"parachute\",\"name\":\"Drogue\",\"diameter\":0.15,\"deployEvent\":\"apogee\"},"
                + "  {\"type\":\"parachute\",\"name\":\"Main\",\"diameter\":0.45,\"deployEvent\":\"altitude\",\"deployAltitude\":150}"
                + "]}]}";
        int r = api.OrkEngine.buildRocket(rocket);
        api.OrkEngine.setMotorById(r, "mount", "C6", 0.018, 0.070,
                new double[] { 0, 0.1, 0.3, 0.5, 1.0, 1.5, 1.85, 2.0 },
                new double[] { 0, 12.0, 6.0, 5.1, 4.9, 4.8, 4.5, 0 },
                new double[] { 0.0240, 0.0231, 0.0215, 0.0202, 0.0174, 0.0147, 0.0133, 0.0132 },
                0.035, 5.0);
        String result = api.OrkEngine.simulateJson(r, "{\"rodLength\":1.0}");
        java.util.Map<String, Object> parsed = api.JsonLite.parseObject(result);
        Object events = parsed.get("events");
        StringBuilder sources = new StringBuilder("flight.dualdeploy.sources");
        java.util.List<Double> times = new java.util.ArrayList<>();
        if (events instanceof java.util.List) {
            for (Object e : (java.util.List<?>) events) {
                if (!(e instanceof java.util.Map)) continue;
                java.util.Map<String, Object> ev = asMap(e);
                if ("RECOVERY_DEVICE_DEPLOYMENT".equals(ev.get("type"))) {
                    sources.append('|').append(ev.get("source"));
                    times.add(api.JsonLite.dbl(ev, "time", Double.NaN));
                }
            }
        }
        // Sources compare exactly (strings); times get flight.* tolerance.
        System.out.println(sources);
        double[] t = new double[times.size()];
        for (int i = 0; i < times.size(); i++) t[i] = times.get(i);
        line("flight.dualdeploy.times", t);
    }

    @SuppressWarnings("unchecked")
    private static java.util.Map<String, Object> asMap(Object o) {
        return (java.util.Map<String, Object>) o;
    }

    /** Cross-sections and freeform fins through the tree API. */
    private static void finVariantScenarios() {
        // Same reference rocket, airfoil cross-section: CD must drop vs square.
        for (String cs : new String[] { "square", "rounded", "airfoil" }) {
            String json = "{\"components\":["
                    + "{\"type\":\"nosecone\",\"length\":0.07,\"aftRadius\":0.012,\"thickness\":0.002},"
                    + "{\"type\":\"bodytube\",\"length\":0.30,\"outerRadius\":0.012,\"thickness\":0.0003,\"density\":950,\"children\":["
                    + "  {\"type\":\"trapezoidfinset\",\"finCount\":3,\"rootChord\":0.05,\"tipChord\":0.03,\"sweep\":0.02,\"height\":0.03,\"thickness\":0.003,\"crossSection\":\"" + cs + "\"}"
                    + "]}]}";
            int r = api.OrkEngine.buildRocket(json);
            info.openrocket.core.rocketcomponent.FlightConfiguration config =
                    ((info.openrocket.core.rocketcomponent.Rocket)
                            getRocketFromInfo(r)).getSelectedConfiguration();
            info.openrocket.core.aerodynamics.BarrowmanCalculator calc =
                    new info.openrocket.core.aerodynamics.BarrowmanCalculator();
            info.openrocket.core.aerodynamics.FlightConditions cond =
                    new info.openrocket.core.aerodynamics.FlightConditions(config);
            cond.setMach(0.3);
            cond.setAOA(0);
            info.openrocket.core.logging.WarningSet w = new info.openrocket.core.logging.WarningSet();
            info.openrocket.core.aerodynamics.AerodynamicForces f =
                    calc.getAerodynamicForces(config, cond, w);
            line("fins.crosssection." + cs, f.getCD(), f.getFrictionCD(), f.getPressureCD());
        }

        // --- Surface finish: every one of ExternalComponent.Finish's nine levels.
        // OPTIMUM and MIRROR had no case in ComponentFactory.finishOf and fell
        // through to NORMAL, so the ladder was non-monotonic and two levels were
        // silently a 12x roughness error. Sweeping all nine pins the mapping.
        for (String fin : new String[] { "rough", "roughunfinished", "unfinished", "normal",
                "smooth", "optimum", "polished", "finishpolished", "mirror" }) {
            String json = "{\"components\":["
                    + "{\"type\":\"nosecone\",\"length\":0.07,\"aftRadius\":0.012,\"thickness\":0.002,\"finish\":\"" + fin + "\"},"
                    + "{\"type\":\"bodytube\",\"length\":0.30,\"outerRadius\":0.012,\"thickness\":0.0003,\"density\":950,\"finish\":\"" + fin + "\",\"children\":["
                    + "  {\"type\":\"trapezoidfinset\",\"finCount\":3,\"rootChord\":0.05,\"tipChord\":0.03,\"sweep\":0.02,\"height\":0.03,\"thickness\":0.003,\"finish\":\"" + fin + "\"}"
                    + "]}]}";
            int r = api.OrkEngine.buildRocket(json);
            info.openrocket.core.rocketcomponent.FlightConfiguration config =
                    ((info.openrocket.core.rocketcomponent.Rocket)
                            getRocketFromInfo(r)).getSelectedConfiguration();
            info.openrocket.core.aerodynamics.BarrowmanCalculator calc =
                    new info.openrocket.core.aerodynamics.BarrowmanCalculator();
            info.openrocket.core.aerodynamics.FlightConditions cond =
                    new info.openrocket.core.aerodynamics.FlightConditions(config);
            cond.setMach(0.3);
            cond.setAOA(0);
            info.openrocket.core.logging.WarningSet w = new info.openrocket.core.logging.WarningSet();
            info.openrocket.core.aerodynamics.AerodynamicForces f =
                    calc.getAerodynamicForces(config, cond, w);
            line("finish." + fin, f.getCD(), f.getFrictionCD());
        }

        // --- Fin fillet epoxy: mass, CG and inertia of the fillet volume.
        // The .ork reader always kept <filletradius>/<filletmaterial>; nothing
        // bridged them, so filleted designs flew light against desktop.
        for (double fr : new double[] { 0.0, 0.009525 }) {
            String json = "{\"components\":["
                    + "{\"type\":\"nosecone\",\"length\":0.217424,\"aftRadius\":0.02032,\"thickness\":0.001524,\"density\":1850},"
                    + "{\"type\":\"bodytube\",\"length\":0.7366,\"outerRadius\":0.02032,\"thickness\":0.001016,\"density\":1954.89,\"children\":["
                    + "  {\"type\":\"freeformfinset\",\"id\":\"ff\",\"finCount\":3,\"thickness\":0.00254,\"crossSection\":\"rounded\",\"density\":1556.99,"
                    + "   \"filletRadius\":" + fr + ",\"filletDensity\":1729.99404,"
                    + "   \"points\":[[0,0],[0.1397,0.0508],[0.1905,0.0508],[0.2159,0]]}"
                    + "]}]}";
            int r = api.OrkEngine.buildRocket(json);
            lineStaticInfo("fins.fillet." + fr + ".info", api.OrkEngine.getStaticInfo(r));
            lineComponentInfo("fins.fillet." + fr + ".comp", api.OrkEngine.getComponentInfo(r, "ff"));
        }

        // Freeform fin set: swept clipped-delta planform.
        String freeform = "{\"components\":["
                + "{\"type\":\"nosecone\",\"length\":0.07,\"aftRadius\":0.012,\"thickness\":0.002},"
                + "{\"type\":\"bodytube\",\"length\":0.30,\"outerRadius\":0.012,\"thickness\":0.0003,\"density\":950,\"children\":["
                + "  {\"type\":\"freeformfinset\",\"finCount\":3,\"thickness\":0.003,\"crossSection\":\"airfoil\","
                + "   \"points\":[[0,0],[0.03,0.035],[0.055,0.035],[0.06,0.0]],"
                + "   \"position\":{\"method\":\"bottom\",\"offset\":0}}"
                + "]}]}";
        int r2 = api.OrkEngine.buildRocket(freeform);
        lineStaticInfo("fins.freeform.info", api.OrkEngine.getStaticInfo(r2));

        finTabScenarios();
    }

    /**
     * Fin tabs (through-the-wall): tab volume must add mass and shift CG;
     * per-component info must expose the (all-fins) mass and subtree mass.
     */
    private static void finTabScenarios() {
        // Trapezoid fins, no tab vs 10 mm-deep × 30 mm-long tab.
        String noTab = "{\"components\":["
                + "{\"type\":\"nosecone\",\"length\":0.07,\"aftRadius\":0.012,\"thickness\":0.002},"
                + "{\"type\":\"bodytube\",\"id\":\"body\",\"length\":0.30,\"outerRadius\":0.012,\"thickness\":0.0003,\"density\":950,\"children\":["
                + "  {\"type\":\"trapezoidfinset\",\"id\":\"fins\",\"finCount\":3,\"rootChord\":0.05,\"tipChord\":0.03,\"sweep\":0.02,\"height\":0.03,\"thickness\":0.003,\"density\":680,"
                + "   \"position\":{\"method\":\"bottom\",\"offset\":0}}"
                + "]}]}";
        int rPlain = api.OrkEngine.buildRocket(noTab);
        lineStaticInfo("fins.tab.none", api.OrkEngine.getStaticInfo(rPlain));
        lineComponentInfo("fins.tab.none.comp", api.OrkEngine.getComponentInfo(rPlain, "fins"));

        String withTab = noTab.replace("\"position\":{\"method\":\"bottom\",\"offset\":0}}",
                "\"position\":{\"method\":\"bottom\",\"offset\":0},"
                + "\"tabHeight\":0.010,\"tabLength\":0.030,\"tabOffset\":0,\"tabOffsetMethod\":\"middle\"}");
        int rTab = api.OrkEngine.buildRocket(withTab);
        lineStaticInfo("fins.tab.10mm", api.OrkEngine.getStaticInfo(rTab));
        lineComponentInfo("fins.tab.10mm.comp", api.OrkEngine.getComponentInfo(rTab, "fins"));
        lineComponentInfo("fins.tab.10mm.body", api.OrkEngine.getComponentInfo(rTab, "body"));

        // Tab height beyond the body radius must clamp (kernel validation).
        String clamped = noTab.replace("\"position\":{\"method\":\"bottom\",\"offset\":0}}",
                "\"position\":{\"method\":\"bottom\",\"offset\":0},"
                + "\"tabHeight\":0.5,\"tabLength\":0.030}");
        int rClamp = api.OrkEngine.buildRocket(clamped);
        lineComponentInfo("fins.tab.clamped.comp", api.OrkEngine.getComponentInfo(rClamp, "fins"));

        // Freeform fins with a tab.
        String ffTab = "{\"components\":["
                + "{\"type\":\"nosecone\",\"length\":0.07,\"aftRadius\":0.012,\"thickness\":0.002},"
                + "{\"type\":\"bodytube\",\"length\":0.30,\"outerRadius\":0.012,\"thickness\":0.0003,\"density\":950,\"children\":["
                + "  {\"type\":\"freeformfinset\",\"id\":\"ff\",\"finCount\":3,\"thickness\":0.003,\"crossSection\":\"airfoil\",\"density\":680,"
                + "   \"points\":[[0,0],[0.03,0.035],[0.055,0.035],[0.06,0.0]],"
                + "   \"tabHeight\":0.008,\"tabLength\":0.025,\"tabOffset\":0,\"tabOffsetMethod\":\"middle\","
                + "   \"position\":{\"method\":\"bottom\",\"offset\":0}}"
                + "]}]}";
        int rFf = api.OrkEngine.buildRocket(ffTab);
        lineStaticInfo("fins.tab.freeform", api.OrkEngine.getStaticInfo(rFf));
        lineComponentInfo("fins.tab.freeform.comp", api.OrkEngine.getComponentInfo(rFf, "ff"));
    }

    private static void lineComponentInfo(String tag, String json) {
        java.util.Map<String, Object> info = api.JsonLite.parseObject(json);
        line(tag,
                api.JsonLite.dbl(info, "length", Double.NaN),
                api.JsonLite.dbl(info, "mass", Double.NaN),
                api.JsonLite.dbl(info, "sectionMass", Double.NaN),
                api.JsonLite.dbl(info, "cgX", Double.NaN),
                api.JsonLite.dbl(info, "positionX", Double.NaN));
    }

    /** Reflection-free accessor: rebuild handle context via the public API. */
    private static Object getRocketFromInfo(int handle) {
        return api.OrkEngine.getRocketForTesting(handle);
    }

    /** P2.4: custom launch conditions (wind + site atmosphere) through the API. */
    private static void conditionsScenarios() {
        String reference = "{\"name\":\"Ref\",\"components\":["
                + "{\"type\":\"nosecone\",\"length\":0.07,\"aftRadius\":0.012,\"thickness\":0.002,\"shape\":\"ogive\"},"
                + "{\"type\":\"bodytube\",\"length\":0.30,\"outerRadius\":0.012,\"thickness\":0.0003,\"density\":950,\"children\":["
                + "  {\"type\":\"trapezoidfinset\",\"finCount\":3,\"rootChord\":0.05,\"tipChord\":0.03,\"sweep\":0.02,\"height\":0.03,\"thickness\":0.003},"
                + "  {\"type\":\"innertube\",\"id\":\"mount\",\"length\":0.07,\"outerRadius\":0.0095,\"thickness\":0.0005,\"motorMount\":true},"
                + "  {\"type\":\"parachute\",\"diameter\":0.30}"
                + "]}]}";
        int r = api.OrkEngine.buildRocket(reference);
        api.OrkEngine.setMotorById(r, "mount", "C6", 0.018, 0.070,
                new double[] { 0, 0.1, 0.3, 0.5, 1.0, 1.5, 1.85, 2.0 },
                new double[] { 0, 12.0, 6.0, 5.1, 4.9, 4.8, 4.5, 0 },
                new double[] { 0.0240, 0.0231, 0.0215, 0.0202, 0.0174, 0.0147, 0.0133, 0.0132 },
                0.035, 5.0);

        // Windy launch from a hot high-altitude site with low pressure.
        // maxTime caps the flight just past apogee (~6.8 s) and deployment
        // (~7.2 s): a turbulent sim is chaotic, and over a ~100 s descent the
        // JVM-vs-JS transcendental ULP noise amplifies until the adaptive
        // stepper's ROW COUNT flips — a structural diff no numeric tolerance
        // absorbs. 8 s keeps full coverage (wind, atmosphere, deployment,
        // every series) while staying within comparable drift.
        String result = api.OrkEngine.simulateJson(r, "{"
                + "\"rodLength\":1.2,\"rodAngle\":0.087,\"windAverage\":3.0,"
                + "\"windStdDeviation\":0.6,\"launchAltitude\":1400,"
                + "\"temperature\":303.15,\"pressure\":86000,\"randomSeed\":7,"
                + "\"maxTime\":8}");
        java.util.Map<String, Object> parsed = api.JsonLite.parseObject(result);
        java.util.Map<String, Object> summary = api.JsonLite.obj(parsed, "summary");
        line("flight.conditions.summary",
                api.JsonLite.dbl(summary, "maxAltitude", Double.NaN),
                api.JsonLite.dbl(summary, "maxVelocity", Double.NaN),
                api.JsonLite.dbl(summary, "timeToApogee", Double.NaN),
                api.JsonLite.dbl(summary, "groundHitVelocity", Double.NaN));
        line("flight.conditions.summaryext",
                api.JsonLite.dbl(summary, "maxMachNumber", Double.NaN),
                api.JsonLite.dbl(summary, "launchRodVelocity", Double.NaN),
                api.JsonLite.dbl(summary, "deploymentVelocity", Double.NaN),
                api.JsonLite.dbl(summary, "optimumDelay", Double.NaN));

        // Extended series exist and have consistent lengths.
        java.util.Map<String, Object> series = api.JsonLite.obj(parsed, "series");
        String[] keys = { "time", "altitude", "velocity", "acceleration", "mass",
                "thrust", "drag", "mach", "stability", "cpLocation", "cgLocation", "aoa" };
        double[] sizes = new double[keys.length];
        for (int i = 0; i < keys.length; i++) {
            Object arr = series.get(keys[i]);
            sizes[i] = arr instanceof java.util.List ? ((java.util.List<?>) arr).size() : -1;
        }
        line("flight.conditions.serieslens", sizes);
    }

    /**
     * P2.1: the JSON tree API must produce identical physics to direct
     * construction, and the extended component set must compute consistent
     * mass/CP on both JVM and TeaVM.
     */
    private static void treeApiScenarios() {
        // Same reference rocket, built via the JSON tree API.
        String reference = "{\"name\":\"Ref\",\"components\":["
                + "{\"type\":\"nosecone\",\"length\":0.07,\"aftRadius\":0.012,\"thickness\":0.002,\"shape\":\"ogive\"},"
                + "{\"type\":\"bodytube\",\"length\":0.30,\"outerRadius\":0.012,\"thickness\":0.0003,\"density\":950,\"children\":["
                + "  {\"type\":\"trapezoidfinset\",\"finCount\":3,\"rootChord\":0.05,\"tipChord\":0.03,\"sweep\":0.02,\"height\":0.03,\"thickness\":0.003},"
                + "  {\"type\":\"innertube\",\"id\":\"mount\",\"length\":0.07,\"outerRadius\":0.0095,\"thickness\":0.0005,\"motorMount\":true},"
                + "  {\"type\":\"parachute\",\"diameter\":0.30}"
                + "]}]}";
        int r1 = api.OrkEngine.buildRocket(reference);
        line("tree.api.ref", 1);
        lineStaticInfo("tree.info.ref", api.OrkEngine.getStaticInfo(r1));

        // Extended component set: transition, coupler, rings, lug, streamer,
        // shock cord, mass component, elliptical fins.
        String extended = "{\"name\":\"Extended\",\"components\":["
                + "{\"type\":\"nosecone\",\"length\":0.1,\"aftRadius\":0.0125,\"thickness\":0.002,\"shape\":\"haack\"},"
                + "{\"type\":\"bodytube\",\"length\":0.35,\"outerRadius\":0.0125,\"thickness\":0.0005,\"density\":950,\"children\":["
                + "  {\"type\":\"ellipticalfinset\",\"finCount\":4,\"rootChord\":0.06,\"height\":0.04,\"thickness\":0.003},"
                + "  {\"type\":\"launchlug\",\"length\":0.05,\"outerRadius\":0.0025,\"thickness\":0.0004,"
                + "   \"position\":{\"method\":\"middle\",\"offset\":0}},"
                + "  {\"type\":\"innertube\",\"id\":\"mount\",\"length\":0.08,\"outerRadius\":0.012,\"thickness\":0.0005,\"motorMount\":true,"
                + "   \"position\":{\"method\":\"bottom\",\"offset\":0},\"children\":["
                + "    {\"type\":\"engineblock\",\"length\":0.005,\"thickness\":0.001,\"position\":{\"method\":\"top\",\"offset\":0}}"
                + "  ]},"
                + "  {\"type\":\"centeringring\",\"length\":0.002,\"position\":{\"method\":\"bottom\",\"offset\":-0.01}},"
                + "  {\"type\":\"centeringring\",\"length\":0.002,\"position\":{\"method\":\"bottom\",\"offset\":-0.07}},"
                + "  {\"type\":\"streamer\",\"stripLength\":0.6,\"stripWidth\":0.05,\"position\":{\"method\":\"top\",\"offset\":0.02}},"
                + "  {\"type\":\"shockcord\",\"cordLength\":0.4,\"position\":{\"method\":\"top\",\"offset\":0.01}},"
                + "  {\"type\":\"masscomponent\",\"mass\":0.015,\"length\":0.02,\"radius\":0.006,\"position\":{\"method\":\"top\",\"offset\":0.05}}"
                + "]},"
                + "{\"type\":\"transition\",\"length\":0.04,\"foreRadius\":0.0125,\"aftRadius\":0.009,\"thickness\":0.001,\"shape\":\"conical\",\"density\":680}"
                + "]}";
        int r2 = api.OrkEngine.buildRocket(extended);
        lineStaticInfo("tree.info.ext", api.OrkEngine.getStaticInfo(r2));
    }

    /** Re-parse the API's JSON (JsonLite) into numeric golden fields so the
     *  differential comparator can apply per-field ULP tolerance. */
    private static void lineStaticInfo(String tag, String json) {
        java.util.Map<String, Object> info = api.JsonLite.parseObject(json);
        line(tag,
                api.JsonLite.dbl(info, "length", Double.NaN),
                api.JsonLite.dbl(info, "mass", Double.NaN),
                api.JsonLite.dbl(info, "cg", Double.NaN),
                api.JsonLite.dbl(info, "cp", Double.NaN),
                api.JsonLite.dbl(info, "cna", Double.NaN),
                api.JsonLite.dbl(info, "stabilityCalibers", Double.NaN),
                api.JsonLite.dbl(info, "warnings", Double.NaN));
    }

    /** java.util.Random is algorithm-specified (LCG) — verify TeaVM matches. */
    private static void randomScenarios() {
        java.util.Random r = new java.util.Random(42);
        line("random.seeded42", r.nextDouble(), r.nextDouble(), r.nextGaussian(), r.nextGaussian());
    }

    /** P1.4: full 6DOF flight — C6-class motor, no wind, ISA, WGS gravity. */
    private static void flightScenarios() {
        Rocket rocket = buildReferenceRocket();
        // Dedicated flight configuration (motors cannot attach to the default config).
        info.openrocket.core.rocketcomponent.FlightConfigurationId fcid =
                new info.openrocket.core.rocketcomponent.FlightConfigurationId(
                        "00000001-0001-4001-8001-000000000001");
        rocket.createFlightConfiguration(fcid);
        rocket.setSelectedConfiguration(fcid);

        // C6-class motor built from explicit data points (deterministic; no db).
        info.openrocket.core.motor.ThrustCurveMotor motor =
                new info.openrocket.core.motor.ThrustCurveMotor.Builder()
                        .setManufacturer(info.openrocket.core.motor.Manufacturer.getManufacturer("Estes"))
                        .setDesignation("C6")
                        .setCommonName("C6")
                        .setMotorType(info.openrocket.core.motor.Motor.Type.SINGLE)
                        .setStandardDelays(new double[] { 3, 5, 7 })
                        .setDiameter(0.018)
                        .setLength(0.070)
                        .setTimePoints(new double[] { 0, 0.1, 0.3, 0.5, 1.0, 1.5, 1.85, 2.0 })
                        .setThrustPoints(new double[] { 0, 12.0, 6.0, 5.1, 4.9, 4.8, 4.5, 0 })
                        .setCGPoints(new Coordinate[] {
                                new Coordinate(0.035, 0, 0, 0.0240), new Coordinate(0.035, 0, 0, 0.0231),
                                new Coordinate(0.035, 0, 0, 0.0215), new Coordinate(0.035, 0, 0, 0.0202),
                                new Coordinate(0.035, 0, 0, 0.0174), new Coordinate(0.035, 0, 0, 0.0147),
                                new Coordinate(0.035, 0, 0, 0.0133), new Coordinate(0.035, 0, 0, 0.0132) })
                        .setDigest("harness-c6")
                        .build();

        // Attach to the inner-tube mount.
        InnerTube mount = null;
        for (info.openrocket.core.rocketcomponent.RocketComponent c
                : rocket.getSelectedConfiguration().getAllComponents()) {
            if (c instanceof InnerTube) {
                mount = (InnerTube) c;
            }
        }
        mount.setMotorMount(true);
        info.openrocket.core.motor.MotorConfiguration mc =
                new info.openrocket.core.motor.MotorConfiguration(mount, fcid);
        mc.setMotor(motor);
        mc.setEjectionDelay(5.0);
        mount.setMotorConfig(mc, fcid);

        info.openrocket.core.simulation.SimulationConditions conditions =
                new info.openrocket.core.simulation.SimulationConditions();
        conditions.setSimulation(new info.openrocket.core.document.Simulation(rocket, fcid));
        conditions.setLaunchRodLength(1.0);
        conditions.setLaunchRodAngle(0.0);
        conditions.setLaunchRodDirection(Math.PI / 2);
        conditions.setLaunchSite(new info.openrocket.core.util.WorldCoordinate(28.61, -80.60, 0));
        conditions.setGeodeticComputation(info.openrocket.core.util.GeodeticComputationStrategy.SPHERICAL);
        conditions.setAtmosphericModel(new ExtendedISAModel());
        conditions.setGravityModel(new info.openrocket.core.models.gravity.WGSGravityModel());
        info.openrocket.core.models.wind.PinkNoiseWindModel wind =
                new info.openrocket.core.models.wind.PinkNoiseWindModel();
        wind.setAverage(0.0);
        wind.setStandardDeviation(0.0);
        conditions.setWindModel(wind);
        conditions.setAerodynamicCalculator(new info.openrocket.core.aerodynamics.BarrowmanCalculator());
        conditions.setMassCalculator(new MassCalculator());
        conditions.setTimeStep(0.05);
        conditions.setMaxSimulationTime(1200);
        conditions.setRandomSeed(42);

        try {
            info.openrocket.core.simulation.BasicEventSimulationEngine engine =
                    new info.openrocket.core.simulation.BasicEventSimulationEngine();
            engine.simulate(conditions);
            info.openrocket.core.simulation.FlightData data = engine.getFlightData();

            line("flight.summary", data.getMaxAltitude(), data.getMaxVelocity(),
                    data.getMaxAcceleration(), data.getTimeToApogee(),
                    data.getFlightTime(), data.getGroundHitVelocity(), data.getBranchCount());

            info.openrocket.core.simulation.FlightDataBranch branch = data.getBranch(0);
            for (info.openrocket.core.simulation.FlightEvent ev : branch.getEvents()) {
                line("flight.event." + ev.getType().name(), ev.getTime());
                if (ev.getData() != null) {
                    System.out.println("flight.eventdata|" + ev.getType().name() + "|" + ev.getData());
                }
            }

            java.util.List<Double> t = branch.get(
                    info.openrocket.core.simulation.FlightDataType.TYPE_TIME);
            java.util.List<Double> alt = branch.get(
                    info.openrocket.core.simulation.FlightDataType.TYPE_ALTITUDE);
            java.util.List<Double> vel = branch.get(
                    info.openrocket.core.simulation.FlightDataType.TYPE_VELOCITY_TOTAL);
            java.util.List<Double> acc = branch.get(
                    info.openrocket.core.simulation.FlightDataType.TYPE_ACCELERATION_TOTAL);
            line("flight.rows", t.size());
            if (alt != null && vel != null && acc != null) {
                for (int i = 0; i < t.size(); i += 25) {
                    line("flight.sample." + i, t.get(i), alt.get(i), vel.get(i), acc.get(i));
                }
            }
        } catch (info.openrocket.core.simulation.exception.SimulationException e) {
            line("flight.exception", -1);
            System.out.println("EXCEPTION: " + e);
        }
    }

    /** P1.3: Extended-Barrowman CP and force coefficients across Mach and AoA. */
    private static void aeroScenarios() {
        Rocket rocket = buildReferenceRocket();
        FlightConfiguration config = rocket.getSelectedConfiguration();
        info.openrocket.core.aerodynamics.BarrowmanCalculator calc =
                new info.openrocket.core.aerodynamics.BarrowmanCalculator();
        info.openrocket.core.logging.WarningSet warnings =
                new info.openrocket.core.logging.WarningSet();

        double[] machs = { 0.1, 0.3, 0.5, 0.8, 0.95, 1.05, 1.5, 2.0 };
        double[] aoasDeg = { 0, 2, 5, 15 };

        for (double mach : machs) {
            for (double aoaDeg : aoasDeg) {
                info.openrocket.core.aerodynamics.FlightConditions conditions =
                        new info.openrocket.core.aerodynamics.FlightConditions(config);
                conditions.setMach(mach);
                conditions.setAOA(Math.toRadians(aoaDeg));

                warnings.clear();
                Coordinate cp = calc.getCP(config, conditions, warnings);
                info.openrocket.core.aerodynamics.AerodynamicForces forces =
                        calc.getAerodynamicForces(config, conditions, warnings);

                line("aero.cp", mach, aoaDeg, cp.x, cp.weight);
                line("aero.forces", mach, aoaDeg,
                        forces.getCN(), forces.getCm(), forces.getCD(),
                        forces.getCDaxial(), forces.getPressureCD(),
                        forces.getBaseCD(), forces.getFrictionCD());
            }
        }
        line("aero.warnings", warnings.size());

        // Static helper functions (pure math, worth pinning).
        for (double m : machs) {
            line("aero.staticCD", m,
                    info.openrocket.core.aerodynamics.BarrowmanCalculator.calculateStagnationCD(m),
                    info.openrocket.core.aerodynamics.BarrowmanCalculator.calculateBaseCD(m));
        }
    }

    /**
     * Reference rocket (Alpha-III class): ogive nose, body tube, 3 trapezoid
     * fins, inner-tube motor mount, parachute. Mix of default materials
     * (exercises the shimmed preference defaults, identical both sides) and
     * explicit materials.
     */
    private static Rocket buildReferenceRocket() {
        Rocket rocket = new Rocket();
        AxialStage stage = new AxialStage();
        rocket.addChild(stage);

        NoseCone nose = new NoseCone(Transition.Shape.OGIVE, 0.07, 0.012);
        nose.setThickness(0.002);
        stage.addChild(nose);

        BodyTube body = new BodyTube(0.30, 0.012, 0.0003);
        body.setMaterial(Material.newMaterial(Material.Type.BULK, "Kraft phenolic", 950, false));
        stage.addChild(body);

        TrapezoidFinSet fins = new TrapezoidFinSet(3, 0.05, 0.03, 0.02, 0.03);
        fins.setThickness(0.003);
        body.addChild(fins);

        InnerTube mount = new InnerTube();
        mount.setLength(0.07);
        mount.setOuterRadius(0.0095);
        mount.setThickness(0.0005);
        body.addChild(mount);

        Parachute chute = new Parachute();
        chute.setDiameter(0.30);
        body.addChild(chute);

        rocket.enableEvents();
        return rocket;
    }

    private static void massScenarios() {
        Rocket rocket = buildReferenceRocket();
        FlightConfiguration config = rocket.getSelectedConfiguration();

        // Direct per-class calls to the bounds API. These are real golden values
        // AND they force TeaVM's dependency analyzer to link every implementation
        // (it under-links impls reached only via map-key virtual dispatch).
        int bi = 0;
        for (info.openrocket.core.rocketcomponent.RocketComponent c : config.getAllComponents()) {
            double boundsSize = c.getComponentBounds().size();
            double instBox = (c instanceof info.openrocket.core.rocketcomponent.BoxBounded)
                    ? ((info.openrocket.core.rocketcomponent.BoxBounded) c).getInstanceBoundingBox().span().x
                    : -1;
            line("comp.bounds." + (bi++), boundsSize, instBox);
        }

        // Structural counts — golden values AND the first divergence tripwire.
        line("tree.counts", rocket.getChildCount(), config.getAllComponents().size(),
                config.getActiveComponents().size(), config.getActiveStages().size(),
                config.getStageCount(), config.getActiveInstances().size());

        // Per-component masses — localizes any mass divergence to a component.
        // (Indexed tag, not getSimpleName(): TeaVM strips class name metadata.)
        int ci = 0;
        for (info.openrocket.core.rocketcomponent.RocketComponent c : config.getAllComponents()) {
            line("comp.mass." + (ci++), c.getMass(), c.getLength());
        }

        // Instance-context counts — masses aggregate through these transforms.
        // Sorted (HashMap iteration order differs between JVM and TeaVM).
        java.util.List<Integer> ctxCounts = new java.util.ArrayList<>();
        for (java.util.ArrayList<info.openrocket.core.rocketcomponent.InstanceContext> v
                : config.getActiveInstances().values()) {
            ctxCounts.add(v.size());
        }
        java.util.Collections.sort(ctxCounts);
        double[] sortedCounts = new double[ctxCounts.size()];
        for (int i = 0; i < ctxCounts.size(); i++) {
            sortedCounts[i] = ctxCounts.get(i);
        }
        line("tree.ctx.sorted", sortedCounts);

        // Direct probes at the JVM/JS divergence point (fin instance expansion).
        TrapezoidFinSet finProbe = null;
        for (info.openrocket.core.rocketcomponent.RocketComponent c : config.getAllComponents()) {
            if (c instanceof TrapezoidFinSet) {
                finProbe = (TrapezoidFinSet) c;
            }
        }
        line("fins.instances", finProbe.getFinCount(), finProbe.getInstanceCount(),
                finProbe.getInstanceAngles().length, finProbe.getInstanceOffsets().length);

        // Virtual dispatch check: the tree walk calls getInstanceCount() through
        // a RocketComponent-typed reference — must hit FinSet's override (=3).
        info.openrocket.core.rocketcomponent.RocketComponent rcRef = finProbe;
        line("fins.virtual", rcRef.getInstanceCount(), rcRef.getInstanceAngles().length);

        // Map emplace probe: repeated emplace on the same key must append (list
        // grows), not replace. InstanceMap extends LinkedHashMap (patched from
        // upstream's ConcurrentHashMap — see patches/LEDGER.md determinism fix).
        info.openrocket.core.rocketcomponent.InstanceMap im =
                new info.openrocket.core.rocketcomponent.InstanceMap();
        im.emplace(finProbe, 0, info.openrocket.core.util.Transformation.IDENTITY);
        im.emplace(finProbe, 1, info.openrocket.core.util.Transformation.IDENTITY);
        im.emplace(finProbe, 2, info.openrocket.core.util.Transformation.IDENTITY);
        line("im.count", im.count(finProbe), im.size());

        // Does an explicit post-enableEvents change event rebuild the contexts?
        line("fins.ctx.before", config.getActiveInstances().count(finProbe));
        finProbe.setFinCount(4);
        line("fins.ctx.after4", config.getActiveInstances().count(finProbe));
        finProbe.setFinCount(3);
        line("fins.ctx.after3", config.getActiveInstances().count(finProbe));

        RigidBody structure = MassCalculator.calculateStructure(config);
        line("mass.structure", structure.getMass(),
                structure.getCM().x, structure.getCM().y, structure.getCM().z,
                structure.getIxx(), structure.getIyy(), structure.getIzz(),
                structure.getLongitudinalInertia(), structure.getRotationalInertia());

        RigidBody burnout = MassCalculator.calculateBurnout(config);
        line("mass.burnout", burnout.getMass(),
                burnout.getCM().x, burnout.getCM().y, burnout.getCM().z,
                burnout.getLongitudinalInertia(), burnout.getRotationalInertia());

        line("rocket.length", rocket.getLength());
    }

    private static void atmosphereScenarios() {
        ExtendedISAModel std = new ExtendedISAModel();
        // Altitudes probing layer boundaries, interpolation midpoints, clamps.
        double[] alts = { -100, 0, 1, 250, 499, 500, 501, 1234.56, 5000, 10999, 11000,
                11001, 15000, 20000, 32000, 47000, 51000, 71000, 84852, 90000 };
        for (double alt : alts) {
            AtmosphericConditions c = std.getConditions(alt);
            line("isa.std", alt, c.getTemperature(), c.getPressure(), c.getDensity(),
                    c.getMachSpeed(), c.getKinematicViscosity());
        }
        // Custom launch-site model (plan: base configurable at site altitude).
        ExtendedISAModel site = new ExtendedISAModel(1400, 285.15, 86000);
        for (double alt : new double[] { 0, 1400, 1401, 3000, 11000, 20000 }) {
            AtmosphericConditions c = site.getConditions(alt);
            line("isa.site1400", alt, c.getTemperature(), c.getPressure(), c.getDensity());
        }
    }

    private static void quaternionScenarios() {
        double[][] rotVecs = {
                { Math.PI / 2, 0, 0 }, { 0, Math.PI / 2, 0 }, { 0, 0, Math.PI / 2 },
                { 0.1, -0.2, 0.3 }, { 1e-9, 0, 0 }, { Math.PI, Math.PI / 3, -Math.PI / 5 },
        };
        Coordinate[] vecs = {
                new Coordinate(1, 0, 0), new Coordinate(0, 1, 0), new Coordinate(0, 0, 1),
                new Coordinate(1.5, -2.5, 3.5),
        };
        for (double[] rv : rotVecs) {
            Quaternion q = Quaternion.rotation(new Coordinate(rv[0], rv[1], rv[2]));
            for (Coordinate v : vecs) {
                Coordinate r = q.rotate(v);
                line("quat.rot", rv[0], rv[1], rv[2], v.x, v.y, v.z, r.x, r.y, r.z);
            }
        }
    }

    /** Canonical output: tag then raw Double.toString values, '|'-separated. */
    private static void line(String tag, double... values) {
        StringBuilder sb = new StringBuilder(tag);
        for (double v : values) {
            sb.append('|').append(v);
        }
        System.out.println(sb);
    }

    private GoldenMain() {}
}
