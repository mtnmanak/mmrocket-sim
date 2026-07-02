package java.text;

import java.util.Locale;

/**
 * SHIM for TeaVM (no java.text.Collator in its classlib). The kernel uses
 * Collator only to sort motor designations and names (never physics).
 * PRIMARY-strength comparison is approximated with case-insensitive string
 * comparison; ties broken case-sensitively for determinism. On the JVM the
 * real JDK class wins via parent delegation — this affects TeaVM only, and
 * any sort-order divergence would surface in differential tests.
 */
public abstract class Collator implements java.util.Comparator<Object> {

    public static final int PRIMARY = 0;
    public static final int SECONDARY = 1;
    public static final int TERTIARY = 2;
    public static final int IDENTICAL = 3;

    private static final Collator INSTANCE = new Collator() {
        @Override
        public int compare(String source, String target) {
            int c = source.compareToIgnoreCase(target);
            if (c != 0) {
                return c;
            }
            return source.compareTo(target);
        }
    };

    protected Collator() {}

    public static Collator getInstance() {
        return INSTANCE;
    }

    public static Collator getInstance(Locale desiredLocale) {
        return INSTANCE;
    }

    public abstract int compare(String source, String target);

    @Override
    public int compare(Object o1, Object o2) {
        return compare((String) o1, (String) o2);
    }

    public void setStrength(int newStrength) {
        // Strength is fixed at the case-insensitive approximation.
    }

    public boolean equals(String source, String target) {
        return (compare(source, target) == 0);
    }
}
