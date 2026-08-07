/**
 * Inbound webhook pipeline — shared HTTP shell for per-provider adapters.
 *
 * Pipeline: rate-limit → adapter.verifySignature → conditional audit-store
 * → adapter.parseEvent → dispatchInboundEvent → HTTP response.
 *
 * Replaces the verify/parse/audit/dispatch ceremony that each provider's own
 * HTTP entry point used to open-code. The send-provider half of those entry
 * points is now one parameterized dispatcher over one registry
 * (`./providerFeedbackHttp.ts` + `./adapters/index.ts`, the seams plan's P2.1);
 * the channel half still registers a handler per vendor (`./channels.ts`).
 */

import { internal } from '../_generated/api';
import type { ActionCtx } from '../_generated/server';
import { getClientIp, rateLimitedResponse } from '../publicRateLimit';
import { logError } from '../lib/runtimeLog';
import { InboundBatchDispatchError, dispatchEventsInOrder, jsonResponse } from './inboundHttp';
import type { InboundEvent } from './types';

/**
 * @typeParam S - This adapter's own wire identifier, as a literal type where the
 * caller cares which one it is. It defaults to `string`, so an adapter that is
 * nobody's registry value (the channel adapters) writes `InboundAdapter` exactly
 * as before; the four send-provider feedback adapters name their kind, which is
 * what lets `./adapters/index.ts` prove at compile time that the key a route is
 * dispatched by IS the source the pipeline rate-limits and audits under. Keyed
 * and sourced are two spellings of one fact, and they used to be kept in
 * agreement only by a runtime test in another folder.
 */
export interface InboundAdapter<S extends string = string> {
	/** Wire identifier for audit-payload `source` field and logs. */
	readonly source: S;
	/**
	 * Verify the request signature. Must read its secret via
	 * `lib/env.getOptional` and fail-closed with status 503 when the secret
	 * is unset.
	 */
	verifySignature(
		request: Request,
		rawBody: string
	): Promise<{ ok: true } | { ok: false; status: number; reason: string }>;
	/**
	 * Translate the verified raw body into a normalized InboundEvent or null
	 * when the provider sent an event kind we don't act on. Adapters never
	 * touch the database and never dispatch.
	 *
	 * A provider that delivers a BATCH per request implements
	 * `InboundBatchAdapter` below instead of this method.
	 */
	parseEvent(rawBody: string): InboundEvent | null;
	/**
	 * Optional raw-audit gate for purpose-specific, privacy-sensitive protocols.
	 * It runs only after signature verification. Returning false must be paired
	 * with a dispatcher path that retains only its explicitly authorized data.
	 * All adapters retain the established raw-audit behavior by default.
	 */
	shouldStoreRawPayload?: (rawBody: string) => boolean;
	/**
	 * Optional per-provider success response factory. Providers whose wire
	 * contract dictates a non-JSON response (Twilio TwiML, Meta plain
	 * `200 OK`) supply this. Must construct a fresh Response per call —
	 * Response bodies are one-shot streams. When absent, the pipeline
	 * returns its default JSON envelope `{success: true, kind}`.
	 *
	 * Called with the LAST dispatched event of a batch and its result. No
	 * batching provider supplies one today; a future one that does must accept
	 * that a single response describes the whole batch.
	 */
	successResponse?: (event: InboundEvent, dispatchResult?: unknown) => Response;
}

/**
 * An adapter for a provider that delivers a BATCH of events per request.
 *
 * Mandrill posts a `mandrill_events` array of up to thousands of items (plan
 * D10) where Resend, SES and the MTA post one event each. Rather than widening
 * `parseEvent` — which would make every single-event adapter's return type
 * `InboundEvent | InboundEvent[] | null` and push the narrowing onto every
 * caller — a batch provider implements `parseEvents` and the pipeline
 * dispatches the result IN ORDER. Everything else (rate limit, signature
 * verification, raw-audit storage, response shaping) is identical, so the rest
 * of the contract is inherited.
 *
 * Returning an empty array is the same acknowledgement as `parseEvent`
 * returning null: it is how a batch of nothing but events we don't act on —
 * and Mandrill's empty-batch verification ping — are answered 200 without
 * dispatching anything.
 */
export interface InboundBatchAdapter<S extends string = string> extends Omit<
	InboundAdapter<S>,
	'parseEvent'
> {
	parseEvents(rawBody: string): InboundEvent[];
}

/** Either adapter shape. What `runInboundPipeline` accepts. */
export type AnyInboundAdapter<S extends string = string> =
	| InboundAdapter<S>
	| InboundBatchAdapter<S>;

export async function runInboundPipeline(
	ctx: ActionCtx,
	request: Request,
	adapter: AnyInboundAdapter
): Promise<Response> {
	if (request.method !== 'POST') {
		return jsonResponse(405, { error: 'Method not allowed' });
	}

	// Key the ingestion bucket per provider source (`<source>:<ip>`). The limit
	// is consumed before signature verification (so unsigned junk still spends a
	// token), and getClientIp() collapses to 'unknown' for every caller when
	// RATE_LIMIT_TRUSTED_PROXY is unset (the default). Without the per-source
	// prefix, a flood on the cheapest path (e.g. /webhooks/sms) would drain one
	// shared bucket and 429 legitimate Resend/MTA bounce + complaint webhooks —
	// dropping suppression events and harming sender reputation. Per-source keys
	// confine a flood to the targeted provider.
	const ip = getClientIp(request);
	const { ok: rateOk, retryAfter } = await ctx.runMutation(
		internal.publicRateLimit.checkPublicRateLimit,
		{ limitType: 'webhookIngestion', key: `${adapter.source}:${ip}` }
	);
	if (!rateOk) return rateLimitedResponse(retryAfter);

	let rawBody: string;
	try {
		rawBody = await request.text();
	} catch {
		return jsonResponse(400, { error: 'Failed to read request body' });
	}

	const verification = await adapter.verifySignature(request, rawBody);
	if (!verification.ok) {
		logError(`[${adapter.source} Webhook] ${verification.reason}`);
		return jsonResponse(verification.status, { error: verification.reason });
	}

	if (adapter.shouldStoreRawPayload?.(rawBody) !== false) {
		// Audit-store raw payload (non-blocking — never fail the webhook on this).
		try {
			await ctx.runMutation(internal.webhooks.payloads.store, {
				source: adapter.source,
				rawPayload: rawBody,
			});
		} catch {
			// intentionally swallowed
		}
	}

	let events: InboundEvent[];
	try {
		if ('parseEvents' in adapter) {
			events = adapter.parseEvents(rawBody);
		} else {
			const parsed = adapter.parseEvent(rawBody);
			events = parsed ? [parsed] : [];
		}
	} catch (err) {
		logError(`[${adapter.source} Webhook] Failed to parse event:`, err);
		return jsonResponse(400, { error: 'Invalid event payload' });
	}

	if (events.length === 0) {
		// Provider sent an event kind we don't act on — acknowledge.
		return jsonResponse(200, { success: true, ignored: true });
	}

	// In order, sequentially, and the whole batch fails together — the rule and
	// its rationale live in `./inboundHttp.ts`, because the plugin feedback route
	// grades the same Send lifecycle and must not drift from it.
	let event = events[0]!;
	let dispatchResult: unknown;
	try {
		const outcome = await dispatchEventsInOrder(ctx, events);
		event = outcome.event ?? event;
		dispatchResult = outcome.result;
	} catch (err) {
		if (err instanceof InboundBatchDispatchError) {
			logError(`[${adapter.source} Webhook] Dispatcher error for ${err.event.kind}:`, err.reason);
		} else {
			logError(`[${adapter.source} Webhook] Dispatcher error for ${event.kind}:`, err);
		}
		return jsonResponse(500, { error: 'Failed to process event' });
	}

	if (adapter.successResponse) {
		return adapter.successResponse(event, dispatchResult);
	}
	return events.length === 1
		? jsonResponse(200, { success: true, kind: event.kind })
		: jsonResponse(200, { success: true, processed: events.length });
}
