/**
 * Slack request-signature verification for the approvals callback endpoint
 * (PP-26). Implements Slack's v0 signing scheme with the replay defense the
 * generic plugin inbound-signature helper (`plugins/inboundSignature.ts`)
 * explicitly leaves to the endpoint: Slack signs
 * `v0:${timestamp}:${rawBody}`, so binding the timestamp INTO the signed string
 * plus a bounded freshness window makes a captured request stop verifying once
 * the window passes.
 *
 * Fails closed, matching the inbound webhook convention:
 *   - signing secret unset/empty → 503 (retry once the operator configures it);
 *   - header missing/malformed   → 401;
 *   - timestamp stale or skewed   → 401 (replay / clock-skew defense);
 *   - signature mismatch          → 401.
 *
 * The recomputed digest is compared to the caller-supplied value in constant
 * time; the secret is only ever fed into the HMAC and is never logged.
 *
 * Web Crypto only, so this module stays V8-isolate-safe (no 'use node').
 */

import { constantTimeEqual, hmacSha256Hex } from '../webhooks/security';

/** Slack rejects requests older than 5 minutes; we match that on both sides. */
export const SLACK_SIGNATURE_TOLERANCE_SECONDS = 60 * 5;

const SLACK_SIGNATURE_VERSION = 'v0';

export type SlackSignatureResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly status: 401 | 503; readonly reason: string };

export interface SlackSignatureInput {
	/** The shared signing secret; `undefined`/empty ⇒ 503 fail-closed. */
	readonly signingSecret: string | undefined;
	/** `X-Slack-Request-Timestamp` — unix SECONDS as a string. */
	readonly timestampHeader: string | null | undefined;
	/** `X-Slack-Signature` — `v0=<hex>`. */
	readonly signatureHeader: string | null | undefined;
	/** The exact raw request body the signature covers. */
	readonly rawBody: string;
	/** Current epoch MILLISECONDS (injected for deterministic tests). */
	readonly nowMs: number;
	/** Allowed |now − timestamp| in seconds. Defaults to Slack's 5 minutes. */
	readonly toleranceSeconds?: number;
}

/**
 * Verify a Slack-signed request. A passing result proves the caller holds the
 * signing secret AND that the request is fresh within the tolerance window — it
 * never authorizes any action beyond recording the vote the body carries.
 */
export async function verifySlackSignature(
	input: SlackSignatureInput
): Promise<SlackSignatureResult> {
	if (input.signingSecret === undefined || input.signingSecret === '') {
		return {
			ok: false,
			status: 503,
			reason: 'Slack approvals endpoint is not configured (missing signing secret)',
		};
	}

	const timestamp = parseUnixSeconds(input.timestampHeader);
	if (timestamp === null) {
		return { ok: false, status: 401, reason: 'Missing or malformed Slack request timestamp' };
	}

	const tolerance = input.toleranceSeconds ?? SLACK_SIGNATURE_TOLERANCE_SECONDS;
	const skewSeconds = Math.abs(input.nowMs / 1000 - timestamp);
	if (!(skewSeconds <= tolerance)) {
		// Covers stale (replayed) AND far-future timestamps, and NaN skew.
		return { ok: false, status: 401, reason: 'Slack request timestamp outside tolerance' };
	}

	const signature = input.signatureHeader;
	if (signature === null || signature === undefined || signature === '') {
		return { ok: false, status: 401, reason: 'Missing Slack signature' };
	}

	const basestring = `${SLACK_SIGNATURE_VERSION}:${timestamp}:${input.rawBody}`;
	const expected = `${SLACK_SIGNATURE_VERSION}=${await hmacSha256Hex(input.signingSecret, basestring)}`;
	if (!constantTimeEqual(signature, expected)) {
		return { ok: false, status: 401, reason: 'Slack signature mismatch' };
	}
	return { ok: true };
}

/**
 * Parse a unix-seconds header. Rejects empty, non-integer, and non-finite
 * values so a malformed timestamp can never satisfy the freshness window.
 */
function parseUnixSeconds(value: string | null | undefined): number | null {
	if (value === null || value === undefined || value.trim() === '') return null;
	if (!/^-?\d+$/.test(value.trim())) return null;
	const parsed = Number(value.trim());
	return Number.isSafeInteger(parsed) ? parsed : null;
}
