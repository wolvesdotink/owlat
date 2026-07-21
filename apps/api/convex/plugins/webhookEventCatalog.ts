import type { PluginWebhookEventKind } from '@owlat/plugin-kit';
import { BUNDLED_PLUGIN_WEBHOOK_EVENT_CATALOG } from './webhookEventCatalog.generated';
import {
	defineHostedContributionCatalog,
	type HostedContributionDefinition,
} from './hostedContributionCatalog';

/**
 * Host view of a plugin-published webhook event. Data-only: a plugin ships no
 * executable code for the event itself, so the catalog carries just the
 * namespaced wire kind, its owner, and its subscription eligibility. The
 * authorization seam (`webhookEventAuthorization.ts`) rechecks flag, grant, and
 * env before a plugin is allowed to publish one of these kinds.
 */
export interface HostedWebhookEventDefinition extends HostedContributionDefinition<'webhooks:publish'> {
	readonly kind: PluginWebhookEventKind;
	readonly description: string;
	readonly subscribable: boolean;
}

const CATALOG = defineHostedContributionCatalog<HostedWebhookEventDefinition>(
	BUNDLED_PLUGIN_WEBHOOK_EVENT_CATALOG,
	'webhook event'
);

export const WEBHOOK_EVENT_CATALOG = CATALOG.all;

export function pluginWebhookEventDefinition(
	kind: string
): HostedWebhookEventDefinition | undefined {
	return CATALOG.byKind(kind);
}
