/**
 * Shared accessor-safe readers for generated hosted-plugin modules — TWO BARS,
 * and which one a registry wants is a real choice.
 *
 * {@link snapshotHostedModule} is the PERMISSIVE one: it copies the fields it was
 * asked for and ignores everything else on the object. Every hosted registry
 * (agent steps, automation triggers, automation steps) uses it, because those
 * registrations are read field-by-field and an extra key is inert.
 *
 * {@link readExactDataObject} and {@link readExactFunctionModule} are the EXACT
 * ones: own key set, prototype and value shapes are all pinned, so a generated
 * import carrying a getter, a prototype, a symbol key or a key the contract does
 * not have is refused. The send-transport tier reads generated modules this way —
 * the send half, the feedback webhook half and the sending-domain identity half
 * are all boundaries where an unexpected surface is the interesting one, and the
 * failure has to happen at module load rather than one frame inside a live send,
 * a live webhook or a scheduled identity call.
 *
 * ONE COPY OF THE EXACT BAR, deliberately: the three send-tier boundaries had
 * grown three hand-written versions of it, and the next hardening (a Proxy rule,
 * a tighter prototype rule) would have landed in whichever one its author was
 * editing while the other two stayed green on the weaker check.
 *
 * Both bars copy ONLY own, enumerable, data-property values and never invoke an
 * accessor.
 *
 * Non-node so it is importable from both the Node-only step registries and the
 * mutation-runtime trigger registry.
 */

function ownFunction(value: object, field: string): ((...args: never[]) => unknown) | undefined {
	const descriptor = Object.getOwnPropertyDescriptor(value, field);
	return descriptor &&
		descriptor.enumerable &&
		'value' in descriptor &&
		typeof descriptor.value === 'function'
		? (descriptor.value as (...args: never[]) => unknown)
		: undefined;
}

export function snapshotHostedModule<T>(
	value: unknown,
	required: readonly string[],
	optional: readonly string[],
	errorMessage: string
): T {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError(errorMessage);
	}
	const snapshot: Record<string, (...args: never[]) => unknown> = {};
	for (const field of required) {
		const fn = ownFunction(value, field);
		if (!fn) throw new TypeError(errorMessage);
		snapshot[field] = fn;
	}
	for (const field of optional) {
		const fn = ownFunction(value, field);
		if (fn) snapshot[field] = fn;
	}
	return Object.freeze(snapshot) as T;
}

/**
 * Every own key must be one this contract knows, every REQUIRED key must be
 * present, and every value must be a plain data property on a plain object.
 *
 * `optionalKeys` is what lets a module ship an extras builder without loosening
 * anything else: an unknown key is still refused, so a bundled module cannot
 * smuggle in a surface the host never agreed to call. Symbol-keyed own
 * properties are refused for the same reason.
 *
 * The prototype read and the descriptor read are wrapped, so an exotic object
 * whose traps throw is a refusal at load rather than an unhandled throw out of a
 * module-scope registry.
 */
export function readExactDataObject(
	input: unknown,
	requiredKeys: readonly string[],
	optionalKeys: readonly string[],
	errorMessage: string
): Record<string, unknown> {
	if (input === null || typeof input !== 'object' || Array.isArray(input)) {
		throw new TypeError(errorMessage);
	}
	let prototype: object | null;
	let descriptors: Record<PropertyKey, PropertyDescriptor>;
	try {
		prototype = Object.getPrototypeOf(input);
		descriptors = Object.getOwnPropertyDescriptors(input);
	} catch {
		throw new TypeError(errorMessage);
	}
	if (prototype !== Object.prototype && prototype !== null) {
		throw new TypeError(errorMessage);
	}
	const keys = Reflect.ownKeys(descriptors);
	if (
		keys.length < requiredKeys.length ||
		keys.some(
			(key) =>
				typeof key !== 'string' || !(requiredKeys.includes(key) || optionalKeys.includes(key))
		)
	) {
		throw new TypeError(errorMessage);
	}
	const values: Record<string, unknown> = {};
	for (const key of requiredKeys) {
		const descriptor = descriptors[key];
		if (!descriptor?.enumerable || !('value' in descriptor)) {
			throw new TypeError(errorMessage);
		}
		values[key] = descriptor.value;
	}
	for (const key of optionalKeys) {
		const descriptor = descriptors[key];
		if (descriptor === undefined) continue;
		if (!descriptor.enumerable || !('value' in descriptor)) {
			throw new TypeError(errorMessage);
		}
		values[key] = descriptor.value;
	}
	return values;
}

/**
 * A generated module exposing EXACTLY `requiredKeys`, every one of them a
 * function.
 *
 * The shape the two catalogs that resolve a bundled send transport's non-send
 * halves want — one call each, no optional surface — expressed on top of the
 * exact reader above so the prototype rule, the key-set rule and the
 * accessor rule have one statement rather than one per boundary.
 */
export function readExactFunctionModule<T>(
	input: unknown,
	requiredKeys: readonly string[],
	errorMessage: string
): T {
	const values = readExactDataObject(input, requiredKeys, [], errorMessage);
	for (const key of requiredKeys) {
		if (typeof values[key] !== 'function') throw new TypeError(errorMessage);
	}
	return Object.freeze(values) as T;
}
