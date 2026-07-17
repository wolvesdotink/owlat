/**
 * A one-way freeze latch for a module-level registry: it starts mutable, flips
 * to frozen exactly once via `finalize()`, and never flips back.
 *
 * The block registries in `@owlat/email-builder` (the third-party block
 * definitions and the editor module registry) each need the same latch shape —
 * a `frozen` flag, a guard that throws on late mutation, a `finalize()`, and an
 * `isFrozen()`. This helper is that shape in one place so the two registries
 * cannot drift. (The renderer package ships its own copies for its two block
 * registries; migrating those is out of scope for this piece.)
 */

/** A one-way freeze latch. See `createFreezeLatch`. */
export interface FreezeLatch {
	/**
	 * Throw if the registry is frozen. Call this at the top of every mutator;
	 * `id` names the entry being registered so the error is actionable.
	 */
	assertMutable(id: string): void;
	/** Latch the registry shut. Idempotent. */
	finalize(): void;
	/** Is the registry frozen? */
	isFrozen(): boolean;
}

/** The registry-specific words that shape a latch's error message. */
export interface FreezeLatchLabels {
	/** What one entry is called, e.g. `"block definition"`, `"editor module"`. */
	readonly noun: string;
	/** The registry's name, e.g. `"block definition registry"`. */
	readonly registryName: string;
	/** The plural used in the remediation hint, e.g. `"blocks"`, `"modules"`. */
	readonly plural: string;
	/** The finalize function's name, named in the remediation hint. */
	readonly finalizeFn: string;
}

/**
 * Build a fresh freeze latch. Each call owns its own `frozen` flag, so distinct
 * registries never share latch state.
 */
export function createFreezeLatch(labels: FreezeLatchLabels): FreezeLatch {
	let frozen = false;
	return {
		assertMutable(id: string): void {
			if (frozen) {
				throw new Error(
					`Cannot register ${labels.noun} "${id}": the ${labels.registryName} is frozen. Register ${labels.plural} during setup before ${labels.finalizeFn}().`
				);
			}
		},
		finalize(): void {
			frozen = true;
		},
		isFrozen(): boolean {
			return frozen;
		},
	};
}
