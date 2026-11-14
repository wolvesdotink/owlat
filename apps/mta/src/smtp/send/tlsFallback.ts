/**
 * Opportunistic TLS's cleartext fallback.
 *
 * Under opportunistic TLS (RFC 7435) a receiver that does not offer STARTTLS
 * gets the message in cleartext. One that offers STARTTLS and then cannot
 * finish the handshake (it only speaks TLS 1.0/1.1 below our TLSv1.2 floor, its
 * TLS stack is broken, or it answers STARTTLS with an error) would otherwise
 * never receive mail at all, though the guarantee on that path is the same:
 * an active attacker who can break the handshake can just as well strip the
 * STARTTLS capability. So the attempt is repeated ONCE on a fresh connection to
 * the same host without STARTTLS.
 *
 * Only when nothing demands TLS: a floor with `requireTLS` (an operator
 * `require`/`require-verified` mode, a provider profile such as Gmail's, an
 * MTA-STS enforce policy) or a DANE plan never reaches cleartext. The failed
 * handshake has already been recorded for TLS-RPT by the attempt that saw it.
 */

import { logger } from '../../monitoring/logger.js';
import type { TlsRequirements } from '../tlsPolicy.js';
import type { AttemptContext } from './attempt.js';
import type { AttemptOutcome } from './outcome.js';

type Attempt = (
	ctx: AttemptContext,
	mxHost: string,
	requireTLS: boolean,
	rejectUnauthorized: boolean,
	danePlan?: undefined,
	cleartext?: boolean
) => Promise<AttemptOutcome>;

/**
 * Whether the cleartext session was refused BECAUSE it is cleartext: 530 or
 * X.7.10 / X.7.11 "encryption needed" (RFC 3207 §4, RFC 5248), or a refusal of
 * MAIL FROM, which on a server that offered STARTTLS is that refusal in
 * practice. Such a verdict is about the transport, not the message, so it must
 * not end the job; the TLS failure stands and the next host is tried.
 */
function refusedForCleartext(outcome: AttemptOutcome): boolean {
	if (outcome.kind !== 'smtp' || outcome.result.success) return false;
	const { smtpCode, enhancedCode, smtpPhase } = outcome.result;
	return smtpCode === 530 || /^[45]\.7\.1[01]$/.test(enhancedCode ?? '') || smtpPhase === 'mail';
}

/**
 * One attempt at `floor`; when the floor allows cleartext and the attempt
 * failed on TLS, one more on a cleartext connection to the same host.
 */
export async function attemptWithCleartextFallback(
	attempt: Attempt,
	ctx: AttemptContext,
	mxHost: string,
	floor: Pick<TlsRequirements, 'requireTLS' | 'rejectUnauthorized'>
): Promise<AttemptOutcome> {
	const outcome = await attempt(ctx, mxHost, floor.requireTLS, floor.rejectUnauthorized);
	if (outcome.kind !== 'tls-failure' || floor.requireTLS || floor.rejectUnauthorized) {
		return outcome;
	}
	logger.warn(
		{ mxHost, recipientDomain: ctx.recipientDomain, resultType: outcome.resultType },
		'Opportunistic STARTTLS failed; retrying this MX once without TLS'
	);
	const fallback = await attempt(ctx, mxHost, false, false, undefined, true);
	return refusedForCleartext(fallback) ? outcome : fallback;
}
