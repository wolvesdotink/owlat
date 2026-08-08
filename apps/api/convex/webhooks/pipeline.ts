/**
 * Inbound webhook pipeline — shared HTTP shell for per-provider adapters.
 *
 * Pipeline: rate-limit → adapter.verifySignature → conditional audit-store
 * → adapter.parseEvent → dispatchInboundEvent → HTTP response.
 *
 * Replaces the verify/parse/audit/dispatch ceremony that resendWebhook.ts
 * and mtaWebhook.ts each open-coded.
 */

import { internal } from '../_generated/api';
import type { ActionCtx } from '../_generated/server';
import { getClientIp, rateLimitedResponse } from '../publicRateLimit';
import { logError } from '../lib/runtimeLog';
import { dispatchInboundEvent } from './dispatcher';
import type { InboundEvent } from './types';

export interface InboundAdapter {
	/** Wire identifier for audit-payload `source` field and logs. */
	readonly source: string;
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
export interface InboundBatchAdapter extends Omit<InboundAdapter, 'parseEvent'> {
	parseEvents(rawBody: string): InboundEvent[];
}

/** Either adapter shape. What `runInboundPipeline` accepts. */
export type AnyInboundAdapter = InboundAdapter | InboundBatchAdapter;

function jsonResponse(status: number, body: Record<string, unknown>): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}

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

	// IN ORDER, AND SEQUENTIALLY. A provider batch is a timeline for a single
	// message as often as it is a fan of unrelated ones (`deferral` then
	// `hard_bounce` on the same id), and the Send lifecycle's legal-edge graph
	// reads the state the previous event left behind. Dispatching concurrently
	// would race two transitions on one row for no latency we need.
	//
	// A FAILURE FAILS THE WHOLE BATCH, deliberately: the provider redelivers it,
	// and every downstream reducer is idempotent per transition (a repeat is
	// `duplicate` / `terminal`, never a second effect), so replaying the already
	// applied prefix costs nothing and losing the unapplied tail would cost a
	// suppression.
	let event = events[0]!;
	let dispatchResult: unknown;
	try {
		for (const next of events) {
			event = next;
			dispatchResult = await dispatchInboundEvent(ctx, next, { returnResult: true });
		}
	} catch (err) {
		logError(`[${adapter.source} Webhook] Dispatcher error for ${event.kind}:`, err);
		return jsonResponse(500, { error: 'Failed to process event' });
	}

	if (adapter.successResponse) {
		return adapter.successResponse(event, dispatchResult);
	}
	return events.length === 1
		? jsonResponse(200, { success: true, kind: event.kind })
		: jsonResponse(200, { success: true, processed: events.length });
}
