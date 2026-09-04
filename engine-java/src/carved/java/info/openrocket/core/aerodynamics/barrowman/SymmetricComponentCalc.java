package info.openrocket.core.aerodynamics.barrowman;

import static info.openrocket.core.models.atmosphere.AtmosphericConditions.GAMMA;
import static info.openrocket.core.util.MathUtil.pow2;
import info.openrocket.core.aerodynamics.AerodynamicForces;
import info.openrocket.core.aerodynamics.BarrowmanCalculator;
import info.openrocket.core.aerodynamics.FlightConditions;
import info.openrocket.core.logging.Warning;
import info.openrocket.core.logging.WarningSet;
import info.openrocket.core.rocketcomponent.BodyTube;
import info.openrocket.core.rocketcomponent.RocketComponent;
import info.openrocket.core.rocketcomponent.SymmetricComponent;
import info.openrocket.core.rocketcomponent.Transition;
import info.openrocket.core.util.BugException;
import info.openrocket.core.util.Coordinate;
import info.openrocket.core.util.LinearInterpolator;
import info.openrocket.core.util.MathUtil;
import info.openrocket.core.util.PolyInterpolator;
import info.openrocket.core.util.Transformation;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Calculates the aerodynamic properties of a <code>SymmetricComponent</code>.
 * <p>
 * CP and CNa are calculated by the Barrowman method extended to account for
 * body lift
 * by the method presented by Galejs. Supersonic CNa and CP are assumed to be
 * the
 * same as the subsonic values.
 * 
 * 
 * @author Sampo Niskanen <sampo.niskanen@iki.fi>
 */
public class SymmetricComponentCalc extends RocketComponentCalc {

	private final static Logger log = LoggerFactory.getLogger(SymmetricComponentCalc.class);

	public static final double BODY_LIFT_K = 1.1;

	private final double length;
	private final double foreRadius, aftRadius;
	private final double fineness;
	private final Transition.Shape shape;
	private final double param;
	private final double frontalArea;
	private final double fullVolume;
	private final double planformArea, planformCenter;
	private final double wetArea;
	private final double sinphi;

	/**
	 * PATCH (RASAero feature #1 Phase 1, see engine-java/patches/LEDGER.md):
	 * opt-in supersonic aerodynamics. When enabled, a NOSE component's CNa
	 * grows with Mach above M1 instead of staying frozen at the slender-body
	 * value: CNa(M) = CNa_slender * (1 + g*(min(M,5)-1)), with g per nose
	 * shape (0.10 conical, 0.07 ogive-class). The slopes are bracketed by
	 * exact Taylor-Maccoll cone / ogive theory (Sims NASA SP-3004 class
	 * values reach ~1.2-1.4x slender by M4-5) and calibrated against the
	 * ARCAS (TN D-4013/D-4014) and Basic Finner (DREV-TM-9703) CP/CNa
	 * anchors — see docs/research/validation-anchors-2026-08-03.md and
	 * validation/score.mjs. Transitions/boattails keep slender values (their
	 * supersonic behavior is Phase-2+ work). Default false ⇒ bit-identical.
	 */
	private boolean supersonicAero = false;
	/** True for a nose-type component (fore radius zero, i.e. the actual tip). */
	private boolean isNoseShape = false;

	/** PATCH (feature #1 Phase 1): enable the opt-in supersonic aero model. */
	public void setSupersonicAero(boolean enabled) {
		this.supersonicAero = enabled;
	}

	/**
	 * PATCH (C7): the subsonic nose-pressure floor below is gated the way every
	 * other extension in this kernel is gated - rogersKbf || supersonicAero, the
	 * 2026-08-27 ruling recorded in FinSetCalc's own comment. That keeps the
	 * `classic` model bit-identical to desktop 24.12 while still reaching the model
	 * the app actually ships, which defaults Rogers Kbf ON.
	 */
	private boolean rogersKbf = false;

	public void setRogersKbf(boolean enabled) {
		this.rogersKbf = enabled;
	}

	public SymmetricComponentCalc(RocketComponent c) {
		super(c);
		if (!(c instanceof SymmetricComponent)) {
			throw new IllegalArgumentException("Illegal component type " + c);
		}
		SymmetricComponent component = (SymmetricComponent) c;

		length = component.getLength();
		if (length > 0) {
			foreRadius = component.getForeRadius();
			aftRadius = component.getAftRadius();
		} else { // If length is zero, the component is a disk, i.e. a zero-length tube, so match
					// the fore and aft diameter
			final double componentMaxR = Math.max(component.getForeRadius(), component.getAftRadius());
			foreRadius = aftRadius = componentMaxR;
		}

		fineness = length / (2 * Math.abs(aftRadius - foreRadius));
		fullVolume = component.getFullVolume();
		planformArea = component.getComponentPlanformArea();
		planformCenter = component.getComponentPlanformCenter();

		wetArea = component.getComponentWetArea();

		// PATCH (feature #1 Phase 1): a nose is a symmetric component whose fore
		// radius is (essentially) zero — the supersonic CNa growth applies only
		// to it, never to mid-body transitions/boattails.
		isNoseShape = component.getForeRadius() < 1e-9
				&& component.getAftRadius() > component.getForeRadius();

		if (component instanceof BodyTube) {
			shape = null;
			param = 0;
			frontalArea = 0;
			sinphi = 0;
		} else if (component instanceof Transition) {
			shape = ((Transition) component).getShapeType();
			param = ((Transition) component).getShapeParameter();
			frontalArea = Math.abs(Math.PI * (foreRadius * foreRadius - aftRadius * aftRadius));

			double r = component.getRadius(0.99 * length);
			sinphi = (aftRadius - r) / MathUtil.hypot(aftRadius - r, 0.01 * length);
		} else {
			throw new UnsupportedOperationException("Unknown component type " +
					component.getComponentName());
		}
	}

	private boolean isTube = false;
	private double cnaCache = Double.NaN;
	private double cpCache = Double.NaN;

	/**
	 * Calculates the non-axial forces produced by the fins (normal and side forces,
	 * pitch, yaw and roll moments, CP position, CNa).
	 * <p>
	 * This method uses the Barrowman method for CP and CNa calculation and the
	 * extension presented by Galejs for the effect of body lift.
	 * <p>
	 * The CP and CNa at supersonic speeds are assumed to be the same as those at
	 * subsonic speeds.
	 */
	@Override
	public void calculateNonaxialForces(FlightConditions conditions, Transformation transform,
			AerodynamicForces forces, WarningSet warnings) {

		// Pre-calculate and store the results
		if (Double.isNaN(cnaCache)) {
			final double r0 = foreRadius;
			final double r1 = aftRadius;

			if (MathUtil.equals(r0, r1)) {
				isTube = true;
				cnaCache = 0;
			} else {
				isTube = false;

				final double A0 = Math.PI * pow2(r0);
				final double A1 = Math.PI * pow2(r1);

				cnaCache = 2 * (A1 - A0);
				// System.out.println("cnaCache = " + cnaCache);
				cpCache = (length * A1 - fullVolume) / (A1 - A0);
			}
		}

		Coordinate cp;

		// PATCH (feature #1 Phase 1): opt-in supersonic nose CNa growth — the
		// classic kernel freezes body CNa/CP at the slender-body (Mach-1) value
		// forever. See the field javadoc for the model and its calibration.
		double cnaEff = cnaCache;
		if (supersonicAero && !isTube && isNoseShape) {
			double m = conditions.getMach();
			if (m > 1) {
				double g = (shape == Transition.Shape.CONICAL) ? 0.10 : 0.07;
				cnaEff = cnaCache * (1 + g * (Math.min(m, 5) - 1));
			}
		}

		// If fore == aft, only body lift is encountered
		if (isTube) {
			cp = getLiftCP(conditions, warnings);
		} else {
			cp = new Coordinate(cpCache, 0, 0, cnaEff * conditions.getSincAOA() /
					conditions.getRefArea()).average(getLiftCP(conditions, warnings));
		}

		forces.setCP(cp);
		forces.setCN(forces.getCP().weight * conditions.getAOA());
		forces.setCm(forces.getCN() * cp.x / conditions.getRefLength());
		forces.setCroll(0);
		forces.setCrollDamp(0);
		forces.setCrollForce(0);
		forces.setCside(0);
		forces.setCyaw(0);

		// Add warning on supersonic flight
		if (conditions.getMach() > 1.1) {
			warnings.add(Warning.SUPERSONIC);
		}

	}

	/**
	 * Calculate the body lift effect according to Galejs.
	 */
	protected Coordinate getLiftCP(FlightConditions conditions, WarningSet warnings) {

		/*
		 * Without this extra multiplier the rocket may become unstable at apogee
		 * when turning around, and begin oscillating horizontally. During the flight
		 * of the rocket this has no effect. It is effective only when AOA > 45 deg
		 * and the velocity is less than 15 m/s.
		 * 
		 * TODO: MEDIUM: This causes an anomaly to the flight results with the CP
		 * jumping at apogee
		 */
		double mul = 1;
		if ((conditions.getMach() < 0.05) && (conditions.getAOA() > Math.PI / 4)) {
			mul = pow2(conditions.getMach() / 0.05);
		}

		return new Coordinate(planformCenter, 0, 0, mul * BODY_LIFT_K * planformArea / conditions.getRefArea() *
				conditions.getSinAOA() * conditions.getSincAOA()); // sin(aoa)^2 / aoa
	}

	@Override
	public double calculateFrictionCD(FlightConditions conditions, double componentCf, WarningSet warningSet) {
		return componentCf * wetArea / conditions.getRefArea();
	}

	private LinearInterpolator interpolator = null;
	/** PATCH (feature #1 Phase 2): conical/ogive noses have an analytic branch
	 * that can be evaluated beyond the interpolator's sampled range. */
	private boolean analyticNose = false;
	private double analyticMul = 1.0;
	/** PATCH (feature #1 Phase 5): tangent/secant-ogive NOSE wave drag from the
	 * Fleeman correlation instead of the collapsed sinphi-driven branch. */
	private boolean fleemanNose = false;
	private double fleemanN = 0;

	@Override
	public double calculatePressureCD(FlightConditions conditions,
			double stagnationCD, double baseCD, WarningSet warnings) {

		// Check for simple cases first
		if (MathUtil.equals(foreRadius, aftRadius))
			return 0;

		if (length < 0.001) {
			if (foreRadius < aftRadius) {
				return stagnationCD * frontalArea / conditions.getRefArea();
			} else {
				return baseCD * frontalArea / conditions.getRefArea();
			}
		}

		// Boattail drag computed directly from base drag
		if (aftRadius < foreRadius) {
			double cdSub;
			if (fineness >= 3) {
				cdSub = 0;
			} else {
				cdSub = baseCD * frontalArea / conditions.getRefArea();
				if (fineness > 1) {
					cdSub *= (3 - fineness) / 2;
				}
			}
			// PATCH (feature #1 Phase 2): the classic model has NO Mach dependence
			// for boattails/reducers — the base-scaled subsonic estimate is used at
			// every speed. Flag on: supersonic wave drag on the expansion surface
			// (RASAero's "Other Body Wave Drag" bucket).
			//
			// PATCH (feature #1 Phase 5): SHAPE + LEVEL fix. Phase 2 blended
			// LINEARLY from the subsonic estimate at M0.8 up to the linearized
			// 2*theta/beta value at M1.5, which put a FALSE PEAK at exactly
			// M1.500 — measured on the ARCAS Long fixture, the boat-tail row
			// climbed to its maximum there (0.3768) and made the total-CD curve
			// double-peaked with the false peak as the global maximum. Real
			// boat-tail drag peaks just above M1 and decays. Phase 5:
			//   M <= 0.90        classic base-scaled estimate (drag divergence M_D)
			//   0.90 -> 1.05     smoothstep rise to the peak
			//   1.05 -> 1.20     plateau at the peak (tunnel band is near-flat)
			//   M >= 1.20        EXACT Prandtl-Meyer expansion Cp, monotone
			//                    decreasing in M, vacuum-limited hypersonically
			// The linearized 2*theta/beta strip value also ran OVER the exact
			// Prandtl-Meyer result by a Mach-dependent factor (measured for the
			// ARCAS 15 deg turn: exact/linear 0.66 at M1.2, 0.73 at M1.8, 0.50
			// at M4.65), so Phase 5 evaluates the expansion exactly instead.
			double machB = conditions.getMach();
			if (!supersonicAero || machB <= BT_ONSET_MACH) {
				return cdSub;
			}
			// Steeper than ~20 deg the boat tail separates and behaves base-like
			// (Hoerner FDD Ch VI/XVI) — clamp rather than extrapolate PM theory.
			double theta = Math.min(Math.atan2(foreRadius - aftRadius, length), 0.349);
			double frontalRatio = frontalArea / conditions.getRefArea();
			double cdPeak = pmExpansionCp(BT_TRUST_MACH, theta) * frontalRatio;
			if (machB >= BT_TRUST_MACH) {
				return pmExpansionCp(machB, theta) * frontalRatio;
			}
			if (machB >= BT_PLATEAU_MACH) {
				return cdPeak;
			}
			double t = (machB - BT_ONSET_MACH) / (BT_PLATEAU_MACH - BT_ONSET_MACH);
			double s = t * t * (3 - 2 * t);
			return cdSub * (1 - s) + cdPeak * s;
		}

		// All nose cones and shoulders from pre-calculated and interpolating
		if (interpolator == null) {
			calculateNoseInterpolator();
		}

		// PATCH (feature #1 Phase 2): the interpolators clamp FLAT beyond their
		// last data point (M2-4 depending on shape) — wave drag never decays.
		// Flag on: conical/ogive noses continue on their own analytic branch
		// (2.1*sinphi^2 + 0.5*sinphi/beta, which has the physical 1/beta decay
		// and the correct high-M asymptote); table shapes decay with the
		// Fleeman/Bonney correlation Mach shape (1.59 + 1.83/M^2).
		double mach = conditions.getMach();
		double cd;
		if (supersonicAero && mach > interpolatorMaxMach()) {
			double mEnd = interpolatorMaxMach();
			if (fleemanNose) {
				// PATCH (feature #1 Phase 5): Fleeman ogive nose wave drag,
				// CD_wave = (1.59 + 1.83/M^2)*(atan(0.5/(l_N/d)))^1.69 referenced
				// to base area. The 1.59 floor IS the hypersonic asymptote, so
				// this needs no Phase-4 style fade.
				cd = (1.59 + 1.83 / (mach * mach)) * fleemanN;
			} else if (analyticNose) {
				// PATCH (feature #1 Phase 4): the 2.1*sinphi^2 asymptote is a
				// transonic-range calibration; exact cone solutions and modified
				// Newtonian theory (Cp_max*sin^2) sit lower at hypersonic Mach.
				// Fade the coefficient from 2.1 to Cp_max(M) over M4-8.
				double coeff = 2.1;
				double t = MathUtil.clamp((mach - 4) / 4, 0, 1);
				if (t > 0) {
					coeff = 2.1 * (1 - t) + stagnationCpMax(mach) * t;
				}
				cd = analyticMul * (coeff * pow2(sinphi) +
						0.5 * sinphi / MathUtil.safeSqrt(mach * mach - 1));
			} else {
				cd = interpolator.getValue(mEnd) *
						(1.59 + 1.83 / (mach * mach)) / (1.59 + 1.83 / (mEnd * mEnd));
			}
		} else {
			cd = interpolator.getValue(mach);
		}
		return cd * frontalArea / conditions.getRefArea();
	}

	/**
	 * PATCH (feature #1 Phase 4): stagnation pressure coefficient behind a
	 * normal shock (Rayleigh pitot, NACA Report 1135 Eq. 100) — the modified-
	 * Newtonian Cp_max. Limit 1.839 as M → infinity (gamma = 1.4).
	 */
	private static double stagnationCpMax(double m) {
		double m2 = m * m;
		double a = Math.pow((GAMMA + 1) * (GAMMA + 1) * m2
				/ (4 * GAMMA * m2 - 2 * (GAMMA - 1)), GAMMA / (GAMMA - 1));
		double b = (1 - GAMMA + 2 * GAMMA * m2) / (GAMMA + 1);
		return (2 / (GAMMA * m2)) * (a * b - 1);
	}

	/** PATCH (feature #1 Phase 5): boat-tail wave-drag band edges. */
	private static final double BT_ONSET_MACH = 0.90;
	private static final double BT_PLATEAU_MACH = 1.05;
	private static final double BT_TRUST_MACH = 1.20;
	/** Prandtl-Meyer maximum turn angle for gamma = 1.4 (rad). */
	private static final double NU_MAX = (Math.sqrt(6) - 1) * Math.PI / 2;

	/**
	 * PATCH (feature #1 Phase 5): Prandtl-Meyer function nu(M) in radians
	 * (Anderson, Modern Compressible Flow Eq. 4.44), gamma = 1.4 via the
	 * (gamma+1)/(gamma-1) = 6 form.
	 */
	private static double prandtlMeyerNu(double m) {
		double b2 = m * m - 1;
		if (b2 <= 0) {
			return 0;
		}
		return Math.sqrt(6) * Math.atan(Math.sqrt(b2 / 6)) - Math.atan(Math.sqrt(b2));
	}

	/**
	 * PATCH (feature #1 Phase 5): magnitude of the pressure coefficient behind a
	 * Prandtl-Meyer expansion of angle theta from free-stream Mach m. Replaces
	 * the linearized strip value 2*theta/beta, which overstates the expansion by
	 * a Mach-dependent factor (25-50 % at M1.8-4.65 for a 15 deg turn).
	 * <p>
	 * The inverse nu(M2) = nu2 is solved by a FIXED-COUNT bisection (48 halvings
	 * of [m, 60], no epsilon test) so the JVM and TeaVM-JS execute exactly the
	 * same operation sequence — the same determinism discipline as kWB1307 and
	 * stagnationCpMax. Uses only Math.sqrt/atan/pow.
	 */
	private static double pmExpansionCp(double m, double theta) {
		if (m <= 1 || theta <= 0) {
			return 0;
		}
		double nu2 = prandtlMeyerNu(m) + theta;
		if (nu2 >= NU_MAX - 1e-6) {
			return 2 / (GAMMA * m * m); // vacuum limit: p2 -> 0
		}
		double lo = m;
		double hi = 60;
		for (int i = 0; i < 48; i++) {
			double mid = 0.5 * (lo + hi);
			if (prandtlMeyerNu(mid) < nu2) {
				lo = mid;
			} else {
				hi = mid;
			}
		}
		double m2 = 0.5 * (lo + hi);
		double c = (GAMMA - 1) / 2;
		double pressureRatio = Math.pow((1 + c * m * m) / (1 + c * m2 * m2),
				GAMMA / (GAMMA - 1));
		return (2 / (GAMMA * m * m)) * (1 - pressureRatio);
	}

	/** PATCH (feature #1 Phase 2): last Mach with real data in the interpolator. */
	private double interpolatorMaxMach() {
		double[] xs = interpolator.getXPoints();
		return xs[xs.length - 1];
	}

	/*
	 * Experimental values of pressure drag for different nose cone shapes with a
	 * fineness
	 * ratio of 3. The data is taken from 'Collection of Zero-Lift Drag Data on
	 * Bodies
	 * of Revolution from Free-Flight Investigations', NASA TR-R-100, NTRS
	 * 19630004995,
	 * page 16.
	 * 
	 * This data is extrapolated for other fineness ratios.
	 */

	private static final LinearInterpolator ellipsoidInterpolator = new LinearInterpolator(
			new double[] { 1.2, 1.25, 1.3, 1.4, 1.6, 2.0, 2.4 },
			new double[] { 0.110, 0.128, 0.140, 0.148, 0.152, 0.159, 0.162 /* constant */ });
	private static final LinearInterpolator x14Interpolator = new LinearInterpolator(
			new double[] { 1.2, 1.3, 1.4, 1.6, 1.8, 2.2, 2.6, 3.0, 3.6 },
			new double[] { 0.140, 0.156, 0.169, 0.192, 0.206, 0.227, 0.241, 0.249, 0.252 });
	private static final LinearInterpolator x12Interpolator = new LinearInterpolator(
			new double[] { 0.925, 0.95, 1.0, 1.05, 1.1, 1.2, 1.3, 1.7, 2.0 },
			new double[] { 0, 0.014, 0.050, 0.060, 0.059, 0.081, 0.084, 0.085, 0.078 });
	private static final LinearInterpolator x34Interpolator = new LinearInterpolator(
			new double[] { 0.8, 0.9, 1.0, 1.06, 1.2, 1.4, 1.6, 2.0, 2.8, 3.4 },
			new double[] { 0, 0.015, 0.078, 0.121, 0.110, 0.098, 0.090, 0.084, 0.078, 0.074 });
	private static final LinearInterpolator vonKarmanInterpolator = new LinearInterpolator(
			new double[] { 0.9, 0.95, 1.0, 1.05, 1.1, 1.2, 1.4, 1.6, 2.0, 3.0 },
			new double[] { 0, 0.010, 0.027, 0.055, 0.070, 0.081, 0.095, 0.097, 0.091, 0.083 });
	private static final LinearInterpolator lvHaackInterpolator = new LinearInterpolator(
			new double[] { 0.9, 0.95, 1.0, 1.05, 1.1, 1.2, 1.4, 1.6, 2.0 },
			new double[] { 0, 0.010, 0.024, 0.066, 0.084, 0.100, 0.114, 0.117, 0.113 });
	private static final LinearInterpolator parabolicInterpolator = new LinearInterpolator(
			new double[] { 0.95, 0.975, 1.0, 1.05, 1.1, 1.2, 1.4, 1.7 },
			new double[] { 0, 0.016, 0.041, 0.092, 0.109, 0.119, 0.113, 0.108 });
	private static final LinearInterpolator parabolic12Interpolator = new LinearInterpolator(
			new double[] { 0.8, 0.9, 0.95, 1.0, 1.05, 1.1, 1.3, 1.5, 1.8 },
			new double[] { 0, 0.016, 0.042, 0.100, 0.126, 0.125, 0.100, 0.090, 0.088 });
	private static final LinearInterpolator parabolic34Interpolator = new LinearInterpolator(
			new double[] { 0.9, 0.95, 1.0, 1.05, 1.1, 1.2, 1.4, 1.7 },
			new double[] { 0, 0.023, 0.073, 0.098, 0.107, 0.106, 0.089, 0.082 });
	private static final LinearInterpolator bluntInterpolator = new LinearInterpolator();
	static {
		for (double m = 0; m < 3; m += 0.05)
			bluntInterpolator.addPoint(m, BarrowmanCalculator.calculateStagnationCD(m));
	}

	/**
	 * Calculate the LinearInterpolator 'interpolator'. After this call, if can be
	 * used
	 * to get the pressure drag coefficient at any Mach number.
	 * 
	 * First, the transonic/supersonic region is computed. For conical and ogive
	 * shapes
	 * this is calculated directly. For other shapes, the values for fineness-ratio
	 * 3
	 * transitions are taken from the experimental values stored above (for
	 * parameterized
	 * shapes the values are interpolated between the parameter values). These are
	 * then
	 * extrapolated to the current fineness ratio.
	 * 
	 * Finally, if the first data points in the interpolator are not zero, the
	 * subsonic
	 * region is interpolated in the form Cd = a*M^b + Cd(M=0).
	 */
	@SuppressWarnings("null")
	private void calculateNoseInterpolator() {
		LinearInterpolator int1 = null, int2 = null;
		double p = 0;

		interpolator = new LinearInterpolator();

		/*
		 * Take into account nose cone shape. Conical and ogive generate the
		 * interpolator
		 * directly. Others store a interpolator for fineness ratio 3 into int1, or
		 * for parameterized shapes store the bounding fineness ratio 3 interpolators
		 * into
		 * int1 and int2 and set 0 <= p <= 1 according to the bounds.
		 */
		switch (shape) {
			case CONICAL:
				interpolator = calculateOgiveNoseInterpolator(0, sinphi); // param==0 -> conical
				analyticNose = true; // PATCH (feature #1 Phase 2)
				analyticMul = 0.72 * pow2(0 - 0.5) + 0.82;
				break;

			case OGIVE:
				// PATCH (feature #1 Phase 5): the classic ogive branch builds its
				// whole supersonic curve from `sinphi`, the surface slope over the
				// AFT 1 % of the shape (line ~116). For a TANGENT ogive that slope
				// is zero by definition, so the measured value is ~0.001 (0.00105
				// ARCAS, 0.00123 RM A53D02) and the nose wave drag collapses:
				// measured nose pressure CD 0.00031 at M2 on the ARCAS nose, and
				// the only supersonic nose pressure left is a SPURIOUS transonic
				// bump (0.058/0.075 at M1.05/1.10 falling to 0.0006 at M1.3) that
				// the fixed sonic slope 4/(GAMMA+1) drives through the M1-1.3
				// cubic between two near-zero endpoints. Flag on, for NOSE ogives
				// that are not cone-like: rebuild the same M1-1.3 bridge around
				// the Fleeman ogive wave-drag correlation instead, and continue on
				// it above M1.3 (calculatePressureCD). Conical noses, cone-like
				// secant ogives (param < 0.35, which route through the same
				// interpolator with a true cone slope) and every non-nose
				// transition keep the classic branch.
				if (supersonicAero && isNoseShape && param >= 0.35) {
					interpolator = calculateFleemanNoseInterpolator();
					break;
				}
				interpolator = calculateOgiveNoseInterpolator(param, sinphi);
				analyticNose = true; // PATCH (feature #1 Phase 2)
				analyticMul = 0.72 * pow2(param - 0.5) + 0.82;
				break;

			case ELLIPSOID:
				int1 = ellipsoidInterpolator;
				break;

			case POWER:
				if (param <= 0.25) {
					int1 = bluntInterpolator;
					int2 = x14Interpolator;
					p = param * 4;
				} else if (param <= 0.5) {
					int1 = x14Interpolator;
					int2 = x12Interpolator;
					p = (param - 0.25) * 4;
				} else if (param <= 0.75) {
					int1 = x12Interpolator;
					int2 = x34Interpolator;
					p = (param - 0.5) * 4;
				} else {
					int1 = x34Interpolator;
					int2 = calculateOgiveNoseInterpolator(0, 1 / MathUtil.safeSqrt(1 + 4 * pow2(fineness)));
					p = (param - 0.75) * 4;
				}
				break;

			case PARABOLIC:
				if (param <= 0.5) {
					int1 = calculateOgiveNoseInterpolator(0, 1 / MathUtil.safeSqrt(1 + 4 * pow2(fineness)));
					int2 = parabolic12Interpolator;
					p = param * 2;
				} else if (param <= 0.75) {
					int1 = parabolic12Interpolator;
					int2 = parabolic34Interpolator;
					p = (param - 0.5) * 4;
				} else {
					int1 = parabolic34Interpolator;
					int2 = parabolicInterpolator;
					p = (param - 0.75) * 4;
				}
				break;

			case HAACK:
				int1 = vonKarmanInterpolator;
				int2 = lvHaackInterpolator;
				p = param * 3;
				break;

			default:
				throw new UnsupportedOperationException("Unknown transition shape: " + shape);
		}

		if (p < 0 || p > 1.00001) {
			throw new BugException("Inconsistent parameter value p=" + p + " shape=" + shape);
		}

		// Check for parameterized shape and interpolate if necessary
		if (int2 != null) {
			LinearInterpolator int3 = new LinearInterpolator();
			for (double m : int1.getXPoints()) {
				int3.addPoint(m, p * int2.getValue(m) + (1 - p) * int1.getValue(m));
			}
			for (double m : int2.getXPoints()) {
				int3.addPoint(m, p * int2.getValue(m) + (1 - p) * int1.getValue(m));
			}
			int1 = int3;
		}

		// PATCH (C7): `int1 != null` is EXACTLY the four stored-table shapes -
		// ELLIPSOID, POWER, PARABOLIC, HAACK. CONICAL and OGIVE build `interpolator`
		// analytically above and never touch int1. That is the scope of the subsonic
		// floor at the foot of this method; see applyStubbyNoseFloor.
		final boolean tableShape = int1 != null;

		// Extrapolate for fineness ratio if necessary
		if (int1 != null) {
			double log4 = Math.log(fineness + 1) / Math.log(4);
			for (double m : int1.getXPoints()) {
				double stag = bluntInterpolator.getValue(m);
				// NOTE this extrapolation is MULTIPLICATIVE, so it maps a tabulated 0
				// to 0 at every fineness - it cannot lift a zero, which is why the
				// floor below is a separate step rather than a change here.
				interpolator.addPoint(m, stag * Math.pow(int1.getValue(m) / stag, log4));
			}
		}

		/*
		 * Now the transonic/supersonic region is ok. We still need to interpolate
		 * the subsonic region, if the values are non-zero.
		 */

		double min = interpolator.getXPoints()[0];
		double minValue = interpolator.getValue(min);

		double cdMach0 = 0.8 * pow2(sinphi);
		double minDeriv = (interpolator.getValue(min + 0.01) - minValue) / 0.01;

		// PATCH (C7): this WAS three separate `return`s - `minValue < 0.001` first,
		// then the two "should not occur" guards. The first of them is the defect:
		// every non-blunt stored table starts at its drag-divergence Mach with the
		// value 0, so the subsonic fit was skipped entirely, no subsonic point was
		// ever added, and LinearInterpolator then clamps flat to that leading 0.
		// Result: ZERO subsonic pressure drag for HAACK, PARABOLIC >= 0.5 and POWER
		// in [0.5, 0.75] at ANY fineness - which includes all three of those shapes'
		// own defaults. Guarding rather than returning lets the floor below still run.
		if (minValue >= 0.001 && cdMach0 < minValue - 0.01 && minDeriv > 0.01) {
			// Cd = a*M^b + cdMach0
			final double b = min * minDeriv / (minValue - cdMach0);
			final double a = (minValue - cdMach0) / Math.pow(min, b);

			for (double m = 0; m < min; m += 0.05) {
				interpolator.addPoint(m, a * Math.pow(m, b) + cdMach0);
			}
		}

		applyStubbyNoseFloor(interpolator, min, tableShape);
	}

	/**
	 * Fineness at and above which a nose's SHAPE stops mattering subsonically.
	 *
	 * Centuri TIR-100 section 8 (printed p. 49) - Mark Mercer's wind-tunnel series on
	 * a Centuri Javelin, one nose swapped at a time, whole-rocket Cd on body frontal
	 * area, L/D 4.0 down to 0 - measures NO significant variation across the standard
	 * catalogue nose shapes and says so in as many words. BC-70 at L/D 1.8 reads the
	 * same as the Javelin's own nose at L/D 4.0.
	 */
	private static final double STUBBY_NOSE_FINENESS_LIMIT = 1.8;

	/**
	 * A stubby ROUNDED nose's subsonic pressure drag, as a fraction of a CONE of the
	 * same fineness.
	 *
	 * Derived from the measured deltas rather than from theory. Mercer, at L/D 0.50:
	 * a hemisphere costs +0.10 (airfoil-fin series) or +0.02 (squared-fin series)
	 * where a 45-degree cone costs +0.21 / +0.10 - so a rounded stubby nose is
	 * 0.20-0.48 of a cone. But this file's own conical value at that fineness is
	 * 0.400, against the same tunnel's +0.21 / +0.10 for a real cone, so the conical
	 * branch is itself 1.9x-4x high at the blunt end. Rounded-as-a-fraction-of-OUR-
	 * cone is therefore 0.05-0.25 on the raw deltas. Those deltas are whole-rocket
	 * and each carries a friction CREDIT (a blunt nose has less wetted area than the
	 * long nose it replaced); adding it back moves the fraction to about 0.39, since
	 * the two shapes lose similar area and the ratio survives while both absolute
	 * figures rise. 1/3 sits inside that, and lands at 0.123 at L/D 0.5 - which is
	 * where @Buckeye's CFD independently puts a stubby nose (~27 % of a CD-0.5
	 * rocket). Erring high charges MORE drag and predicts LESS altitude, the safe
	 * direction.
	 *
	 * DeMar (NARAM-37) corroborates the blunt end independently: his half-sphere
	 * minus elliptical-2:1 is +0.07 / +0.03 / 0.00 across three speeds.
	 *
	 * WHY NOT THE NEWTONIAN 0.8*sin^2(phi) FLOOR, which was the obvious candidate:
	 * it would charge an ellipsoid at L/D 0.5 -> 0.421 and a Von Karman -> 0.270,
	 * three to four times the measured figure. Structurally it CANNOT be right here -
	 * a hemisphere and a flat face have the SAME 90-degree tip tangent and Newtonian
	 * charges both ~0.8, but they measure 0.02-0.10 and 0.6-0.95. The law is about
	 * CURVATURE, not tip angle, and nothing keyed on the tip angle can express that.
	 *
	 * CAVEATS, and they are not small: TIR-100 states no test velocity, no Reynolds
	 * number, no repeat count and no accuracy anywhere; its two fin series disagree
	 * by 30-45 % on every delta; and the same tunnel's launch-lug figure is the one
	 * Karbon's CFD and flight data put ~20x too high. This is a BRACKET on the
	 * endpoint and the shape of the law, never a calibrated curve. Everything between
	 * L/D 0.5 and 1.8 is interpolation, and Karbon p. 35 lists nose-shape CFD as work
	 * nobody has done.
	 */
	private static final double STUBBY_NOSE_ROUNDNESS = 1.0 / 3.0;

	/**
	 * Add a subsonic pressure-drag floor for a stubby STORED-TABLE nose.
	 *
	 * Applied as max(existing, floor) over the whole subsonic range INCLUDING the
	 * leading tabulated point itself - overriding that point matters, because
	 * otherwise a Von Karman at L/D 0.5 would sit at the floor up to its drag-
	 * divergence Mach, drop to the tabulated 0 there, and jump to 0.271 one step
	 * later.
	 *
	 * Scope is deliberately the FOUR STORED-TABLE shapes only (ELLIPSOID, POWER,
	 * PARABOLIC, HAACK), which is what `tableShape` means. CONICAL and OGIVE build
	 * their curve analytically: a cone's own cdMach0 is three times this floor so
	 * max() would ignore it anyway, but a stubby tangent OGIVE reads 0.005 today and
	 * WOULD be raised - and ogives are the commonest nose shape there is, so that
	 * belongs in its own item with its own evidence.
	 */
	private void applyStubbyNoseFloor(LinearInterpolator interpolator, double min, boolean tableShape) {
		if (!tableShape || !isNoseShape) {
			return;
		}
		if (!rogersKbf && !supersonicAero) {
			return;
		}
		if (!(fineness > 0) || fineness >= STUBBY_NOSE_FINENESS_LIMIT) {
			return;
		}
		// 0.8/(1+4f^2) IS this file's own conical Newtonian value: verified against
		// the shipped kernel's measured isolated-nose pressure Cd at fineness
		// 5 / 3 / 1 / 0.5 -> 0.007921 / 0.021623 / 0.161170 / 0.400935.
		double cone = 0.8 / (1 + 4 * fineness * fineness);
		double taper = 1 - pow2(fineness / STUBBY_NOSE_FINENESS_LIMIT);
		double floor = STUBBY_NOSE_ROUNDNESS * cone * taper;
		if (!(floor > 0)) {
			return;
		}
		for (double m = 0; m <= min + 1e-9; m += 0.05) {
			if (interpolator.getValue(m) < floor) {
				interpolator.addPoint(m, floor);
			}
		}
		if (interpolator.getValue(min) < floor) {
			interpolator.addPoint(min, floor);
		}
	}

	private static final PolyInterpolator conicalPolyInterpolator = new PolyInterpolator(new double[] { 1.0, 1.3 },
			new double[] { 1.0, 1.3 });

	private static LinearInterpolator calculateOgiveNoseInterpolator(double param,
			double sinphi) {
		LinearInterpolator interpolator = new LinearInterpolator();

		// In the range M = 1 ... 1.3 use polynomial approximation
		double cdMach1 = sinphi;
		double cdMach1_3 = 2.1 * pow2(sinphi) + 0.6019 * sinphi;

		double[] poly = conicalPolyInterpolator.interpolator(
				cdMach1, cdMach1_3,
				4 / (GAMMA + 1) * (1 - 0.5 * cdMach1), -1.1341 * sinphi);

		// Shape parameter multiplier
		double mul = 0.72 * pow2(param - 0.5) + 0.82;

		for (double m = 1; m < 1.3001; m += 0.02) {
			interpolator.addPoint(m, mul * PolyInterpolator.eval(m, poly));
		}

		// Above M = 1.3 use direct formula
		for (double m = 1.32; m < 4; m += 0.02) {
			interpolator.addPoint(m, mul * (2.1 * pow2(sinphi) + 0.5 * sinphi / MathUtil.safeSqrt(m * m - 1)));
		}

		return interpolator;
	}

	/**
	 * PATCH (feature #1 Phase 5): sonic-to-M1.3 bridge slope cap. The classic
	 * bridge pins the M1 derivative at the transonic-similarity value
	 * 4/(GAMMA+1)*(1 - cd1/2) ~ 1.65, which for a streamlined nose (cd1 tiny)
	 * drives the cubic far above both endpoints. Cap it at a multiple of the
	 * mean M1->M1.3 slope so the transonic overshoot stays inside the TR R-100
	 * streamlined-nose family ratio (peak ~1.1-1.3x the M1.3 value).
	 */
	private static final double CAL_BRIDGE_SLOPE_CAP = 2.0;

	/**
	 * PATCH (feature #1 Phase 5): M1 - M1.3 bridge built around the Fleeman
	 * ogive wave-drag correlation, replacing the sinphi-driven ogive bridge for
	 * tangent/near-tangent nose ogives (see the OGIVE case). Sets
	 * fleemanNose/fleemanN for the above-table branch.
	 * <p>
	 * Source: Fleeman, <i>Tactical Missile Design</i> (AIAA Education Series) —
	 * CD_wave = (1.59 + 1.83/M^2)*(atan(0.5/(l_N/d)))^1.69, base-area
	 * referenced, ogive family, M >~ 1.2. Same Fleeman/Bonney lineage the
	 * Phase-2 table-end decay already uses.
	 */
	private LinearInterpolator calculateFleemanNoseInterpolator() {
		double fn = length / (2 * aftRadius);
		double mul = 0.72 * pow2(param - 0.5) + 0.82;
		fleemanNose = true;
		fleemanN = Math.pow(Math.atan(0.5 / fn), 1.69) * mul;

		double cdMach1_3 = (1.59 + 1.83 / (1.3 * 1.3)) * fleemanN;
		// Sonic/M1.3 ratio 0.30, the mean of this file's own TR R-100 tables for
		// the fully STREAMLINED nose family, read at M1.0 vs M1.3: von Karman
		// 0.027/0.088 = 0.31, LV-Haack 0.024/0.107 = 0.22, parabolic
		// 0.041/0.116 = 0.35. (The blunter parabolic-1/2 and -3/4 tables sit far
		// higher, 0.75-1.0, and are not this family.)
		double cdMach1 = 0.30 * cdMach1_3;

		double d1 = Math.min(4 / (GAMMA + 1) * (1 - 0.5 * cdMach1),
				CAL_BRIDGE_SLOPE_CAP * (cdMach1_3 - cdMach1) / 0.3);
		double d2 = -2 * 1.83 / (1.3 * 1.3 * 1.3) * fleemanN;

		double[] poly = conicalPolyInterpolator.interpolator(cdMach1, cdMach1_3, d1, d2);
		LinearInterpolator interp = new LinearInterpolator();
		for (double m = 1; m < 1.3001; m += 0.02) {
			interp.addPoint(m, PolyInterpolator.eval(m, poly));
		}
		return interp;
	}

}
