package info.openrocket.core.simulation;

import static org.junit.jupiter.api.Assertions.*;

import java.util.List;

import org.junit.jupiter.api.Test;

/**
 * OR #2909 (PR #2909, KPERF 2026-10-11): DataBranch.get returns an unmodifiable
 * view backed by the branch, and getClone returns an independent copy. The view
 * replaced a whole-column clone on every read; every reader in the kernel and
 * the bridge only reads, so the serialized flight output is unchanged.
 */
class DataBranchViewTest {

    private static FlightDataBranch twoPoints() {
        FlightDataBranch b = new FlightDataBranch("test", FlightDataType.TYPE_TIME, FlightDataType.TYPE_ALTITUDE);
        b.addPoint();
        b.setValue(FlightDataType.TYPE_TIME, 0.1);
        b.setValue(FlightDataType.TYPE_ALTITUDE, 1.0);
        b.addPoint();
        b.setValue(FlightDataType.TYPE_TIME, 0.2);
        b.setValue(FlightDataType.TYPE_ALTITUDE, 2.0);
        return b;
    }

    @Test void getIsALiveViewThatFollowsLaterAppends() {
        FlightDataBranch b = twoPoints();
        List<Double> view = b.get(FlightDataType.TYPE_TIME);
        assertEquals(List.of(0.1, 0.2), view);
        b.addPoint();
        b.setValue(FlightDataType.TYPE_TIME, 0.3);
        assertEquals(3, view.size(), "the view is backed by the branch, not a snapshot");
        assertEquals(0.3, view.get(2));
    }

    @Test void getRefusesEveryMutation() {
        FlightDataBranch b = twoPoints();
        List<Double> view = b.get(FlightDataType.TYPE_TIME);
        assertThrows(UnsupportedOperationException.class, () -> view.add(9.0));
        assertThrows(UnsupportedOperationException.class, () -> view.set(0, 9.0));
        assertThrows(UnsupportedOperationException.class, () -> view.remove(0));
        assertThrows(UnsupportedOperationException.class, view::clear);
        assertThrows(UnsupportedOperationException.class, () -> view.replaceAll(v -> v * 2));
        assertEquals(List.of(0.1, 0.2), b.get(FlightDataType.TYPE_TIME), "a refused write left the data alone");
    }

    @Test void aMissingTypeIsStillNullOnBothAccessors() {
        FlightDataBranch b = twoPoints();
        assertNull(b.get(FlightDataType.TYPE_VELOCITY_TOTAL));
        assertNull(b.getClone(FlightDataType.TYPE_VELOCITY_TOTAL));
    }

    @Test void getCloneIsAnIndependentMutableSnapshot() {
        FlightDataBranch b = twoPoints();
        List<Double> copy = b.getClone(FlightDataType.TYPE_ALTITUDE);
        copy.set(0, 99.0);
        copy.add(100.0);
        assertEquals(List.of(1.0, 2.0), b.get(FlightDataType.TYPE_ALTITUDE), "writing the clone never reaches the branch");
        b.addPoint();
        b.setValue(FlightDataType.TYPE_ALTITUDE, 3.0);
        assertEquals(List.of(99.0, 2.0, 100.0), copy, "a later append never reaches the clone");
    }

    @Test void anImmutedBranchStillServesTheView() {
        FlightDataBranch b = twoPoints();
        b.immute();
        assertEquals(List.of(1.0, 2.0), b.get(FlightDataType.TYPE_ALTITUDE));
        // getDataIndexOfTime reads through the view.
        assertEquals(-1, b.getDataIndexOfTime(10));
        assertEquals(1, b.getDataIndexOfTime(0.15));
    }

    @Test void aBranchCopyIsIndependentOfItsParentsView() {
        FlightDataBranch parent = twoPoints();
        List<Double> parentView = parent.get(FlightDataType.TYPE_TIME);
        FlightDataBranch child = new FlightDataBranch("child", null, parent);
        child.addPoint();
        child.setValue(FlightDataType.TYPE_TIME, 0.5);
        assertEquals(List.of(0.1, 0.2), parentView, "the child's appends never reach the parent");
        assertEquals(List.of(0.1, 0.2, 0.5), child.get(FlightDataType.TYPE_TIME));
        FlightDataBranch cloned = parent.clone();
        cloned.addPoint();
        assertEquals(2, parentView.size(), "clone() copies the columns, so the parent's view does not grow");
    }
}
