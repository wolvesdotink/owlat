import type { PluginId } from './pluginId';

/** Capability the host assigns to every plugin that contributes navigation items. */
export const PLUGIN_NAV_ITEM_CAPABILITY = 'ui:navigation' as const;

export type PluginNavItemCapability = typeof PLUGIN_NAV_ITEM_CAPABILITY;
export type PluginNavItemLocalId = string;

/**
 * Namespaced identity for a plugin-contributed navigation destination. Core
 * items keep their flat hrefs as identity; every plugin item is
 * `plugin.<pluginId>.<localId>` so a plugin can never shadow or collide with a
 * core destination or another plugin's destination.
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
	/** Absolute internal dashboard path the destination links to. */
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
