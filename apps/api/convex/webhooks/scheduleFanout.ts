/**
 * Typed scheduler helpers for outbound Webhook event fanout.
 *
 * Callers in `sendLifecycle`, `contacts`, `topics` etc. import these
 * instead of scheduling delivery work directly. Each helper resolves the
 * Webhook event module from the registry, calls `module.build(input)` to
 * produce the wire payload, then schedules the matching enqueue MUTATION in
 * `deliveryQueries.ts`, which writes the delivery rows and schedules their
 * first attempts in one transaction. A mutation, not an action: a scheduled
 * mutation runs exactly once, while a scheduled action runs at most once, so
 * an action here could fail after being dequeued and drop the event before
 * any delivery row existed.
 *
 * Runtime validation of the built payload happens at the mutation boundary
 * (`webhookPayloadValidator`). The compile-time safety comes from
 * FanoutSpec/DeliverSpec — a discriminated mapped type that pairs every
 * literal with its required input shape.
 */

import type { GenericActionCtx, GenericMutationCtx } from 'convex/server';
import type { DataModel, Id } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import {
	WEBHOOK_EVENT_REGISTRY,
	type WebhookEventLiteral,
	type WebhookEventInputFor,
} from './events/registry';

/** Subscribable literals only — `test` is excluded (per-target via DeliverSpec). */
type SubscribableWebhookEventLiteral = Exclude<WebhookEventLiteral, 'test'>;

/**
 * Spec for fanout-to-all-subscribed. Mapped type guarantees `input` matches
 * `literal` at the call site.
 */
export type FanoutSpec = {
	[L in SubscribableWebhookEventLiteral]: {
		literal: L;
		input: WebhookEventInputFor<L>;
	};
}[SubscribableWebhookEventLiteral];

/**
 * Spec for per-target delivery — accepts every literal, including `test`.
 */
type DeliverSpec = {
	[L in WebhookEventLiteral]: {
		literal: L;
		input: WebhookEventInputFor<L>;
	};
}[WebhookEventLiteral];

/**
 * Helpers accept either a MutationCtx or an ActionCtx — both have the
 * scheduler the enqueue mutations need.
 */
type ScheduleCtx = GenericMutationCtx<DataModel> | GenericActionCtx<DataModel>;

/** Wire-compatible event data — matches the Convex `jsonPrimitiveRecord` validator. */
type WirePayload = Record<string, string | number | boolean | null>;

/**
 * The full webhook body (`docs/webhook-payloads.md`). The timestamp is taken
 * here, when the event is emitted, not when the enqueue mutation runs.
 */
function buildPayload<L extends WebhookEventLiteral>(spec: { literal: L; input: unknown }) {
	const module = WEBHOOK_EVENT_REGISTRY[spec.literal];
	const data = (module.build as (input: unknown) => WirePayload)(spec.input);
	return { event: spec.literal, timestamp: new Date().toISOString(), data };
}

/** Schedule an event to fan out to every active subscribed webhook. */
export async function scheduleFanout(ctx: ScheduleCtx, spec: FanoutSpec): Promise<void> {
	await ctx.scheduler.runAfter(0, internal.webhooks.deliveryQueries.enqueueFanoutDeliveries, {
		event: spec.literal,
		payload: buildPayload(spec),
	});
}

/** Schedule an event for delivery to a specific webhook. */
export async function scheduleDeliver(
	ctx: ScheduleCtx,
	webhookId: Id<'webhooks'>,
	spec: DeliverSpec
): Promise<void> {
	await ctx.scheduler.runAfter(0, internal.webhooks.deliveryQueries.enqueueDelivery, {
		webhookId,
		event: spec.literal,
		payload: buildPayload(spec),
	});
}
