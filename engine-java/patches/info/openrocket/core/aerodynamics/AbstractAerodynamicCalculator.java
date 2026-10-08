package info.openrocket.core.aerodynamics;

import java.util.Map;

import info.openrocket.core.logging.WarningSet;
import info.openrocket.core.rocketcomponent.FlightConfiguration;
import info.openrocket.core.rocketcomponent.RocketComponent;
import info.openrocket.core.util.MathUtil;
import info.openrocket.core.util.ModID;
import info.openrocket.core.util.Coordinate;

/**
 * An abstract aerodynamic calculator implementation, that offers basic
 * implementation
 * of some methods and methods for cache validation and purging.
 * 
 * @author Sampo Niskanen <sampo.niskanen@iki.fi>
 */

public abstract class AbstractAerodynamicCalculator implements AerodynamicCalculator {

	/** Number of divisions used when calculating worst CP. */
	public static final int DIVISIONS = 360;

	/**
	 * A <code>WarningSet</code> that can be used if <code>null</code> is passed
	 * to a calculation method.
	 */
	protected WarningSet ignoreWarningSet = new WarningSet();

	/** The aerodynamic modification ID of the latest rocket */
	private ModID rocketAeroModID = new ModID();
	private ModID rocketTreeModID = new ModID();

	/**
	 * PATCH (OR #3093, MMRocket Sim 2026-10-08; see patches/LEDGER.md): the angle of
	 * attack at which the fins are considered stalled, in RADIANS. A property of the
	 * calculator, independent of whatever it last evaluated: callers compare it with
	 * the AOA they actually hold (e.g. the recorded TYPE_AOA), never with the AOA of
	 * the calculator's most recent - possibly RK4 sub-step or diagnostic - call.
	 * Replaces 24.12's getStallMargin(), which returned (stall angle - last AOA).
	 *
	 * @return the stall angle in radians
	 */
	@Override
	public abstract double getStallAngle();

	//////////////// Aerodynamic calculators ////////////////

	@Override
	public abstract Coordinate getCP(FlightConfiguration configuration, FlightConditions conditions,
			WarningSet warnings);

	@Override
	public abstract Map<RocketComponent, AerodynamicForces> getForceAnalysis(FlightConfiguration configuration,
			FlightConditions conditions,
			WarningSet warnings);

	@Override
	public abstract AerodynamicForces getAerodynamicForces(FlightConfiguration configuration,
			FlightConditions conditions, WarningSet warnings);

	/*
	 * The worst theta angle is stored in conditions.
	 */
	@Override
	public Coordinate getWorstCP(FlightConfiguration configuration, FlightConditions conditions,
			WarningSet warnings) {
		FlightConditions cond = conditions.clone();
		Coordinate worst = new Coordinate(Double.MAX_VALUE);
		Coordinate cp;
		double theta = 0;
		// PATCH (decision 66(b)): above the force-consistent threshold a plane's
		// reported CP x may be undefined (NaN); such a plane is skipped, never
		// selected. Below it the derivative CP x is finite whenever its weight
		// is usable, so this explicit test changes nothing there.
		boolean found = false;

		for (int i = 0; i < DIVISIONS; i++) {
			cond.setTheta(2 * Math.PI * i / DIVISIONS);
			cp = getCP(configuration, cond, warnings);
			if ((cp.weight > MathUtil.EPSILON) && Double.isFinite(cp.x) && (cp.x < worst.x)) {
				worst = cp;
				theta = cond.getTheta();
				found = true;
			}
		}

		conditions.setTheta(theta);

		// PATCH (decision 66(b)): a HIGH-AOA query in which no roll plane supplies
		// a defined CP reports an undefined worst CP (NaN x and NaN weight), not
		// the Double.MAX_VALUE sentinel, which would read as a real position.
		// Low-angle queries keep the 24.12 sentinel contract unchanged (the
		// static-info adapter in OrkEngine relies on it). A mixture of defined
		// and undefined planes returns the most-forward DEFINED one; that does
		// not certify the undefined planes.
		if (!found && aboveForceConsistentAOA(conditions)) {
			return new Coordinate(Double.NaN, 0, 0, Double.NaN);
		}

		return worst;
	}

	/**
	 * PATCH (decision 66(b), MMRocket Sim 2026-10-08; see patches/LEDGER.md): the
	 * angle of attack ABOVE which the reported CP is the force-consistent
	 * x = d * Cm_normal / CN instead of the derivative (CNa-weighted) CP, in
	 * radians. At and below it every CP output is the 24.12 derivative CP.
	 * Deliberately not the 17.5 deg stall-warning angle.
	 */
	public static final double FORCE_CONSISTENT_CP_AOA = 20 * Math.PI / 180;

	/**
	 * PATCH (decision 66(b)): the dimensionless |CN| at or below which the
	 * force-consistent CP is undefined (reported as NaN x), never an infinite
	 * or clipped lever arm and never a silent derivative-CP fallback.
	 */
	public static final double FORCE_CONSISTENT_CN_CUTOFF = 1e-8;

	/** PATCH (decision 66(b)): finite AOA strictly above the threshold. */
	public static boolean aboveForceConsistentAOA(FlightConditions conditions) {
		double aoa = conditions.getAOA();
		return Double.isFinite(aoa) && aoa > FORCE_CONSISTENT_CP_AOA;
	}

	/**
	 * PATCH (decision 66(b)): the force-consistent CP from a normal-force-only,
	 * zero-rate evaluation whose Cm is about the rocket's reference origin (the
	 * tip): x = refLength * cmNormal / cn. Keeps the derivative CP's y, z and
	 * weight. Undefined (NaN x) when cn, cmNormal or refLength is unusable.
	 */
	public static Coordinate forceConsistentCP(Coordinate derivativeCP, double cn, double cmNormal,
			double refLength) {
		double x = Double.NaN;
		if (Double.isFinite(cn) && Math.abs(cn) > FORCE_CONSISTENT_CN_CUTOFF
				&& Double.isFinite(cmNormal) && Double.isFinite(refLength) && refLength > 0) {
			double candidate = cmNormal * refLength / cn;
			if (Double.isFinite(candidate))
				x = candidate;
		}
		return new Coordinate(x, derivativeCP.y, derivativeCP.z, derivativeCP.weight);
	}

	/**
	 * PATCH (decision 66(b)): a clone of the conditions with pitch, yaw and roll
	 * rates exactly zero, so the reported CP excludes every rate-dependent term.
	 * The caller's conditions are never modified.
	 */
	public static FlightConditions zeroRates(FlightConditions conditions) {
		FlightConditions c = conditions.clone();
		c.setPitchRate(0);
		c.setYawRate(0);
		c.setRollRate(0);
		return c;
	}

	/**
	 * Check the current cache consistency. This method must be called by all
	 * methods that may use any cached data before any other operations are
	 * performed. If the rocket has changed since the previous call to
	 * <code>checkCache()</code>, then {@link #voidAerodynamicCache()} is called.
	 * <p>
	 * This method performs the checking based on the rocket's modification IDs,
	 * so that these method may be called from listeners of the rocket itself.
	 * 
	 * @param configuration the configuration of the current call
	 */
	protected final void checkCache(FlightConfiguration configuration) {
		if (rocketAeroModID != configuration.getRocket().getAerodynamicModID() ||
				rocketTreeModID != configuration.getRocket().getTreeModID()) {
			// // vvvv DEVEL vvvv
			// log.error("Voiding the aerodynamic cache because modIDs changed...", new
			// BugException(" unsure why modID has changed..."));
			// // ^^^^ DEVEL ^^^^

			rocketAeroModID = configuration.getRocket().getAerodynamicModID();
			rocketTreeModID = configuration.getRocket().getTreeModID();
			voidAerodynamicCache();
		}
	}

	/**
	 * Void cached aerodynamic data. This method is called whenever a change occurs
	 * in
	 * the rocket structure that affects the aerodynamics of the rocket and when a
	 * new
	 * Rocket is set. This method must be overridden to void any cached data
	 * necessary. The method must call <code>super.voidAerodynamicCache()</code>
	 * during
	 * its execution.
	 */
	protected void voidAerodynamicCache() {
		// No-op
	}

}
