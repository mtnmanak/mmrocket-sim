package info.openrocket.core.simulation;

import static org.junit.jupiter.api.Assertions.*;

import org.junit.jupiter.api.Test;

import info.openrocket.core.util.Mutable;

class MutableTest {
    @Test void immuteKeepsTheExactMessageWithoutACause() {
        Mutable mutable = new Mutable();
        assertTrue(mutable.isMutable());
        assertDoesNotThrow(mutable::check);
        mutable.immute();
        assertFalse(mutable.isMutable());
        IllegalStateException error = assertThrows(IllegalStateException.class, mutable::check);
        assertEquals("Object has been made immutable at null", error.getMessage());
        assertNull(error.getCause());
    }

    @Test void cloneKeepsStateAndIsIndependent() {
        Mutable original = new Mutable();
        Mutable copy = original.clone();
        assertNotSame(original, copy);
        assertTrue(copy.isMutable());
        copy.immute();
        assertTrue(original.isMutable());
        original.immute();
        Mutable frozenCopy = original.clone();
        assertFalse(frozenCopy.isMutable());
        assertThrows(IllegalStateException.class, frozenCopy::check);
    }

    @Test void repeatedImmuteIsANoOp() {
        Mutable mutable = new Mutable();
        mutable.immute();
        assertDoesNotThrow(mutable::immute);
        assertFalse(mutable.isMutable());
        assertThrows(IllegalStateException.class, mutable::check);
        assertDoesNotThrow(mutable::immute);
        assertFalse(mutable.isMutable());
        IllegalStateException error = assertThrows(IllegalStateException.class, mutable::check);
        assertEquals("Object has been made immutable at null", error.getMessage());
        assertNull(error.getCause());
    }
}
