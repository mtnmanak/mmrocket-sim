package info.openrocket.core.simulation;

import java.util.Arrays;
import java.util.Collection;
import java.util.Random;

import info.openrocket.core.logging.SimulationAbort;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import info.openrocket.core.aerodynamics.AerodynamicCalculator; // PATCH (pressure thrust)
import info.openrocket.core.aerodynamics.BarrowmanCalculator; // PATCH (pressure thrust)
import info.openrocket.core.aerodynamics.FlightConditions;
import info.openrocket.core.logging.Warning;
import info.openrocket.core.logging.WarningSet;
import info.openrocket.core.l10n.Translator;
import info.openrocket.core.masscalc.RigidBody;
import info.openrocket.core.models.atmosphere.AtmosphericConditions;
import info.openrocket.core.rocketcomponent.AxialStage; // PATCH (pressure thrust)
import info.openrocket.core.rocketcomponent.RocketComponent; // PATCH (pressure thrust)
import info.openrocket.core.simulation.exception.SimulationCalculationException;
import info.openrocket.core.simulation.exception.SimulationException;
import info.openrocket.core.simulation.listeners.SimulationListenerHelper;
import info.openrocket.core.startup.Application;
import info.openrocket.core.util.Coordinate;
import info.openrocket.core.util.MathUtil;
import info.openrocket.core.util.Quaternion;
import info.openrocket.core.util.Rotation2D;
import info.openrocket.core.util.WorldCoordinate;

public class RK4SimulationStepper extends AbstractSimulationStepper {
	
	private static final Logger log = LoggerFactory.getLogger(RK4SimulationStepper.class);
	private static final Translator trans = Application.getTranslator();
	

	/** Random value with which to XOR the random seed value */
	private static final int SEED_RANDOMIZATION = 0x23E3A01F;
	

	/**
	 * A recommended reasonably accurate time step.
	 */
	public static final double RECOMMENDED_TIME_STEP = 0.05;

	/**
	 * A recommended reasonable maximum simulation time (in seconds).
	 */
	public static final double RECOMMENDED_MAX_TIME = 1200;
	
	/**
	 * A recommended maximum angle step value.
	 */
	public static final double RECOMMENDED_ANGLE_STEP = 3 * Math.PI / 180;
	
	/**
	 * A random amount that is added to pitch and yaw coefficients, plus or minus.
	 */
	public static final double PITCH_YAW_RANDOM = 0.0005;
	
	/**
	 * Maximum roll step allowed.  This is selected as an uneven division of the full
	 * circle so that the simulation will sample the most wind directions
	 */
	private static final double MAX_ROLL_STEP_ANGLE = 2 * 28.32 * Math.PI / 180;
	//	private static final double MAX_ROLL_STEP_ANGLE = 8.32 * Math.PI/180;
	
	private static final double MAX_ROLL_RATE_CHANGE = 2 * Math.PI / 180;
	private static final double MAX_PITCH_YAW_CHANGE = 4 * Math.PI / 180;
	
	private Random random;
	DataStore store = new DataStore();
	
	@Override
	public SimulationStatus initialize(SimulationStatus original) {
		
		SimulationStatus status = new SimulationStatus(original);
		// Copy the existing warnings
		status.setWarnings(original.getWarnings());
		
		SimulationConditions sim = original.getSimulationConditions();

		store.launchRodDirection = new Coordinate(
												  Math.sin(sim.getLaunchRodAngle()) * Math.cos(Math.PI / 2.0 - sim.getLaunchRodDirection()),
												  Math.sin(sim.getLaunchRodAngle()) * Math.sin(Math.PI / 2.0 - sim.getLaunchRodDirection()),
												  Math.cos(sim.getLaunchRodAngle()));

		this.random = new Random(original.getSimulationConditions().getRandomSeed() ^ SEED_RANDOMIZATION);
		
		return status;
	}
	
	


	@Override
	public void step(SimulationStatus status, double maxTimeStep) throws SimulationException {

		status.storeData();

		////////  Perform RK4 integration:  ////////
		
		SimulationStatus status2;
		RK4Parameters k1, k2, k3, k4;

		/*
		 * Get the current atmospheric conditions
		 */
		calculateFlightConditions(status, store);

		/*
		 * Perform RK4 integration.  Decide the time step length after the first step.
		 */

		//// First position, k1 = f(t, y)
		
		k1 = computeParameters(status, store);

		// If maxTimeStep is NaN we'll just record sim params and leave
		if (Double.isNaN(maxTimeStep)) {
			store.timeStep = maxTimeStep;
			store.storeData(status);

			landedValues(status, store);
			return;
		}
		
		/*
		 * Select the actual time step to use.  It is the minimum of the following:
		 *  dt[0]:  the user-specified time step (or 1/5th of it if still on the launch rod)
		 *  dt[1]:  the value of maxTimeStep
		 *  dt[2]:  the maximum pitch step angle limit
		 *  dt[3]:  the maximum roll step angle limit
		 *  dt[4]:  the maximum roll rate change limit
		 *  dt[5]:  the maximum pitch change limit
		 *  dt[6]:  1/10th of the launch rod length if still on the launch rod
		 *  dt[7]:  1.50 times the previous time step
		 * 
		 * The limits #5 and #6 are required since near the steady-state roll rate the roll rate
		 * may oscillate significantly even between the sub-steps of the RK4 integration.
		 * 
		 * The step is still at least 1/20th of the user-selected time step.
		 */
		double[] dt = new double[8];
		Arrays.fill(dt, Double.MAX_VALUE);

		// If the user selected a really small timestep, use MIN_TIME_STEP instead.
		dt[0] = MathUtil.max(status.getSimulationConditions().getTimeStep(), MIN_TIME_STEP);
		dt[1] = maxTimeStep;
		dt[2] = status.getSimulationConditions().getMaximumAngleStep() / store.lateralPitchRate;
		dt[3] = Math.abs(MAX_ROLL_STEP_ANGLE / store.flightConditions.getRollRate());
		dt[4] = Math.abs(MAX_ROLL_RATE_CHANGE / store.accelerationData.getRotationalAccelerationRC().z);
		dt[5] = Math.abs(MAX_PITCH_YAW_CHANGE /
						 MathUtil.max(Math.abs(store.accelerationData.getRotationalAccelerationRC().x),
									  Math.abs(store.accelerationData.getRotationalAccelerationRC().y)));
		if (!status.isLaunchRodCleared()) {
			dt[0] /= 5.0;
			dt[6] = status.getSimulationConditions().getLaunchRodLength() / k1.v.length() / 10;
		}
		dt[7] = 1.5 * store.timeStep;
		
		store.timeStep = Double.MAX_VALUE;
		int limitingValue = -1;
		for (int i = 0; i < dt.length; i++) {
			if (dt[i] < store.timeStep) {
				store.timeStep = dt[i];
				limitingValue = i;
			}
		}

		log.trace("Selected time step " + store.timeStep + " (limiting factor " + limitingValue + ")");

		// If our selected time step is too close to our next scheduled event,
		// (passed in as maxTimeStep) adjust
		double minTimeStep = status.getSimulationConditions().getTimeStep() / 20;

		if (Math.abs(maxTimeStep - store.timeStep) < minTimeStep) {
			store.timeStep = maxTimeStep;
			log.trace("selected time step too close to maxTimeStep; adjusted to " + store.timeStep);
		}

		// If we've wound up with a too-small timestep, increase it avoid numerical instability even at the
		// cost of not being *quite* on an event
		if (store.timeStep < minTimeStep) {
			log.trace("Too small time step " + store.timeStep + " (limiting factor " + limitingValue + "), using " +
					minTimeStep + " instead.");
			store.timeStep = minTimeStep;
		}

		// TODO: MEDIUM: Store acceleration etc of entire RK4 step, store should be cloned or something...
		store.storeData(status);
		checkNaN(store.timeStep, "store.timeStep");

		//// Second position, k2 = f(t + h/2, y + k1*h/2)
		
		status2 = status.clone();
		status2.setSimulationTime(status.getSimulationTime() + store.timeStep / 2);
		status2.setRocketPosition(status.getRocketPosition().add(k1.v.multiply(store.timeStep / 2)));
		status2.setRocketVelocity(status.getRocketVelocity().add(k1.a.multiply(store.timeStep / 2)));
		status2.setRocketOrientationQuaternion(status.getRocketOrientationQuaternion().multiplyLeft(Quaternion.rotation(k1.rv.multiply(store.timeStep / 2))));
		status2.setRocketRotationVelocity(status.getRocketRotationVelocity().add(k1.ra.multiply(store.timeStep / 2)));
		
		k2 = computeParameters(status2, store);
		

		//// Third position, k3 = f(t + h/2, y + k2*h/2)
		
		status2 = status.clone();
		status2.setSimulationTime(status.getSimulationTime() + store.timeStep / 2);
		status2.setRocketPosition(status.getRocketPosition().add(k2.v.multiply(store.timeStep / 2)));
		status2.setRocketVelocity(status.getRocketVelocity().add(k2.a.multiply(store.timeStep / 2)));
		status2.setRocketOrientationQuaternion(status2.getRocketOrientationQuaternion().multiplyLeft(Quaternion.rotation(k2.rv.multiply(store.timeStep / 2))));
		status2.setRocketRotationVelocity(status.getRocketRotationVelocity().add(k2.ra.multiply(store.timeStep / 2)));
		
		k3 = computeParameters(status2, store);
		

		//// Fourth position, k4 = f(t + h, y + k3*h)
		
		status2 = status.clone();
		status2.setSimulationTime(status.getSimulationTime() + store.timeStep);
		status2.setRocketPosition(status.getRocketPosition().add(k3.v.multiply(store.timeStep)));
		status2.setRocketVelocity(status.getRocketVelocity().add(k3.a.multiply(store.timeStep)));
		status2.setRocketOrientationQuaternion(status2.getRocketOrientationQuaternion().multiplyLeft(Quaternion.rotation(k3.rv.multiply(store.timeStep))));
		status2.setRocketRotationVelocity(status.getRocketRotationVelocity().add(k3.ra.multiply(store.timeStep)));
		
		k4 = computeParameters(status2, store);
		

		//// Sum all together,  y(n+1) = y(n) + h*(k1 + 2*k2 + 2*k3 + k4)/6
		Coordinate deltaV, deltaP, deltaR, deltaO;
		deltaV = k2.a.add(k3.a).multiply(2).add(k1.a).add(k4.a).multiply(store.timeStep / 6);
		deltaP = k2.v.add(k3.v).multiply(2).add(k1.v).add(k4.v).multiply(store.timeStep / 6);
		deltaR = k2.ra.add(k3.ra).multiply(2).add(k1.ra).add(k4.ra).multiply(store.timeStep / 6);
		deltaO = k2.rv.add(k3.rv).multiply(2).add(k1.rv).add(k4.rv).multiply(store.timeStep / 6);
		

		status.setRocketVelocity(status.getRocketVelocity().add(deltaV));
		status.setRocketPosition(status.getRocketPosition().add(deltaP));
		status.setRocketRotationVelocity(status.getRocketRotationVelocity().add(deltaR));
		status.setRocketOrientationQuaternion(status.getRocketOrientationQuaternion().multiplyLeft(Quaternion.rotation(deltaO)).normalizeIfNecessary());
		
		WorldCoordinate w = status.getSimulationConditions().getLaunchSite();
		w = status.getSimulationConditions().getGeodeticComputation().addCoordinate(w, status.getRocketPosition());
		status.setRocketWorldPosition(w);
		
		if (!(0 <= store.timeStep)) {
			// Also catches NaN
			throw new IllegalArgumentException("Stepping backwards in time, timestep=" + store.timeStep);
		}
		status.setSimulationTime(status.getSimulationTime() + store.timeStep);
		
		// Verify that values don't run out of range
		if (status.getRocketVelocity().length2() > 1.0e18 ||
				status.getRocketPosition().length2() > 1.0e18 ||
				status.getRocketRotationVelocity().length2() > 1.0e18) {
			throw new SimulationCalculationException(trans.get("error.valuesTooLarge"), status.getFlightDataBranch());
		}
	}

	private RK4Parameters computeParameters(SimulationStatus status, DataStore store)
			throws SimulationException {
		RK4Parameters params = new RK4Parameters();

		calculateAcceleration(status, store);

		params.a = store.accelerationData.getLinearAccelerationWC();
		params.ra = store.accelerationData.getRotationalAccelerationWC();
		params.v = status.getRocketVelocity();
		params.rv = status.getRocketRotationVelocity();
		
		checkNaN(params.a, "params.a");
		checkNaN(params.ra, "params.ra");
		checkNaN(params.v, "params.v");
		checkNaN(params.rv, "params.rv");
		
		return params;
	}
	
	@Override
	void calculateAcceleration(SimulationStatus status, DataStore store) throws SimulationException {
		
		// Call pre-listeners
		store.accelerationData = SimulationListenerHelper.firePreAccelerationCalculation(status);

		// Calculate acceleration (if not overridden by pre-listeners)
		if (store.accelerationData == null) {
			store.accelerationData = computeAcceleration(status, store);
		}

		// Call post-listeners
		store.accelerationData = SimulationListenerHelper.firePostAccelerationCalculation(status, store.accelerationData);

	}

	/**
	 * Calculate the thrust produced by the motors in the current
	 * configuration, at the current simulation time, allowing listeners to override
	 * TODO: HIGH:  This method does not take into account any moments generated by off-center motors.
	 *  
	 * @param status					the current simulation status.
	 * @param store                     the simulation calculation DataStore (contains acceleration, atmosphere)
	 * @return							the average thrust during the time step.
	 */
	protected double calculateThrust(SimulationStatus status,
									 DataStore store) throws SimulationException {
		double thrust;

		// Pre-listeners
		thrust = SimulationListenerHelper.firePreThrustCalculation(status);
		if (!Double.isNaN(thrust)) {
			return thrust;
		}

		thrust = 0;
		Collection<MotorClusterState> activeMotorList = status.getActiveMotors();
		for (MotorClusterState currentMotorState : activeMotorList ) {
			thrust += currentMotorState.getThrust( status.getSimulationTime() );
		}

		// PATCH (see engine-java/patches/LEDGER.md, RASAero feature #5, 2026-09-08):
		// RASAero-style PRESSURE THRUST. A published thrust curve is a sea-level
		// test-stand measurement; as the rocket climbs the atmosphere presses less
		// on the nozzle exit plane, so the motor gains exactly the exit area times
		// the pressure lost:  F(h) = F_curve(t) + A_exit * (101325 - P(h)).
		// Added AFTER the curve loop so the existing summation order (and therefore
		// every flag-off number) is untouched, and guarded so that on the off path
		// no floating-point operation touches `thrust` at all.
		double pressureThrust = calculatePressureThrust(status, store, activeMotorList);
		if (pressureThrust != 0.0) {
			thrust += pressureThrust;
			// FLOOR AT ZERO, and only on this path (2026-09-08, review). The term is
			// SIGNED: a pad above 101325 Pa makes it negative, and the exit diameter
			// is a free 1-200 mm field with nothing above it but an advisory notice.
			// A 0.12 m exit typed against a 105000 Pa pad gives -41.6 N, which drove
			// a burning 32 N motor to -9.6 N and returned a 0.000 m apogee with no
			// reason attached - a burning motor pushing the rocket backwards, which
			// is not a thing. In reality an over-expanded nozzle separates and thrust
			// floors near zero, so that is what is modelled. RASAero does not clamp;
			// this is the third stated deviation from it, alongside t = 0 and
			// burnout, and it can only bite where the total was already going to be
			// negative - every physical exit on every real pad is far from it.
			// Inside the guard so the flags-off path still executes no arithmetic at
			// all on `thrust`, and after the add so an ordinary flight sees one
			// comparison against a positive number.
			if (thrust < 0.0) {
				thrust = 0.0;
			}
		}

		// Post-listeners
		thrust = SimulationListenerHelper.firePostThrustCalculation(status, thrust);

		checkNaN(thrust, "thrust");

		return thrust;
	}

	/**
	 * PATCH (see engine-java/patches/LEDGER.md, RASAero feature #5, 2026-09-08).
	 * The ambient pressure a thrust curve is ASSUMED to have been measured at (Pa).
	 * <p>
	 * RASAero's stated convention (Chuck Rogers, "RASAero II Comparison with MESOS
	 * 293K Flight Data", slide 12: "rasp.eng Motor Data is Assumed to be a Sea Level
	 * Thrust Curve"), and the only convention the data supports: a RASP .eng file
	 * carries no test-site field, so nothing else could be filled in. A curve that
	 * was really shot at altitude is overstated by a CONSTANT offset - the app
	 * already carries that bias today, and this term neither adds to it nor removes
	 * it; it supplies only the exact SLOPE above the pad. Deliberately NOT the
	 * launch site's own pressure (that would zero the term at t = 0 by definition,
	 * wrong for a sea-level curve flown from a high pad) and NOT the model's own
	 * back-computed sea level (ExtendedISAModel(alt, T, P) extrapolates the DAY's
	 * weather to sea level, which is not a test stand).
	 */
	private static final double PRESSURE_THRUST_REFERENCE_PRESSURE = 101325.0;

	/**
	 * PATCH (see engine-java/patches/LEDGER.md, RASAero feature #5, 2026-09-08):
	 * the RASAero pressure-thrust correction, {@code A_exit * (P_ref - P(h))},
	 * summed ONCE PER THRUSTING STAGE.
	 * <p>
	 * Gates, in the order they are cheapest to fail:
	 * <ol>
	 * <li><b>Model.</b> Only under Rogers Kbf or the supersonic model - read
	 * straight off the {@link BarrowmanCalculator} the simulation was configured
	 * with, so no new field, setter or bridge export is needed. This is the same
	 * disjunction that gates the nozzle's OTHER half, the power-on base-drag
	 * reduction in {@code BarrowmanCalculator.calculateBaseCD}, and it is there for
	 * the same reason: desktop OpenRocket 24.12 has no nozzle-exit model of any
	 * kind (the identifier appears in exactly two files in the release, both under
	 * {@code file/rasaero}), so letting this into "OpenRocket - Extended Barrowman"
	 * would break that model's only promise. Eric's standing ruling, 2026-08-25.</li>
	 * <li><b>Pressure deficit.</b> Taken from {@code store.flightConditions}, i.e.
	 * the very same {@link AtmosphericConditions} object the drag term reads at this
	 * RK4 sub-step - one atmosphere per sub-step, so thrust and drag can never
	 * disagree about the altitude, and the pad's typed temperature and pressure flow
	 * through unchanged. May be NEGATIVE (a pad above 101325 Pa, or a below-sea-level
	 * site), which is physically right, hence the {@code != 0.0} test.</li>
	 * <li><b>Nozzle.</b> The stage that carries the burning motor's MOUNT, so a
	 * booster's nozzle is never credited to the sustainer. 0 (the default, and every
	 * design that has never named one) means no term.</li>
	 * <li><b>Burning.</b> Only while the motor's CURVE thrust is above zero - the
	 * same predicate {@code AbstractSimulationStepper.applyThrustState} uses for the
	 * drag half, so both halves switch on and off at the same sub-step. RASAero
	 * applies its term before ignition and after burnout as well (Chuck confirmed
	 * the artefact, TRF 194463 #17/#19); that is a deliberate deviation.</li>
	 * </ol>
	 * <p>
	 * ONCE PER STAGE, not once per motor: {@code AxialStage.nozzleExitDiameter} is
	 * defined app-side as the single equivalent nozzle of the whole cluster, with the
	 * exit AREAS summed (the {@code FIELDS.stage} entry in
	 * packages/app/src/tree/schema.ts, and RASAero's own manual p.50), so multiplying
	 * by {@code MotorClusterState.motorCount} would count a cluster twice. It also
	 * keeps this half consistent with the drag half, which subtracts one nozzle area
	 * per stage INSTANCE. Two mounts on one stage are therefore de-duplicated by
	 * stage number, the way {@code applyThrustState} builds its thrusting-stage set.
	 * <p>
	 * Three caveats, recorded rather than modelled (all three are in the LEDGER too):
	 * <ul>
	 * <li><b>Tail-off.</b> The full geometric exit area assumes a full-flowing
	 * nozzle. During tail-off the flow separates and {@code A_e * dP} overstates.
	 * RASAero applies the full term whenever the motor burns, and reproducing RASAero
	 * is the point.</li>
	 * <li><b>Staggered ignition.</b> The stage's WHOLE summed equivalent area is
	 * charged from the moment its FIRST motor lights, so a cluster whose outboards
	 * are airstarted later is over-credited until they all light. The drag half has
	 * exactly the same shape (its gate is the stage's thrusting flag), so the two
	 * halves stay consistent; correcting it would mean scaling by the burning
	 * fraction, in both halves at once.</li>
	 * <li><b>Parallel stages.</b> {@code getStageNumber()} is ONE number for a whole
	 * {@code ParallelStage}, so this half charges one area however many strap-on
	 * instances burn, while the drag half removes one per INSTANCE
	 * ({@code total += instanceCount * cd}). Not reachable today - the JS bridge has
	 * no PodSet/ParallelStage build path - and it must be resolved in the same
	 * sitting that bridge lands, either by multiplying here or by redefining the
	 * field as per-instance and changing the drag half.</li>
	 * </ul>
	 *
	 * @param status          the current simulation status
	 * @param store           this sub-step's DataStore (carries the atmosphere)
	 * @param activeMotorList the caller's active-motor list, reused (getActiveMotors
	 *                        allocates a fresh list on every call)
	 * @return the pressure-thrust correction in newtons; EXACTLY 0.0, computed by no
	 *         arithmetic at all, whenever the feature is off
	 */
	private double calculatePressureThrust(SimulationStatus status, DataStore store,
			Collection<MotorClusterState> activeMotorList) {
		AerodynamicCalculator aeroCalc = status.getSimulationConditions().getAerodynamicCalculator();
		if (!(aeroCalc instanceof BarrowmanCalculator)) {
			return 0.0;
		}
		BarrowmanCalculator barrowman = (BarrowmanCalculator) aeroCalc;
		if (!(barrowman.isRogersKbf() || barrowman.isSupersonicAero())) {
			return 0.0;
		}
		if (store.flightConditions == null) {
			// Defensive: step() populates it before k1 and calculateForces before
			// every sub-step, so this cannot be null on any path today.
			return 0.0;
		}
		double deficit = PRESSURE_THRUST_REFERENCE_PRESSURE
				- store.flightConditions.getAtmosphericConditions().getPressure();
		if (deficit == 0.0) {
			// A sea-level standard-ISA pad gives exactly this at t = 0.
			return 0.0;
		}

		double sum = 0.0;
		double time = status.getSimulationTime();
		java.util.Set<Integer> creditedStages = null;
		for (MotorClusterState currentMotorState : activeMotorList) {
			if (currentMotorState.getThrust(time) <= 0.0) {
				continue;
			}
			AxialStage stage = ((RocketComponent) currentMotorState.getMount()).getStage();
			if (stage == null) {
				continue;
			}
			double exitDiameter = stage.getNozzleExitDiameter();
			if (exitDiameter <= 0.0) {
				continue;
			}
			Integer stageNumber = stage.getStageNumber();
			if (creditedStages == null) {
				creditedStages = new java.util.HashSet<Integer>();
			} else if (creditedStages.contains(stageNumber)) {
				continue;
			}
			creditedStages.add(stageNumber);
			// Same expression as the drag half's nozzle area, so the two halves
			// cannot disagree about what a diameter means.
			sum += Math.PI * MathUtil.pow2(exitDiameter / 2.0) * deficit;
		}
		return sum;
	}

	/**
	 * Calculate the linear and angular acceleration at the given status.  The results
	 * are stored in the fields {@link #linearAcceleration} and {@link #angularAcceleration}.
	 *  
	 * @param status   the status of the rocket.
	 * @throws SimulationException 
	 */
	private AccelerationData computeAcceleration(SimulationStatus status, DataStore store) throws SimulationException {
		Coordinate linearAcceleration;
		Coordinate angularAcceleration;
		
		// Calculate mass data
		RigidBody structureMassData = calculateStructureMass(status);
		
		store.motorMass = calculateMotorMass(status);
		store.rocketMass = structureMassData.add( store.motorMass );

		if (store.rocketMass.getMass() < MathUtil.EPSILON) {
			status.abortSimulation(SimulationAbort.Cause.ACTIVE_MASS_ZERO);
		}
			
		// Compute the forces affecting the rocket
		calculateForces(status, store);

		// Calculate the forces from the aerodynamic coefficients
		
		double dynP = (0.5 * store.flightConditions.getAtmosphericConditions().getDensity() *
					MathUtil.pow2(store.flightConditions.getVelocity()));
		double refArea = store.flightConditions.getRefArea();
		double refLength = store.flightConditions.getRefLength();
		
		// Linear forces in rocket coordinates
		store.dragForce = store.forces.getCDaxial() * dynP * refArea;
		double fN = store.forces.getCN() * dynP * refArea;
		double fSide = store.forces.getCside() * dynP * refArea;

		store.thrustForce = calculateThrust(status, store);
		double forceZ =  store.thrustForce - store.dragForce;
		
		linearAcceleration = new Coordinate(-fN / store.rocketMass.getMass(),
					-fSide / store.rocketMass.getMass(),
					forceZ / store.rocketMass.getMass());
		
		linearAcceleration = store.thetaRotation.rotateZ(linearAcceleration);
		
		// Convert into rocket world coordinates
		linearAcceleration = status.getRocketOrientationQuaternion().rotate(linearAcceleration);
		
		// add effect of gravity
		store.gravity = modelGravity(status);
		linearAcceleration = linearAcceleration.sub(0, 0, store.gravity);
		
		// add effect of Coriolis acceleration
		store.coriolisAcceleration = status.getSimulationConditions().getGeodeticComputation()
				.getCoriolisAcceleration(status.getRocketWorldPosition(), status.getRocketVelocity());
		linearAcceleration = linearAcceleration.add(store.coriolisAcceleration);

		// If we haven't taken off yet, don't sink into the ground
		if (!status.isLiftoff()) {
			angularAcceleration = Coordinate.NUL;
			if (linearAcceleration.z < 0) {
				linearAcceleration = Coordinate.ZERO;
			}
		} else if (!status.isLaunchRodCleared()) {

			// If still on the launch rod, project acceleration onto launch rod direction and
			// set angular acceleration to zero.
			
			linearAcceleration = store.launchRodDirection.multiply(linearAcceleration.dot(store.launchRodDirection));
			angularAcceleration = Coordinate.NUL;
			
		} else {
			
			// Shift moments to CG
			double Cm = store.forces.getCm() - store.forces.getCN() * store.rocketMass.getCM().x / refLength;
			double Cyaw = store.forces.getCyaw() - store.forces.getCside() * store.rocketMass.getCM().x / refLength;
			
			// Compute moments
			double momX = -Cyaw * dynP * refArea * refLength;
			double momY = Cm * dynP * refArea * refLength;
			double momZ = store.forces.getCroll() * dynP * refArea * refLength;
			
			// Compute angular acceleration in rocket coordinates
			angularAcceleration = new Coordinate(momX / store.rocketMass.getLongitudinalInertia(),
						momY / store.rocketMass.getLongitudinalInertia(),
						momZ / store.rocketMass.getRotationalInertia());
			
			angularAcceleration = store.thetaRotation.rotateZ(angularAcceleration);
			
			// Convert to world coordinates
			angularAcceleration = status.getRocketOrientationQuaternion().rotate(angularAcceleration);
		}

		return new AccelerationData(null, null, linearAcceleration, angularAcceleration, status.getRocketOrientationQuaternion());
	}
	
	
	/**
	 * Calculate the aerodynamic forces into the data store.  This method also handles
	 * whether to include aerodynamic computation warnings or not.
	 */
	private void calculateForces(SimulationStatus status, DataStore store) throws SimulationException {
		
		// Call pre-listeners
		store.forces = SimulationListenerHelper.firePreAerodynamicCalculation(status);
		if (store.forces != null) {
			return;
		}
		
		// Compute flight conditions
		calculateFlightConditions(status, store);
		
		/*
		 * Check whether to store warnings or not.  Warnings are ignored when on the 
		 * launch rod or 0.25 seconds after departure, and when the velocity has dropped
		 * below 20% of the max. velocity.
		 */
		WarningSet warnings = status.recordWarnings() ? new WarningSet() : null;

		// Calculate aerodynamic forces
		store.forces = status.getSimulationConditions().getAerodynamicCalculator()
				.getAerodynamicForces(status.getConfiguration(), store.flightConditions, warnings);

		if (null != warnings) {
			// If this doesn't include the sustainer and either isn't stable or is about
			// to deploy a recovery device, don't store open airframe warnings
			boolean sustainer = status.getConfiguration().isStageActive(0);
			boolean stable = store.rocketMass.getCM().x < store.forces.getCP().x;
			boolean recoverySoon = false;
			for (FlightEvent e : status.getEventQueue()) {
				if ((e.getType() == FlightEvent.Type.RECOVERY_DEVICE_DEPLOYMENT) &&
					(e.getTime() < status.getSimulationTime() + 0.5)) {
					recoverySoon = true;
				}
			}
			
			if (!sustainer && (!stable || recoverySoon)) {
				warnings.filterOut(Warning.OPEN_AIRFRAME_FORWARD);
			}
				
			status.addWarnings(warnings);
		}

		// Add very small randomization to yaw & pitch moments to prevent over-perfect flight
		// TODO: HIGH: This should rather be performed as a listener
		store.forces.setCm(store.forces.getCm() + (PITCH_YAW_RANDOM * 2 * (random.nextDouble() - 0.5)));
		store.forces.setCyaw(store.forces.getCyaw() + (PITCH_YAW_RANDOM * 2 * (random.nextDouble() - 0.5)));
		

		// Call post-listeners
		store.forces = SimulationListenerHelper.firePostAerodynamicCalculation(status, store.forces);
	}
	
	

	private static class RK4Parameters {
		/** Linear acceleration */
		public Coordinate a;
		/** Linear velocity */
		public Coordinate v;
		/** Rotational acceleration */
		public Coordinate ra;
		/** Rotational velocity */
		public Coordinate rv;
	}
}
