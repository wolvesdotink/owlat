/**
 * The shared unknown-input boundary for every operator-persisted config this
 * plugin parses.
 *
 * All three automation modules receive config the host has stored on the
 * operator's behalf and never validated for us, so each `parseConfig` starts
 * from the same two guarantees: the value is a plain object (no exotic
 * prototype, no array, no `null`), and every field is read as an OWN DATA
 * property, so a getter cannot run plugin-visible code and an inherited
 * property cannot smuggle a value past the parser.
 *
 * They live here rather than in one of the modules because a config error is
 * not a trigger, condition or step concern, and because a strengthened guard
 * must land in exactly one place — including in the copy an author makes of
 * this reference.
 */

/** Thrown by every `parseConfig` in this plugin; the host treats it as "do not run". */
export class EscalationConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'EscalationConfigError';
	}
}

/**
 * Assert the untrusted value is a plain object and narrow it. Rejects `null`,
 * primitives, arrays and anything whose prototype is neither `Object.prototype`
 * nor `null` (a class instance, a `Proxy`-backed exotic, a prototype-polluted
 * literal).
 */
export function assertPlainObject(raw: unknown, message: string): asserts raw is object {
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
		throw new EscalationConfigError(message);
	}
	const prototype = Object.getPrototypeOf(raw);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new EscalationConfigError(message);
	}
}

/**
 * Read one own data property. A getter, an accessor, or an inherited property
 * all read as `undefined` rather than executing or resolving up the chain.
 */
export function readOwnValue(raw: object, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(raw, key);
	return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
