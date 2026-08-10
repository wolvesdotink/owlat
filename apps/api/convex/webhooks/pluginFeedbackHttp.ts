/**
 * BUNDLED-PLUGIN FEEDBACK WEBHOOK — one route for every plugin transport that
 * reports its own outcomes (the seams plan's D6, wired by P2.2).
 *
 *     POST /webhooks/plugin/<pluginId>
 *
 * This is the most exposed surface the plugin platform has: unauthenticated and
 * internet-facing by design, because the caller is a third-party ESP that will
 * never hold an Owlat session. Everything below is therefore written as a
 * sequence of gates that each fail CLOSED, in an order chosen so that the
 * cheapest and most conclusive checks run first and NOTHING BUT A RATE-LIMIT
 * TOKEN is spent on behalf of a caller who has not proved possession of the
 * secret — no audit row, no delivery claim, no retained payload:
 *
 *   1. method + path      — POST only; exactly one path segment after the prefix
 *   2. rate limit         — per plugin id; every unknown id shares one bucket, so
 *                           guessing ids cannot mint buckets. First because a
 *                           limiter that does not record cannot limit, which is
 *                           why the core pipeline spends its token first too —
 *                           and it is the one write an unproven caller causes.
 *   3. registration       — an id no bundled webhook claims is 404, before the
 *                           body is read: no signature oracle, no parse, no row
 *   4. size               — a body over the cap is refused on its DECLARED length
 *                           when it has one, and on its actual byte length
 *                           otherwise (a chunked caller declares nothing, so that
 *                           body is buffered before it can be measured)
 *   5. signature          — host-verified under the scheme the contract declares
 *                           (the HMAC over `<timestamp>.<body>`, or Svix), plus
 *                           the timestamp freshness the contract declares
 *   6. authorization      — flag, operator grant, env and singleton scope,
 *                           rechecked now (`sendTransportWebhookAuthorization`)
 *   7. replay             — the delivery digest is claimed, or this is a repeat of
 *                           one already applied (200) or still in flight (503)
 *   8. retention          — raw payload stored only if the adapter opted in, and
 *                           stored BEFORE the plugin's module runs (see below)
 *   9. parse              — the plugin's parse-only module, its output revalidated
 *                           by the host before anything is trusted
 *  10. dispatch           — the same inbound plane the core adapters feed
 *
 * WHY RETENTION PRECEDES PARSE. Verify → store → parse is the core pipeline's own
 * order, and for the same reason: the delivery an operator most needs the bytes
 * of is the one that FAILED to parse. A plugin whose parse half has drifted from
 * its provider's real payloads drops 100% of that transport's feedback, and a
 * retention that ran only after a successful parse would keep nothing at all
 * about exactly that outage. Nothing security-related argues for the later
 * placement — by this point the body is signature-verified, fresh, claimed and
 * authorized.
 *
 * WHY NOT `runInboundPipeline`. The shared pipeline's shape is
 * verify → audit → parse → dispatch with a per-adapter verifier. Here the
 * verifier is the HOST's (a plugin never decides whether a request is
 * authentic), there are two additional gates the core kinds have no notion of
 * (grant recheck and replay), and the parsed events are untrusted output that
 * must be revalidated. Reusing the pipeline would have meant a plugin-shaped
 * adapter carrying host-owned verification — the conflation this seam exists to
 * avoid — so the two stay separate and the core path is untouched.
 *
 * WHAT IS DELIBERATELY NOT HERE: the reserved `inboundAdapters` contribution
 * bucket, which is held for genuine inbound MAIL sources, and the core kinds'
 * static `/webhooks/<kind>` routes, whose URLs live in provider consoles we do
 * not own.
 */

import { PLUGIN_WEBHOOK_MAX_BODY_BYTES } from '@owlat/plugin-kit';
import { internal } from '../_generated/api';
import { httpAction, type ActionCtx } from '../_generated/server';
import { logError } from '../lib/runtimeLog';
import {
	pluginSendTransportWebhookFor,
	type HostedSendTransportWebhook,
} from '../plugins/sendTransportWebhookCatalog';
import { verifyPluginWebhookDelivery } from '../plugins/inboundSignature';
import { getClientIp, rateLimitedResponse } from '../publicRateLimit';
import { InboundBatchDispatchError, dispatchEventsInOrder, jsonResponse } from './inboundHttp';
import type { PluginFeedbackClaimResult } from './pluginFeedbackDeliveries';
import {
	PluginFeedbackBatchTooLargeError,
	parsePluginFeedbackEvents,
} from './pluginFeedbackEvents';

/** The route prefix. One segment follows it: the plugin id, and nothing else. */
export const PLUGIN_FEEDBACK_PATH_PREFIX = '/webhooks/plugin/';

/**
 * Largest accepted body, in BYTES of UTF-8 — not in string length, which counts
 * UTF-16 units and would let a body of three-byte characters run to three times
 * the documented cap. Generous for a feedback batch and far below the runtime's
 * own limit, so an oversized post is refused by us, with a code the provider can
 * act on, rather than by the platform. Declared in the kit beside the per-batch
 * event cap, because both are terms a plugin author writes against.
 */
const MAX_BODY_BYTES = PLUGIN_WEBHOOK_MAX_BODY_BYTES;

/**
 * Whether the read body exceeds the cap.
 *
 * The cheap test first: a UTF-8 encoding is never SHORTER than the string's
 * UTF-16 length, so a string longer than the cap is over it without encoding
 * anything. Only a string that could still fit is encoded, which bounds the
 * measurement's own cost.
 */
function exceedsBodyCap(rawBody: string): boolean {
	if (rawBody.length > MAX_BODY_BYTES) return true;
	return new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES;
}

/**
 * The plugin id in `/webhooks/plugin/<pluginId>`, or `null`.
 *
 * Convex matches a `pathPrefix` route on the prefix alone, so anything deeper
 * (`/webhooks/plugin/a/b`) arrives here too and must be rejected rather than
 * silently read as `a`. The id itself is not parsed into its branded form here:
 * the registry lookup is the authority on which ids exist, and an id that fails
 * `parsePluginId` simply is not in it.
 */
function pluginIdFromPath(url: string): string | null {
	const path = new URL(url).pathname;
	if (!path.startsWith(PLUGIN_FEEDBACK_PATH_PREFIX)) return null;
	const segment = path.slice(PLUGIN_FEEDBACK_PATH_PREFIX.length);
	if (segment.length === 0 || segment.length > 128 || segment.includes('/')) return null;
	return segment;
}

/**
 * Spend a rate-limit token for this caller.
 *
 * Keyed per plugin id so one provider's flood cannot 429 another's bounce feed —
 * the same reasoning as the core pipeline's `<source>:<ip>` buckets. An id that
 * matches no webhook collapses to ONE shared bucket: otherwise walking made-up
 * ids would be a way to mint an unbounded number of fresh buckets and defeat the
 * limit entirely.
 */
async function spendRateLimitToken(
	ctx: ActionCtx,
	request: Request,
	pluginId: string | null
): Promise<Response | null> {
	const ip = getClientIp(request);
	const { ok, retryAfter } = await ctx.runMutation(internal.publicRateLimit.checkPublicRateLimit, {
		limitType: 'webhookIngestion',
		key: `plugin:${pluginId ?? 'unknown'}:${ip}`,
	});
	return ok ? null : rateLimitedResponse(retryAfter);
}

export const pluginFeedbackWebhook = httpAction(async (ctx, request) => {
	if (request.method !== 'POST') {
		return jsonResponse(405, { error: 'Method not allowed' });
	}

	const pluginId = pluginIdFromPath(request.url);
	const webhook = pluginId === null ? undefined : pluginSendTransportWebhookFor(pluginId);

	const limited = await spendRateLimitToken(ctx, request, webhook ? pluginId : null);
	if (limited) return limited;

	// UNKNOWN ID. Answered the same way a route that does not exist would be, and
	// answered before any body is read: a caller who cannot name a bundled webhook
	// gets no signature oracle, no parse, and no row anywhere.
	if (!webhook || pluginId === null) {
		return jsonResponse(404, { error: 'Unknown plugin webhook' });
	}

	const declaredLength = Number(request.headers.get('content-length') ?? '0');
	if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
		return jsonResponse(413, { error: 'Payload too large' });
	}
	let rawBody: string;
	try {
		rawBody = await request.text();
	} catch {
		return jsonResponse(400, { error: 'Failed to read request body' });
	}
	if (exceedsBodyCap(rawBody)) {
		return jsonResponse(413, { error: 'Payload too large' });
	}

	return deliver(ctx, request, pluginId, webhook, rawBody);
});

async function deliver(
	ctx: ActionCtx,
	request: Request,
	pluginId: string,
	webhook: HostedSendTransportWebhook,
	rawBody: string
): Promise<Response> {
	const { definition, module } = webhook;
	const { signature } = definition;

	// (5) AUTHENTICITY, host-owned. The plugin's own module is not consulted:
	// it never sees the secret and never decides whether bytes are trustworthy.
	// WHICH host scheme proves it is the contract's declaration and the verifier's
	// dispatch, not this route's business — every arm answers in the same terms, so
	// nothing below gate 5 knows or cares which one ran. The delivery is named by
	// the plugin it arrived for, so one plugin's claim can never answer for
	// another's — see `deliveryDigestOf`.
	const verification = await verifyPluginWebhookDelivery({
		contract: signature,
		pluginId,
		transportKind: definition.kind,
		rawBody,
		headers: request.headers,
		nowMs: Date.now(),
	});
	if (!verification.ok) {
		logError(`[${definition.kind} Webhook] ${verification.reason}`);
		return jsonResponse(verification.status, { error: verification.reason });
	}

	// (6) AUTHORIZATION, after authenticity so that a stranger cannot make us
	// write audit rows, and before the replay claim so a denial leaves no state.
	// A disabled plugin or a revoked grant stops inbound events as surely as it
	// stops outbound sends.
	const authorized = await ctx.runMutation(
		internal.plugins.sendTransportWebhookAuthorization.authorizeDelivery,
		{ pluginId, transportKind: definition.kind }
	);
	if (!authorized) {
		return jsonResponse(403, { error: 'Plugin webhook delivery is not authorized' });
	}

	// (7) REPLAY. The claim is atomic: two concurrent copies of one delivery
	// race in a single mutation and exactly one wins. The loser is told which
	// case it lost to, because the two are answered differently — see
	// `duplicateResponse`.
	const claimed = await ctx.runMutation(internal.webhooks.pluginFeedbackDeliveries.claim, {
		pluginId,
		transportKind: definition.kind,
		deliveryDigest: verification.deliveryDigest,
		expiresAt: verification.expiresAtMs,
	});
	if (claimed !== 'claimed') return duplicateResponse(claimed);

	// (8) RETENTION IS OPT-IN, and it happens BEFORE the plugin's module runs: a
	// body that fails to parse is precisely the one whose bytes are worth having.
	// A third party's payload can carry recipient content this deployment never
	// asked to keep, so a plugin adapter must ask for raw storage rather than
	// inherit it from the core providers' default.
	if (definition.storeRawPayload) {
		await storeRawPayload(ctx, definition.kind, rawBody);
	}

	try {
		return await applyDelivery(
			ctx,
			pluginId,
			webhook,
			verification.deliveryDigest,
			module.parseEvents(rawBody)
		);
	} catch (error) {
		// The claim goes back: a body we could not apply is a delivery that did not
		// happen, and the provider's retry must not be mistaken for an attack.
		await releaseClaim(ctx, verification.deliveryDigest);
		logError(`[${definition.kind} Webhook] Failed to apply delivery:`, error);
		// AUDITED WHATEVER WENT WRONG. An authenticated, authorized delivery that
		// we then refused is exactly the case an operator opens the Audit Log to
		// explain ("why are no bounces arriving?"), and a plugin whose parse half
		// is wrong against its provider's real payloads drops 100% of its feedback
		// on this path. A row here is the only place that becomes visible.
		await recordOutcome(ctx, pluginId, definition.kind, 'failed');
		return jsonResponse(...deliveryFailureResponse(error));
	}
}

/**
 * How long we ask a provider to wait before re-posting bytes another copy of
 * this same delivery is still working on. A hint, not a contract — every ESP
 * keeps its own backoff schedule — sized to comfortably outlast one batch
 * dispatch so the redelivery arrives after the first copy has resolved either
 * way, rather than joining it in flight.
 */
const IN_FLIGHT_RETRY_AFTER_SECONDS = 30;

/**
 * The second copy of one delivery, answered by WHAT THE FIRST COPY DID.
 *
 * COMPLETED → 200, not 409. Nothing is wrong on either side: our acknowledgement
 * was lost and the provider re-posted the identical signed bytes (Mailgun and
 * Postmark re-send the original payload rather than re-signing it). The batch is
 * already applied, so the state is right either way — but a 4xx here is counted
 * as an endpoint failure, and providers deactivate on a run of those (Postmark
 * after 10 consecutive non-2xx, Mailgun after days of them). Answering a correct
 * redelivery in a way that can cost the operator the whole feedback channel is a
 * worse outcome than any information the status code carried. `duplicate: true`
 * says what happened, mirroring the core pipeline's `ignored: true`.
 *
 * IN FLIGHT → 503, and this is the case a bare 200 loses batches on. Copy A has
 * claimed the digest and is dispatching; copy B is the provider's timeout retry
 * of the very same bytes. Nothing is applied yet, and A may still fail — at which
 * point it releases the claim and answers 5xx, expecting the provider to come
 * back. If B had been told 2xx, the provider has its acknowledgement and never
 * will: the whole batch of bounces, complaints and suppressions is lost with no
 * trace on either side. 503 is a RETRYABLE answer — the same status this route
 * already gives when the signing secret is unset, and carrying the `Retry-After`
 * hint its 429 does — so the provider redelivers after A has resolved. If A
 * succeeded, that redelivery meets a completed claim and gets the 200 above.
 *
 * One 503 among the 2xx a healthy channel returns is not a deactivation risk;
 * silently dropping a batch has no upper bound on what it costs.
 */
function duplicateResponse(outcome: Exclude<PluginFeedbackClaimResult, 'claimed'>): Response {
	if (outcome === 'duplicate_completed') {
		return jsonResponse(200, { success: true, duplicate: true });
	}
	return new Response(JSON.stringify({ error: 'Delivery already in progress', duplicate: true }), {
		status: 503,
		headers: {
			'Content-Type': 'application/json',
			'Retry-After': String(IN_FLIGHT_RETRY_AFTER_SECONDS),
		},
	});
}

/**
 * How a refused delivery reads from the provider's own delivery log.
 *
 * Three distinguishable answers, because the operator's fix differs: 500 when
 * the failure is OURS and a redelivery may work, 413 with the limit when the
 * batch was well formed but bigger than we accept (chunk it), 400 when the
 * payload itself is not something we can apply.
 */
function deliveryFailureResponse(error: unknown): [number, Record<string, unknown>] {
	if (error instanceof InboundBatchDispatchError)
		return [500, { error: 'Failed to process event' }];
	if (error instanceof PluginFeedbackBatchTooLargeError) return [413, { error: error.message }];
	return [400, { error: 'Invalid event payload' }];
}

/**
 * Keep the verified body, for the adapters that asked to.
 *
 * Never fails the delivery — but it SAYS so when it could not write, because a
 * deployment that opted into retention and is silently keeping nothing only
 * discovers it during the dispute the payloads were kept for.
 */
async function storeRawPayload(ctx: ActionCtx, kind: string, rawBody: string): Promise<void> {
	try {
		await ctx.runMutation(internal.webhooks.payloads.store, {
			source: kind,
			rawPayload: rawBody,
		});
	} catch (error) {
		logError(`[${kind} Webhook] Failed to store raw payload:`, error);
	}
}

async function applyDelivery(
	ctx: ActionCtx,
	pluginId: string,
	webhook: HostedSendTransportWebhook,
	deliveryDigest: string,
	parsed: unknown
): Promise<Response> {
	const { definition } = webhook;
	// (9) The plugin's output is untrusted input, exactly as a send attempt's
	// result is: the host re-validates every field and refuses anything it cannot
	// attribute. A throw here is the payload's fault, not ours — 400, or 413 with
	// the limit named when the batch was merely bigger than we accept.
	const events = parsePluginFeedbackEvents(parsed, definition.kind);

	// (10) In order, sequentially, whole batch fails together — the same rule the
	// core pipeline dispatches by, shared rather than restated (`./inboundHttp`).
	// A throw propagates to `deliver`, which releases the claim and audits.
	await dispatchEventsInOrder(ctx, events);
	await markCompleted(ctx, pluginId, definition.kind, deliveryDigest);
	await recordOutcome(ctx, pluginId, definition.kind, 'completed');
	return jsonResponse(200, { success: true, processed: events.length });
}

/**
 * Turn our in-flight claim into a receipt, and stamp the channel as alive.
 *
 * ONLY REACHED WITH EVERY EVENT ALREADY DISPATCHED, which decides how its own
 * failure is handled: NEVER by throwing. A rejection here would land in
 * `deliver`'s catch, which releases the replay claim and answers a non-2xx — so
 * the provider would redeliver bytes we had applied, against a claim we had just
 * given back. The claim then simply expires with the signature tolerance window,
 * which is the same outcome as before this marking existed, and a redelivery
 * inside that window is answered retryably rather than acknowledged. The failure
 * is logged because the other half of this write is what the Delivery page grades
 * a plugin feedback channel by: a deployment whose stamps are silently not
 * landing sees a healthy channel report `awaiting_event`.
 */
async function markCompleted(
	ctx: ActionCtx,
	pluginId: string,
	transportKind: string,
	deliveryDigest: string
): Promise<void> {
	try {
		await ctx.runMutation(internal.webhooks.pluginFeedbackDeliveries.complete, {
			pluginId,
			transportKind,
			deliveryDigest,
		});
	} catch (error) {
		logError(`[${transportKind} Webhook] Failed to record the completed delivery:`, error);
	}
}

/**
 * Audit the delivery under the plugin's own attribution. Scheduled rather than
 * awaited inline for the same reason the send path schedules its outcome: an
 * audit-write failure must not turn an applied delivery into a 500 the provider
 * retries.
 *
 * WHICH IS WHY IT NEVER THROWS, exactly as `storeRawPayload` never throws.
 * Scheduling can itself fail (an unavailable scheduler, a scheduling limit), and
 * the `'completed'` call happens AFTER the events are already in the delivery
 * record: letting that rejection escape would land in `deliver`'s catch, release
 * the replay claim and answer 400 — so the provider would redeliver bytes we had
 * applied, against a claim we had just given back, and apply them twice. The
 * guarantee this function's scheduling exists to provide would be undone by its
 * own failure. A row we could not even schedule is logged and nothing else.
 */
async function recordOutcome(
	ctx: ActionCtx,
	pluginId: string,
	transportKind: string,
	outcome: 'completed' | 'failed'
): Promise<void> {
	try {
		await ctx.scheduler.runAfter(
			0,
			internal.plugins.sendTransportWebhookAuthorization.recordOutcome,
			{ pluginId, transportKind, outcome }
		);
	} catch (error) {
		logError(`[${transportKind} Webhook] Failed to schedule the ${outcome} audit row:`, error);
	}
}

async function releaseClaim(ctx: ActionCtx, deliveryDigest: string): Promise<void> {
	try {
		await ctx.runMutation(internal.webhooks.pluginFeedbackDeliveries.release, { deliveryDigest });
	} catch {
		// A claim we cannot release simply expires with its tolerance window.
	}
}
