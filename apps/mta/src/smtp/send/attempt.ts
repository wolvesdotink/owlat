/**
 * One delivery attempt to one MX host at one TLS profile.
 *
 * Opens (or reuses) a socket through the connect phase, writes the envelope and
 * the pre-signed bytes, records the TLS-RPT result, and hands the socket back to
 * the pool — parked for reuse when the session is still protocol-healthy, evicted
 * otherwise. Returns a discriminated {@link AttemptOutcome} so the MX loop decides
 * whether to return, try the next MX, or retry the same MX at a lower floor.
 */

import { sendEnvelope, type SendResult } from '@owlat/smtp-client';
import { pool } from '../connectionPool.js';
import type { DanePlan } from '../daneVerify.js';
import { recordTlsResult, type TlsPolicyContext, type TlsResultType } from '../tlsRpt.js';
import { stsAttributedResultType } from '../tlsFailureClassification.js';
import { isIpEligibilityLeaseValid } from '../../scaling/ipPool.js';
import { openMxConnection, type ConnectContext } from './connect.js';
import { fencedDataBodyWrite, SmtpDataBodyJournalTransitionError } from './dataJournal.js';
import { classifyFailure, isCleanPreDataRejection, type AttemptOutcome } from './outcome.js';

/** Everything one attempt needs beyond the connect inputs: the exact payload. */
export interface AttemptContext extends ConnectContext {
	/** MAIL FROM — the VERP return path for this job. */
	verpAddress: string;
	/** RCPT TO — a job carries exactly one recipient. */
	recipient: string;
	/** The bytes composed and signed once for the job, retried unchanged. */
	signedBytes: Buffer;
	/** MTA-STS attribution for a non-DANE attempt. */
	policyContext: TlsPolicyContext;
	/** Durability fence awaited between the 354 reply and the body write. */
	beforeDataBodyWrite: (() => Promise<void>) | undefined;
}

export async function attemptSend(
	ctx: AttemptContext,
	mxHost: string,
	requireTLS: boolean,
	rejectUnauthorized: boolean,
	danePlan?: DanePlan
): Promise<AttemptOutcome> {
	const { redis, recipientDomain, bindIp, stsPolicyMode, eligibilityLease } = ctx;
	const tlsContext = danePlan?.policyContext ?? ctx.policyContext;
	const daneRequired = danePlan !== undefined;

	const opened = await openMxConnection(
		ctx,
		mxHost,
		requireTLS,
		rejectUnauthorized,
		tlsContext,
		danePlan
	);
	if (opened.kind === 'failed') return opened.outcome;
	const { key, conn } = opened;

	try {
		// Acquisition, RSET, and connect are asynchronous. Fence once more at the
		// last safe boundary before MAIL FROM so quarantine always wins that race,
		// including for a socket already checked out when its pool is invalidated.
		if (eligibilityLease && !(await isIpEligibilityLeaseValid(redis, eligibilityLease))) {
			pool.evictConnection(key, conn);
			return {
				kind: 'smtp',
				result: {
					success: false,
					error: 'Selected outbound IP became ineligible before SMTP envelope',
					bounceType: 'deferred',
					smtpCode: 451,
				},
			};
		}

		// `secured` reports whether this CONNECTION negotiated TLS (STARTTLS
		// upgrade). It is per-connection: every message carried over a reused
		// socket is attributed to the same TLS state. A cleartext delivery to an
		// MX that did not advertise STARTTLS (opportunistic, requireTLS:false) is
		// NOT a TLS success.
		const secured = conn.secured;

		const result: SendResult = await sendEnvelope(conn, {
			from: ctx.verpAddress,
			to: [ctx.recipient],
			data: ctx.signedBytes,
			...(ctx.beforeDataBodyWrite
				? { beforeDataBodyWrite: fencedDataBodyWrite(ctx.beforeDataBodyWrite) }
				: {}),
		});

		// Record the TLS-RPT result for this successful delivery (RFC 8460 §4.3).
		// Encrypted → 'success'; cleartext → 'starttls-not-supported' (escalated to
		// the STS-specific type under a testing/enforce policy). Recording a
		// cleartext send as success would overstate our TLS coverage to the domain
		// owner.
		const successResultType: TlsResultType = secured
			? 'success'
			: stsAttributedResultType('starttls-not-supported', stsPolicyMode);
		recordTlsResult(redis, recipientDomain, successResultType, mxHost, bindIp, tlsContext).catch(
			() => {}
		);

		// Healthy delivery: park the socket for the next job to reuse across an RSET
		// boundary (or let the pool cleanly QUIT it at the per-connection / lifetime
		// cap), then release the entry's in-flight reservation.
		pool.storeConnection(key, conn);
		pool.release(key);

		// Parse remote message ID from the final SMTP reply text
		// Gmail: "250 2.0.0 OK 1234567890 abc123.google.com"
		// Outlook: "250 2.6.0 <msgid@outlook.com> [Hostname=...]"
		const responseText = `${result.response.code} ${result.response.text}`.trim();
		const remoteIdMatch = result.response.text.match(/<([^>]+)>/);
		const remoteMessageId = remoteIdMatch?.[1];

		return {
			kind: 'sent',
			result: {
				success: true,
				smtpResponse: responseText,
				remoteMessageId,
				smtpCode: result.response.code,
			},
		};
	} catch (err) {
		if (err instanceof SmtpDataBodyJournalTransitionError) {
			// The peer has entered DATA mode but no body bytes were written. The
			// socket cannot be reused, and a Redis durability failure must escape
			// this MX loop so the queue retries from a durable pre-DATA state.
			pool.evictConnection(key, conn);
			throw err.transitionFailure;
		}
		if (isCleanPreDataRejection(err)) {
			// A clean pre-DATA reply rejection (every recipient refused, or MAIL FROM
			// bounced) left the SMTP session OPEN and the socket protocol-healthy — it
			// carries a server reply code, no TLS fault, never reached DATA, and was
			// not a 421 channel-close. Before socket reuse a bounce left the pooled
			// entry intact; preserve that (and its Redis slot) by parking the socket
			// for reuse rather than evicting. The next job's RSET boundary aborts the
			// leftover transaction before the socket carries a new one.
			pool.storeConnection(key, conn);
			pool.release(key);
		} else {
			// ANY other failure — a transport/TLS fault, a 421 channel close, or a
			// DATA-phase ambiguity — poisons this socket: evict the entry, release its
			// global slot, and never reuse it. The in-flight job retries on a fresh
			// connection (next MX, or a requeue) exactly once.
			pool.evictConnection(key, conn);
		}
		return classifyFailure(ctx, err, mxHost, tlsContext, daneRequired);
	}
}
