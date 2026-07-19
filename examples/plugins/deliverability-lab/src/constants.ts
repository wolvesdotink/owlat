import { parsePluginId, type PluginId } from '@owlat/plugin-kit';

/**
 * The plugin's validated identity, shared by the manifest and every namespaced
 * kind it derives (job kinds, gate kinds, flag namespace). Parsed once so an
 * invalid id would fail at module load rather than silently producing malformed
 * namespaced strings.
 */
export const DELIVERABILITY_LAB_PLUGIN_ID: PluginId = parsePluginId('deliverability-lab');
