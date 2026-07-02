package java.awt.geom;

/**
 * SHIM for TeaVM (no java.awt in its classlib): minimal Line2D with
 * intersectsLine, semantics copied faithfully from OpenJDK's relativeCCW /
 * linesIntersect. Never loaded on the JVM (bootstrap class wins).
 */
public abstract class Line2D {

    public abstract double getX1();

    public abstract double getY1();

    public abstract double getX2();

    public abstract double getY2();

    public static int relativeCCW(double x1, double y1, double x2, double y2,
            double px, double py) {
        x2 -= x1;
        y2 -= y1;
        px -= x1;
        py -= y1;
        double ccw = px * y2 - py * x2;
        if (ccw == 0.0) {
            ccw = px * x2 + py * y2;
            if (ccw > 0.0) {
                px -= x2;
                py -= y2;
                ccw = px * x2 + py * y2;
                if (ccw < 0.0) {
                    ccw = 0.0;
                }
            }
        }
        return (ccw < 0.0) ? -1 : ((ccw > 0.0) ? 1 : 0);
    }

    public static boolean linesIntersect(double x1, double y1, double x2, double y2,
            double x3, double y3, double x4, double y4) {
        return ((relativeCCW(x1, y1, x2, y2, x3, y3)
                * relativeCCW(x1, y1, x2, y2, x4, y4) <= 0)
                && (relativeCCW(x3, y3, x4, y4, x1, y1)
                        * relativeCCW(x3, y3, x4, y4, x2, y2) <= 0));
    }

    public boolean intersectsLine(Line2D l) {
        return linesIntersect(l.getX1(), l.getY1(), l.getX2(), l.getY2(),
                getX1(), getY1(), getX2(), getY2());
    }

    public static class Double extends Line2D {
        public double x1;
        public double y1;
        public double x2;
        public double y2;

        public Double() {}

        public Double(double x1, double y1, double x2, double y2) {
            this.x1 = x1;
            this.y1 = y1;
            this.x2 = x2;
            this.y2 = y2;
        }

        public Double(Point2D p1, Point2D p2) {
            this(p1.getX(), p1.getY(), p2.getX(), p2.getY());
        }

        @Override
        public double getX1() {
            return x1;
        }

        @Override
        public double getY1() {
            return y1;
        }

        @Override
        public double getX2() {
            return x2;
        }

        @Override
        public double getY2() {
            return y2;
        }
    }
}
