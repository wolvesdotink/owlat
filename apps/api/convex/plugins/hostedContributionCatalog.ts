import type { PluginCapability, PluginId } from '@owlat/plugin-kit';

/**
 * The shape every hosted contribution catalog entry shares.
 *
 * Six catalogs repeated `{ kind, pluginId, requiredCapability, … }` by hand and
 * two of them typed `pluginId` as a bare `string`. That drift was not cosmetic:
 * `HostedContributionAuthorizationSpec.definitionFor` requires a branded
 * `PluginId`, so the two string-typed catalogs were structurally locked out of
 * the shared runtime-authorization path and had to keep their own copy of it.
 * One base type keeps the ownership check on the branded id everywhere, which is
 * what makes the shared authorization seam usable by every bucket.
 */
export interface HostedContributionDefinition<C extends PluginCapability = PluginCapability> {
	/** Namespaced `plugin.<pluginId>.<localId>` kind. */
	readonly kind: string;
	/** Owning plugin. Branded, so an ownership compare cannot be fooled by a string. */
	readonly pluginId: PluginId;
	/** Capability the host rechecks immediately before running the contribution. */
	readonly requiredCapability: C;
}

/** A composed catalog: the generated entry list plus one lookup. */
export interface HostedContributionCatalog<E extends HostedContributionDefinition> {
	readonly all: readonly E[];
	/** The entry for `kind`, or `undefined` when unknown. */
	byKind(kind: string): E | undefined;
}

/**
 * Compose one generated catalog into its host view.
 *
 * Deliberately reads the generated array on every lookup rather than snapshotting
 * it: the catalog is a module-level binding a deployment never mutates, and the
 * seam tests swap the generated module's contents between cases. A snapshot
 * would make the seams untestable in exchange for nothing — these lists hold one
 * entry per contributed kind of one bucket, so the scan is over a handful of
 * entries. The load-time uniqueness check turns a codegen collision into an
 * immediate failure instead of a silently shadowed contribution.
 */
export function defineHostedContributionCatalog<E extends HostedContributionDefinition>(
	generated: readonly unknown[],
	label: string
): HostedContributionCatalog<E> {
	const all = generated as readonly E[];
	if (new Set(all.map((entry) => entry.kind)).size !== all.length) {
		throw new TypeError(`Bundled ${label} kinds must be unique`);
	}
	return Object.freeze({
		get all(): readonly E[] {
			return all;
		},
		byKind: (kind: string): E | undefined => all.find((entry) => entry.kind === kind),
	});
}
