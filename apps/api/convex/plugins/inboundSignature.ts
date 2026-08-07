/**
 * Host enforcement of a plugin import provider's inbound signature-verification
 * contract. The host recomputes the declared HMAC over the raw request body
 * with the secret named by the contract and compares it to the caller-supplied
 * header value in constant time.
 *
 * Fails closed:
 *   - secret unset/empty     → 503 (retryable once the operator configures it)
 *   - header missing/empty   → 401
 *   - signature mismatch     → 401
 *
 * A passing check of {@link verifyPluginInboundSignature} proves ORIGIN ONLY —
 * that the caller holds the shared secret. It is NOT replay-resistant: the
 * signed payload is the raw body alone (no timestamp, tolerance, or nonce), so a
 * captured request verifies forever. It gates no endpoint; the import-provider
 * contract that declares it has no inbound HTTP surface yet.
 *
 * {@link verifyPluginReplayBoundSignature} is the form that DOES gate one — the
 * send transport feedback webhook (D6/P2.2). It binds a caller-supplied
 * timestamp into the signed string and refuses one outside the contract's
 * tolerance, which bounds how long a captured request stays valid; the route
 * pairs it with delivery de-duplication over that same window, which removes
 * what remains. Neither half is sufficient alone.
 *
 * Uses Web Crypto so this module stays V8-isolate-safe (no 'use node').
 */

import {
	PLUGIN_INBOUND_REPLAY_MAX_TOLERANCE_SECONDS,
	type PluginInboundSignatureContract,
	type PluginReplayBoundSignatureContract,
} from '@owlat/plugin-kit';
import { getPluginSecret } from '../lib/env';
import { bytesToBase64, bytesToHex, constantTimeEqual } from '../webhooks/security';

export type InboundSignatureResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly status: 401 | 503; readonly reason: string };

const HASH_BY_ALGORITHM = {
	'hmac-sha256': 'SHA-256',
	'hmac-sha1': 'SHA-1',
} as const;

async function computeSignature(
	contract: PluginInboundSignatureContract,
	secret: string,
	signingBase: string
): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: HASH_BY_ALGORITHM[contract.algorithm] },
		false,
		['sign']
	);
	const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingBase));
	return contract.encoding === 'hex' ? bytesToHex(signature) : bytesToBase64(signature);
}

/**
 * Compare a caller-supplied signature against the recomputed one, in constant
 * time, having read the secret through the contract. Shared by both verifiers so
 * the fail-closed order (secret first, header second, comparison last) is stated
 * once.
 */
async function verifyAgainst(
	contract: PluginInboundSignatureContract,
	signingBase: string,
	providedSignature: string | null | undefined
): Promise<InboundSignatureResult> {
	const secret = getPluginSecret(contract.secretEnvVar);
	if (secret === undefined) {
		return {
			ok: false,
			status: 503,
			reason: `Inbound signature is not configured (missing ${contract.secretEnvVar})`,
		};
	}
	if (providedSignature === null || providedSignature === undefined || providedSignature === '') {
		return { ok: false, status: 401, reason: 'Missing inbound signature' };
	}
	const expected = await computeSignature(contract, secret, signingBase);
	if (!constantTimeEqual(providedSignature, expected)) {
		return { ok: false, status: 401, reason: 'Inbound signature mismatch' };
	}
	return { ok: true };
}

/**
 * Verify a plugin-sourced inbound request against its declared contract. The
 * secret is read from the environment variable the contract names; a plugin can
 * never disable this check.
 */
export async function verifyPluginInboundSignature(
	contract: PluginInboundSignatureContract,
	rawBody: string,
	providedSignature: string | null | undefined
): Promise<InboundSignatureResult> {
	return verifyAgainst(contract, rawBody, providedSignature);
}

/**
 * A verified delivery: origin proven AND bound to a moment.
 *
 * The `deliveryDigest` is what the caller de-duplicates on. It is derived from
 * the SIGNATURE, which is an HMAC over the timestamp and the exact body under a
 * secret only the sender holds: two requests share a digest exactly when they
 * are the same signed bytes, and an attacker cannot mint a fresh digest for a
 * captured body without the secret. `expiresAtMs` is when remembering it stops
 * mattering, because the timestamp check below would reject the same request by
 * then anyway.
 */
export interface ReplayBoundVerification {
	readonly ok: true;
	readonly deliveryDigest: string;
	readonly expiresAtMs: number;
}

export type ReplayBoundSignatureResult =
	| ReplayBoundVerification
	| { readonly ok: false; readonly status: 401 | 503; readonly reason: string };

/**
 * Verify an inbound request against a contract that carries replay provisions.
 *
 * Order is fail-closed and deliberate: configuration (503, retryable once the
 * operator sets the secret), then the timestamp header, then freshness, then the
 * signature itself. Freshness is checked BEFORE the HMAC so a flood of stale
 * captures costs a header parse rather than a key import — and after it, since
 * the timestamp is inside the signed string, a rewritten one cannot verify.
 *
 * The tolerance is clamped again here: the manifest validator bounds it, but
 * this module must not depend on a generated artifact having been validated by
 * the version of the kit that is running now.
 */
export async function verifyPluginReplayBoundSignature(
	contract: PluginReplayBoundSignatureContract,
	rawBody: string,
	providedSignature: string | null | undefined,
	providedTimestamp: string | null | undefined,
	nowMs: number
): Promise<ReplayBoundSignatureResult> {
	if (
		providedTimestamp === null ||
		providedTimestamp === undefined ||
		!/^\d{1,15}$/.test(providedTimestamp)
	) {
		return { ok: false, status: 401, reason: 'Missing or malformed inbound timestamp' };
	}
	const toleranceSeconds = Math.min(
		Math.max(Math.trunc(contract.replay.toleranceSeconds), 1),
		PLUGIN_INBOUND_REPLAY_MAX_TOLERANCE_SECONDS
	);
	const skewSeconds = Math.abs(nowMs / 1000 - Number(providedTimestamp));
	if (!(skewSeconds <= toleranceSeconds)) {
		// Both directions: a stale capture AND a far-future timestamp, which is how
		// a captured request would otherwise be parked for later.
		return { ok: false, status: 401, reason: 'Inbound timestamp outside tolerance' };
	}
	const verification = await verifyAgainst(
		contract,
		`${providedTimestamp}.${rawBody}`,
		providedSignature
	);
	if (!verification.ok) return verification;
	return {
		ok: true,
		deliveryDigest: await deliveryDigestOf(contract, providedTimestamp, providedSignature!),
		// Two tolerances wide, not one: the request stays verifiable until its own
		// timestamp plus the tolerance, and our clock may sit a tolerance behind it.
		expiresAtMs: nowMs + 2 * toleranceSeconds * 1000,
	};
}

/**
 * A collision-resistant name for one delivery: the secret-bearing header value,
 * domain-separated by the contract's own header names and the timestamp.
 *
 * Hashed rather than stored raw because the signature is a MAC computed under a
 * live shared secret, and a de-duplication table is not a place to accumulate
 * those. SHA-256 over a value an attacker cannot predict without the secret is
 * enough to make forging a colliding digest infeasible.
 */
async function deliveryDigestOf(
	contract: PluginReplayBoundSignatureContract,
	timestamp: string,
	signature: string
): Promise<string> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(
			`owlat.plugin.webhook.v1\n${contract.header}\n${contract.replay.timestampHeader}\n${timestamp}\n${signature}`
		)
	);
	return bytesToHex(digest);
}
