/**
 * Shared accessor-safe snapshot for generated hosted-plugin modules.
 *
 * Every hosted registry (agent steps, automation triggers, automation steps)
 * turns a generated `{ kind, pluginId, module }` registration into a stable
 * function surface at import time. Generated modules are trusted, but the codegen
 * boundary is still hardened: the snapshot copies ONLY own, enumerable,
 * data-property *function* values and never invokes an accessor. A `required`
 * field that is missing, a non-function, or exposed via a getter/setter throws;
 * an `optional` field is copied only when it is a valid own function (an
 * accessor-based optional is dropped, never read).
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
