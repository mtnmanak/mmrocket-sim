package info.openrocket.core.masscalc;

import java.util.Collection;
import java.util.HashMap;
import java.util.Map;

import info.openrocket.core.motor.Motor;
import info.openrocket.core.rocketcomponent.FlightConfiguration;
import info.openrocket.core.simulation.MotorClusterState;
import info.openrocket.core.simulation.SimulationStatus;
import info.openrocket.core.util.MathUtil;
import info.openrocket.core.util.ModID;
import info.openrocket.core.util.Monitorable;
import info.openrocket.core.util.Transformation;
public class MassCalculator implements Monitorable {

	public static final double MIN_MASS = MathUtil.EPSILON;

	/*
	 * Cached data. All CG data is in absolute coordinates. All moments of inertia
	 * are relative to their respective CG.
	 */
	// private HashMap< Integer, MassData> stageMassCache = new HashMap<Integer,
	// MassData >();
	// private MassData rocketSpentMassCache;
	// private MassData motorMassCache;

	private final ModID modID = ModID.ZERO;

	////////////////// Constructors ///////////////////
	public MassCalculator() {
	}

	////////////////// Public Accessors ///////////////////

	/**
	 * Calculates mass data of the rocket's structure
	 * - includes structure
	 * - excludes motors
	 * - excludes propellant
	 * 
	 * @param config the rocket configuration to calculate for
	 * @return the MassData struct of the rocket
	 */
	public static RigidBody calculateStructure(final FlightConfiguration config) {
		// PERF PATCH — memoize. Upstream recomputes this on every call, and the
		// RK4 stepper calls it four times per accepted step (AbstractSimulation-
		// Stepper.calculateStructureMass, once per derivative evaluation), so a
		// 2,336-step LEM-IV flight walks the whole component tree 9,726 times for
		// an answer that cannot change: structure mass excludes motors and
		// propellant, and nothing mutates the rocket during a simulation.
		//
		// Upstream MEANT to cache this — the fields at the top of this class are
		// commented-out cache slots and `modID` below is dead. The memo lives on
		// FlightConfiguration so it is invalidated by the same fireChangeEvent()
		// that clears cachedBounds/cachedRefLength, and is dropped by its
		// clone()/copy(). Editor edits therefore invalidate it; a flight does not.
		//
		// Deliberately BELOW the simulation listener hooks: AbstractSimulation-
		// Stepper fires firePreMassCalculation/firePostMassCalculation around its
		// call to this method, so listeners still see every step.
		final RigidBody cached = config.getCachedStructureMass();
		if (cached != null) {
			return cached;
		}
		final RigidBody computed = calculate(MassCalculation.Type.STRUCTURE, config, Motor.PSEUDO_TIME_EMPTY);
		config.setCachedStructureMass(computed);
		return computed;
	}

	/**
	 * Calculates mass data of the rocket's burnout mass
	 * - includes structure
	 * - includes motors
	 * - for Black Powder & Composite motors, this generally *excludes* propellant
	 * 
	 * @param config the rocket configuration to calculate for
	 * @return the MassData struct of the rocket at burnout
	 */
	public static RigidBody calculateBurnout(final FlightConfiguration config) {
		return calculate(MassCalculation.Type.BURNOUT, config, Motor.PSEUDO_TIME_BURNOUT);
	}

	/**
	 * Calculates mass data of the rocket's motor(s) at launch
	 * - excludes structure
	 * - includes motors
	 * - includes propellant
	 * 
	 * @param config the rocket configuration to calculate for
	 * @return the MassData struct of the motors at launch
	 */
	public static RigidBody calculateMotor(final FlightConfiguration config) {
		return calculate(MassCalculation.Type.MOTOR, config, Motor.PSEUDO_TIME_LAUNCH);
	}

	/**
	 * Compute the rocket's launch mass properties, given a configuration
	 * - includes structure
	 * - includes motors
	 * - includes propellant
	 * 
	 * @param config the rocket configuration
	 * @return the MassData struct of the rocket at launch
	 */
	public static RigidBody calculateLaunch(final FlightConfiguration config) {
		return calculate(MassCalculation.Type.LAUNCH, config, Motor.PSEUDO_TIME_LAUNCH);
	}

	/**
	 * calculates the massdata for all motors in the rocket given the simulation
	 * status.
	 * - excludes structure
	 * - includes motors
	 * - includes propellant
	 * 
	 * @param status CurrentSimulation status to calculate data with
	 * @return combined mass data for all propellant
	 */
	public static RigidBody calculateMotor(final SimulationStatus status) {
		return calculate(MassCalculation.Type.MOTOR, status);
	}

	////////////////// Mass property Wrappers ///////////////////
	// all mass calculation calls should probably call through one of these two
	////////////////// wrappers.

	// convenience wrapper -- use this to implicitly create a plain MassCalculation
	// object with common parameters,
	// for calculations in the course of a simulation
	public static RigidBody calculate(final MassCalculation.Type _type, final SimulationStatus status) {
		final FlightConfiguration config = status.getConfiguration();
		final double time = status.getSimulationTime();
		final Collection<MotorClusterState> activeMotorList = status.getActiveMotors();
		MassCalculation calculation = new MassCalculation(_type, config, time, activeMotorList, config.getRocket(),
				Transformation.IDENTITY, null);

		calculation.calculateAssembly();
		RigidBody result = calculation.calculateMomentOfInertia();
		return result;
	}

	// convenience wrapper -- use this to implicitly create a plain MassCalculation
	// object with common parameters,
	// for static mass calculations
	public static RigidBody calculate(final MassCalculation.Type _type, final FlightConfiguration _config,
			double _time) {
		MassCalculation calculation = new MassCalculation(_type, _config, _time, null, _config.getRocket(),
				Transformation.IDENTITY, null);
		calculation.calculateAssembly();
		return calculation.calculateMomentOfInertia();
	}

	/**
	 * Compute an analysis of the per-component CG's of the provided configuration.
	 * The returned map will contain an entry for each physical rocket component
	 * (not stages)
	 * with its corresponding (best-effort) CG. Overriding of subcomponents is
	 * ignored.
	 * The CG of the entire configuration with motors is stored in the entry with
	 * the corresponding
	 * Rocket as the key.
	 *
	 * Deprecated:
	 * This function is fundamentally broken, because it asks for a calculation
	 * which ignores instancing.
	 * This function will work with simple rockets, but will be misleading or
	 * downright wrong for others.
	 *
	 * This is a problem with using a single-typed map:
	 * [1] multiple instances of components are not allowed, and must be merged.
	 * [2] propellant / motor data does not have a corresponding RocketComponent.
	 * ( or mount-data collides with motor-data )
	 *
	 * @return a list of CG coordinates for every instance of this component
	 */
	public static Map<Integer, CMAnalysisEntry> getCMAnalysis(FlightConfiguration config) {

		Map<Integer, CMAnalysisEntry> analysisMap = new HashMap<>();

		MassCalculation calculation = new MassCalculation(
				MassCalculation.Type.LAUNCH,
				config,
				Motor.PSEUDO_TIME_LAUNCH,
				null,
				config.getRocket(),
				Transformation.IDENTITY,
				analysisMap);

		calculation.calculateAssembly();

		CMAnalysisEntry totals = new CMAnalysisEntry(config.getRocket());
		totals.totalCM = calculation.centerOfMass;
		totals.eachMass = calculation.centerOfMass.weight;
		analysisMap.put(config.getRocket().hashCode(), totals);

		return analysisMap;
	}

	////////////////// Mass property calculations ///////////////////
	@Override
	public ModID getModID() {
		return modID;
	}

}
