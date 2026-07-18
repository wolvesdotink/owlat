/**
 * Slack request-signature verification (the `v0` scheme).
 *
 * Every interaction Slack POSTs (a button click on the approve/reject message)
 * is authenticated exactly as Slack documents it:
 *   basestring = `v0:<timestamp>:<raw request body>`
 *   header     = `X-Slack-Signature: v0=<hex HMAC-SHA256(signingSecret, basestring)>`
 *   header     = `X-Slack-Request-Timestamp: <unix seconds>`
 *
 * The check FAILS CLOSED: a missing header, a malformed timestamp, a stale
 * timestamp (replay outside the tolerance window), or any signature mismatch all
 * return an `invalid` result, and the caller records no vote. The HMAC
 * comparison is constant-time so a forged signature leaks no timing. The raw
 * body — not a re-serialized parse — must be signed, because Slack signs the
 * exact bytes it sent.
 */

import { constantTimeEqual, hmacSha256Hex } from './crypto';
import { parseUnixSecondsHeader } from './timestampHeader';

/** Slack's documented replay tolerance: reject timestamps older/newer than 5 min. */
export const SLACK_SIGNATURE_TOLERANCE_SECONDS = 60 * 5;

const SLACK_SIGNATURE_VERSION = 'v0';

export interface SlackSignatureInput {
	readonly signingSecret: string;
	/** `X-Slack-Signature` header value, e.g. `v0=abc…`. */
	readonly signatureHeader: string | null | undefined;
	/** `X-Slack-Request-Timestamp` header value (unix seconds, as a string). */
	readonly timestampHeader: string | null | undefined;
	/** The EXACT request body bytes Slack sent, decoded as UTF-8. */
	readonly rawBody: string;
	readonly nowMs: number;
	readonly toleranceSeconds?: number;
}

export type SlackSignatureFailure =
	| 'missing_signature'
	| 'missing_timestamp'
	| 'stale_timestamp'
	| 'signature_mismatch';

export type SlackSignatureResult =
	| { readonly valid: true }
	| { readonly valid: false; readonly reason: SlackSignatureFailure };

/**
 * Verify one Slack interaction request. Returns `{ valid: true }` only when the
 * signing secret reproduces the presented signature over the raw body and the
 * timestamp is fresh; every other path is a typed `invalid` result so the caller
 * can log the reason without ever treating an unauthenticated click as a vote.
 */
export async function verifySlackSignature(
	input: SlackSignatureInput
): Promise<SlackSignatureResult> {
	if (typeof input.signatureHeader !== 'string' || input.signatureHeader.length === 0) {
		return { valid: false, reason: 'missing_signature' };
	}
	const timestampSeconds = parseUnixSecondsHeader(input.timestampHeader);
	if (timestampSeconds === null) {
		return { valid: false, reason: 'missing_timestamp' };
	}
	const tolerance = input.toleranceSeconds ?? SLACK_SIGNATURE_TOLERANCE_SECONDS;
	const skewSeconds = Math.abs(Math.floor(input.nowMs / 1000) - timestampSeconds);
	if (skewSeconds > tolerance) {
		return { valid: false, reason: 'stale_timestamp' };
	}
	const basestring = `${SLACK_SIGNATURE_VERSION}:${timestampSeconds}:${input.rawBody}`;
	const expected = `${SLACK_SIGNATURE_VERSION}=${await hmacSha256Hex(input.signingSecret, basestring)}`;
	if (!constantTimeEqual(input.signatureHeader, expected)) {
		return { valid: false, reason: 'signature_mismatch' };
	}
	return { valid: true };
}

/**
 * Produce a valid `X-Slack-Signature` value for `rawBody` at `timestampSeconds`.
 * Provided so tests (and a local Slack simulator) can generate authentic
 * requests; production only ever VERIFIES, through {@link verifySlackSignature}.
 */
export async function signSlackRequest(
	signingSecret: string,
	timestampSeconds: number,
	rawBody: string
): Promise<string> {
	const basestring = `${SLACK_SIGNATURE_VERSION}:${timestampSeconds}:${rawBody}`;
	return `${SLACK_SIGNATURE_VERSION}=${await hmacSha256Hex(signingSecret, basestring)}`;
}
