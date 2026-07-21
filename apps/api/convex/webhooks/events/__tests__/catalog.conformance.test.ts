import { describe, expect, it, vi } from 'vitest';

/**
 * Conformance: composing the built-in webhook event registry with the bundled
 * plugin catalog must preserve every core event's membership, description,
 * subscription eligibility, and the subscribable-set semantics (the synthetic
 * `test` event is never subscribable). Plugin events are additive and
 * namespaced; they can never shadow a core kind.
 */

vi.mock('../../../plugins/webhookEventCatalog.generated', () => ({
	BUNDLED_PLUGIN_WEBHOOK_EVENT_CATALOG: Object.freeze([
		Object.freeze({
			kind: 'plugin.crm-pack.deal-won',
			pluginId: 'crm-pack',
			description: 'A deal was won',
			subscribable: true,
			requiredCapability: 'webhooks:publish',
		}),
		Object.freeze({
			kind: 'plugin.crm-pack.internal-sync',
			pluginId: 'crm-pack',
			description: 'Internal sync tick',
			subscribable: false,
			requiredCapability: 'webhooks:publish',
		}),
	]),
}));

import {
	isSubscribableWebhookEventKind,
	isWebhookEventKind,
	SUBSCRIBABLE_WEBHOOK_EVENT_KINDS,
	webhookEventCatalogEntry,
	WEBHOOK_EVENT_KINDS,
} from '../catalog';

const CORE_KINDS = [
	'email.sent',
	'email.delivered',
	'email.opened',
	'email.clicked',
	'email.bounced',
	'email.complained',
	'contact.created',
	'topic.unsubscribed',
	'test',
];

const CORE_SUBSCRIBABLE = CORE_KINDS.filter((k) => k !== 'test');

describe('composed webhook event catalog conformance', () => {
	it('retains every built-in event kind', () => {
		for (const kind of CORE_KINDS) {
			expect(isWebhookEventKind(kind)).toBe(true);
		}
	});

	it('keeps the core subscribable set exactly (test excluded) and adds only subscribable plugin events', () => {
		expect([...SUBSCRIBABLE_WEBHOOK_EVENT_KINDS].sort()).toEqual(
			[...CORE_SUBSCRIBABLE, 'plugin.crm-pack.deal-won'].sort()
		);
		expect(isSubscribableWebhookEventKind('test')).toBe(false);
		expect(isSubscribableWebhookEventKind('plugin.crm-pack.internal-sync')).toBe(false);
	});

	it('namespaces plugin events without shadowing core kinds', () => {
		expect(WEBHOOK_EVENT_KINDS).toContain('plugin.crm-pack.deal-won');
		expect(isWebhookEventKind('plugin.crm-pack.deal-won')).toBe(true);
		expect(webhookEventCatalogEntry('plugin.crm-pack.deal-won').pluginId).toBe('crm-pack');
		// Core entries carry no plugin ownership.
		expect(webhookEventCatalogEntry('email.sent').pluginId).toBeUndefined();
	});

	it('rejects unknown kinds', () => {
		expect(isWebhookEventKind('nope')).toBe(false);
		expect(isWebhookEventKind(undefined)).toBe(false);
		expect(() => webhookEventCatalogEntry('nope')).toThrow('Unknown webhook event kind');
	});

	it('fails closed at load when a plugin kind shadows a core kind', async () => {
		vi.resetModules();
		vi.doMock('../../../plugins/webhookEventCatalog.generated', () => ({
			BUNDLED_PLUGIN_WEBHOOK_EVENT_CATALOG: Object.freeze([
				Object.freeze({
					kind: 'email.sent',
					pluginId: 'crm-pack',
					description: 'Shadow of a core kind',
					subscribable: true,
					requiredCapability: 'webhooks:publish',
				}),
			]),
		}));
		await expect(import('../catalog')).rejects.toThrow(
			'Webhook event kinds (core + bundled plugin) must be unique'
		);
		vi.doUnmock('../../../plugins/webhookEventCatalog.generated');
		vi.resetModules();
	});
});
