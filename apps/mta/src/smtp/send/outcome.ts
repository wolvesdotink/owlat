/**
 * Outcome classification for one delivery attempt.
 *
 * Turns whatever `@owlat/smtp-client` threw into the discriminated
 * {@link AttemptOutcome} the MX loop reducer understands, recording the TLS-RPT
 * result along the way. It reads only the structured discriminants of an
 * `SmtpError` — `tlsCause`, `replyCode`, `enhancedCode`, `phase`,
 * `clientRefusal` — never a log-line string.
 */

import type Redis from 'ioredis';
import { isSmtpError } from '@owlat/smtp-client';
import type { EmailJobResult } from '../../types.js';
import { logger } from '../../monitoring/logger.js';
import { fireAndForget } from '../../lib/fireAndForget.js';
import { recordTlsResult, type TlsPolicyContext, type TlsResultType } from '../tlsRpt.js';
import { classifyTlsFailure, stsAttributedResultType } from '../tlsFailureClassification.js';
import type { StsPolicyMode } from '../mtaSts.js';

/** The discriminated outcome of one delivery attempt to a single MX host. */
export type AttemptOutcome =
	| { kind: 'sent'; result: EmailJobResult }
	| { kind: 'smtp'; result: EmailJobResult }
	// A post-DATA drop with no server reply: the message MAY already have been
	// accepted, so this is TERMINAL — never a next-MX attempt, never an
	// auto-retried soft bounce. Carries its own result.
	| { kind: 'ambiguous'; result: EmailJobResult }
	| { kind: 'tls-failure'; resultType: TlsResultType; response: string }
	| { kind: 'connection'; response: string }
	| { kind: 'over-cap' };

/** Everything outcome classification needs to attribute and record a failure. */
export interface FailureClassificationContext {
	redis: Redis;
	recipientDomain: string;
	/** Outbound source IP, reported as the sending MTA in TLS-RPT. */
	bindIp: string;
	/** The recipient's MTA-STS state, which escalates a TLS failure type. */
	stsPolicyMode: StsPolicyMode;
}

/**
 * True for a delivery failure that left the socket protocol-healthy and reusable:
 * a server reply rejection in a pre-DATA phase (`mail`/`rcpt`), carrying a reply
 * code, with no TLS fault and not a 421 (which signals the server is closing the
 * channel). Everything else — transport faults, TLS faults, DATA/DATA-final
 * ambiguity, 421 — leaves the socket unusable and must evict.
 */
export function isCleanPreDataRejection(err: unknown): boolean {
	return (
		isSmtpError(err) &&
		err.tlsCause === undefined &&
		err.replyCode !== undefined &&
		err.replyCode !== 421 &&
		(err.phase === 'mail' || err.phase === 'rcpt')
	);
}

/**
 * Classify a structured `SmtpError` from a connect or send attempt into a
 * delivery outcome, recording TLS-RPT along the way.
 *
 * `tlsContext` is the policy the attempt ran under — the DANE plan's `tlsa`
 * context when one applied, else the destination's MTA-STS context — and
 * `daneRequired` says whether a TLSA RRset authenticated that attempt.
 */
export function classifyFailure(
	ctx: FailureClassificationContext,
	err: unknown,
	mxHost: string,
	tlsContext: TlsPolicyContext,
	daneRequired: boolean
): AttemptOutcome {
	const { redis, recipientDomain, bindIp, stsPolicyMode } = ctx;
	if (!isSmtpError(err)) {
		const response = err instanceof Error ? err.message : String(err);
		logger.warn(
			{ mxHost, recipientDomain, error: response },
			'Unexpected non-SMTP error during delivery, trying next MX'
		);
		return { kind: 'connection', response };
	}
	const response = err.message;

	// 0. Client-side permanent refusal (no reply code, no TLS cause). Today the
	//    only case is `smtputf8-unavailable`: the envelope carries a non-ASCII
	//    (RFC 6531) mailbox but this MX did not advertise SMTPUTF8. There is no
	//    ASCII downgrade for a UTF-8 local-part, so retrying (this MX or the next)
	//    can never succeed — a HARD bounce, terminal like a 5xx.
	if (err.clientRefusal === 'smtputf8-unavailable') {
		return {
			kind: 'smtp',
			result: {
				success: false,
				error: response,
				bounceType: 'hard',
			},
		};
	}

	// 1. TLS-phase failure (a structured tlsCause). Under DANE this is an RFC 8460
	//    'validation-failure' attributed to the tlsa policy and never downgrades
	//    to cleartext. Otherwise escalate to the STS-specific type under a policy.
	if (err.tlsCause !== undefined) {
		if (daneRequired) {
			void fireAndForget(
				recordTlsResult(redis, recipientDomain, 'validation-failure', mxHost, bindIp, tlsContext),
				logger,
				'record_tls_result'
			);
			return { kind: 'tls-failure', resultType: 'validation-failure', response };
		}
		const baseType = classifyTlsFailure(err.tlsCause);
		const stsResultType = stsAttributedResultType(baseType, stsPolicyMode);
		void fireAndForget(
			recordTlsResult(redis, recipientDomain, stsResultType, mxHost, bindIp, tlsContext),
			logger,
			'record_tls_result'
		);
		return { kind: 'tls-failure', resultType: stsResultType, response };
	}

	// 2. A server reply code is the DEFINITIVE verdict. 5xx = permanent (hard
	//    bounce) unless 5.2.2 "mailbox full" (soft); 4xx = temporary (deferred).
	if (err.replyCode !== undefined) {
		const smtpCode = err.replyCode;
		const enhancedCode = err.enhancedCode;
		if (smtpCode >= 500 && smtpCode < 600) {
			const isSoftDespite5xx = enhancedCode === '5.2.2';
			return {
				kind: 'smtp',
				result: {
					success: false,
					error: response,
					bounceType: isSoftDespite5xx ? 'soft' : 'hard',
					smtpCode,
					...(enhancedCode !== undefined ? { enhancedCode } : {}),
				},
			};
		}
		if (smtpCode >= 400 && smtpCode < 500) {
			return {
				kind: 'smtp',
				result: {
					success: false,
					error: response,
					bounceType: 'deferred',
					smtpCode,
					...(enhancedCode !== undefined ? { enhancedCode } : {}),
				},
			};
		}
	}

	// 3. Post-DATA ambiguous drop: a `data`/`data-final` phase failure with NO
	//    server reply and no TLS cause. The body (and possibly the terminating
	//    dot) was already written, so the receiver may have accepted the message
	//    before the connection dropped. Retrying — on the next MX or via a
	//    soft-bounce requeue — risks a DOUBLE DELIVERY, so the retry taxonomy must
	//    NEVER auto-retry it (see @owlat/smtp-client's transaction errors).
	//    Terminate the job here with its OWN `ambiguous` bounceType — NOT `hard` —
	//    so the dispatch reducer stays terminal (no next-MX, no requeue) WITHOUT
	//    suppressing the recipient or fabricating a 5xx: the message may in fact
	//    have been delivered.
	if (
		(err.phase === 'data' || err.phase === 'data-final') &&
		err.replyCode === undefined &&
		err.tlsCause === undefined
	) {
		logger.warn(
			{ mxHost, recipientDomain, phase: err.phase, error: response },
			'Ambiguous post-DATA failure with no server reply; not retrying (message may already be delivered)'
		);
		return {
			kind: 'ambiguous',
			result: {
				success: false,
				error: `Ambiguous delivery outcome for ${recipientDomain} (phase ${err.phase}, no server reply): message may already have been accepted — not retrying to avoid a double delivery: ${response}`,
				bounceType: 'ambiguous',
			},
		};
	}

	// 4. No reply, no TLS cause — a connection/greeting-level failure (or a
	//    reply-less ambiguous drop in a retry-safe phase). Try the next MX host.
	//    A required floor never reaches here without a tlsCause, so it is never
	//    silently downgraded (that lives in branch 1).
	logger.warn(
		{ mxHost, recipientDomain, error: response, phase: err.phase },
		'Connection failed to MX host, trying next'
	);
	return { kind: 'connection', response };
}

/**
 * The result of an outcome that ENDS the job: a delivery, a server verdict, or
 * an ambiguous post-DATA drop. `undefined` for the outcomes that let the MX loop
 * carry on (connection failure, TLS failure, connection cap).
 */
export function terminalResult(outcome: AttemptOutcome): EmailJobResult | undefined {
	return outcome.kind === 'sent' || outcome.kind === 'smtp' || outcome.kind === 'ambiguous'
		? outcome.result
		: undefined;
}
