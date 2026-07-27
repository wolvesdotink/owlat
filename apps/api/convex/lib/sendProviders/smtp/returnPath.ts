/**
 * The relay arm's RETURN-PATH decision (plan G-08).
 *
 * Split out of `./index.ts` so the one rule that governs bounce attribution on
 * the relay arm is a small, pure, exhaustively-fixtured module rather than a
 * paragraph inside the send path. No clock, no env, no sockets — every input is
 * a parameter.
 */

import { buildVerpAddress, isUsableVerpKey, normalizeVerpKey } from '@owlat/shared/verp';

/** Inputs to the relay envelope-sender decision. All explicit — no clock, no env. */
export interface RelayEnvelopeSenderInput {
	/** What the composer built: the From address, i.e. the shipped behaviour. */
	readonly composedEnvelopeFrom: string;
	/** The id the VERP token encodes (the composed Message-ID for a real send). */
	readonly messageId: string;
	/**
	 * The return-path host to stamp, or `undefined` for the shipped behaviour.
	 *
	 * ONE input, not a capability boolean plus a host: the two could only ever
	 * disagree, and every reason not to stamp — an unproven relay, no configured
	 * bounce domain, a host whose SPF does not authorise this transport —
	 * resolves to the same thing, an absent host. The routing seam owns those
	 * decisions and hands down their single answer.
	 */
	readonly returnPathHost: string | undefined;
	/** The MTA's VERP signing key (MTA_BOUNCE_VERP_KEY). */
	readonly verpKey: string | undefined;
	readonly now: number;
}

export interface RelayEnvelopeSender {
	/** The RFC5321.MailFrom to put on the wire. */
	readonly envelopeFrom: string;
	/** True ⇒ it is our signed VERP address, so relayed bounces come back here. */
	readonly isVerp: boolean;
}

/**
 * Decide the relay send's envelope sender (plan G-08, D11).
 *
 * ONLY the RFC5321.MailFrom is affected. The From header, the DKIM `d=` and
 * therefore DMARC's DKIM leg are untouched — the composed message bytes are not
 * even read here. Giving the two arms different sending identities is what D11
 * forbids; giving them different *envelope senders* is what makes their bounce
 * data comparable in the first place. DMARC's SPF leg is evaluated on exactly
 * the value this function changes, which is why the host reaches it only once
 * it is proven to authorise this transport.
 *
 * Falls back to the composed envelope sender — the exact shipped behaviour —
 * whenever there is no authorised host or no USABLE signing key. An UNSIGNED
 * VERP address would be a forgery surface on the bounce path, and a key shorter
 * than the floor the MTA enforces at startup mints tokens the MTA will never
 * verify — which reads downstream as "this arm produced no bounces", the exact
 * measurement bias this whole change exists to remove. Both mean no stamp,
 * never a bad token.
 */
export function resolveRelayEnvelopeSender(input: RelayEnvelopeSenderInput): RelayEnvelopeSender {
	const key = normalizeVerpKey(input.verpKey);
	if (!input.returnPathHost || !isUsableVerpKey(key) || input.messageId.length === 0) {
		return { envelopeFrom: input.composedEnvelopeFrom, isVerp: false };
	}
	return {
		envelopeFrom: buildVerpAddress(input.messageId, input.returnPathHost, key, input.now),
		isVerp: true,
	};
}

/**
 * How long a published return-path SPF proof is trusted before the stamp is
 * withdrawn. DNS an operator changed a month ago is not evidence about today's
 * authorisation.
 */
export const RETURN_PATH_SPF_PROOF_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** A verification result for the return-path host's generated SPF record. */
export interface ReturnPathSpfProof {
	readonly verified: boolean;
	readonly lastChecked: number;
	/** What the checker actually read at the host, when it recorded it. */
	readonly foundValue?: string | undefined;
}

export interface ReturnPathAuthorizationInput {
	/** The resolved return-path host (per-domain override, else the global env). */
	readonly host: string | undefined;
	/** The configured relay-authorisation terms (`MTA_RETURN_PATH_RELAY_SPF`). */
	readonly relaySpfTerms: readonly string[];
	/** The SPF value we GENERATED for that host, if the domain carries one. */
	readonly generatedSpfValue: string | undefined;
	/** The verification result for that generated record, if it was checked. */
	readonly proof: ReturnPathSpfProof | undefined;
	readonly now: number;
}

/**
 * Does the return-path host actually authorise the RELAY to use it as an
 * envelope sender?
 *
 * The generated return-path SPF record authorises the MTA pool IPs. Stamping
 * `bounce+…@<host>` on a send that leaves through a third-party relay makes the
 * receiver evaluate SPF for that host against the RELAY's IP, so without this
 * gate the act of measuring the relay arm would fail its SPF, remove DMARC's
 * SPF leg, and degrade the very reputation under measurement — biasing the
 * bounce comparison in the opposite direction from the one this feature exists
 * to correct.
 *
 * So the stamp requires PUBLISHED, VERIFIED evidence: every configured relay
 * term must appear in the record actually observed at the host (the observed
 * value wins over the one we generated — the operator may not have published
 * our latest), that check must have passed, and it must be recent.
 *
 * Total and fail-closed: a missing host, no configured terms, an unverified,
 * stale or clock-skewed proof all return `false`, which means "do not stamp" —
 * a degraded measurement, never an error and never a blocked send (plan D2).
 */
export function returnPathAuthorizesRelay(input: ReturnPathAuthorizationInput): boolean {
	if (!input.host || input.relaySpfTerms.length === 0) return false;
	const proof = input.proof;
	if (!proof?.verified) return false;
	const age = input.now - proof.lastChecked;
	if (!Number.isFinite(age) || age < 0 || age >= RETURN_PATH_SPF_PROOF_MAX_AGE_MS) return false;
	const record = proof.foundValue ?? input.generatedSpfValue;
	if (!record) return false;
	// Whole-token comparison: `include:relay.example.com` must not be satisfied
	// by `include:relay.example.com.evil` appearing as a substring.
	const tokens = new Set(record.toLowerCase().split(/\s+/).filter(Boolean));
	return input.relaySpfTerms.every((term) => tokens.has(term.trim().toLowerCase()));
}
