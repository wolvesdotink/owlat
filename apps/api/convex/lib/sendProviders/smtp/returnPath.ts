/**
 * The relay arm's RETURN-PATH decision (plan G-08).
 *
 * Split out of `./index.ts` so the one rule that governs bounce attribution on
 * the relay arm is a small, pure, exhaustively-fixtured module rather than a
 * paragraph inside the send path. No clock, no env, no sockets — every input is
 * a parameter.
 */

import {
	buildVerpAddress,
	isUsableVerpKey,
	normalizeReturnPathDomain,
	normalizeVerpKey,
} from '@owlat/shared/verp';

/** Inputs to the relay envelope-sender decision. All explicit — no clock, no env. */
export interface RelayEnvelopeSenderInput {
	/** What the composer built: the From address, i.e. the shipped behaviour. */
	readonly composedEnvelopeFrom: string;
	/** The id the VERP token encodes (the composed Message-ID for a real send). */
	readonly messageId: string;
	/** Has this transport's `supportsCustomReturnPath` resolved to `supported`? */
	readonly customReturnPath: boolean;
	/** Our bounce domain (MTA_RETURN_PATH_DOMAIN). */
	readonly returnPathDomain: string | undefined;
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
 * therefore DMARC alignment are untouched — the composed message bytes are not
 * even read here. Giving the two arms different sending identities is what D11
 * forbids; giving them different *envelope senders* is what makes their bounce
 * data comparable in the first place.
 *
 * Falls back to the composed envelope sender — the exact shipped behaviour —
 * whenever the capability is unproven or the deployment has not configured a
 * return-path domain + a USABLE signing key. An UNSIGNED VERP address would be
 * a forgery surface on the bounce path, and a key shorter than the floor the
 * MTA enforces at startup mints tokens the MTA will never verify — which reads
 * downstream as "this arm produced no bounces", the exact measurement bias this
 * whole change exists to remove. Both mean no stamp, never a bad token.
 */
export function resolveRelayEnvelopeSender(input: RelayEnvelopeSenderInput): RelayEnvelopeSender {
	const domain = normalizeReturnPathDomain(input.returnPathDomain);
	const key = normalizeVerpKey(input.verpKey);
	if (!input.customReturnPath || !domain || !isUsableVerpKey(key) || input.messageId.length === 0) {
		return { envelopeFrom: input.composedEnvelopeFrom, isVerp: false };
	}
	return {
		envelopeFrom: buildVerpAddress(input.messageId, domain, key, input.now),
		isVerp: true,
	};
}
