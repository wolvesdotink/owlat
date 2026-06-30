/**
 * Typed scheduler helpers for outbound Webhook event fanout.
 *
 * Callers in `sendLifecycle`, `contacts`, `topics` etc. import these
 * instead of poking the fanout action directly. Each helper resolves the
 * Webhook event module from the registry, calls `module.build(input)` to
 * produce the wire payload, then schedules the matching internal action.
 *
 * Runtime validation of the built payload happens at the Convex action
 * boundary (`args.data: jsonPrimitiveRecord`). The compile-time safety
 * comes from FanoutSpec/DeliverSpec — a discriminated mapped type that
 * pairs every literal with its required input shape.
 */

import type {
	GenericActionCtx,
	GenericMutationCtx,
} from 'convex/server';
import type { DataModel, Id } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import {
	WEBHOOK_EVENT_REGISTRY,
	type WebhookEventLiteral,
	type WebhookEventInputFor,
} from './events/registry';

/** Subscribable literals only — `test` is excluded (per-target via DeliverSpec). */
export type SubscribableWebhookEventLiteral = Exclude<
	WebhookEventLiteral,
	'test'
>;

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
export type DeliverSpec = {
	[L in WebhookEventLiteral]: {
		literal: L;
		input: WebhookEventInputFor<L>;
	};
}[WebhookEventLiteral];

/**
 * Helpers accept either a MutationCtx or an ActionCtx — both have the
 * scheduler the fanout actions need.
 */
type ScheduleCtx =
	| GenericMutationCtx<DataModel>
	| GenericActionCtx<DataModel>;

/** Wire-compatible payload — matches the Convex `jsonPrimitiveRecord` validator. */
type WirePayload = Record<string, string | number | boolean | null>;

function buildPayload(spec: FanoutSpec | DeliverSpec): WirePayload {
	const module = WEBHOOK_EVENT_REGISTRY[spec.literal];
	return (module.build as (input: unknown) => WirePayload)(spec.input);
}

/** Schedule an event to fan out to every active subscribed webhook. */
export async function scheduleFanout(
	ctx: ScheduleCtx,
	spec: FanoutSpec
): Promise<void> {
	const data = buildPayload(spec);
	await ctx.scheduler.runAfter(0, internal.webhooks.fanout.fanoutEvent, {
		event: spec.literal,
		data,
	});
}

/** Schedule an event for delivery to a specific webhook. */
export async function scheduleDeliver(
	ctx: ScheduleCtx,
	webhookId: Id<'webhooks'>,
	spec: DeliverSpec
): Promise<void> {
	const data = buildPayload(spec);
	await ctx.scheduler.runAfter(0, internal.webhooks.fanout.deliverEvent, {
		webhookId,
		event: spec.literal,
		data,
	});
}
