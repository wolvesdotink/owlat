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
 * cheapest and most conclusive checks run first and nothing writes to the
 * database on behalf of a caller who has not proved possession of the secret:
 *
 *   1. method + path      — POST only; exactly one path segment after the prefix
 *   2. registration       — an id no bundled webhook claims is 404, before I/O
 *   3. rate limit         — per plugin id; every unknown id shares one bucket, so
 *                           guessing ids cannot mint buckets
 *   4. size               — a body larger than the cap is refused unread
 *   5. signature          — host-verified HMAC over `<timestamp>.<body>`, plus
 *                           the timestamp freshness the contract declares
 *   6. authorization      — flag, operator grant, env and singleton scope,
 *                           rechecked now (`sendTransportWebhookAuthorization`)
 *   7. replay             — the delivery digest is claimed, or this is a repeat
 *   8. parse              — the plugin's parse-only module, its output revalidated
 *                           by the host before anything is trusted
 *   9. retention          — raw payload stored only if the adapter opted in
 *  10. dispatch           — the same inbound plane the core adapters feed
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

import { internal } from '../_generated/api';
import { httpAction, type ActionCtx } from '../_generated/server';
import { logError } from '../lib/runtimeLog';
import {
	pluginSendTransportWebhookFor,
	type HostedSendTransportWebhook,
} from '../plugins/sendTransportWebhookCatalog';
import { verifyPluginReplayBoundSignature } from '../plugins/inboundSignature';
import { getClientIp, rateLimitedResponse } from '../publicRateLimit';
import { dispatchInboundEvent } from './dispatcher';
import { parsePluginFeedbackEvents } from './pluginFeedbackEvents';

/** The route prefix. One segment follows it: the plugin id, and nothing else. */
export const PLUGIN_FEEDBACK_PATH_PREFIX = '/webhooks/plugin/';

/**
 * Largest accepted body. Generous for a feedback batch and far below the
 * runtime's own limit, so an oversized post is refused by us, with a code the
 * provider can act on, rather than by the platform.
 */
const MAX_BODY_BYTES = 1_048_576;

function jsonResponse(status: number, body: Record<string, unknown>): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
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
	if (rawBody.length > MAX_BODY_BYTES) {
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
	const verification = await verifyPluginReplayBoundSignature(
		signature,
		rawBody,
		request.headers.get(signature.header),
		request.headers.get(signature.replay.timestampHeader),
		Date.now()
	);
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
	// race in a single mutation and exactly one wins.
	const claimed = await ctx.runMutation(internal.webhooks.pluginFeedbackDeliveries.claim, {
		pluginId,
		transportKind: definition.kind,
		deliveryDigest: verification.deliveryDigest,
		expiresAt: verification.expiresAtMs,
	});
	if (!claimed) {
		return jsonResponse(409, { error: 'Duplicate webhook delivery' });
	}

	try {
		return await applyDelivery(ctx, pluginId, webhook, rawBody, module.parseEvents(rawBody));
	} catch (error) {
		// The claim goes back: a body we could not apply is a delivery that did not
		// happen, and the provider's retry must not be mistaken for an attack.
		await releaseClaim(ctx, verification.deliveryDigest);
		logError(`[${definition.kind} Webhook] Failed to apply delivery:`, error);
		return jsonResponse(error instanceof DeliveryDispatchError ? 500 : 400, {
			error:
				error instanceof DeliveryDispatchError
					? 'Failed to process event'
					: 'Invalid event payload',
		});
	}
}

/** Raised where a failure is OURS (dispatch), not the payload's. */
class DeliveryDispatchError extends Error {}

async function applyDelivery(
	ctx: ActionCtx,
	pluginId: string,
	webhook: HostedSendTransportWebhook,
	rawBody: string,
	parsed: unknown
): Promise<Response> {
	const { definition } = webhook;
	// (8) The plugin's output is untrusted input, exactly as a send attempt's
	// result is: the host re-validates every field and refuses anything it cannot
	// attribute. A throw here is a 400 — the payload's fault, not ours.
	const events = parsePluginFeedbackEvents(parsed, definition.kind);

	// (9) RETENTION IS OPT-IN. A third party's payload can carry recipient
	// content this deployment never asked to keep, so a plugin adapter must ask
	// for raw storage rather than inherit it from the core providers' default.
	if (definition.storeRawPayload) {
		try {
			await ctx.runMutation(internal.webhooks.payloads.store, {
				source: definition.kind,
				rawPayload: rawBody,
			});
		} catch {
			// Audit storage never fails a webhook.
		}
	}

	// (10) In order and sequentially, like the core pipeline: a batch is as often
	// one message's timeline as a fan of unrelated ones, and each dispatch reads
	// the state the previous one left.
	try {
		for (const event of events) await dispatchInboundEvent(ctx, event);
	} catch (error) {
		await recordOutcome(ctx, pluginId, definition.kind, 'failed');
		throw new DeliveryDispatchError(error instanceof Error ? error.message : 'dispatch failed');
	}
	await recordOutcome(ctx, pluginId, definition.kind, 'completed');
	return jsonResponse(200, { success: true, processed: events.length });
}

/**
 * Audit the delivery under the plugin's own attribution. Scheduled rather than
 * awaited inline for the same reason the send path schedules its outcome: an
 * audit-write failure must not turn an applied delivery into a 500 the provider
 * retries.
 */
async function recordOutcome(
	ctx: ActionCtx,
	pluginId: string,
	transportKind: string,
	outcome: 'completed' | 'failed'
): Promise<void> {
	await ctx.scheduler.runAfter(
		0,
		internal.plugins.sendTransportWebhookAuthorization.recordOutcome,
		{ pluginId, transportKind, outcome }
	);
}

async function releaseClaim(ctx: ActionCtx, deliveryDigest: string): Promise<void> {
	try {
		await ctx.runMutation(internal.webhooks.pluginFeedbackDeliveries.release, { deliveryDigest });
	} catch {
		// A claim we cannot release simply expires with its tolerance window.
	}
}
