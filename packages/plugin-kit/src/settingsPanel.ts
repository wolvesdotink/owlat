import type { PluginLocalId } from './namespacedKind';

/** Capability the host assigns to every plugin that contributes settings panels. */
export const PLUGIN_SETTINGS_PANEL_CAPABILITY = 'ui:settings' as const;

/**
 * Data-only descriptor for one entry a plugin adds to the workspace settings
 * section. The plugin ships no executable code for the entry itself — it is a
 * labelled link to a settings destination. The host clamps and scrubs the label
 * before rendering, gates it behind the plugin's feature flag, and orders it
 * deterministically after every core settings entry.
 */
export interface PluginSettingsPanelDefinition {
	readonly id: PluginLocalId;
	/** Settings entry label (host-clamped and injection-scrubbed at render time). */
	readonly name: string;
	/** Absolute internal dashboard path the entry links to. */
	readonly href: string;
	/** Icon token, for example `lucide:sliders-horizontal`. */
	readonly icon: string;
	/** Ordering hint among this plugin's settings entries (default: declaration order). */
	readonly order?: number;
}
