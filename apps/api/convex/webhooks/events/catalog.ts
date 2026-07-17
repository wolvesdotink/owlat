/**
 * Host-composed webhook event catalog — the single resolver that unifies the
 * built-in event registry with the statically bundled plugin webhook events.
 *
 * Built-in events keep their flat literals (`email.sent`, `contact.created`,
 * …); every plugin event is namespaced `plugin.<id>.<event>` so a plugin can
 * never shadow a core event or another plugin's event. The outbound fanout and
 * per-target delivery machinery (`webhooks/fanout.ts`, `webhooks/delivery.ts`)
 * are unchanged — only kind resolution is routed through the host here.
 */

import type { PluginId, PluginWebhookEventKind } from '@owlat/plugin-kit';
import { composeHostedCatalog } from '../../lib/hostedCatalog';
import { WEBHOOK_EVENT_CATALOG } from '../../plugins/webhookEventCatalog';
import { WEBHOOK_EVENT_REGISTRY, type WebhookEventLiteral } from './registry';

export type CoreWebhookEventKind = WebhookEventLiteral;
export type WebhookEventKind = CoreWebhookEventKind | PluginWebhookEventKind;

export interface WebhookEventCatalogEntry {
	readonly kind: WebhookEventKind;
	readonly description: string;
	readonly subscribable: boolean;
	/** Present only for plugin-published events. */
	readonly pluginId?: PluginId;
	readonly requiredCapability?: 'webhooks:publish';
}

const CORE_WEBHOOK_EVENT_CATALOG: readonly WebhookEventCatalogEntry[] = Object.values(
	WEBHOOK_EVENT_REGISTRY
).map((module) => ({
	kind: module.literal,
	description: module.description,
	subscribable: module.isSubscribable,
}));

const catalog = composeHostedCatalog<WebhookEventCatalogEntry>(
	CORE_WEBHOOK_EVENT_CATALOG,
	WEBHOOK_EVENT_CATALOG.map((entry) => ({
		kind: entry.kind,
		description: entry.description,
		subscribable: entry.subscribable,
		pluginId: entry.pluginId,
		requiredCapability: entry.requiredCapability,
	})),
	'webhook event'
);

export const WEBHOOK_EVENT_CATALOG_ALL: readonly WebhookEventCatalogEntry[] = catalog.all;

export const WEBHOOK_EVENT_KINDS = catalog.kinds;

/** Subscribable subset (core `test` and non-subscribable plugin events excluded). */
export const SUBSCRIBABLE_WEBHOOK_EVENT_KINDS = Object.freeze(
	catalog.all.filter((entry) => entry.subscribable).map((entry) => entry.kind)
);

export function isWebhookEventKind(kind: string | null | undefined): kind is WebhookEventKind {
	return catalog.has(kind);
}

export function isSubscribableWebhookEventKind(
	kind: string | null | undefined
): kind is WebhookEventKind {
	return catalog.get(kind)?.subscribable ?? false;
}

export function webhookEventCatalogEntry(kind: string): WebhookEventCatalogEntry {
	return catalog.entryFor(kind);
}
