import { isPluginId, parsePluginId, type PluginId } from './pluginId';

/**
 * The ONE place the namespaced-kind grammar is written.
 *
 * Every contributed kind is `plugin.<pluginId>.<localId>`. That grammar used to
 * be restated eleven times — a `PluginXLocalId = string` alias, a
 * `PluginXKind` template type and a `pluginXKind()` builder per bucket — while
 * the seven places that actually construct a kind (codegen and the automation
 * trigger seam) bypassed all of them and inlined the template literal. So the
 * grammar existed in eighteen places and no single edit could change it.
 *
 * A namespaced kind is a security boundary, not a display string: the host tells
 * core kinds from plugin kinds by this prefix, and every ownership check compares
 * the plugin id embedded in it. It gets one builder, one parser and one prefix
 * constant.
 */
export const PLUGIN_KIND_NAMESPACE = 'plugin' as const;

/** `plugin.` — the prefix every host `startsWith` check must use. */
export const PLUGIN_KIND_PREFIX = `${PLUGIN_KIND_NAMESPACE}.` as const;

const LOCAL_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MAX_LOCAL_ID_LENGTH = 64;

/**
 * A contribution's plugin-local identifier: the `id` of one entry in one
 * `contributes.<bucket>[]` array. Unique only within its plugin and bucket — the
 * namespaced kind is what is globally unique.
 */
export type PluginLocalId = string;

/** A contributed kind, `plugin.<pluginId>.<localId>`. */
export type PluginNamespacedKind<L extends PluginLocalId = PluginLocalId> =
	`${typeof PLUGIN_KIND_NAMESPACE}.${PluginId}.${L}`;

export class PluginLocalIdError extends Error {
	constructor() {
		super('Invalid plugin contribution local id');
		this.name = 'PluginLocalIdError';
	}
}

export function isPluginLocalId(value: unknown): value is PluginLocalId {
	return typeof value === 'string' && value.length <= MAX_LOCAL_ID_LENGTH && LOCAL_ID.test(value);
}

export function parsePluginLocalId(value: unknown): PluginLocalId {
	if (!isPluginLocalId(value)) throw new PluginLocalIdError();
	return value;
}

/**
 * Build the namespaced kind for one contribution. Both halves are validated, so
 * a kind can never carry a separator, whitespace, or an id shape the parser
 * below would read back differently.
 */
export function pluginNamespacedKind<L extends PluginLocalId>(
	pluginId: PluginId,
	localId: L
): PluginNamespacedKind<L> {
	return `${PLUGIN_KIND_NAMESPACE}.${parsePluginId(pluginId)}.${parsePluginLocalId(localId) as L}`;
}

/** Whether `kind` is a plugin-contributed kind rather than a core one. */
export function isPluginNamespacedKind(kind: unknown): kind is PluginNamespacedKind {
	return typeof kind === 'string' && parsePluginNamespacedKind(kind) !== undefined;
}

/**
 * Read a namespaced kind back into its parts, or `undefined` when it is not one.
 * The inverse of {@link pluginNamespacedKind}: an ownership check that compares
 * the parsed `pluginId` cannot be fooled by a local id containing a dot, because
 * only the first two segments are structural and both are re-validated.
 */
export function parsePluginNamespacedKind(
	kind: string
): { readonly pluginId: PluginId; readonly localId: PluginLocalId } | undefined {
	const parts = kind.split('.');
	if (parts.length !== 3) return undefined;
	const [namespace, pluginId, localId] = parts as [string, string, string];
	if (namespace !== PLUGIN_KIND_NAMESPACE) return undefined;
	if (!isPluginId(pluginId) || !isPluginLocalId(localId)) return undefined;
	return Object.freeze({ pluginId, localId });
}
