/**
 * Terminal bounce classification for the direct-MX sender: once every MX host
 * has been exhausted, decide which soft/deferred bounce to surface based on the
 * strictest reason we recorded along the way. Kept out of `sender.ts` so the
 * MX loop reads as control flow and this file owns the bounce-string wording.
 */

import type { EmailJobResult } from '../types.js';
import type { AttemptOutcome } from './send/outcome.js';

export type UnroutableReason = Extract<AttemptOutcome, { kind: 'unroutable' }>['reason'];

/**
 * The failure when no MX host of the domain had an address to dial, or `null`
 * to fall through to the generic "all MX failed" result.
 *
 *  - Every host resolves only to loopback, private, link-local or otherwise
 *    non-public addresses: 5.4.4 (unable to route). The verdict is about the
 *    recipient's domain, so it carries no SMTP phase and neutral text; the bounce-cause logic (`bounceCause.ts`) then treats it
 *    like a Null MX or NXDOMAIN bounce and the address is suppressed with this
 *    reason attached.
 *  - No host has an address in the source IP's family: a deferral that says so
 *    (source-IP selection normally avoids this; a dedicated IP cannot).
 *  - The domain has no MX and its implicit MX, the domain itself, has neither
 *    A nor AAAA (RFC 5321 §5.1): 5.1.2 (bad destination system). A lookup
 *    that merely failed is not this; it stays a deferral.
 */
export function buildUnroutableResult(
	recipientDomain: string,
	mxHosts: readonly string[],
	implicitMx: boolean,
	unroutable: ReadonlyMap<string, UnroutableReason>
): EmailJobResult | null {
	if (mxHosts.length === 0 || !mxHosts.every((host) => unroutable.has(host))) return null;
	const reasons = mxHosts.map((host) => unroutable.get(host));
	if (reasons.every((reason) => reason === 'refused')) {
		return {
			success: false,
			// No domain or host name in the text: the SMTP classifier matches
			// categories from prose, and a name such as `spam.example` would turn
			// this into a refusal of our sending identity.
			error:
				'Every MX host of the recipient resolves only to loopback, private or link-local addresses, which the MTA does not connect to',
			bounceType: 'hard',
			smtpCode: 550,
			enhancedCode: '5.4.4',
		};
	}
	if (reasons.every((reason) => reason === 'no-family-address')) {
		return {
			success: false,
			error: `No MX host of ${recipientDomain} has an address in the sending IP's family: ${mxHosts.join(', ')}`,
			bounceType: 'soft',
		};
	}
	if (implicitMx && reasons.every((reason) => reason === 'not-found')) {
		return {
			success: false,
			error: `Recipient domain ${recipientDomain} has no MX record and no A or AAAA record`,
			bounceType: 'hard',
			smtpCode: 550,
			enhancedCode: '5.1.2',
		};
	}
	return null;
}

/**
 * Build the failure result after the MX loop has tried (or skipped) every host
 * without a delivery. Precedence — most specific first:
 *
 *  1. A TLS-required floor made every MX fail its handshake: name the TLS
 *     failure and stay soft/deferred (a TLS-required floor never falls back to
 *     cleartext — retried until the receiver's TLS is fixed or the message
 *     expires).
 *  2. Every MX deferred because its DANE TLSA lookup could not be completed
 *     (SERVFAIL / timeout / transport error). Not a denial of existence, so we
 *     never downgrade to a non-DANE (possibly cleartext) delivery (RFC 7672
 *     §2.1) — soft/deferred until the resolver recovers or the message expires.
 *  3. Otherwise every MX failed at connection level.
 */
export function buildAllMxFailedResult(
	recipientDomain: string,
	mxHosts: readonly string[],
	lastTlsFailureResponse: string | null,
	lastDaneDeferResponse: string | null
): EmailJobResult {
	if (lastTlsFailureResponse) {
		return {
			success: false,
			error: `TLS required but no MX for ${recipientDomain} completed a usable TLS handshake: ${lastTlsFailureResponse}`,
			bounceType: 'soft',
		};
	}

	if (lastDaneDeferResponse) {
		return {
			success: false,
			error: `DANE enabled but TLSA lookup could not be completed for any MX of ${recipientDomain}; deferring rather than delivering without DANE: ${lastDaneDeferResponse}`,
			bounceType: 'soft',
		};
	}

	return {
		success: false,
		error: `All MX hosts failed for ${recipientDomain}: ${mxHosts.join(', ')}`,
		bounceType: 'soft',
	};
}
