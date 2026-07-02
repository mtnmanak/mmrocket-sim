package info.openrocket.core.rocketcomponent;

import info.openrocket.core.util.LongUUID;

/**
 * FlightConfigurationID is a very minimal wrapper class used to identify a
 * given flight configuration for various components and options.
 * It is intended to provide better visibility and traceability by more specific
 * type safety -- this class replaces a
 * straight-up <code>String</code> Key in previous implementations.
 */
public final class FlightConfigurationId implements Comparable<FlightConfigurationId> {
	final public LongUUID key;

	private final static long DEFAULT_MOST_SIG_BITS = 0xF4F2F1F0;
	private final static LongUUID ERROR_UUID = new LongUUID(DEFAULT_MOST_SIG_BITS, 2489);
	private final static String ERROR_KEY_NAME = "ErrorKey";
	private final static LongUUID DEFAULT_VALUE_UUID = new LongUUID(DEFAULT_MOST_SIG_BITS, 5676);
	private final static String DEFAULT_VALUE_NAME = "DefaultKey";

	public final static FlightConfigurationId ERROR_FCID = new FlightConfigurationId(FlightConfigurationId.ERROR_UUID);
	public final static FlightConfigurationId DEFAULT_VALUE_FCID = new FlightConfigurationId(
			FlightConfigurationId.DEFAULT_VALUE_UUID);

	/**
	 * default constructor, builds with an unique random ID
	 */
	public FlightConfigurationId() {
		this(LongUUID.randomUUID());
	}

	/**
	 * builds the id with the given String
	 * 
	 * @param _str the string to be made into the id
	 */
	public FlightConfigurationId(final String _str) {
		LongUUID candidate;
		if (_str == null || _str.isEmpty()) {
			candidate = LongUUID.randomUUID();
		} else {
			try {
				candidate = LongUUID.fromString(_str);
			} catch (IllegalArgumentException iae) {
				candidate = new LongUUID(0, _str.hashCode());
			}
		}
		this.key = candidate;
	}

	/**
	 * builds he id with the given LongUUID object
	 * 
	 * @param _val the LongUUID to be made into the id
	 */
	public FlightConfigurationId(final LongUUID _val) {
		if (null == _val) {
			this.key = FlightConfigurationId.ERROR_UUID;
		} else {
			this.key = _val;
		}
	}

	/**
	 * {@inheritDoc}
	 * considers equals ids with the same key
	 */
	@Override
	public boolean equals(Object anObject) {
		if (!(anObject instanceof FlightConfigurationId)) {
			return false;
		}

		FlightConfigurationId otherFCID = (FlightConfigurationId) anObject;
		return this.key.equals(otherFCID.key);
	}

	/**
	 * 
	 * @return
	 */
	public String toShortKey() {
		if (hasError())
			return FlightConfigurationId.ERROR_KEY_NAME;
		if (isDefaultId())
			return FlightConfigurationId.DEFAULT_VALUE_NAME;
		return this.key.toString().substring(0, 8);

	}

	/**
	 * gets if the id is the default
	 * 
	 * @return if the id is default
	 */
	public boolean isDefaultId() {
		return this.key == FlightConfigurationId.DEFAULT_VALUE_UUID;
	}

	/**
	 * returns the whole key in the id
	 * 
	 * @return the full key of the id
	 */
	public String toFullKey() {
		return this.toString();
	}

	/**
	 * {@inheritDoc}
	 * uses the key hash code
	 */
	@Override
	public int hashCode() {
		return this.key.hashCode();
	}

	/**
	 * checks if the key is the ERROR_UUID flag
	 * 
	 * @return if the id has error
	 */
	public boolean hasError() {
		return (ERROR_UUID == this.key);
	}

	/**
	 * checks if the key from the id is valid
	 * 
	 * @return if the id is valid or not
	 */
	public boolean isValid() {
		return !hasError();
	}

	/**
	 * {@inheritDoc}
	 * same as get full id
	 */
	@Override
	public String toString() {
		return this.key.toString();
	}

	@Override
	public int compareTo(FlightConfigurationId other) {
		return this.key.compareTo(other.key);
	}

	/**
	 * used for debuggin, gets the short key
	 * 
	 * @return the short key version of the id
	 */
	public String toDebug() {
		return this.toShortKey();
	}

}
