package info.openrocket.core.aerodynamics.barrowman;

import static org.junit.jupiter.api.Assertions.*;

import java.util.ArrayList;
import java.util.List;
import java.util.Random;

import org.junit.jupiter.api.Test;

import info.openrocket.core.rocketcomponent.AxialStage;
import info.openrocket.core.rocketcomponent.BodyTube;
import info.openrocket.core.rocketcomponent.CenteringRing;
import info.openrocket.core.rocketcomponent.InnerTube;
import info.openrocket.core.rocketcomponent.NoseCone;
import info.openrocket.core.rocketcomponent.ParallelStage;
import info.openrocket.core.rocketcomponent.Rocket;
import info.openrocket.core.rocketcomponent.RocketComponent;
import info.openrocket.core.rocketcomponent.TrapezoidFinSet;
import info.openrocket.core.rocketcomponent.Transition;
import info.openrocket.core.rocketcomponent.position.AxialMethod;
import info.openrocket.core.util.Coordinate;

/**
 * The per-parent sibling scans of the 2026-10-11 performance patch (patches/LEDGER.md)
 * give upstream's answers: the fin-interference count, a centering ring's automatic inner
 * radius, and new stage numbers. Each is checked against upstream's own computation, written
 * out here, on designs large enough to take the fast path.
 */
class SiblingScanTest {

    /** Upstream FinSetCalc.calculateInterferenceFinCount's loop, verbatim, as a sum. */
    private static int upstreamInterference(TrapezoidFinSet component) {
        RocketComponent parent = component.getParent();
        double lead = component.toRelative(Coordinate.NUL, parent)[0].x;
        double trail = component.toRelative(new Coordinate(component.getLength()), parent)[0].x;
        if (trail - lead < 0.007) {
            return component.getFinCount();
        }
        int count = 0;
        for (RocketComponent c : parent.getChildren()) {
            if (c instanceof info.openrocket.core.rocketcomponent.FinSet) {
                double finLead = c.toRelative(Coordinate.NUL, parent)[0].x;
                double finTrail = c.toRelative(new Coordinate(c.getLength()), parent)[0].x;
                if ((finLead < trail - 0.005) && (finTrail > lead + 0.005)) {
                    count += ((info.openrocket.core.rocketcomponent.FinSet) c).getFinCount();
                }
            }
        }
        return count;
    }

    @Test
    void sweepCountsWhatTheDoubleLoopCounts() {
        Random random = new Random(20261011L);
        // Coarse grids force ties between leads, trails and the +-0.005 limits;
        // -0.0, infinities and huge counts (int overflow) are mixed in.
        double[] grid = { -0.0, 0.0, 0.005, 0.01, 0.015, 0.02, 0.1, -0.005, 1e300, Double.NEGATIVE_INFINITY,
                Double.POSITIVE_INFINITY };
        for (int round = 0; round < 400; round++) {
            int m = 1 + random.nextInt(300);
            double[] leads = new double[m];
            double[] trails = new double[m];
            int[] counts = new int[m];
            for (int i = 0; i < m; i++) {
                if (random.nextInt(3) == 0) {
                    leads[i] = grid[random.nextInt(grid.length)];
                    trails[i] = grid[random.nextInt(grid.length)];
                } else {
                    leads[i] = Math.round(random.nextDouble() * 200) * 0.0025 - 0.1;
                    trails[i] = leads[i] + Math.round(random.nextDouble() * 40) * 0.0025;
                }
                counts[i] = random.nextInt(5) == 0 ? Integer.MAX_VALUE - random.nextInt(3) : 1 + random.nextInt(8);
            }
            assertArrayEquals(FinSetCalc.countOverlappingFinsDirect(leads, trails, counts),
                    FinSetCalc.countOverlappingFinsSweep(leads, trails, counts), "round " + round);
        }
    }

    @Test
    void nanFallsBackToTheDoubleLoop() {
        int m = FinSetCalc.OVERLAP_SWEEP_MIN + 10;
        double[] leads = new double[m];
        double[] trails = new double[m];
        int[] counts = new int[m];
        for (int i = 0; i < m; i++) {
            leads[i] = i * 0.01;
            trails[i] = leads[i] + 0.05;
            counts[i] = 3;
        }
        leads[7] = Double.NaN;
        assertArrayEquals(FinSetCalc.countOverlappingFinsDirect(leads, trails, counts),
                FinSetCalc.countOverlappingFins(leads, trails, counts));
    }

    @Test
    void finSetCalcCountsTheSameInsideAndOutsideTheScope() {
        Random random = new Random(7L);
        Rocket rocket = new Rocket();
        AxialStage stage = new AxialStage();
        rocket.addChild(stage);
        stage.addChild(new NoseCone(Transition.Shape.OGIVE, 0.1, 0.03));
        BodyTube body = new BodyTube(1.0, 0.03, 0.001);
        stage.addChild(body);
        List<TrapezoidFinSet> fins = new ArrayList<>();
        for (int i = 0; i < 3 * FinSetCalc.OVERLAP_SWEEP_MIN; i++) {
            TrapezoidFinSet f = new TrapezoidFinSet(1 + random.nextInt(6), 0.004 + 0.002 * random.nextInt(40),
                    0.02, 0.01, 0.03);
            f.setAxialMethod(AxialMethod.TOP);
            f.setAxialOffset(0.0025 * random.nextInt(400));
            body.addChild(f);
            fins.add(f);
        }
        rocket.enableEvents();

        int[] outside = new int[fins.size()];
        for (int i = 0; i < fins.size(); i++) {
            outside[i] = new FinSetCalc(fins.get(i)).interferenceFinCount;
            assertEquals(upstreamInterference(fins.get(i)), outside[i], "fin set " + i + ", upstream loop");
        }
        FinSetCalc.beginSiblingFinScope();
        try {
            int before = RocketComponent.siblingScanSteps;
            for (int i = 0; i < fins.size(); i++) {
                assertEquals(outside[i], new FinSetCalc(fins.get(i)).interferenceFinCount, "fin set " + i + ", in scope");
            }
            // One pass over the tube's children for all of its fin sets.
            assertEquals(body.getChildCount(), RocketComponent.siblingScanSteps - before);
        } finally {
            FinSetCalc.endSiblingFinScope();
        }
    }

    /** Upstream CenteringRing.getInnerRadius's loop, verbatim. */
    private static double upstreamInnerRadius(CenteringRing ring) {
        double r = 0;
        for (RocketComponent sibling : ring.getParent().getChildren()) {
            if (!(sibling instanceof InnerTube))
                continue;
            double pos1 = ring.toRelative(Coordinate.NUL, sibling)[0].x;
            double pos2 = ring.toRelative(new Coordinate(ring.getLength()), sibling)[0].x;
            if (pos2 < 0 || pos1 > sibling.getLength())
                continue;
            r = Math.max(r, ((InnerTube) sibling).getOuterRadius());
        }
        return Math.min(r, ring.getOuterRadius());
    }

    @Test
    void centeringRingSeesEveryChangeToItsSiblings() {
        Random random = new Random(11L);
        Rocket rocket = new Rocket();
        AxialStage stage = new AxialStage();
        rocket.addChild(stage);
        BodyTube body = new BodyTube(1.0, 0.04, 0.001);
        stage.addChild(body);
        List<CenteringRing> rings = new ArrayList<>();
        for (int i = 0; i < 60; i++) {
            if (i % 3 == 0) {
                InnerTube t = new InnerTube();
                t.setLength(0.05 + 0.01 * random.nextInt(10));
                t.setOuterRadius(0.005 + 0.001 * random.nextInt(20));
                t.setAxialMethod(AxialMethod.TOP);
                t.setAxialOffset(0.01 * random.nextInt(90));
                body.addChild(t);
            } else {
                CenteringRing ring = new CenteringRing();
                ring.setAxialMethod(AxialMethod.TOP);
                ring.setAxialOffset(0.01 * random.nextInt(95));
                body.addChild(ring);
                rings.add(ring);
            }
        }
        rocket.enableEvents();
        assertRingsMatch(rings);

        // Each kind of change to the child list: insert, append, move, remove.
        InnerTube big = new InnerTube();
        big.setLength(1.0);
        big.setOuterRadius(0.03);
        body.addChild(big, 5);
        assertRingsMatch(rings);
        body.moveChild(big, body.getChildCount() - 1);
        assertRingsMatch(rings);
        body.removeChild(big);
        assertRingsMatch(rings);
        InnerTube appended = new InnerTube();
        appended.setLength(1.0);
        appended.setOuterRadius(0.025);
        body.addChild(appended);
        assertRingsMatch(rings);
        // A copy rebuilds its own child lists.
        Rocket copy = rocket.copyWithOriginalID();
        List<CenteringRing> copied = new ArrayList<>();
        for (RocketComponent c : copy) {
            if (c instanceof CenteringRing) {
                copied.add((CenteringRing) c);
            }
        }
        assertEquals(rings.size(), copied.size());
        assertRingsMatch(copied);
    }

    private static void assertRingsMatch(List<CenteringRing> rings) {
        for (CenteringRing ring : rings) {
            assertEquals(upstreamInnerRadius(ring), ring.getInnerRadius(), 0.0);
            // The kept list is the parent's inner tubes, in child order.
            List<RocketComponent> tubes = new ArrayList<>();
            for (RocketComponent c : ring.getParent().getChildren()) {
                if (c instanceof InnerTube) {
                    tubes.add(c);
                }
            }
            assertEquals(tubes, ring.getParent().getInnerTubeChildren());
        }
    }

    @Test
    void stageNumbersStayContiguousThroughAddsAndRemoves() {
        Rocket rocket = new Rocket();
        AxialStage stage = new AxialStage();
        rocket.addChild(stage);
        BodyTube body = new BodyTube(1.0, 0.04, 0.001);
        stage.addChild(body);
        List<ParallelStage> boosters = new ArrayList<>();
        for (int i = 0; i < 40; i++) {
            ParallelStage p = new ParallelStage(2);
            body.addChild(p);
            boosters.add(p);
        }
        rocket.enableEvents();
        assertStageNumbers(rocket);
        body.removeChild(boosters.get(10));
        assertStageNumbers(rocket);
        body.removeChild(boosters.get(0));
        assertStageNumbers(rocket);
        body.addChild(new ParallelStage(3), 4);
        assertStageNumbers(rocket);
        body.addChild(new ParallelStage(3));
        assertStageNumbers(rocket);
    }

    /** Upstream's numbering: stages numbered 0..n-1 in tree order, each tracked under its number. */
    private static void assertStageNumbers(Rocket rocket) {
        List<AxialStage> stages = rocket.getSubStages();
        assertEquals(stages.size(), rocket.getStageCount());
        for (int i = 0; i < stages.size(); i++) {
            assertEquals(i, stages.get(i).getStageNumber());
            assertSame(stages.get(i), rocket.getStage(i));
        }
    }
}
