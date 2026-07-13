/**
 * Terminal bounce classification for the direct-MX sender: once every MX host
 * has been exhausted, decide which soft/deferred bounce to surface based on the
 * strictest reason we recorded along the way. Kept out of `sender.ts` so the
 * MX loop reads as control flow and this file owns the bounce-string wording.
 */

import type { EmailJobResult } from '../types.js';

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
