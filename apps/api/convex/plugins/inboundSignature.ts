/**
 * Host enforcement of a plugin's inbound signature-verification contract. The
 * host verifies the bytes under the scheme the contract names, with the secret
 * the contract names, and a plugin never sees that secret and never decides
 * whether bytes are authentic.
 *
 * Fails closed:
 *   - secret unset/empty     → 503 (retryable once the operator configures it)
 *   - header missing/empty   → 401
 *   - signature mismatch     → 401
 *
 * {@link verifyPluginWebhookDelivery} is the form that gates a live endpoint —
 * the send transport feedback webhook. It dispatches on the declared
 * scheme over a vocabulary the HOST owns, and every arm ends at host code the
 * core providers are verified by:
 *
 *   - the parameterized HMAC over `<timestamp>.<rawBody>`
 *     ({@link verifyPluginReplayBoundSignature}), which binds a caller-supplied
 *     timestamp into the signed string and refuses one outside the contract's
 *     tolerance;
 *   - `svix` ({@link verifyPluginSvixDelivery}), whose binding is the scheme's
 *     own `<id>.<timestamp>.<body>` and which is verified by the SAME
 *     `verifySvixHeaders` the core Resend path and the provider verifier
 *     registry call.
 *
 * Both bound how long a captured request stays valid; the route pairs either
 * with delivery de-duplication, which removes what remains. Neither half is
 * sufficient alone, and the claim is the same claim for both arms — it names a
 * BATCH, not a signature scheme. The Svix arm's name leaves the timestamp out,
 * so a sender's re-signed retry is the same batch, and its receipt is kept for
 * the sender's retry window rather than the signature's.
 *
 * The ORIGIN-ONLY form the import-provider contract declares lives in
 * `./importProviderSignature.ts` and shares the two primitives below. It is in
 * its own module so the orphan gate keeps asking whether anything calls it —
 * nothing does, and that is a fact worth failing on the day it changes.
 *
 * Uses Web Crypto so this module stays V8-isolate-safe (no 'use node').
 */

import {
	isPluginSvixSignatureContract,
	PLUGIN_INBOUND_REPLAY_MAX_TOLERANCE_SECONDS,
	type PluginInboundSignatureContract,
	type PluginReplayBoundSignatureContract,
	type PluginSvixSignatureContract,
	type PluginWebhookSignatureContract,
} from '@owlat/plugin-kit';
import { getPluginSecret } from '../lib/env';
// The Svix scheme's reusable inner half, IMPORTED rather than reimplemented.
// It lives beside the Resend adapter because that is the core provider signing
// this way, but nothing in it is Resend's: the provider verifier registry
// already calls it for the `svix` bundles, and a second copy here would be a
// second implementation of a signature check to keep in agreement.
import { verifySvixHeaders } from '../webhooks/adapters/resend';
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
	contract: Pick<PluginInboundSignatureContract, 'secretEnvVar'>
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
	if (providedSignature == null || providedSignature === '') {
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
 * The `deliveryDigest` is what the caller de-duplicates on. It is derived only
 * from what the verifier AUTHENTICATED, so two requests share a digest exactly
 * when they carry the same signed content, and no unauthenticated framing of
 * that content (how a header spells it) can mint a fresh one. Each arm decides
 * what that content is — see the two call sites of `deliveryDigestOf`.
 * `expiresAtMs` is when THIS REQUEST stops verifying: no earlier than the first
 * instant the timestamp check rejects it — see {@link claimExpiresAtMs}.
 *
 * `receiptExpiresAtMs` is set only by an arm whose digest OUTLIVES the request,
 * because it leaves the timestamp out: the Svix arm names a message, and the
 * sender re-signs every retry of it with a fresh timestamp. It says how
 * long a completed receipt must still answer for that message. Absent, the
 * receipt only has to outlive the request, since nothing else can present the
 * same digest.
 */
interface ReplayBoundVerification {
	readonly ok: true;
	readonly deliveryDigest: string;
	readonly expiresAtMs: number;
	readonly receiptExpiresAtMs?: number;
}

type ReplayBoundSignatureResult =
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
		// The raw header IS the authenticated value here: `compareSignature` accepts
		// exactly one string, the recomputed MAC, so there is no second spelling of
		// a verified header to mint a second digest with.
		deliveryDigest: await deliveryDigestOf(delivery.pluginId, delivery.transportKind, [
			contract.header,
			contract.replay.timestampHeader,
			timestamp,
			delivery.signature!,
		]),
		expiresAtMs: claimExpiresAtMs(timestamp, toleranceSeconds),
	};
}

/** One inbound delivery to the feedback route, before its scheme is known. */
export interface PluginWebhookDelivery {
	readonly contract: PluginWebhookSignatureContract;
	/** The plugin whose route this arrived on; part of the delivery's name. */
	readonly pluginId: string;
	/** The transport kind its events will be attributed to. */
	readonly transportKind: string;
	readonly rawBody: string;
	/**
	 * The request's headers. WHICH ONES ARE READ IS THE CONTRACT'S DECISION, not
	 * the route's: the parameterized HMAC names its own two, and `svix` names the
	 * three the scheme fixes. Handing over the collection rather than two
	 * pre-read values is what lets the arm that knows decide.
	 */
	readonly headers: Headers;
	readonly nowMs: number;
}

/**
 * Verify one inbound feedback delivery against whichever host-verified scheme
 * its contract declares.
 *
 * THE DISPATCH IS THE WHOLE OF WHAT WIDENING THE VOCABULARY ADDED. Each arm
 * below is host code — a plugin supplies a word and a secret variable, never a
 * verifier — and each answers in the same terms, because everything downstream
 * of here (the claim, the retention opt-in, the parse, the dispatch) is about a
 * BATCH and has no interest in how the bytes were proved.
 */
export async function verifyPluginWebhookDelivery(
	delivery: PluginWebhookDelivery
): Promise<ReplayBoundSignatureResult> {
	const { contract, headers } = delivery;
	if (isPluginSvixSignatureContract(contract)) {
		return verifyPluginSvixDelivery(delivery, contract);
	}
	return verifyPluginReplayBoundSignature({
		contract,
		pluginId: delivery.pluginId,
		transportKind: delivery.transportKind,
		rawBody: delivery.rawBody,
		signature: headers.get(contract.header),
		timestamp: headers.get(contract.replay.timestampHeader),
		nowMs: delivery.nowMs,
	});
}

/**
 * Domain separator for a Svix delivery's digest, followed by the version of
 * what the digest covers.
 *
 * The other arm's digest is named by the contract's own header names, which are
 * what distinguishes two contracts that happen to share a secret. Svix fixes its
 * headers, so there is nothing contract-specific to name — this constant and
 * {@link SVIX_DIGEST_VERSION} take their place. Both arms pass four parts
 * (the other arm: signature header, timestamp header, timestamp, signature;
 * this one: scheme, version, id, body hash), so the version is what keeps them
 * apart. It contains a `:`, which the lower-case header grammar the other arm's
 * `timestampHeader` must match refuses, so no replay-bound delivery can collide
 * with a Svix one, even across a change of a plugin's declared scheme.
 */
const SVIX_DIGEST_SCHEME = 'svix';

/**
 * What the digest covers, by version:
 *
 *  - v1 hashed the raw `svix-signature` header. The header is a LIST that
 *    verifies when any one candidate matches, so a captured delivery could be
 *    re-sent with an extra junk candidate, doubled spaces or reordered
 *    candidates — still authentic, but a fresh digest and so a fresh claim.
 *  - v2 hashed the authenticated content instead: id, timestamp and body.
 *  - v3 (`v3:message`) drops the timestamp. Svix signs every attempt
 *    again with "the timestamp of the attempt" (docs.svix.com, "Verifying
 *    Webhooks Manually"),
 *    so under v2 a retry after a lost 2xx was a new digest and the batch was
 *    applied twice. The message id is what names the message across its
 *    retries, and it is inside the signed string (`<id>.<timestamp>.<body>`),
 *    so it cannot be forged. The body stays in, so a sender reusing an id for
 *    different content is still a different delivery.
 *
 * Versioned because each change re-names every live delivery: a receipt stored
 * under v2 does not match the same delivery's v3 digest. For a sender's
 * re-signed retry that costs nothing new — v2 never matched one anyway. For a
 * byte-identical replay of a v2-era request it reopens that request's window
 * for one tolerance after the deploy. The rollout that closes it: disable the
 * plugin that signs with Svix (its route then answers 403), deploy, and wait
 * MORE than twice the contract tolerance plus one second, measured from
 * disabling — at most just over 30 minutes — before re-enabling it. A delivery
 * accepted just before the switch-off may carry a timestamp a tolerance ahead
 * of our clock, and the verifier rounds our clock down to the second (see
 * `claimExpiresAtMs`), so that is when the last of them stops verifying. The
 * Svix service retries any non-2xx for about 27 hours (docs.svix.com,
 * "Retries"), re-signed, so the pause loses nothing it sends; a sender that
 * names this scheme but reuses its original timestamp must resend by hand.
 */
const SVIX_DIGEST_VERSION = 'v3:message';

/**
 * How long a completed Svix receipt keeps answering for its message, past the
 * moment the attempt that applied it stops verifying.
 *
 * It has to cover the sender's whole retry schedule, because any attempt in it
 * may be the retry of a 2xx we sent and the sender never saw. The Svix service
 * makes up to 8 attempts at a message: immediately, then 5 s, 5 min, 30 min,
 * 2 h, 5 h, 10 h and 10 h after each failure, about 27.5 hours in all
 * (docs.svix.com, "Retries"). The receipt is
 * counted from the attempt that APPLIED the batch, which is never earlier than
 * the first, so two days covers the schedule with room for the sender's own
 * queueing delays. A message re-sent by hand after that is applied again.
 */
const SVIX_RECEIPT_RETENTION_MS = 48 * 60 * 60 * 1000;

/**
 * The Svix arm, in the same fail-closed order the arm above documents:
 * configuration (503, an operator's problem, one environment read), then the
 * timestamp header's FORM, then the signature — which is where freshness is
 * enforced too, because `verifySvixHeaders` checks the window and the MAC
 * together over `<id>.<timestamp>.<body>`.
 *
 * The format gate is ours rather than the helper's: the helper reads the
 * timestamp with `parseInt`, which accepts exponent and hex forms no sender
 * wrote, and the plugin tier already refuses those on its other arm through
 * `isUnixSecondsTimestamp`. Applying it here keeps one rigour across both arms
 * and lets a malformed header be answered as the malformed header it is instead
 * of as a signature mismatch.
 *
 * The tolerance is clamped to the same ceiling for the same reason as the other
 * arm: this module must not depend on a generated artifact having been validated
 * by the version of the kit that is running now.
 */
async function verifyPluginSvixDelivery(
	delivery: PluginWebhookDelivery,
	contract: PluginSvixSignatureContract
): Promise<ReplayBoundSignatureResult> {
	const { headers, nowMs } = delivery;
	const configured = readSignatureSecret(contract);
	if (!configured.ok) return configured;

	const id = headers.get('svix-id');
	const timestamp = headers.get('svix-timestamp');
	const signature = headers.get('svix-signature');
	if (id === null || id === '' || signature === null || signature === '') {
		return { ok: false, status: 401, reason: 'Missing inbound signature' };
	}
	if (!isUnixSecondsTimestamp(timestamp)) {
		return { ok: false, status: 401, reason: 'Missing or malformed inbound timestamp' };
	}

	const toleranceSeconds = clampToleranceSeconds(
		contract.toleranceSeconds,
		PLUGIN_INBOUND_REPLAY_MAX_TOLERANCE_SECONDS
	);
	const verified = await verifySvixHeaders(
		delivery.rawBody,
		id,
		timestamp,
		signature,
		configured.secret,
		Math.floor(nowMs / 1000),
		toleranceSeconds
	);
	// ONE ANSWER FOR TWO FAILURES, because the helper gives one: a stale window and
	// a bad MAC are indistinguishable from here, and both are 401 anyway.
	if (!verified) {
		return { ok: false, status: 401, reason: 'Inbound signature mismatch or outside tolerance' };
	}
	// NAMED BY WHAT WAS SIGNED, NOT BY THE HEADER THAT SIGNED IT. The header is an
	// unauthenticated list around the one candidate that matched, and the
	// candidate itself depends on which key the sender used — so neither belongs
	// in the name: the same delivery must keep one name across a reformatted
	// header and across a key rotation. NOR BY THE ATTEMPT: the timestamp is
	// signed, but the sender re-signs each retry with a new one, and a retry of
	// a batch we applied is the same batch. The body is hashed first so
	// the digest's input stays newline-free and never holds a payload.
	const bodyDigest = bytesToHex(
		await crypto.subtle.digest('SHA-256', new TextEncoder().encode(delivery.rawBody))
	);
	const expiresAtMs = claimExpiresAtMs(timestamp, toleranceSeconds);
	return {
		ok: true,
		deliveryDigest: await deliveryDigestOf(delivery.pluginId, delivery.transportKind, [
			SVIX_DIGEST_SCHEME,
			SVIX_DIGEST_VERSION,
			id,
			bodyDigest,
		]),
		expiresAtMs,
		receiptExpiresAtMs: expiresAtMs + SVIX_RECEIPT_RETENTION_MS,
	};
}

/**
 * When a request stops verifying, and so when a claim that names only that
 * request may be forgotten: no earlier than the first instant at which the same
 * signed timestamp can no longer verify, on either arm.
 *
 * Derived from the SIGNED timestamp, not from when we happened to accept it,
 * because that is what bounds the request's life. And one second past the
 * tolerance, because the two arms round differently and the claim must outlast
 * both: the Svix check floors our clock to whole seconds, so it accepts every
 * instant before `(timestamp + tolerance + 1) s`; the parameterized check
 * compares milliseconds and accepts up to `(timestamp + tolerance) s`
 * inclusive. The claim mutation treats a row as gone once `expiresAt <= now`,
 * so anything earlier leaves an instant at which a still-verifiable copy finds
 * its receipt expired and is applied again.
 */
function claimExpiresAtMs(timestamp: string, toleranceSeconds: number): number {
	return (Number(timestamp) + toleranceSeconds + 1) * 1000;
}

/**
 * A collision-resistant name for one delivery, domain-separated by the OWNING
 * PLUGIN, its transport kind, and the scheme-specific parts its caller passes:
 * for the parameterized HMAC, the contract's own header names, the timestamp
 * and the verified signature; for Svix, the scheme tag and digest version, the
 * message id and a hash of the body.
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
 * Hashed rather than stored raw because the parts include a MAC computed under
 * a live shared secret, or a payload, and a de-duplication table is not a place
 * to accumulate either. A digest is only ever claimed after its delivery
 * verified, so being able to predict one (a Svix digest covers no secret) does
 * not let anyone claim it ahead of the real sender.
 */
async function deliveryDigestOf(
	pluginId: string,
	transportKind: string,
	schemeParts: readonly string[]
): Promise<string> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(
			['owlat.plugin.webhook.v1', pluginId, transportKind, ...schemeParts].join('\n')
		)
	);
	return bytesToHex(digest);
}
