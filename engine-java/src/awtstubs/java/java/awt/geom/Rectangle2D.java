package java.awt.geom;

/**
 * SHIM for TeaVM (no java.awt in its classlib): minimal Rectangle2D surface
 * used by the carved kernel (BoundingBox). Never loaded on the JVM.
 */
public abstract class Rectangle2D {

    public abstract double getX();

    public abstract double getY();

    public abstract double getWidth();

    public abstract double getHeight();

    public double getMinX() {
        return getX();
    }

    public double getMinY() {
        return getY();
    }

    public double getMaxX() {
        return getX() + getWidth();
    }

    public double getMaxY() {
        return getY() + getHeight();
    }

    public static class Double extends Rectangle2D {
        public double x;
        public double y;
        public double width;
        public double height;

        public Double() {}

        public Double(double x, double y, double w, double h) {
            this.x = x;
            this.y = y;
            this.width = w;
            this.height = h;
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
        public double getWidth() {
            return width;
        }

        @Override
        public double getHeight() {
            return height;
        }

        @Override
        public String toString() {
            return "Rectangle2D.Double[" + x + ", " + y + ", " + width + ", " + height + "]";
        }
    }
}
