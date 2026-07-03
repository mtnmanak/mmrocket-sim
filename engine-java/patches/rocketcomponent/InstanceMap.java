package info.openrocket.core.rocketcomponent;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.LinkedHashMap;

import info.openrocket.core.util.Transformation;

/**
 *
 * @author teyrana (aka Daniel Williams) <equipoise@gmail.com>
 *
 */
// PATCH(online-openrocket): HashMap -> LinkedHashMap. RocketComponent has no
// hashCode() override, so HashMap iteration order follows identity hash codes,
// which vary per JVM process. BarrowmanCalculator iterates this map when
// summing per-component aerodynamic forces every simulation step; a varying
// summation order produces ULP-level differences that chaos-amplify over a
// flight, making simulations nondeterministic run-to-run (and JVM-vs-TeaVM
// differential comparison impossible). LinkedHashMap iterates in insertion
// order — the deterministic tree-walk order — identically on JVM and TeaVM.
// See patches/LEDGER.md.
public class InstanceMap extends LinkedHashMap<RocketComponent, ArrayList<InstanceContext>> {

	// =========== Public Functions ========================

	// public InstanceMap() {}

	public int count(final RocketComponent key) {
		if (containsKey(key)) {
			return get(key).size();
		} else {
			return 0;
		}
	}

	public void emplace(final RocketComponent component, int number, final Transformation transform) {
		if (!containsKey(component)) {
			put(component, new ArrayList<>());
		}

		final InstanceContext context = new InstanceContext(component, number, transform);
		get(component).add(context);
	}

	public List<InstanceContext> getInstanceContexts(final RocketComponent key) {
		return get(key);
	}

	// this is primarily for debugging.
	@Override
	public String toString() {
		StringBuffer buffer = new StringBuffer();
		int outerIndex = 0;
		buffer.append(">> Printing InstanceMap:\n");
		for (Map.Entry<RocketComponent, ArrayList<InstanceContext>> entry : entrySet()) {
			final RocketComponent key = entry.getKey();
			final ArrayList<InstanceContext> contexts = entry.getValue();
			buffer.append(String.format("....[% 2d]:[%s]\n", outerIndex, key.getName()));
			outerIndex++;

			int innerIndex = 0;
			for (InstanceContext ctxt : contexts) {
				buffer.append(String.format("........[@% 2d][% 2d]  %s\n", innerIndex, ctxt.instanceNumber,
						ctxt.getLocation().toPreciseString()));
				innerIndex++;
			}
		}

		return buffer.toString();
	}

	// =========== Instance Member Variables ========================

	// =========== Private Instance Functions ========================

}
