/**
 * Host enforcement of a plugin's inbound signature-verification contract. The
 * host recomputes the declared HMAC with the secret named by the contract and
 * compares it to the caller-supplied header value in constant time — a plugin
 * never sees the secret and never decides whether bytes are authentic.
 *
 * Fails closed:
 *   - secret unset/empty     → 503 (retryable once the operator configures it)
 *   - header missing/empty   → 401
 *   - signature mismatch     → 401
 *
 * {@link verifyPluginReplayBoundSignature} is the form that gates a live
 * endpoint — the send transport feedback webhook (D6/P2.2). It binds a
 * caller-supplied timestamp into the signed string and refuses one outside the
 * contract's tolerance, which bounds how long a captured request stays valid;
 * the route pairs it with delivery de-duplication over that same window, which
 * removes what remains. Neither half is sufficient alone.
 *
 * The ORIGIN-ONLY form the import-provider contract declares lives in
 * `./importProviderSignature.ts` and shares the two primitives below. It is in
 * its own module so the orphan gate keeps asking whether anything calls it —
 * nothing does, and that is a fact worth failing on the day it changes.
 *
 * Uses Web Crypto so this module stays V8-isolate-safe (no 'use node').
 */

import {
	PLUGIN_INBOUND_REPLAY_MAX_TOLERANCE_SECONDS,
	type PluginInboundSignatureContract,
	type PluginReplayBoundSignatureContract,
} from '@owlat/plugin-kit';
import { getPluginSecret } from '../lib/env';
import {
	bytesToHex,
	clampToleranceSeconds,
	constantTimeEqual,
	hmacSignature,
	isUnixSecondsTimestamp,
	isWithinTimestampTolerance,
} from '../webhooks/security';

export type InboundSignatureResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly status: 401 | 503; readonly reason: string };

async function computeSignature(
	contract: PluginInboundSignatureContract,
	secret: string,
	signingBase: string
): Promise<string> {
	return hmacSignature(
		secret,
		signingBase,
		contract.algorithm === 'hmac-sha256' ? 'sha256' : 'sha1',
		contract.encoding
	);
}

/**
 * The configuration gate, first for every verifier: an unset secret is the
 * deployment's problem, not the caller's, and it is answered 503 so an operator
 * still wiring an endpoint up sees "misconfigured" rather than a 401 that reads
 * as a caller error. It costs one environment read, which is why it can run
 * before anything else.
 */
export function readSignatureSecret(
	contract: PluginInboundSignatureContract
):
	| { readonly ok: true; readonly secret: string }
	| { readonly ok: false; readonly status: 503; readonly reason: string } {
	const secret = getPluginSecret(contract.secretEnvVar);
	if (secret === undefined) {
		return {
			ok: false,
			status: 503,
			reason: `Inbound signature is not configured (missing ${contract.secretEnvVar})`,
		};
	}
	return { ok: true, secret };
}

/**
 * Compare a caller-supplied signature against the recomputed one, in constant
 * time. Shared by both verifiers so the remaining fail-closed order (header
 * present, then comparison) is stated once.
 */
export async function compareSignature(
	contract: PluginInboundSignatureContract,
	secret: string,
	signingBase: string,
	providedSignature: string | null | undefined
): Promise<InboundSignatureResult> {
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

/** One inbound delivery, named by the route it arrived on and its contract. */
export interface ReplayBoundDelivery {
	readonly contract: PluginReplayBoundSignatureContract;
	/** The plugin whose route this arrived on; part of the delivery's name. */
	readonly pluginId: string;
	/** The transport kind its events will be attributed to. */
	readonly transportKind: string;
	readonly rawBody: string;
	readonly signature: string | null | undefined;
	readonly timestamp: string | null | undefined;
	readonly nowMs: number;
}

/**
 * Verify an inbound request against a contract that carries replay provisions.
 *
 * Order is fail-closed and deliberate: configuration first (503, retryable once
 * the operator sets the secret — an environment read costs nothing, and an
 * operator wiring an endpoint up must not be told 401 about a deployment
 * problem), then the timestamp header, then freshness, then the signature
 * itself. Freshness is checked BEFORE the HMAC so a flood of stale captures
 * costs a header parse rather than a key import — and it is safe to check
 * before it, since the timestamp is inside the signed string and a rewritten one
 * cannot verify.
 *
 * The tolerance is clamped again here: the manifest validator bounds it, but
 * this module must not depend on a generated artifact having been validated by
 * the version of the kit that is running now.
 */
export async function verifyPluginReplayBoundSignature(
	delivery: ReplayBoundDelivery
): Promise<ReplayBoundSignatureResult> {
	const { contract, timestamp, nowMs } = delivery;
	const configured = readSignatureSecret(contract);
	if (!configured.ok) return configured;
	if (!isUnixSecondsTimestamp(timestamp)) {
		return { ok: false, status: 401, reason: 'Missing or malformed inbound timestamp' };
	}
	const toleranceSeconds = clampToleranceSeconds(
		contract.replay.toleranceSeconds,
		PLUGIN_INBOUND_REPLAY_MAX_TOLERANCE_SECONDS
	);
	if (!isWithinTimestampTolerance(timestamp, toleranceSeconds, nowMs)) {
		return { ok: false, status: 401, reason: 'Inbound timestamp outside tolerance' };
	}
	const verification = await compareSignature(
		contract,
		configured.secret,
		`${timestamp}.${delivery.rawBody}`,
		delivery.signature
	);
	if (!verification.ok) return verification;
	return {
		ok: true,
		deliveryDigest: await deliveryDigestOf(delivery, timestamp, delivery.signature!),
		// Two tolerances wide, not one: the request stays verifiable until its own
		// timestamp plus the tolerance, and our clock may sit a tolerance behind it.
		expiresAtMs: nowMs + 2 * toleranceSeconds * 1000,
	};
}

/**
 * A collision-resistant name for one delivery: the secret-bearing header value,
 * domain-separated by the OWNING PLUGIN, its transport kind, the contract's own
 * header names and the timestamp.
 *
 * The plugin id is in there because nothing forbids two bundled plugins from
 * naming the same `secretEnvVar` and the same headers (the manifest validator
 * only requires the `PLUGIN_` prefix, and it validates one manifest at a time).
 * Without it, one plugin's claimed delivery would answer for the byte-identical
 * delivery to another's route — and the loser of that race is not an attacker,
 * it is a real provider whose bounce is then dropped as a "replay" and never
 * redelivered. The signing base cannot carry the id (the provider computes the
 * HMAC), but the digest is entirely ours.
 *
 * Hashed rather than stored raw because the signature is a MAC computed under a
 * live shared secret, and a de-duplication table is not a place to accumulate
 * those. SHA-256 over a value an attacker cannot predict without the secret is
 * enough to make forging a colliding digest infeasible.
 */
async function deliveryDigestOf(
	delivery: ReplayBoundDelivery,
	timestamp: string,
	signature: string
): Promise<string> {
	const { contract } = delivery;
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(
			[
				'owlat.plugin.webhook.v1',
				delivery.pluginId,
				delivery.transportKind,
				contract.header,
				contract.replay.timestampHeader,
				timestamp,
				signature,
			].join('\n')
		)
	);
	return bytesToHex(digest);
}
