import type { PluginId } from './pluginId';

/** Capability the host assigns to every plugin that contributes settings panels. */
export const PLUGIN_SETTINGS_PANEL_CAPABILITY = 'ui:settings' as const;

export type PluginSettingsPanelCapability = typeof PLUGIN_SETTINGS_PANEL_CAPABILITY;
export type PluginSettingsPanelLocalId = string;

/**
 * Namespaced identity for a plugin-contributed settings entry. Core entries
 * keep their flat hrefs as identity; every plugin entry is
 * `plugin.<pluginId>.<localId>` so a plugin can never shadow or collide with a
 * core settings entry or another plugin's entry.
 */
export type PluginSettingsPanelKind = `plugin.${PluginId}.${PluginSettingsPanelLocalId}`;

/**
 * Data-only descriptor for one entry a plugin adds to the workspace settings
 * section. The plugin ships no executable code for the entry itself — it is a
 * labelled link to a settings destination. The host clamps and scrubs the label
 * before rendering, gates it behind the plugin's feature flag, and orders it
 * deterministically after every core settings entry.
 */
export interface PluginSettingsPanelDefinition {
	readonly id: PluginSettingsPanelLocalId;
	/** Settings entry label (host-clamped and injection-scrubbed at render time). */
	readonly name: string;
	/** Absolute internal dashboard path the entry links to. */
	readonly href: string;
	/** Icon token, for example `lucide:sliders-horizontal`. */
	readonly icon: string;
	/** Ordering hint among this plugin's settings entries (default: declaration order). */
	readonly order?: number;
}

export function pluginSettingsPanelKind(
	pluginId: PluginId,
	localId: PluginSettingsPanelLocalId
): PluginSettingsPanelKind {
	return `plugin.${pluginId}.${localId}`;
}
