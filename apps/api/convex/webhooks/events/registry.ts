/**
 * Webhook event module registry.
 *
 * Single source of truth for outbound Webhook events: each entry pairs a
 * wire literal with its WebhookEventModule. Phase-7 caller migration
 * routes every fanout through this registry's `build` + `schema`
 * validation; the ADR-0002 catalog tuple in `webhooks/events.ts` derives
 * from the registry keys.
 *
 * Adding a new event = one new module folder + one entry below + bumping
 * `webhookEventValidator` if the new literal isn't already there.
 */

import { contactCreated } from './contactCreated';
import { emailBounced } from './emailBounced';
import { emailClicked } from './emailClicked';
import { emailComplained } from './emailComplained';
import { emailDelivered } from './emailDelivered';
import { emailOpened } from './emailOpened';
import { emailSent } from './emailSent';
import { test } from './test';
import { topicUnsubscribed } from './topicUnsubscribed';

export const WEBHOOK_EVENT_REGISTRY = {
	[emailSent.literal]: emailSent,
	[emailDelivered.literal]: emailDelivered,
	[emailOpened.literal]: emailOpened,
	[emailClicked.literal]: emailClicked,
	[emailBounced.literal]: emailBounced,
	[emailComplained.literal]: emailComplained,
	[contactCreated.literal]: contactCreated,
	[topicUnsubscribed.literal]: topicUnsubscribed,
	[test.literal]: test,
} as const;

export type WebhookEventLiteral = keyof typeof WEBHOOK_EVENT_REGISTRY;

export type WebhookEventModuleFor<L extends WebhookEventLiteral> =
	(typeof WEBHOOK_EVENT_REGISTRY)[L];

export type WebhookEventInputFor<L extends WebhookEventLiteral> = Parameters<
	WebhookEventModuleFor<L>['build']
>[0];

export type WebhookEventDataFor<L extends WebhookEventLiteral> = ReturnType<
	WebhookEventModuleFor<L>['build']
>;

/** Subscribable subset (excludes `test`). Used by the events.ts catalog. */
export const SUBSCRIBABLE_LITERALS = Object.values(WEBHOOK_EVENT_REGISTRY)
	.filter((m) => m.isSubscribable)
	.map((m) => m.literal);
