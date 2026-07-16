import type { PluginId } from './pluginId';

/** Capability the host assigns to every plugin that publishes webhook events. */
export const PLUGIN_WEBHOOK_EVENT_CAPABILITY = 'webhooks:publish' as const;

export type PluginWebhookEventCapability = typeof PLUGIN_WEBHOOK_EVENT_CAPABILITY;
export type PluginWebhookEventLocalId = string;

/**
 * Namespaced wire literal for a plugin-published webhook event. Core events
 * keep their flat literals (`email.sent`, `contact.created`, …); every plugin
 * event is `plugin.<pluginId>.<localId>` so a plugin can never shadow or
 * collide with a core event or another plugin's event.
 */
export type PluginWebhookEventKind = `plugin.${PluginId}.${PluginWebhookEventLocalId}`;

/**
 * Data-only descriptor for one webhook event type a plugin publishes. The
 * plugin ships no executable code for the event itself — it hands the host
 * already-built (and therefore untrusted) payload data at emit time, which the
 * host clamps and scrubs before delivery.
 */
export interface PluginWebhookEventDefinition {
	readonly id: PluginWebhookEventLocalId;
	/** Operator-facing one-line description of what the event signals. */
	readonly description: string;
	/**
	 * Whether customer webhook endpoints may subscribe to this event and
	 * receive it via fan-out. Non-subscribable events are only ever delivered
	 * to a single explicit target.
	 */
	readonly subscribable: boolean;
}

export function pluginWebhookEventKind(
	pluginId: PluginId,
	localId: PluginWebhookEventLocalId
): PluginWebhookEventKind {
	return `plugin.${pluginId}.${localId}`;
}
