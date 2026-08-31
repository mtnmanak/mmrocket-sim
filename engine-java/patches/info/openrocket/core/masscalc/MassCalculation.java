package info.openrocket.core.masscalc;

import java.util.ArrayList;
import java.util.Collection;
import java.util.Map;

import info.openrocket.core.motor.Motor;
import info.openrocket.core.motor.MotorConfiguration;
import info.openrocket.core.rocketcomponent.ComponentAssembly;
import info.openrocket.core.rocketcomponent.FlightConfiguration;
import info.openrocket.core.rocketcomponent.MotorMount;
import info.openrocket.core.rocketcomponent.RocketComponent;
import info.openrocket.core.simulation.MotorClusterState;
import info.openrocket.core.util.Coordinate;
import info.openrocket.core.util.MathUtil;
import info.openrocket.core.util.Transformation;

/**
 * 
 * @author teyrana (aka Daniel Williams) <equipoise@gmail.com> 
 *
 */
public class MassCalculation {

	/**
	 * NOTE:  Multiple enums may map to the same settings.  This allows a caller to use the
	 *     enum which best matches their use case.
	 */
	public enum Type {
		// no motor data, even if the configuration contains active engines
		STRUCTURE(true, false, false),

		// n.b. 'motor-mass' calculations are to be preferred over 'propellant-mass'
		// calculations because they are computationally simpler:
		// not only are they faster, but *slightly* more accurate because of fewer
		// calculation rounding errors
		MOTOR(false, true, true),

		BURNOUT(true, true, false),

		LAUNCH(true, true, true);

		public final boolean includesStructure;
		public final boolean includesMotorCasing;
		public final boolean includesPropellant;
		
		Type( double simulationTime ) {
			includesStructure = false;
			includesMotorCasing = true;
			includesPropellant = true;
		}
		
	    Type( boolean include_structure, boolean include_casing, boolean include_prop) {
			this.includesStructure = include_structure;
			this.includesMotorCasing = include_casing;
			this.includesPropellant = include_prop;
		}   
	}
	
	// =========== Instance Functions ========================
	
	public void merge( final MassCalculation other ) {
		// Adjust Center-of-mass
		this.addMass( other.getCM() );
		this.bodies.addAll( other.bodies );
	}

	public void addInertia( final RigidBody data ) {
		this.bodies.add( data );
	}
	
	public void addMass( final Coordinate pointMass ) {
		if( MIN_MASS > this.centerOfMass.weight ){
		    this.centerOfMass = pointMass;
		}else {
			this.centerOfMass = this.centerOfMass.average( pointMass);
		}
	}

	public void addMass(double mass) {
		this.centerOfMass = this.centerOfMass.setWeight(getMass() + mass);
	}
	
	public MassCalculation copy(final RocketComponent _root, final Transformation _transform){
		return new MassCalculation( this.type, this.config, this.simulationTime, this.activeMotorList, _root, _transform, this.analysisMap);
	}
		
	public Coordinate getCM() {
		return this.centerOfMass;
	}
	
	public double getMass() {
		return this.centerOfMass.weight;
	}

	public void setMass(double mass) {
		this.centerOfMass = this.centerOfMass.setWeight(mass);
	}
	
	public double getLongitudinalInertia() {
		return this.inertia.Iyy;
	}
	
	public double getRotationalInertia() {
		return this.inertia.Ixx;
	}
	
	@Override
	public boolean equals(Object obj) {
		if (this == obj)
			return true;
		
		MassCalculation other = (MassCalculation) obj;
		return ((this.centerOfMass.equals(other.centerOfMass)) 
				&& (this.config.equals( other.config))
				&& (this.simulationTime == other.simulationTime)
				&& (this.type == other.type) );
	}
	
	@Override
	public int hashCode() {
		return this.centerOfMass.hashCode();
	}

	public MassCalculation(final Type _type, final FlightConfiguration _config, final double _time,
						   final Collection<MotorClusterState> _activeMotorList,
						   final RocketComponent _root, final Transformation _transform,
						   Map<Integer, CMAnalysisEntry> _map)
	{
		type = _type;
		config = _config;
		simulationTime = _time;
		activeMotorList = _activeMotorList;
		root = _root;
		transform = _transform;
		analysisMap = _map;

		reset();
	}
	
	public void setCM( final Coordinate newCM ) {
		this.centerOfMass = newCM;
	}	

	public void reset(){
		centerOfMass = Coordinate.ZERO;
		inertia = RigidBody.EMPTY;
		bodies.clear();
	}
	
	public int size() {
		return this.bodies.size();
	}
	
	public String toCMDebug(){ 
		return String.format("cm= %.6fg@[%.6f,%.6f,%.6f]", centerOfMass.weight, centerOfMass.x, centerOfMass.y, centerOfMass.z);
	}

//	public String toMOIDebug(){
//		return String.format("I_cm=[ %.8f, %.8f, %.8f ]", inertia.getIxx(), inertia.getIyy(), inertia.getIzz() ));	 
//	}

	@Override
	public String toString() {
		return this.toCMDebug();
	}

	
	// =========== Instance Member Variables ========================
	
	private static final double MIN_MASS = MathUtil.EPSILON;

	// === package-private ===
	final FlightConfiguration config;
	final double simulationTime;
	final Collection<MotorClusterState> activeMotorList;
	final RocketComponent root;
	final Transformation transform;
	final Type type;
	
	// center-of-mass only.
	Coordinate centerOfMass = Coordinate.ZERO;
	
	// center-of-mass AND moment-of-inertia data.
	RigidBody inertia = RigidBody.EMPTY;
	
	// center-of-mass AND moment-of-inertia data.
	final ArrayList<RigidBody> bodies = new ArrayList<>();

	String prefix = "";

	Map<Integer, CMAnalysisEntry> analysisMap;

	// =========== Private Instance Functions ========================

	private MassCalculation calculateMountData(){
		if( ! config.isComponentActive(this.root)) {
			return this;
		}
		
		final MotorMount mount = (MotorMount)root;
		MotorConfiguration motorConfig = mount.getMotorConfig( config.getId() );
		if( motorConfig.isEmpty() ){
			return this;
		}
		final Motor motor = motorConfig.getMotor();

		// If we don't have any MotorClusterStates,
		// we're using a synthetic time to do a static analysis.
		// If we do have MotorClusterStates, we need to adjust
		// time according to motor ignition time.
		double motorTime = simulationTime;
		if (activeMotorList != null) {
			for (MotorClusterState currentMotorState : activeMotorList ) {
				if (currentMotorState.getMotor() == motor) {
					motorTime = currentMotorState.getMotorTime(simulationTime);
					break;
				}
			}
		}

		final double mountXPosition = root.getPosition().x;
		
		final int instanceCount = root.getInstanceCount();

		final double motorXPosition = motorConfig.getX();  // location of motor from mount
		final Coordinate[] offsets = root.getInstanceOffsets();
		
		double eachMass;
		double eachCMx;  // CoM from beginning of motor
		
		if ( this.type.includesMotorCasing && this.type.includesPropellant ){
			eachMass = motor.getTotalMass( motorTime );
			eachCMx = motor.getCMx( motorTime);
		}else if( this.type.includesMotorCasing ) {
			eachMass = motor.getTotalMass( Motor.PSEUDO_TIME_BURNOUT );
			eachCMx = motor.getCMx( Motor.PSEUDO_TIME_BURNOUT );
		} else {
			final double eachMotorMass = motor.getTotalMass( motorTime );
			final double eachMotorCMx = motor.getCMx( motorTime ); // CoM from beginning of motor
			final double eachCasingMass = motor.getBurnoutMass();
			final double eachCasingCMx = motor.getBurnoutCGx();
			
			eachMass = eachMotorMass - eachCasingMass;
			eachCMx = (eachMotorCMx*eachMotorMass - eachCasingCMx*eachCasingMass)/eachMass;
		}

//		System.err.println(String.format("%-40s|Motor: %s....  Mass @%f = %.6f", prefix, motorConfig.toDescription(), motorTime, eachMass ));


		// coordinates in rocket frame; Ir, It about CoM.
		final Coordinate clusterLocalCM = new Coordinate( mountXPosition + motorXPosition + eachCMx, 0, 0, eachMass*instanceCount);
		
		double clusterBaseIr = motorConfig.getUnitRotationalInertia()*instanceCount*eachMass;
		
		double clusterIt = motorConfig.getUnitLongitudinalInertia()*instanceCount*eachMass;
		
		// if more than 1 motor => motors are not at the centerline => adjust via parallel-axis theorem
		double clusterIr = clusterBaseIr; 
		if( 1 < instanceCount ){
			for( Coordinate coord : offsets ){
				double distance = Math.hypot( coord.y, coord.z);
				clusterIr += eachMass*Math.pow( distance, 2);
			}
		}
		
		final Coordinate clusterCM = transform.transform( clusterLocalCM  );
		addMass( clusterCM );

		if(null != this.analysisMap) {
			CMAnalysisEntry entry = analysisMap.get(motor.getDesignation().hashCode());
			if (null == entry){
				entry = new CMAnalysisEntry(motor);
				analysisMap.put(motor.getDesignation().hashCode(), entry);
			}
			entry.updateEachMass(eachMass);
			entry.updateAverageCM(clusterCM);
		}

		RigidBody clusterMOI = new RigidBody( clusterCM, clusterIr, clusterIt, clusterIt );
		addInertia( clusterMOI );
		
		return this;
	}
	
	/**
	 * Returns the mass and inertia data for this component and all subcomponents.
	 * The inertia is returned relative to the CG, and the CG is in the coordinates
	 * of the specified component, not global coordinates.
	 *
	 */
	/* package-scope */ MassCalculation calculateAssembly(){
		
		if (this.type.includesStructure) {
			MassCalculation structureCalc = this.copy(this.root, this.transform);
			structureCalc.calculateStructure();
			this.merge(structureCalc);
		}

		if (this.type.includesMotorCasing || this.type.includesPropellant) {
			MassCalculation motorCalc = this.copy(this.root, this.transform);
			motorCalc.calculateMotors();
			this.merge(motorCalc);
		}

		return this;
	}

	MassCalculation calculateStructure() {
		final RocketComponent component = this.root;
		final Transformation parentTransform = this.transform;
		final int instanceCount = component.getInstanceCount();
		final Coordinate[] allInstanceOffsets = component.getInstanceLocations();
		final double[] allInstanceAngles = component.getInstanceAngles();

		// vvv DEBUG
		//if( this.config.isComponentActive(component) ){
		//	System.err.println(String.format( "%s>>[%s]....", prefix, component.getName()));
		//}

		if(null != analysisMap) {
			if (this.config.isComponentActive(component) && (! analysisMap.containsKey(component.hashCode()))){
				CMAnalysisEntry entry = new CMAnalysisEntry(component);
				analysisMap.put(component.hashCode(), entry);
			}
		}

		// iterate over the aggregated instances for the whole tree.
		MassCalculation children = this.copy(component, parentTransform );
		for( int currentInstanceNumber = 0; currentInstanceNumber < instanceCount; ++currentInstanceNumber) {
			final Coordinate currentInstanceOffset = allInstanceOffsets[currentInstanceNumber];
			final Transformation offsetTransform = Transformation.getTranslationTransform( currentInstanceOffset );

			final double currentInstanceAngle = allInstanceAngles[currentInstanceNumber];
			final Transformation angleTransform = Transformation.getAxialRotation(currentInstanceAngle);

			final Transformation currentTransform = parentTransform.applyTransformation(offsetTransform)
														.applyTransformation(angleTransform);

			for (RocketComponent child : component.getChildren()) {
				// child data, relative to rocket reference frame
				MassCalculation eachChild = copy(child, currentTransform);
				
				eachChild.prefix = prefix + "....";
				eachChild.calculateStructure(); 

				// accumulate children's data
				children.merge( eachChild );
			}
		}
		
		if (this.config.isComponentActive(component) ){
			Coordinate compCM = component.getComponentCG();
			
			// mass data for *this component only* in the rocket-frame
			compCM = parentTransform.transform( compCM.add(component.getPosition()) );

			// setting zero as the CG position means the top of the component, which is component.getPosition()
			final Coordinate compZero = parentTransform.transform( component.getPosition() );

			// MMRocket Sim patch (v0.088) — see the block comment on
			// subtreeOverride below. `geomOwnCM` is this component's own CG
			// carrying its own GEOMETRIC mass, captured before any override
			// rewrites the weight; it is needed to fold a massive parent into
			// the geometry being scaled.
			final Coordinate geomOwnCM = compCM;
			boolean subtreeOverride = false;
			double subIxx = 0.0;
			double subIyy = 0.0;

			if (component.isMassOverridden()) {
				if (!component.isMassive()) {
					compCM = children.getCM();
				}
				compCM = compCM.setWeight(component.getOverrideMass());

				if (component.isSubcomponentsOverriddenMass()) {
					// ===== MMRocket Sim patch (v0.088): scale the subtree's
					// INERTIA by the same factor the override scales its MASS.
					//
					// Upstream zeroes the children's CM weight here and stops.
					// The children's RigidBody list is untouched, so it crosses
					// over at `this.merge(children)` still carrying every
					// child's GEOMETRIC mass. The result is not a rigid body at
					// all: the mass, the CG and the inertia tensor describe
					// three different objects.
					//
					// Measured on the shipped kernel before this patch: pinning
					// a stage at k x its geometric mass left the roll inertia
					// BIT-IDENTICAL to the unpinned value (golden
					// mass.override.k1/k2/k5 all read 1.2522450621924655E-5
					// while the mass tripled), i.e. low by exactly k. Pitch
					// moved, but only through a transport term charged at the
					// override mass ON TOP of the children's own rebases, which
					// already carry that distance — so pitch could come out
					// HIGH. The sign of the error varied by design, which is
					// why no single sentence could describe the old behaviour.
					//
					// The fix, and the modelling ruling behind it: the user has
					// told us the SHAPE is right and the MASS was wrong ("I put
					// the stage on a scale"). So keep the geometry and scale
					// the whole tensor uniformly by k = override / geometric.
					// One body then carries both the override mass and the
					// shape-preserved inertia, and rebase() transports it
					// exactly once.
					//
					// SCOPE: this branch only. `overrideMass` WITHOUT the
					// subcomponents flag is a different, self-consistent
					// behaviour (a coherent point mass added at the subtree CG)
					// that upstream and two shipped JS tests depend on — golden
					// `mass.override.unflagged` is the leak detector for it.
					final RigidBody subtree = children.calculateMomentOfInertia();
					double geomMass = subtree.getMass();
					RigidBody geomWhole = subtree;
					if (component.isMassive()) {
						// A massive parent's override covers parent AND
						// subtree, so the parent's own geometry joins the
						// tree being scaled. (On a ComponentAssembly every
						// term here is zero and this is a no-op.)
						final double ownIx = component.getRotationalUnitInertia() * geomOwnCM.weight;
						final double ownIt = component.getLongitudinalUnitInertia() * geomOwnCM.weight;
						geomWhole = subtree.add(new RigidBody(geomOwnCM, ownIx, ownIt, ownIt));
						geomMass += geomOwnCM.weight;
					}
					// MIN_MASS guard is NOT optional: a subtree whose children
					// are all massless gives k = Infinity or NaN, and NaN slips
					// past RigidBody's negative-value check straight into the
					// RK4 angular-acceleration divisor.
					final double k = (geomMass > MIN_MASS)
							? component.getOverrideMass() / geomMass
							: 0.0;
					subtreeOverride = true;
					subIxx = geomWhole.Ixx * k;
					subIyy = geomWhole.Iyy * k;

					// The children's bodies have now been folded into
					// (subIxx, subIyy). Leaving them in the list would ADD the
					// unscaled geometry on top, giving roughly (1+k)x.
					children.bodies.clear();
					children.setCM(children.getCM().setWeight(0));
				}
			}

			if (component.isCGOverridden()) {
				compCM = compCM.setX( compZero.x + component.getOverrideCGX() );

				if (component.isSubcomponentsOverriddenCG()) {
					children.setCM(children.getCM().setX(compCM.x));
				}
			}
			this.addMass(compCM);
			
			if(null != analysisMap){
				final CMAnalysisEntry entry = analysisMap.get(component.hashCode());
				if( component instanceof ComponentAssembly) {
					// For ComponentAssemblies, record the _assembly_ information
					entry.updateEachMass(children.getMass() / component.getInstanceCount());
					entry.updateAverageCM(this.centerOfMass);
				}else{
					// For actual components, record the mass of the component, and disregard children
					entry.updateEachMass(compCM.weight);
					entry.updateAverageCM(compCM);
				}
			}
			
			// MMRocket Sim patch (v0.088): under a subtree mass override the
			// scaled tensor computed above REPLACES the usual per-component
			// term — it already includes this component's own geometry when
			// the component is massive. Adding both would double-count it.
			// compCM is the attachment point, so an active CG override (which
			// moves compCM.x just above) carries the shape with it: "keep the
			// shape, put it where the user says the CG is".
			final RigidBody componentInertia;
			if (subtreeOverride) {
				componentInertia = new RigidBody( compCM, subIxx, subIyy, subIyy );
			} else {
				final double compIx = component.getRotationalUnitInertia() * compCM.weight;
				final double compIt = component.getLongitudinalUnitInertia() * compCM.weight;
				componentInertia = new RigidBody( compCM, compIx, compIt, compIt );
			}
			this.addInertia( componentInertia );
			// // vvv DEBUG
			// if( 0 < compCM.weight ) {
			// 	System.err.println(String.format( "%s....componentData:            %s", prefix, compCM.toPreciseString() ));
			// }
		}

		this.merge( children );

		// // vvv DEBUG
		// if( this.config.isComponentActive(component) && 0 < this.getMass() ) {
		// 	System.err.println(String.format( "%s....<< return data @ %s:   %s", prefix, component.getName(), this.toCMDebug() ));
		// }
		// // ^^^ DEBUG
		
		return this;
	}

	MassCalculation calculateMotors() {
		final RocketComponent component = this.root;
		final Transformation parentTransform = this.transform;
		
		final int instanceCount = component.getInstanceCount();
		Coordinate[] instanceLocations = component.getInstanceLocations();

//		// vvv DEBUG
//		if( this.config.isComponentActive(component) ){
//			System.err.println(String.format( "%s[%s]....", prefix, component.getName()));
//		}

		if (component.isMotorMount()) {
			MassCalculation motor = this.copy(component, parentTransform);
			
			motor.calculateMountData();

			this.merge( motor );

//			// vvv DEBUG
//			if( 0 < motor.getMass() ) {
//				System.err.println(String.format( "%s........++ motorData: %s", prefix, propellant.toCMDebug()));
//			}

		}
		
		// iterate over the aggregated instances for the whole tree.
		MassCalculation children = this.copy(component, parentTransform );
		for( int instanceNumber = 0; instanceNumber < instanceCount; ++instanceNumber) {
			Coordinate currentLocation = instanceLocations[instanceNumber];
			Transformation currentTransform = parentTransform.applyTransformation( Transformation.getTranslationTransform( currentLocation ));
			
			for (RocketComponent child : component.getChildren()) {
				// child data, relative to rocket reference frame
				MassCalculation eachChild = copy( child, currentTransform);
				
				eachChild.prefix = prefix + "....";
				eachChild.calculateMotors(); 
				
				// accumulate children's data
				children.merge( eachChild );
			}
		}
		
		if( MIN_MASS < children.getMass() ) {
			this.merge( children );
			//System.err.println(String.format( "%s....assembly mass (incl/children):  %s", prefix, this.toCMDebug()));
		}

		
//		// vvv DEBUG
//		if( this.config.isComponentActive(component) && 0 < this.getMass() ) {
//			System.err.println(String.format( "%s....<< return assemblyData:   %s (tree @%s)", prefix, this.toCMDebug(), component.getName() ));
//		}
//      // ^^^ DEBUG
		
		return this;
	}
	
	/** 
	 * MOI Calculation needs to be a two-step process:
	 * (1) calculate overall Center-of-Mass (CM) first (down inline with data-gathering)
	 * (2) Move MOIs to CM via parallel axis theorem (this method)
	 *
	 * @return freshly calculated Moment-of-Inertia matrix
	 */
	/* package-scope */ RigidBody calculateMomentOfInertia() {
		double Ir=0, It=0;
		for( final RigidBody eachLocal : this.bodies ){
			final RigidBody eachGlobal = eachLocal.rebase( this.centerOfMass );
			Ir += eachGlobal.Ixx;
			It += eachGlobal.Iyy;
		}
		
		return new RigidBody( centerOfMass, Ir, It, It );
	}

}

