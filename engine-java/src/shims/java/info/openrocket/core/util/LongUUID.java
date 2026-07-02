package info.openrocket.core.util;

/**
 * SHIM: drop-in replacement for the java.util.UUID surface used by
 * FlightConfigurationId / MotorConfigurationId. TeaVM's UUID is string-backed
 * and lacks the (long, long) constructor, getMostSignificantBits and
 * compareTo, so those two carved files are patched to use this class (see
 * engine-java/patches/LEDGER.md).
 *
 * toString / hashCode / equals / compareTo reproduce java.util.UUID's
 * semantics EXACTLY (JDK algorithms), so any id string that leaks into
 * output or .ork files is indistinguishable from the original.
 *
 * randomUUID() is DETERMINISTIC (counter-based) by design: the engine needs
 * reproducible runs for differential testing, and this class is compiled
 * into both the JVM and TeaVM sides, so behavior is identical everywhere.
 */
public final class LongUUID implements Comparable<LongUUID> {

    private static long counter = 0x0123456789ABCDEFL;

    private final long mostSigBits;
    private final long leastSigBits;

    public LongUUID(long mostSigBits, long leastSigBits) {
        this.mostSigBits = mostSigBits;
        this.leastSigBits = leastSigBits;
    }

    /** Deterministic (counter-based) unique id — see class javadoc. */
    public static LongUUID randomUUID() {
        long a = counter++;
        long b = counter++;
        // Set version 4 / IETF variant bits like a real random UUID.
        long msb = (a & ~0xF000L) | 0x4000L;
        long lsb = (b & 0x3FFFFFFFFFFFFFFFL) | 0x8000000000000000L;
        return new LongUUID(msb, lsb);
    }

    /** JDK-compatible parse of the 8-4-4-4-12 form. */
    public static LongUUID fromString(String name) {
        String[] components = name.split("-");
        if (components.length != 5) {
            throw new IllegalArgumentException("Invalid UUID string: " + name);
        }
        long mostSigBits = Long.parseLong(components[0], 16);
        mostSigBits <<= 16;
        mostSigBits |= Long.parseLong(components[1], 16);
        mostSigBits <<= 16;
        mostSigBits |= Long.parseLong(components[2], 16);
        long leastSigBits = Long.parseLong(components[3], 16);
        leastSigBits <<= 48;
        leastSigBits |= Long.parseLong(components[4], 16);
        return new LongUUID(mostSigBits, leastSigBits);
    }

    public long getMostSignificantBits() {
        return mostSigBits;
    }

    public long getLeastSignificantBits() {
        return leastSigBits;
    }

    /** JDK UUID.toString algorithm. */
    @Override
    public String toString() {
        return (digits(mostSigBits >> 32, 8) + "-"
                + digits(mostSigBits >> 16, 4) + "-"
                + digits(mostSigBits, 4) + "-"
                + digits(leastSigBits >> 48, 4) + "-"
                + digits(leastSigBits, 12));
    }

    private static String digits(long val, int digits) {
        long hi = 1L << (digits * 4);
        return Long.toHexString(hi | (val & (hi - 1))).substring(1);
    }

    /** JDK UUID.hashCode algorithm. */
    @Override
    public int hashCode() {
        long hilo = mostSigBits ^ leastSigBits;
        return ((int) (hilo >> 32)) ^ (int) hilo;
    }

    @Override
    public boolean equals(Object obj) {
        if (!(obj instanceof LongUUID)) {
            return false;
        }
        LongUUID id = (LongUUID) obj;
        return (mostSigBits == id.mostSigBits && leastSigBits == id.leastSigBits);
    }

    /** JDK UUID.compareTo algorithm (signed long comparison, most then least). */
    @Override
    public int compareTo(LongUUID val) {
        return (this.mostSigBits < val.mostSigBits ? -1
                : (this.mostSigBits > val.mostSigBits ? 1
                        : (this.leastSigBits < val.leastSigBits ? -1
                                : (this.leastSigBits > val.leastSigBits ? 1 : 0))));
    }
}
