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

import type { PluginId } from '@owlat/plugin-kit';
import { WEBHOOK_EVENT_CATALOG } from '../../plugins/webhookEventCatalog';
import { WEBHOOK_EVENT_REGISTRY, type WebhookEventLiteral } from './registry';

export type CoreWebhookEventKind = WebhookEventLiteral;
export type WebhookEventKind = string;

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

export const WEBHOOK_EVENT_CATALOG_ALL: readonly WebhookEventCatalogEntry[] = Object.freeze([
	...CORE_WEBHOOK_EVENT_CATALOG,
	...WEBHOOK_EVENT_CATALOG.map((entry) => ({
		kind: entry.kind,
		description: entry.description,
		subscribable: entry.subscribable,
		pluginId: entry.pluginId,
		requiredCapability: entry.requiredCapability,
	})),
]);

const catalogByKind = new Map(WEBHOOK_EVENT_CATALOG_ALL.map((entry) => [entry.kind, entry]));

if (catalogByKind.size !== WEBHOOK_EVENT_CATALOG_ALL.length) {
	throw new TypeError('Webhook event kinds (core + bundled plugin) must be unique');
}

export const WEBHOOK_EVENT_KINDS = Object.freeze(
	WEBHOOK_EVENT_CATALOG_ALL.map((entry) => entry.kind)
);

/** Subscribable subset (core `test` and non-subscribable plugin events excluded). */
export const SUBSCRIBABLE_WEBHOOK_EVENT_KINDS = Object.freeze(
	WEBHOOK_EVENT_CATALOG_ALL.filter((entry) => entry.subscribable).map((entry) => entry.kind)
);

export function isWebhookEventKind(kind: string | null | undefined): boolean {
	return kind != null && catalogByKind.has(kind);
}

export function isSubscribableWebhookEventKind(kind: string | null | undefined): boolean {
	return kind != null && (catalogByKind.get(kind)?.subscribable ?? false);
}

export function webhookEventCatalogEntry(kind: string): WebhookEventCatalogEntry {
	const entry = catalogByKind.get(kind);
	if (!entry) throw new TypeError('Unknown webhook event kind');
	return entry;
}
