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

import { isIP } from 'node:net';
import { isSmtpError, SmtpConnection, type SmtpConnectOptions } from '@owlat/smtp-client';
import type { DestinationProviderKey } from '@owlat/shared/deliverabilityRouting';
import { logger } from '../../monitoring/logger.js';
import { isIpEligibilityLeaseValid, type IpEligibilityLease } from '../../scaling/ipPool.js';
import { pool, PoolOverCapError } from '../connectionPool.js';
import type { DanePlan } from '../daneVerify.js';
import {
	connectFamilyFor,
	resolveMxHostAddresses,
	screenAddressList,
	type MxHostAddresses,
} from '../mxAddresses.js';
import type { TlsPolicyContext } from '../tlsRpt.js';
import {
	asHostRefusal,
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
	/** `MTA_ALLOW_PRIVATE_MX`: connect to MX addresses the screen would refuse. */
	allowPrivateMxTargets: boolean;
}

/**
 * How many addresses of one MX host a fresh connection tries before the host
 * counts as unreachable. Each failed address can cost the full connect
 * timeout, so the list is cut short rather than walked to the end.
 */
const MAX_ADDRESSES_PER_HOST = 3;

/**
 * The outcome for an MX host that has no address this attempt may dial, or
 * the addresses to dial in order.
 */
function connectAddresses(
	resolution: MxHostAddresses,
	mxHost: string,
	bindIp: string
): { kind: 'addresses'; addresses: string[] } | { kind: 'unroutable'; outcome: AttemptOutcome } {
	const unroutable = (
		reason: Extract<AttemptOutcome, { kind: 'unroutable' }>['reason'],
		response: string
	) => ({
		kind: 'unroutable' as const,
		outcome: { kind: 'unroutable' as const, reason, response },
	});
	switch (resolution.status) {
		case 'refused':
			return unroutable(
				'refused',
				`MX host ${mxHost} resolves only to non-public addresses (${resolution.addresses.join(', ')}); not connecting`
			);
		case 'not-found':
			return unroutable('not-found', `MX host ${mxHost} has no A or AAAA record`);
		case 'temporary-failure':
			return unroutable(
				'lookup-failed',
				`Address lookup for MX host ${mxHost} failed: ${resolution.reason}`
			);
		case 'resolved': {
			const family = connectFamilyFor(bindIp);
			const addresses = family === 'ipv6' ? resolution.ipv6 : resolution.ipv4;
			if (addresses.length === 0) {
				return unroutable(
					'no-family-address',
					`MX host ${mxHost} has no ${family === 'ipv6' ? 'IPv6' : 'IPv4'} address to reach from ${bindIp}`
				);
			}
			return { kind: 'addresses', addresses: addresses.slice(0, MAX_ADDRESSES_PER_HOST) };
		}
	}
}

/**
 * The pool's connect config aimed at one resolved address. TLS keeps the MX
 * HOSTNAME as its SNI and certificate name: the client would otherwise default
 * both to `host`, which is now an address literal, and every certificate check
 * (MTA-STS enforce, require-verified) would run against the wrong name.
 */
function aimedAt(config: SmtpConnectOptions, address: string, mxHost: string): SmtpConnectOptions {
	const bareMxHost = mxHost.replace(/^\[(.*)\]$/, '$1');
	const servername = config.tls?.servername ?? (isIP(bareMxHost) ? address : mxHost);
	return { ...config, host: address, tls: { ...config.tls, servername } };
}

/** A TCP connect that failed before the server said anything: another address may answer. */
function isTcpConnectFailure(err: unknown): boolean {
	return (
		isSmtpError(err) &&
		err.phase === 'connect' &&
		err.replyCode === undefined &&
		err.tlsCause === undefined
	);
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
	danePlan: DanePlan | undefined,
	cleartext = false
): Promise<MxConnection> {
	const { redis, recipientDomain, bindIp, eligibilityLease } = ctx;
	const daneRequired = danePlan !== undefined;

	// A DANE session dials the addresses the validating resolver vouched for; a
	// forged system-resolver answer would otherwise pick the peer the TLSA check
	// then runs against.
	const resolution = danePlan
		? screenAddressList(danePlan.addresses, ctx.allowPrivateMxTargets)
		: await resolveMxHostAddresses(mxHost, { allowPrivate: ctx.allowPrivateMxTargets });
	const target = connectAddresses(resolution, mxHost, bindIp);
	if (target.kind === 'unroutable') {
		logger.warn(
			{ mxHost, recipientDomain, bindIp, reason: target.outcome },
			'MX host has no address this attempt can connect to, trying next'
		);
		return { kind: 'failed', outcome: target.outcome };
	}

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
			...(cleartext ? { cleartext: true } : {}),
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

	const { addresses } = target;
	for (const [index, address] of addresses.entries()) {
		let conn: SmtpConnection;
		try {
			// Connect → greeting → EHLO → (STARTTLS + re-EHLO). A TLS/handshake/
			// connection failure throws here, classified from the structured
			// SmtpError (phase/tlsCause/replyCode) — never a log-string match.
			conn = await SmtpConnection.connect(aimedAt(connectConfig, address, mxHost));
		} catch (err) {
			if (index < addresses.length - 1 && isTcpConnectFailure(err)) {
				logger.debug({ mxHost, address }, 'MX address did not accept a connection, trying next');
				continue;
			}
			pool.release(key);
			return {
				kind: 'failed',
				outcome: asHostRefusal(err, classifyFailure(ctx, err, mxHost, tlsContext, daneRequired)),
			};
		}
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
	}
	// `connectAddresses` never returns an empty list, so the loop always returns.
	pool.release(key);
	return { kind: 'failed', outcome: { kind: 'connection', response: `No address for ${mxHost}` } };
}
