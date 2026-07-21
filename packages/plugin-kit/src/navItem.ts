import type { PluginId } from './pluginId';

/** Capability the host assigns to every plugin that contributes navigation items. */
export const PLUGIN_NAV_ITEM_CAPABILITY = 'ui:navigation' as const;

export type PluginNavItemCapability = typeof PLUGIN_NAV_ITEM_CAPABILITY;
export type PluginNavItemLocalId = string;

/**
 * Plugin-scoped identity for a plugin-contributed navigation destination,
 * `plugin.<pluginId>.<localId>`. This is the stable handle for flags,
 * telemetry and settings surfaces — it is NOT what the sidebar registry
 * deduplicates on. Registry dedup is by destination href
 * (`derivePluginNavigation` sets each entry's id to its href), which is what
 * prevents a plugin from shadowing a core destination: two entries at the same
 * href collapse first-registered-wins, and core is always registered first.
 *
 * Intended consumer: the plugin-scoped settings index landing in PP-20; until
 * that lands `pluginNavItemKind` is exercised only by its own unit tests.
 */
export type PluginNavItemKind = `plugin.${PluginId}.${PluginNavItemLocalId}`;

/**
 * Data-only descriptor for one sidebar navigation destination a plugin adds.
 * The plugin ships no executable code for the entry itself — it is a labelled
 * link into an existing core section. The host clamps and scrubs the label
 * before rendering, gates the whole entry behind the plugin's feature flag, and
 * orders it deterministically after every core destination.
 */
export interface PluginNavItemDefinition {
	readonly id: PluginNavItemLocalId;
	/**
	 * Key of the core sidebar section the destination attaches to (for example
	 * `audience` or `settings`). An item that targets an unknown or feature-off
	 * section is dropped — a plugin cannot create a new top-level section here.
	 */
	readonly section: string;
	/** Sidebar label (host-clamped and injection-scrubbed at render time). */
	readonly name: string;
	/**
	 * Absolute internal dashboard path the destination links to.
	 *
	 * A plugin cannot ship a page: no arbitrary browser code is loaded at runtime
	 * and codegen emits no Nuxt routes, so this must resolve to a route the
	 * dashboard build already has or the link renders and then 404s. Every plugin
	 * gets `/dashboard/settings/plugins/<pluginId>` — its schema-rendered settings
	 * page — for free; anything else must be a core route, or one the operator's
	 * own build provides.
	 */
	readonly href: string;
	/** Icon token, for example `lucide:sparkles`. */
	readonly icon: string;
	/** Ordering hint among this plugin's items in the same section (default: declaration order). */
	readonly order?: number;
}

export function pluginNavItemKind(
	pluginId: PluginId,
	localId: PluginNavItemLocalId
): PluginNavItemKind {
	return `plugin.${pluginId}.${localId}`;
}
