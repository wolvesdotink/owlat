/**
 * GitHub merge webhook HTTP endpoint.
 *
 * Verifies the `X-Hub-Signature-256` HMAC of the raw body against the
 * `GITHUB_WEBHOOK_SECRET` env var, then handles `pull_request` `closed` events
 * where the PR was actually merged. The merged PR's `html_url` is matched
 * against `codeWorkTasks.prUrl`; on a hit the task is moved to `merged` via the
 * existing `markMerged` lifecycle (through the `markMergedByPrUrl` resolver).
 *
 * Fail-safe: a missing secret returns 503 (configuration error, not a crash);
 * an unverified or malformed payload returns 4xx; an event we don't track
 * (non-PR event, unmerged close, or a PR with no matching task) returns 200 so
 * GitHub does not retry. Nothing here throws into the request handler.
 *
 * Webhook URL: POST /webhooks/github
 * https://docs.github.com/en/webhooks/webhook-events-and-payloads#pull_request
 */

import { httpAction } from '../_generated/server';
import { internal } from '../_generated/api';
import { getOptional } from '../lib/env';
import { constantTimeEqual, hmacSha256Hex } from './security';
import { logError, logInfo } from '../lib/runtimeLog';

const SIGNATURE_PREFIX = 'sha256=';

/**
 * Verify a GitHub `X-Hub-Signature-256` header against the raw body. Header
 * format is `sha256=<hex>`. Returns false on a missing prefix or a mismatch
 * (constant-time compare).
 */
export async function verifyGithubSignature(
	rawBody: string,
	headerValue: string,
	secret: string
): Promise<boolean> {
	if (!headerValue.startsWith(SIGNATURE_PREFIX)) return false;
	const provided = headerValue.slice(SIGNATURE_PREFIX.length);
	const expected = await hmacSha256Hex(secret, rawBody);
	return constantTimeEqual(expected, provided);
}

interface GithubPullRequestPayload {
	action?: string;
	pull_request?: {
		merged?: boolean;
		html_url?: string;
	};
}

export const handleGithubWebhook = httpAction(async (ctx, request) => {
	const secret = getOptional('GITHUB_WEBHOOK_SECRET');
	if (!secret) {
		logError('[GitHub Webhook] GITHUB_WEBHOOK_SECRET is not set');
		return new Response(
			JSON.stringify({ error: 'Webhook endpoint is not configured securely' }),
			{ status: 503, headers: { 'Content-Type': 'application/json' } }
		);
	}

	const signature = request.headers.get('x-hub-signature-256');
	if (!signature) {
		return new Response('Missing X-Hub-Signature-256 header', { status: 401 });
	}

	const rawBody = await request.text();
	if (!(await verifyGithubSignature(rawBody, signature, secret))) {
		return new Response('Invalid GitHub signature', { status: 401 });
	}

	// Only the pull_request event carries a merge; ignore everything else.
	const eventType = request.headers.get('x-github-event');
	if (eventType !== 'pull_request') {
		return new Response('OK', { status: 200 });
	}

	let payload: GithubPullRequestPayload;
	try {
		payload = JSON.parse(rawBody) as GithubPullRequestPayload;
	} catch {
		return new Response('Malformed JSON payload', { status: 400 });
	}

	// A merge is a `closed` action with `pull_request.merged === true`. A close
	// without a merge (PR rejected) is acknowledged but ignored.
	const prUrl = payload.pull_request?.html_url;
	if (payload.action !== 'closed' || !payload.pull_request?.merged || !prUrl) {
		return new Response('OK', { status: 200 });
	}

	const taskId = await ctx.runMutation(internal.codeWorkTasks.markMergedByPrUrl, {
		prUrl,
	});

	if (taskId) {
		logInfo(`[GitHub Webhook] Marked code work task ${taskId} merged for PR ${prUrl}`);
	}

	return new Response('OK', { status: 200 });
});
