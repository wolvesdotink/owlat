/**
 * Slack approvals reference app — signed interaction callback endpoint (Tier-2
 * connected app, PP-26). Slack POSTs here when a user clicks Approve / Reject.
 *
 * Route: POST /webhooks/slack/approvals
 *
 * The endpoint's ONLY effect is to record one deduplicated vote. It has NO code
 * path that sends mail, approves a message, or bypasses a gate — so even a
 * perfectly-signed Slack request can only ever ADD a vote to the hold record.
 *
 * The route is registered POST-only in http.ts, so the router rejects other
 * methods before the handler runs. Ceremony, fail-closed at each step:
 *   1. rate-limit the ingestion bucket → 429 when drained;
 *   2. verify Slack v0 signature + freshness window (replay defense) → 401/503;
 *   3. parse the interaction payload   → 400 when malformed;
 *   4. record the vote (idempotent)    → 200 ack (also for duplicate/unknown so
 *      the endpoint reveals nothing about which tokens exist).
 */

import { httpAction } from '../_generated/server';
import { internal } from '../_generated/api';
import { getClientIp, rateLimitedResponse } from '../publicRateLimit';
import { getOptional } from '../lib/env';
import { verifySlackSignature } from './signature';
import { parseSlackApprovalCallback } from './payload';

const SLACK_TIMESTAMP_HEADER = 'X-Slack-Request-Timestamp';
const SLACK_SIGNATURE_HEADER = 'X-Slack-Signature';

// public: signature-verified Slack callback (no session); auth is the v0 HMAC.
export const handleSlackApprovalCallback = httpAction(async (ctx, request) => {
	const ip = getClientIp(request);
	const { ok: rateOk, retryAfter } = await ctx.runMutation(
		internal.publicRateLimit.checkPublicRateLimit,
		{ limitType: 'webhookIngestion', key: `slack-approvals:${ip}` }
	);
	if (!rateOk) return rateLimitedResponse(retryAfter);

	let rawBody: string;
	try {
		rawBody = await request.text();
	} catch {
		return jsonResponse(400, { error: 'Unreadable request body' });
	}

	const signature = await verifySlackSignature({
		signingSecret: getOptional('SLACK_APPROVALS_SIGNING_SECRET'),
		timestampHeader: request.headers.get(SLACK_TIMESTAMP_HEADER),
		signatureHeader: request.headers.get(SLACK_SIGNATURE_HEADER),
		rawBody,
		nowMs: Date.now(),
	});
	if (!signature.ok) {
		return jsonResponse(signature.status, { error: signature.reason });
	}

	const callback = parseSlackApprovalCallback(rawBody);
	if (!callback) {
		return jsonResponse(400, { error: 'Unrecognized Slack interaction payload' });
	}

	// The sole side effect: record one deduplicated vote. No send, no approval,
	// no gate bypass is reachable from here.
	await ctx.runMutation(internal.slack.approvals.recordApprovalVote, {
		approvalToken: callback.approvalToken,
		slackUserId: callback.slackUserId,
		decision: callback.decision,
		votedAt: Date.now(),
	});

	// Uniform 200 ephemeral ack regardless of new/duplicate/unknown, so the
	// endpoint leaks nothing about which tokens exist or whether quorum was met.
	return jsonResponse(200, {
		response_type: 'ephemeral',
		replace_original: false,
		text: 'Thanks — your response was recorded. Owlat decides the final send after all its safety gates.',
	});
});

function jsonResponse(status: number, body: Record<string, unknown>): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}
