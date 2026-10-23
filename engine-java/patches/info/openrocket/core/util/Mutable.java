package info.openrocket.core.util;

/**
 * A utility class helping an object to be made immutable after a certain point
 * of time.
 * An object should contain an instance of Mutable and an immute() method which
 * calls
 * {@link #immute()}. Additionally, every method that changes the state of the
 * object
 * should call {@link #check()} before modification.
 * <p>
 * Only the immutable state is retained, avoiding captured stack receivers in TeaVM.
 * 
 * @author Sampo Niskanen <sampo.niskanen@iki.fi>
 */
public class Mutable implements Cloneable {

	private boolean immutable = false;

	/**
	 * Mark the object immutable. Once the object has been called the object
	 * cannot be made mutable again. Repeated calls to this method have no effect.
	 */
	public void immute() {
		immutable = true;
	}

	/**
	 * Check that the object is still mutable, and throw an exception if it is not.
	 * The message preserves the original no-message Throwable's text, without a cause.
	 * 
	 * @throws IllegalStateException if {@link #immute()} has been called for this
	 *                               object.
	 */
	public void check() {
		if (immutable) {
			throw new IllegalStateException("Object has been made immutable at null");
		}
	}

	/**
	 * Check whether this object is still mutable.
	 * 
	 * @return whether this object is still mutable.
	 */
	public boolean isMutable() {
		return !immutable;
	}

	/**
	 * Return a new Mutable instance with the same state as the current object.
	 */
	@Override
	public Mutable clone() {
		try {
			return (Mutable) super.clone();
		} catch (CloneNotSupportedException e) {
			throw new BugException("CloneNotSupportedException", e);
		}
	}
}
