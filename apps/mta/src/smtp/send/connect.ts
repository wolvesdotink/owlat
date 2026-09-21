/**
 * Connect phase: get a usable SMTP socket to one MX host at one TLS profile.
 *
 * Reserves a pool entry (which enforces the global and per-provider connection
 * caps), then either checks out an idle, RSET-cleaned socket or opens a fresh
 * one — connect → greeting → EHLO → STARTTLS → re-EHLO, with the DANE
 * certificate hook when a TLSA RRset authenticates this MX. Every failure is
 * returned as an already-classified {@link AttemptOutcome}, so the caller never
 * inspects a connection error itself.
 */

import { SmtpConnection } from '@owlat/smtp-client';
import type { DestinationProviderKey } from '@owlat/shared/deliverabilityRouting';
import { logger } from '../../monitoring/logger.js';
import { isIpEligibilityLeaseValid, type IpEligibilityLease } from '../../scaling/ipPool.js';
import { pool, PoolOverCapError } from '../connectionPool.js';
import type { DanePlan } from '../daneVerify.js';
import type { TlsPolicyContext } from '../tlsRpt.js';
import {
	classifyFailure,
	type AttemptOutcome,
	type FailureClassificationContext,
} from './outcome.js';
import type { DeliveryProviderPolicy } from './route.js';

/** Inputs that are fixed for the whole job but shape every connection. */
export interface ConnectContext extends FailureClassificationContext {
	/** Quarantine fence: an invalidated lease stops any further acquisition. */
	eligibilityLease: IpEligibilityLease | undefined;
	/** EHLO name whose PTR record matches this bind IP. */
	ehloHostname: string;
	/** Connection-cap scope follows the actual MX set, not the snapshot. */
	routeProvider: DestinationProviderKey;
	providerPolicy: DeliveryProviderPolicy;
	/** Pool-key component: sockets never cross DKIM signing domains. */
	dkimDomain: string | undefined;
}

/** A reserved pool entry with a live socket, or an already-classified failure. */
export type MxConnection =
	| { kind: 'ready'; key: string; conn: SmtpConnection }
	| { kind: 'failed'; outcome: AttemptOutcome };

export async function openMxConnection(
	ctx: ConnectContext,
	mxHost: string,
	requireTLS: boolean,
	rejectUnauthorized: boolean,
	tlsContext: TlsPolicyContext,
	danePlan: DanePlan | undefined
): Promise<MxConnection> {
	const { redis, recipientDomain, bindIp, eligibilityLease } = ctx;
	const daneRequired = danePlan !== undefined;

	let acquired: Awaited<ReturnType<typeof pool.acquire>>;
	try {
		// Fence the discovery interval too: no reusable or fresh SMTP connection
		// is acquired after the selection generation becomes ineligible.
		if (eligibilityLease && !(await isIpEligibilityLeaseValid(redis, eligibilityLease))) {
			return {
				kind: 'failed',
				outcome: {
					kind: 'smtp',
					result: {
						success: false,
						error: 'Selected outbound IP became ineligible before SMTP acquisition',
						bounceType: 'deferred',
						smtpCode: 451,
					},
				},
			};
		}
		acquired = await pool.acquire(mxHost, bindIp, {
			port: 25,
			requireTLS,
			// Pin a TLSv1.2 floor: RFC 8996 deprecates TLS 1.0/1.1 and RFC 9325
			// mandates 1.2+. The pool pins this on every outbound connection so the
			// floor is never Node's env-fragile process default.
			tls: {
				rejectUnauthorized,
				minVersion: 'TLSv1.2',
				// DANE (RFC 7672): authenticate the MX certificate against its TLSA
				// RRset AFTER STARTTLS but before SMTP resumes. It runs even under
				// rejectUnauthorized:false (DANE-EE); a mismatch fails the connection
				// closed (never a cleartext fallback). Absent for non-DANE sends.
				...(danePlan ? { verifyPeerCertificate: danePlan.verifyPeerCertificate } : {}),
				...(danePlan ? { danePolicyFingerprint: danePlan.policyFingerprint } : {}),
			},
			name: ctx.ehloHostname,
			connectionTimeout: 30_000,
			greetingTimeout: 30_000,
			socketTimeout: 60_000,
			dkimDomain: ctx.dkimDomain,
			connectionLimits: {
				scope: ctx.routeProvider === 'other' ? `mx:${mxHost}` : `provider:${ctx.routeProvider}`,
				maxConnections: ctx.providerPolicy.maxConnections,
				maxDeliveriesPerConnection: ctx.providerPolicy.maxDeliveriesPerConnection,
			},
		});
	} catch (err) {
		// Over the global per-host connection cap — treat like a connection
		// failure: try the next MX, and if all are capped the loop falls through
		// to a soft bounce so the job is re-queued with backoff.
		if (err instanceof PoolOverCapError) {
			logger.warn(
				{ mxHost, recipientDomain },
				'Global connection cap reached, trying next MX host'
			);
			return { kind: 'failed', outcome: { kind: 'over-cap' } };
		}
		throw err;
	}
	const { key, config: connectConfig } = acquired;

	// Reuse fast-path (true socket reuse): an idle, RSET-cleaned live socket to
	// this exact {mx,bindIp,dkim,tlsProfile}. `takeConnection` returns undefined —
	// cleanly tearing the parked socket down where needed — when none is parked,
	// when it is over the per-connection / lifetime cap, or when its RSET probe
	// failed (poisoned). In every such case we open a fresh socket below on the
	// SAME pooled entry, whose global slot is retained.
	const parked = await pool.takeConnection(key);
	if (parked !== undefined) return { kind: 'ready', key, conn: parked };

	try {
		// Connect → greeting → EHLO → (STARTTLS + re-EHLO). A TLS/handshake/
		// connection failure throws here, classified from the structured
		// SmtpError (phase/tlsCause/replyCode) — never a log-string match.
		const conn = await SmtpConnection.connect(connectConfig);
		if (!pool.attachConnection(key, conn)) {
			return {
				kind: 'failed',
				outcome: {
					kind: 'connection',
					response: 'Distributed connection lease was lost before SMTP envelope',
				},
			};
		}
		return { kind: 'ready', key, conn };
	} catch (err) {
		pool.release(key);
		return { kind: 'failed', outcome: classifyFailure(ctx, err, mxHost, tlsContext, daneRequired) };
	}
}
