/**
 * Convex validators for the Webhook event literal union.
 *
 * Per-event description, isSubscribable flag, schema, and build function
 * live on each Webhook event module under `webhooks/events/<dir>/index.ts`,
 * registered in `webhooks/events/registry.ts`. This file is just the
 * enumerated Convex validators — they stay enumerated (not derived via
 * `.map() + spread`) so TypeScript preserves per-literal narrowing on
 * `defineTable` / `v.array(webhookEventValidator)` consumers.
 *
 * A compile-time assertion below guarantees the two validators cover the
 * registry's keys exactly — adding a Webhook event module without
 * appending its literal here is a type error.
 */

import { v, type Infer } from 'convex/values';
import type { WebhookEventLiteral } from './events/registry';

/** All event literals (subscribable + synthetic `test`). Used by the wire payload. */
export const webhookEventValidator = v.union(
	v.literal('email.sent'),
	v.literal('email.delivered'),
	v.literal('email.opened'),
	v.literal('email.clicked'),
	v.literal('email.bounced'),
	v.literal('email.complained'),
	v.literal('contact.created'),
	v.literal('topic.unsubscribed'),
	v.literal('test'),
);

/** Subscribable subset (excludes `test`). Used by webhook create/update/listByEvent args. */
export const subscribableWebhookEventValidator = v.union(
	v.literal('email.sent'),
	v.literal('email.delivered'),
	v.literal('email.opened'),
	v.literal('email.clicked'),
	v.literal('email.bounced'),
	v.literal('email.complained'),
	v.literal('contact.created'),
	v.literal('topic.unsubscribed'),
);

// ─── Compile-time: webhookEventValidator ≡ keys of WEBHOOK_EVENT_REGISTRY ──
// If you add a module to the registry without appending its literal to
// `webhookEventValidator` above (or vice versa), this stops compiling.

type AssertEqual<A, B> = [A] extends [B]
	? [B] extends [A]
		? true
		: { error: 'Validator has literals missing from registry'; missing: Exclude<B, A> }
	: { error: 'Registry has literals missing from validator'; missing: Exclude<A, B> };

const _WEBHOOK_EVENT_LITERALS_IN_SYNC: AssertEqual<
	WebhookEventLiteral,
	Infer<typeof webhookEventValidator>
> = true;
void _WEBHOOK_EVENT_LITERALS_IN_SYNC;
