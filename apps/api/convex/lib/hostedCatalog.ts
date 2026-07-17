/**
 * One resolver shape for a host-composed registry: a built-in catalog unified
 * with a statically bundled plugin catalog. Plugin entries are additive and
 * namespaced (`plugin.<id>.<x>`), so the merged key set must be unique — a
 * plugin kind can never shadow a core kind or another plugin's kind. A
 * collision throws at module load so composition fails closed. Shared by the
 * webhook-event and import-provider catalogs.
 */

export interface HostedCatalog<E extends { readonly kind: string }> {
	/** Frozen core-then-plugin entry list, in composition order. */
	readonly all: readonly E[];
	/** Frozen list of every composed kind, in composition order. */
	readonly kinds: readonly string[];
	/** Whether `kind` is a known composed kind. */
	has(kind: string | null | undefined): boolean;
	/** The entry for `kind`, or `undefined` when unknown. */
	get(kind: string | null | undefined): E | undefined;
	/** The entry for `kind`, throwing when unknown. */
	entryFor(kind: string): E;
}

export function composeHostedCatalog<E extends { readonly kind: string }>(
	core: readonly E[],
	plugin: readonly E[],
	label: string
): HostedCatalog<E> {
	const all = Object.freeze([...core, ...plugin]);
	const byKind = new Map(all.map((entry) => [entry.kind, entry] as const));
	if (byKind.size !== all.length) {
		const capitalized = label.charAt(0).toUpperCase() + label.slice(1);
		throw new TypeError(`${capitalized} kinds (core + bundled plugin) must be unique`);
	}
	const kinds = Object.freeze(all.map((entry) => entry.kind));
	return Object.freeze({
		all,
		kinds,
		has: (kind: string | null | undefined) => kind != null && byKind.has(kind),
		get: (kind: string | null | undefined) => (kind == null ? undefined : byKind.get(kind)),
		entryFor: (kind: string) => {
			const entry = byKind.get(kind);
			if (!entry) throw new TypeError(`Unknown ${label} kind`);
			return entry;
		},
	});
}
