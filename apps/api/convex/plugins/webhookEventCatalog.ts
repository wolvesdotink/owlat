import type { PluginId, PluginWebhookEventKind } from '@owlat/plugin-kit';
import { BUNDLED_PLUGIN_WEBHOOK_EVENT_CATALOG } from './webhookEventCatalog.generated';

/**
 * Host view of a plugin-published webhook event. Data-only: a plugin ships no
 * executable code for the event itself, so the catalog carries just the
 * namespaced wire kind, its owner, and its subscription eligibility. The
 * authorization seam (`webhookEventAuthorization.ts`) rechecks flag, grant, and
 * env before a plugin is allowed to publish one of these kinds.
 */
export interface HostedWebhookEventDefinition {
	readonly kind: PluginWebhookEventKind;
	readonly pluginId: PluginId;
	readonly description: string;
	readonly subscribable: boolean;
	readonly requiredCapability: 'webhooks:publish';
}

export const WEBHOOK_EVENT_CATALOG =
	BUNDLED_PLUGIN_WEBHOOK_EVENT_CATALOG as readonly HostedWebhookEventDefinition[];

export function pluginWebhookEventDefinition(
	kind: string
): HostedWebhookEventDefinition | undefined {
	return WEBHOOK_EVENT_CATALOG.find((definition) => definition.kind === kind);
}
