package info.openrocket.core.simulation;

import static org.junit.jupiter.api.Assertions.*;

import java.lang.reflect.Method;
import java.util.List;

import org.junit.jupiter.api.Test;

import api.OrkEngine;
import info.openrocket.core.rocketcomponent.AxialStage;
import info.openrocket.core.rocketcomponent.BodyTube;
import info.openrocket.core.rocketcomponent.Rocket;
import info.openrocket.core.util.ModID;

class DataBranchStorageTest {
    private static final FlightDataType TIME = FlightDataType.TYPE_TIME;
    private static final FlightDataType ALT = FlightDataType.TYPE_ALTITUDE;
    private static final FlightDataType MISSING = FlightDataType.TYPE_VELOCITY_TOTAL;
    private static final double[] SPECIAL = { Double.NaN, -0.0, Double.POSITIVE_INFINITY,
            Double.NEGATIVE_INFINITY, Double.MIN_VALUE, Double.MAX_VALUE,
            Double.longBitsToDouble(0x7ff8000000000042L) };

    private static void sameBits(double expected, double actual) {
        assertEquals(Double.doubleToRawLongBits(expected), Double.doubleToRawLongBits(actual));
    }

    private static FlightDataBranch samples(double... values) {
        FlightDataBranch branch = new FlightDataBranch("test", TIME, ALT);
        for (int i = 0; i < values.length; i++) {
            branch.addPoint();
            branch.setValue(TIME, i);
            branch.setValue(ALT, values[i]);
        }
        return branch;
    }

    @Test void specialValuesRoundTripWithoutNarrowing() {
        FlightDataBranch branch = samples(SPECIAL);
        double[] primitive = branch.getValuesCopy(ALT);
        List<Double> view = branch.get(ALT);
        List<Double> copy = branch.getClone(ALT);
        double[] cloned = branch.clone().getValuesCopy(ALT);
        for (int i = 0; i < SPECIAL.length; i++) {
            sameBits(SPECIAL[i], primitive[i]);
            sameBits(SPECIAL[i], view.get(i));
            sameBits(SPECIAL[i], copy.get(i));
            sameBits(SPECIAL[i], cloned[i]);
            sameBits(SPECIAL[i], branch.getByIndex(ALT, i));
        }
        sameBits(SPECIAL[SPECIAL.length - 1], branch.getLast(ALT));
    }

    @Test void columnGrowsAndSupportsBoxedAndPrimitiveAccess() {
        DataBranch.DoubleColumn column = new DataBranch.DoubleColumn();
        for (int i = 0; i < 4097; i++) {
            if (i % 2 == 0) column.addDouble(i + 0.1);
            else assertTrue(column.add(i + 0.1));
        }
        assertEquals(4097, column.size());
        for (int i = 0; i < column.size(); i++) {
            sameBits(i + 0.1, column.getDouble(i));
            sameBits(i + 0.1, column.get(i));
        }
        for (double value : SPECIAL) {
            int index = column.size();
            column.addDouble(value);
            assertTrue(column.add(value));
            sameBits(value, column.getDouble(index));
            sameBits(value, column.get(index));
            sameBits(value, column.getDouble(index + 1));
            sameBits(value, column.get(index + 1));
        }
        sameBits(0.1, column.set(0, -0.0));
        sameBits(1.1, column.setDouble(1, Double.MIN_VALUE));
        sameBits(-0.0, column.getDouble(0));
        sameBits(Double.MIN_VALUE, column.getDouble(1));
        // Boxed replacement must preserve double precision and all special bits too.
        sameBits(-0.0, column.set(0, 0.1));
        sameBits(0.1, column.getDouble(0));
        sameBits(0.1, column.get(0));
        double previous = 0.1;
        for (double value : SPECIAL) {
            sameBits(previous, column.set(0, value));
            sameBits(value, column.getDouble(0));
            sameBits(value, column.get(0));
            previous = value;
        }
        column.setDouble(0, -0.0);
        DataBranch.DoubleColumn copy = column.copy();
        copy.setDouble(0, 10);
        column.setDouble(1, 20);
        sameBits(-0.0, column.getDouble(0));
        sameBits(Double.MIN_VALUE, copy.getDouble(1));
        // A copied empty column must also be able to grow from capacity zero.
        DataBranch.DoubleColumn emptyCopy = new DataBranch.DoubleColumn().copy();
        emptyCopy.addDouble(7);
        sameBits(7, emptyCopy.getDouble(0));
    }

    @Test void fullCapacityCopiesAndCloneOfCloneAreIndependentBothWays() {
        for (int capacity : new int[] { 8, 16, 32 }) {
            DataBranch.DoubleColumn column = new DataBranch.DoubleColumn();
            double[] values = new double[capacity];
            for (int i = 0; i < capacity; i++) {
                values[i] = i + 0.1;
                column.addDouble(values[i]);
            }
            DataBranch.DoubleColumn copy = column.copy();
            DataBranch.DoubleColumn copyOfCopy = copy.copy();
            column.setDouble(0, -1);
            sameBits(values[0], copy.getDouble(0));
            copy.setDouble(1, -2);
            sameBits(values[1], column.getDouble(1));
            sameBits(values[1], copyOfCopy.getDouble(1));
            copyOfCopy.setDouble(2, -3);
            sameBits(values[2], copy.getDouble(2));

            FlightDataBranch parent = samples(values);
            FlightDataBranch clone = parent.clone();
            FlightDataBranch cloneOfClone = clone.clone();
            double[] snapshot = parent.getValuesCopy(ALT);
            double[] cloneSnapshot = clone.getValuesCopy(ALT);
            snapshot[0] = -4;
            sameBits(values[0], parent.getByIndex(ALT, 0));
            parent.setValue(ALT, -5);
            sameBits(values[capacity - 1], snapshot[capacity - 1]);
            sameBits(values[capacity - 1], clone.getLast(ALT));
            clone.setValue(ALT, -6);
            sameBits(-5, parent.getLast(ALT));
            sameBits(values[capacity - 1], cloneOfClone.getLast(ALT));
            sameBits(values[capacity - 1], cloneSnapshot[capacity - 1]);
            cloneSnapshot[0] = -7;
            sameBits(values[0], clone.getByIndex(ALT, 0));
            cloneOfClone.setValue(ALT, -8);
            sameBits(-6, clone.getLast(ALT));
        }
    }

    @Test void columnChecksLogicalBoundsEvenInsideSpareCapacity() {
        DataBranch.DoubleColumn column = new DataBranch.DoubleColumn();
        assertThrows(IndexOutOfBoundsException.class, () -> column.getDouble(0));
        column.addDouble(1);
        for (int index : new int[] { -1, 1, 7 }) {
            assertThrows(IndexOutOfBoundsException.class, () -> column.get(index));
            assertThrows(IndexOutOfBoundsException.class, () -> column.getDouble(index));
            assertThrows(IndexOutOfBoundsException.class, () -> column.set(index, 2.0));
            assertThrows(IndexOutOfBoundsException.class, () -> column.setDouble(index, 2));
        }
    }

    @Test void primitiveSnapshotIsExactLengthIndependentBothWaysAndNullWhenMissing() {
        FlightDataBranch branch = samples(1, 2);
        double[] copy = branch.getValuesCopy(ALT);
        List<Double> boxedCopy = branch.getClone(ALT);
        assertArrayEquals(new double[] { 1, 2 }, copy);
        copy[0] = 99;
        sameBits(1, branch.getByIndex(ALT, 0));
        branch.setValue(ALT, 3);
        branch.addPoint();
        assertArrayEquals(new double[] { 99, 2 }, copy);
        assertEquals(List.of(1.0, 2.0), boxedCopy);
        boxedCopy.remove(0);
        boxedCopy.add(0, 7.0);
        boxedCopy.clear();
        assertEquals(3, branch.getLength());
        sameBits(3, branch.getByIndex(ALT, 1));
        assertNull(branch.getValuesCopy(MISSING));
        assertEquals(0, new FlightDataBranch("empty", TIME).getValuesCopy(TIME).length);
    }

    @Test void branchBoundariesBackfillExtremaAndModIdKeepTheirSemantics() {
        FlightDataBranch branch = new FlightDataBranch("empty", TIME);
        assertEquals(0, branch.getLength());
        assertTrue(Double.isNaN(branch.getLast(TIME)));
        assertTrue(Double.isNaN(branch.getLast(MISSING)));
        assertNull(branch.get(MISSING));
        assertNull(branch.getClone(MISSING));
        assertThrows(IllegalArgumentException.class, () -> branch.getByIndex(TIME, 0));
        // Even a write without a row updates extrema and the modification ID.
        ModID before = branch.getModID();
        branch.setValue(ALT, 12);
        assertNotSame(before, branch.getModID());
        assertEquals(0, branch.getLength());
        sameBits(12, branch.getMinimum(ALT));
        sameBits(12, branch.getMaximum(ALT));
        before = branch.getModID();
        branch.addPoint();
        assertNotSame(before, branch.getModID());
        assertTrue(Double.isNaN(branch.getLast(ALT)));
        branch.addPoint();
        branch.addPoint();
        before = branch.getModID();
        branch.setValue(MISSING, -4);
        assertNotSame(before, branch.getModID());
        assertEquals(3, branch.getLength());
        assertTrue(Double.isNaN(branch.getByIndex(MISSING, 0)));
        assertTrue(Double.isNaN(branch.getByIndex(MISSING, 1)));
        sameBits(-4, branch.getByIndex(MISSING, 2));
        sameBits(-4, branch.getMinimum(MISSING));
        sameBits(-4, branch.getMaximum(MISSING));
        branch.setValue(MISSING, 8);
        branch.setValue(MISSING, Double.NaN);
        sameBits(-4, branch.getMinimum(MISSING));
        sameBits(8, branch.getMaximum(MISSING));
        assertTrue(Double.isNaN(branch.getLast(MISSING)));
        assertNull(branch.getByIndex(FlightDataType.TYPE_MASS, 1));
        assertThrows(IllegalArgumentException.class, () -> branch.getByIndex(TIME, -1));
        assertThrows(IllegalArgumentException.class, () -> branch.getByIndex(TIME, 3));
        assertThrows(IllegalArgumentException.class, () -> branch.getByIndex(FlightDataType.TYPE_MASS, 3));
        FlightDataBranch noTypes = new FlightDataBranch("child", null, null);
        assertEquals(0, noTypes.getLength());
        assertTrue(Double.isNaN(noTypes.getLast(TIME)));
        DataBranch<FlightDataType> bare = new DataBranch<FlightDataType>("bare") { };
        assertEquals(0, bare.getLength());
    }

    @Test void clonedBranchOwnsColumnsExtremaAndEventListBothWays() {
        FlightDataBranch parent = samples(1, 2);
        FlightEvent launch = new FlightEvent(FlightEvent.Type.LAUNCH, 0);
        parent.addEvent(launch);
        parent.setTimeToOptimumAltitude(9);
        parent.setOptimumAltitude(100);
        parent.immute();
        FlightDataBranch clone = parent.clone();
        assertTrue(clone.isMutable()); // Existing FlightDataBranch.clone semantics.
        assertSame(parent.getModID(), clone.getModID());
        sameBits(1, clone.getMinimum(ALT));
        sameBits(2, clone.getMaximum(ALT));
        assertEquals(List.of(launch), clone.getEvents());
        sameBits(9, clone.getTimeToOptimumAltitude());
        sameBits(100, clone.getOptimumAltitude());
        clone.setValue(ALT, -5);
        clone.addPoint();
        clone.addEvent(new FlightEvent(FlightEvent.Type.APOGEE, 9));
        assertEquals(List.of(1.0, 2.0), parent.get(ALT));
        sameBits(1, parent.getMinimum(ALT));
        assertEquals(List.of(launch), parent.getEvents());
        FlightDataBranch mutableParent = samples(1, 2);
        FlightDataBranch second = mutableParent.clone();
        mutableParent.setValue(ALT, 8);
        mutableParent.addPoint();
        mutableParent.addEvent(launch);
        assertEquals(List.of(1.0, 2.0), second.get(ALT));
        sameBits(2, second.getMaximum(ALT));
        assertTrue(second.getEvents().isEmpty());
    }

    @Test void separationCopiesPointsRecomputesExtremaAndFiltersEventsExactlyAsBefore() {
        Rocket rocket = new Rocket();
        AxialStage stage = new AxialStage();
        AxialStage other = new AxialStage();
        BodyTube body = new BodyTube();
        rocket.addChild(stage);
        rocket.addChild(other);
        stage.addChild(body);
        FlightDataBranch parent = samples(-2, 5, Double.NaN);
        FlightEvent stageEvent = new FlightEvent(FlightEvent.Type.LAUNCH, 0, stage);
        FlightEvent childEvent = new FlightEvent(FlightEvent.Type.LIFTOFF, 1, body);
        parent.addEvent(stageEvent);
        parent.addEvent(childEvent);
        parent.addEvent(new FlightEvent(FlightEvent.Type.STAGE_SEPARATION, 2, stage));
        parent.addEvent(new FlightEvent(FlightEvent.Type.APOGEE, 3, other));
        parent.addEvent(new FlightEvent(FlightEvent.Type.GROUND_HIT, 4));
        FlightDataBranch child = new FlightDataBranch("child", stage, parent);
        assertEquals(parent.get(TIME), child.get(TIME));
        assertEquals(parent.get(ALT), child.get(ALT));
        sameBits(-2, child.getMinimum(ALT));
        sameBits(5, child.getMaximum(ALT));
        assertEquals(List.of(stageEvent, childEvent), child.getEvents());
        assertEquals(List.of(childEvent), new FlightDataBranch("body", body, parent).getEvents());
        assertTrue(new FlightDataBranch("rocket", rocket, parent).getEvents().isEmpty());
        assertTrue(Double.isNaN(child.getSeparationTime()));
        child.setValue(ALT, -9);
        sameBits(-2, parent.getMinimum(ALT));
        parent.setValue(ALT, 11);
        sameBits(5, child.getMaximum(ALT));
        assertTrue(new FlightDataBranch("no source", null, parent).getEvents().isEmpty());
        FlightDataBranch empty = new FlightDataBranch("no parent", stage, null);
        assertEquals(0, empty.getLength());
        assertTrue(Double.isNaN(empty.getMinimum(TIME)));
        // Separation replays per-point writes: overwritten historical extrema are not copied.
        FlightDataBranch overwritten = samples(3);
        overwritten.setValue(ALT, 2);
        FlightDataBranch replayed = new FlightDataBranch("replayed", stage, overwritten);
        sameBits(3, overwritten.getMaximum(ALT));
        sameBits(2, replayed.getMaximum(ALT));
    }

    @Test void primitiveSerializationMatchesThePreviousBoxedText() throws Exception {
        Method append = OrkEngine.class.getDeclaredMethod("appendSeries", StringBuilder.class, String.class, double[].class);
        append.setAccessible(true);
        double[] values = { Double.NaN, -0.0, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY,
                Double.MIN_VALUE, Double.MAX_VALUE, 0.125, 1e-30 };
        StringBuilder expected = new StringBuilder("\"x\":[");
        for (int i = 0; i < values.length; i++) {
            if (i > 0) expected.append(',');
            Double v = values[i];
            expected.append(v == null || v.isNaN() || v.isInfinite() ? "null" : v.toString());
        }
        expected.append(']');
        StringBuilder actual = new StringBuilder();
        append.invoke(null, actual, "x", values);
        assertEquals(expected.toString(), actual.toString());
        actual = new StringBuilder();
        append.invoke(null, actual, "missing", null);
        assertEquals("\"missing\":[]", actual.toString());
    }
}
