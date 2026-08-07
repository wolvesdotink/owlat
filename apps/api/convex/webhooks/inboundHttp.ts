/**
 * The small rules every inbound webhook route obeys, in one place.
 *
 * The two routes that accept provider feedback — the core adapters' shared
 * pipeline (`./pipeline.ts`) and the bundled-plugin route
 * (`./pluginFeedbackHttp.ts`) — deliberately do NOT share their middles: the
 * plugin route's verifier is the host's rather than an adapter's, and it carries
 * two gates the core kinds have no notion of. But the batch-dispatch rule below
 * is the same fact for both, and it is load-bearing for the Send lifecycle, so
 * it lives here rather than in two copies that can drift apart while both look
 * right.
 *
 * `jsonResponse` is here for the same reason. It is not `lib/httpResponse.ts`'s:
 * that one carries the Operation error envelope (`{ error: { category, … } }`)
 * for our own API surfaces, while a webhook answers a third party's console with
 * a flat `{ error: '…' }` and takes its status first.
 */

import type { ActionCtx } from '../_generated/server';
import { dispatchInboundEvent } from './dispatcher';
import type { InboundEvent } from './types';

/** A webhook-shaped JSON response: status first, flat body. */
export function jsonResponse(status: number, body: Record<string, unknown>): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}

/**
 * A dispatch that failed, naming the event it failed on so the caller can log
 * the kind and re-surface the original cause.
 */
export class InboundBatchDispatchError extends Error {
	constructor(
		readonly event: InboundEvent,
		/** The dispatcher's own throw, unwrapped, for the caller's log line. */
		readonly reason: unknown
	) {
		super(reason instanceof Error ? reason.message : 'Dispatch failed');
		this.name = 'InboundBatchDispatchError';
	}
}

/** What a batch left behind: its last dispatched event and that event's result. */
export interface InboundBatchOutcome {
	/** `undefined` only for an empty batch. */
	readonly event: InboundEvent | undefined;
	readonly result: unknown;
}

/**
 * Dispatch a provider batch IN ORDER, AND SEQUENTIALLY.
 *
 * A provider batch is a timeline for a single message as often as it is a fan of
 * unrelated ones (`deferral` then `hard_bounce` on the same id), and the Send
 * lifecycle's legal-edge graph reads the state the previous event left behind.
 * Dispatching concurrently would race two transitions on one row for no latency
 * we need.
 *
 * A FAILURE FAILS THE WHOLE BATCH, deliberately: the provider redelivers it, and
 * every downstream reducer is idempotent per transition (a repeat is
 * `duplicate` / `terminal`, never a second effect), so replaying the already
 * applied prefix costs nothing and losing the unapplied tail would cost a
 * suppression.
 *
 * Both callers pass `returnResult: true` so this function has one shape; a
 * caller with no use for the result simply ignores it.
 */
export async function dispatchEventsInOrder(
	ctx: ActionCtx,
	events: readonly InboundEvent[]
): Promise<InboundBatchOutcome> {
	let event: InboundEvent | undefined;
	let result: unknown;
	for (const next of events) {
		event = next;
		try {
			result = await dispatchInboundEvent(ctx, next, { returnResult: true });
		} catch (error) {
			throw new InboundBatchDispatchError(next, error);
		}
	}
	return { event, result };
}
