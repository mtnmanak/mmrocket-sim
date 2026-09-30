package info.openrocket.core.masscalc;

import static info.openrocket.core.util.MathUtil.pow2;

import info.openrocket.core.util.BugException;
import info.openrocket.core.util.Coordinate;
import info.openrocket.core.util.MathUtil;

// implements a simplified, diagonal MOI
public class RigidBody {
	public final Coordinate cm;
	// Roll uses the true radial centroid; pitch/yaw retain the legacy reference.
	public final Coordinate transverseCM;
	public final double Ixx;
	public final double Iyy;
	public final double Izz;

	public static final RigidBody EMPTY = new RigidBody(Coordinate.ZERO, 0.0, 0.0, 0.0);

	public RigidBody(Coordinate _cm, double I_axial, double I_long) {
		this(_cm, I_axial, I_long, I_long);
	}

	public RigidBody(Coordinate _cm, double Ixx, double Iyy, double Izz) {
		this(_cm, _cm, Ixx, Iyy, Izz);
	}

	public RigidBody(Coordinate _cm, Coordinate transverseCM, double Ixx, double Iyy, double Izz) {
		if ((0 > Ixx) || (0 > Iyy) || (0 > Izz)) {
			throw new BugException("  attempted to initialize an InertiaMatrix with a negative inertia value.");
		}
		this.cm = _cm;
		this.transverseCM = transverseCM.setWeight(_cm.weight);
		this.Ixx = Ixx;
		this.Iyy = Iyy;
		this.Izz = Izz;
	}

	public RigidBody add(RigidBody that) {
		final Coordinate newCM = this.cm.average(that.cm);
		final Coordinate newTransverseCM = this.transverseCM.average(that.transverseCM);

		RigidBody movedThis = this.rebase(newCM, newTransverseCM);
		RigidBody movedThat = that.rebase(newCM, newTransverseCM);

		final double newIxx = movedThis.Ixx + movedThat.Ixx;
		final double newIyy = movedThis.Iyy + movedThat.Iyy;
		final double newIzz = movedThis.Izz + movedThat.Izz;

		return new RigidBody(newCM, newTransverseCM, newIxx, newIyy, newIzz);
	}

	public Coordinate getCenterOfMass() {
		return cm;
	}

	public Coordinate getCM() {
		return cm;
	}

	public double getIyy() {
		return Iyy;
	}

	public double getIxx() {
		return Ixx;
	}

	public double getIzz() {
		return Izz;
	}

	public double getLongitudinalInertia() {
		return Iyy;
	}

	public double getMass() {
		return this.cm.weight;
	}

	public double getRotationalInertia() {
		return Ixx;
	}

	public boolean isEmpty() {
		if (RigidBody.EMPTY == this) {
			return true;
		}
		return RigidBody.EMPTY.equals(this);
	}

	@Override
	public int hashCode() {
		return (int) (Double.doubleToLongBits(this.Ixx) ^ Double.doubleToLongBits(this.Iyy)
				^ Double.doubleToLongBits(this.Ixx));
	}

	@Override
	public boolean equals(Object obj) {
		if (this == obj)
			return true;
		if (!(obj instanceof RigidBody))
			return false;

		RigidBody other = (RigidBody) obj;
		return (MathUtil.equals(this.Ixx, other.Ixx) && MathUtil.equals(this.Iyy, other.Iyy) &&
				MathUtil.equals(this.Izz, other.Izz));
	}

	/**
	 * Rebase the current moment of inertia from this.cm reference system to
	 * newLocation reference system
	 * 
	 * @param newLocation new moment of inertia reference system
	 * @return RigidBody with rebased moment of inertia
	 */
	public RigidBody rebase(final Coordinate newLocation) {
		return rebase(newLocation, newLocation);
	}

	// Internal composition transports each approximation about its own reference.
	public RigidBody rebase(final Coordinate newLocation, final Coordinate newTransverseLocation) {
		final Coordinate delta = this.cm.sub(newLocation);
		final Coordinate transverseDelta = this.transverseCM.sub(newTransverseLocation);
		double newIxx = this.Ixx + cm.weight * (pow2(delta.y) + pow2(delta.z));
		double newIyy = this.Iyy + cm.weight * (pow2(transverseDelta.x) + pow2(transverseDelta.z));
		double newIzz = this.Izz + cm.weight * (pow2(transverseDelta.x) + pow2(transverseDelta.y));
		// A change of reference does not change this body's mass.
		return new RigidBody(newLocation.setWeight(cm.weight), newTransverseLocation.setWeight(cm.weight),
				newIxx, newIyy, newIzz);
	}

	@Override
	public String toString() {
		return toCMString() + " // " + toMOIString();
	}

	public String toCMString() {
		return String.format("CoM: %.8fg @[%.8f,%.8f,%.8f]", cm.weight, cm.x, cm.y, cm.z);
	}

	public String toMOIString() {
		return String.format("MOI: [ %.8f, %.8f, %.8f]", Ixx, Iyy, Izz);
	}

	/**
	 * This function returns a <b>copy</b> of this MassData translated to a new
	 * location via
	 * a simplified model.
	 * 
	 * Assuming rotations are independent, and occur perpendicular to the principal
	 * axes,
	 * The above can be simplified to produce a diagonal newMOI in
	 * the form of the parallel axis theorem:
	 * [ oldMOI + m*d^2, ...]
	 * 
	 * For the full version of the equations, see:
	 * [1] https://en.wikipedia.org/wiki/Parallel_axis_theorem#Tensor_generalization
	 * [2] http://www.kwon3d.com/theory/moi/triten.html
	 * 
	 * 
	 * @param delta vector position from center of mass to desired reference
	 *              location
	 * 
	 * @return MassData the new MassData instance
	 */
	public RigidBody translateInertia(final Coordinate delta) {
		final Coordinate newLocation = this.cm.add(delta);
		return rebase(newLocation, this.transverseCM.add(delta));
	}

}
