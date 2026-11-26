package info.openrocket.core.util;

import java.util.Collection;
import java.util.LinkedHashSet;
import java.util.Iterator;

/**
 * A Set that additionally implements the Monitorable interface.
 *
 * DETERMINISM PATCH (KD1, 2026-11-25; see engine-java/patches/LEDGER.md):
 * upstream extends HashSet. Its one user is SimulationStatus's deployed
 * recovery devices, which BasicLandingStepper sums CdA over; a RocketComponent
 * hashes by its random UUID, so with three or more devices out at once the sum
 * was taken in a different order every time the same design was rebuilt.
 * LinkedHashSet (a HashSet) iterates in deployment order instead.
 *
 * @author Sampo Niskanen <sampo.niskanen@iki.fi>
 */
public class MonitorableSet<E> extends LinkedHashSet<E> implements Monitorable {

	private ModID modID;

	@Override
	public boolean add(E e) {
		modID = new ModID();
		return super.add(e);
	}

	@Override
	public boolean addAll(Collection<? extends E> c) {
		modID = new ModID();
		return super.addAll(c);
	}

	@Override
	public void clear() {
		modID = new ModID();
		super.clear();
	}

	@Override
	public Iterator<E> iterator() {
		return new MonitorableIterator<>(super.iterator());
	}

	@Override
	public boolean remove(Object o) {
		modID = new ModID();
		return super.remove(o);
	}

	@Override
	public boolean removeAll(Collection<?> c) {
		modID = new ModID();
		return super.removeAll(c);
	}

	@Override
	public boolean retainAll(Collection<?> c) {
		modID = new ModID();
		return super.retainAll(c);
	}

	@Override
	public ModID getModID() {
		return modID;
	}

	@SuppressWarnings("unchecked")
	@Override
	public MonitorableSet<E> clone() {
		return (MonitorableSet<E>) super.clone();
	}

	private class MonitorableIterator<F> implements Iterator<F> {
		private final Iterator<F> iterator;

		public MonitorableIterator(Iterator<F> iterator) {
			this.iterator = iterator;
		}

		@Override
		public boolean hasNext() {
			return iterator.hasNext();
		}

		@Override
		public F next() {
			return iterator.next();
		}

		@Override
		public void remove() {
			iterator.remove();
			modID = new ModID();
		}
	}
}
