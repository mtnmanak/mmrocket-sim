package java.awt.geom;

/**
 * SHIM for TeaVM (whose classlib has no java.awt): the minimal Point2D
 * surface the carved kernel uses. On the JVM the bootstrap loader's real
 * class wins and this copy is never loaded — it exists for the TeaVM
 * transpile only. Semantics mirror OpenJDK exactly.
 */
public abstract class Point2D {

    public abstract double getX();

    public abstract double getY();

    public abstract void setLocation(double x, double y);

    public static double distanceSq(double x1, double y1, double x2, double y2) {
        x1 -= x2;
        y1 -= y2;
        return (x1 * x1 + y1 * y1);
    }

    public static double distance(double x1, double y1, double x2, double y2) {
        x1 -= x2;
        y1 -= y2;
        return Math.sqrt(x1 * x1 + y1 * y1);
    }

    public double distance(Point2D pt) {
        double px = pt.getX() - this.getX();
        double py = pt.getY() - this.getY();
        return Math.sqrt(px * px + py * py);
    }

    public static class Double extends Point2D {
        public double x;
        public double y;

        public Double() {}

        public Double(double x, double y) {
            this.x = x;
            this.y = y;
        }

        @Override
        public double getX() {
            return x;
        }

        @Override
        public double getY() {
            return y;
        }

        @Override
        public void setLocation(double x, double y) {
            this.x = x;
            this.y = y;
        }

        @Override
        public String toString() {
            return "Point2D.Double[" + x + ", " + y + "]";
        }
    }
}
