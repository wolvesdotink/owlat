import { parsePluginId, type PluginId } from '@owlat/plugin-kit';

/**
 * The plugin's validated identity, shared by the manifest and every namespaced
 * kind derived from it (agent step kind, automation kinds, webhook event kind,
 * flag namespace). Parsing once at module load means an invalid id fails loudly
 * instead of silently producing malformed namespaced strings.
 */
export const ESCALATION_GUARD_PLUGIN_ID: PluginId = parsePluginId('escalation-guard');
