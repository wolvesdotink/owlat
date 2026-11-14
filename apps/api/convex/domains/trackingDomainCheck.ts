'use node';

/**
 * One tracking-domain check: the CNAME lookup, then the HTTPS probe, then one
 * commit (`trackingDomains.recordTrackingDomainCheck`). Run by the Verify
 * button, by the daily re-check (`reverificationSweep.ts`) and by the
 * confirming check a verified domain's first failure schedules.
 *
 * Node runtime because the probe goes through the SSRF guard: the tracking
 * host is operator-supplied, so it must not be able to point this fetch at an
 * internal address.
 */

import { v } from 'convex/values';
import { isValidDomain } from '@owlat/shared';
import { validatorDecoder } from '@owlat/worker-protocol/decodeJson';
import { internal } from '../_generated/api';
import { internalAction } from '../_generated/server';
import { getOptional } from '../lib/env';
import { logError, logWarn } from '../lib/runtimeLog';
import type { TrackingDomainCheckOutcome } from '../lib/literalValidators';
import { constantTimeEqual } from '../lib/crypto';
import {
	FetchGuardError,
	RedirectRefusedError,
	SsrfBlockedError,
	fetchGuarded,
	readCappedBytes,
} from '../lib/ssrfGuard';
import { TRACKING_PROBE_PATH_PREFIX, trackingProbeAnswer } from '../delivery/trackingProbe';
import { trackingDomainCheckOutcome } from './trackingDomainVerdict';
import type { TrackingCnameObservation, TrackingProbeObservation } from './trackingDomainVerdict';

const LOOKUP_TIMEOUT_MS = 10_000;
// The answer is a 43-character base64url HMAC; anything much longer is not it.
const PROBE_MAX_BYTES = 1_024;

/** A DNS-over-HTTPS JSON answer, as far as the CNAME check reads it. */
const decodeDnsAnswer = validatorDecoder(
	v.object({
		Status: v.optional(v.number()),
		Answer: v.optional(v.array(v.object({ type: v.number(), data: v.string() }))),
	})
);

// RCODEs that are an answer about the name: NOERROR and NXDOMAIN. Anything
// else (SERVFAIL, REFUSED) is the resolver failing, which proves nothing.
const ANSWERED_RCODES = new Set([0, 3]);
const CNAME_RR_TYPE = 5;

/**
 * Whether `domain`'s CNAME is `expected`, asked over DNS-over-HTTPS (the public
 * view the recipients' clients see). A transport error, a non-2xx, an
 * unreadable body or a resolver RCODE is `unanswered`.
 */
export async function lookupTrackingCname(
	domain: string,
	expected: string
): Promise<TrackingCnameObservation> {
	try {
		const response = await fetch(
			`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=CNAME`,
			{
				headers: { Accept: 'application/dns-json' },
				signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
			}
		);
		if (!response.ok) return 'unanswered';
		const decoded = decodeDnsAnswer(await response.json());
		if (!decoded.ok) return 'unanswered';
		const { Status, Answer } = decoded.value;
		if (Status !== undefined && !ANSWERED_RCODES.has(Status)) return 'unanswered';
		const target = expected.replace(/\.$/, '').toLowerCase();
		const matches = (Answer ?? []).some(
			(a) => a.type === CNAME_RR_TYPE && a.data.replace(/\.$/, '').toLowerCase() === target
		);
		return matches ? 'match' : 'mismatch';
	} catch (error) {
		logWarn('[Tracking Domain] CNAME lookup failed', { domain, error });
		return 'unanswered';
	}
}

export type ProbeFetch = (
	url: string,
	init: RequestInit & { protocols?: string[] }
) => Promise<Response>;

/**
 * Ask `https://<domain>/t/probe/<nonce>` for this deployment's probe answer.
 * The fetch is the SSRF guard's: HTTPS only, the host's addresses checked
 * before and at connect time, no redirects followed, and the platform's
 * certificate validation, so a missing or invalid certificate is a failed
 * connection here exactly as it would be in a recipient's browser.
 */
export async function probeTrackingHost(
	domain: string,
	secret: string,
	nonce: string,
	fetchFn: ProbeFetch = fetchGuarded
): Promise<TrackingProbeObservation> {
	// A row from before the add mutation checked the shape: never let it put a
	// port, path or userinfo into the request URL.
	if (!isValidDomain(domain)) return 'unreachable';
	let response: Response;
	try {
		response = await fetchFn(`https://${domain}${TRACKING_PROBE_PATH_PREFIX}${nonce}`, {
			protocols: ['https:'],
			headers: { Accept: 'text/plain' },
			signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
		});
	} catch (error) {
		if (error instanceof RedirectRefusedError) return 'wrong_response';
		if (error instanceof SsrfBlockedError) return 'unreachable';
		// The guard could not resolve the host: no evidence about the proxy.
		if (error instanceof FetchGuardError) return 'unanswered';
		return 'unreachable';
	}
	// Our own route's rate limit, not the operator's setup.
	if (response.status === 429) return 'unanswered';
	if (!response.ok) return 'wrong_response';
	let body: string;
	try {
		const bytes = await readCappedBytes(response.body, PROBE_MAX_BYTES);
		body = bytes === null ? '' : new TextDecoder().decode(bytes).trim();
	} catch {
		return 'wrong_response';
	}
	return constantTimeEqual(body, await trackingProbeAnswer(secret, nonce))
		? 'ok'
		: 'wrong_response';
}

function newProbeNonce(): string {
	return crypto.randomUUID().replace(/-/g, '');
}

export const checkTrackingDomain = internalAction({
	args: { trackingDomainId: v.id('trackingDomains') },
	handler: async (ctx, args): Promise<{ outcome: TrackingDomainCheckOutcome } | null> => {
		const row = await ctx.runQuery(internal.domains.trackingDomains.getTrackingDomainForCheck, {
			trackingDomainId: args.trackingDomainId,
		});
		if (!row) return null;

		const cname = await lookupTrackingCname(row.domain, row.cnameTarget);
		let probe: TrackingProbeObservation | null = null;
		if (cname === 'match') {
			const secret = getOptional('UNSUBSCRIBE_SECRET');
			if (secret) {
				probe = await probeTrackingHost(row.domain, secret, newProbeNonce());
			} else {
				// Without it no tracked link works on any host; nothing to judge here.
				logWarn('[Tracking Domain] UNSUBSCRIBE_SECRET is not set; the HTTPS probe was skipped');
				probe = 'unanswered';
			}
		}
		const outcome = trackingDomainCheckOutcome(cname, probe);

		try {
			await ctx.runMutation(internal.domains.trackingDomains.recordTrackingDomainCheck, {
				trackingDomainId: args.trackingDomainId,
				domain: row.domain,
				outcome,
			});
		} catch (error) {
			// The row stays as it was; the next check records afresh.
			logError('[Tracking Domain] could not record the check', {
				trackingDomainId: args.trackingDomainId,
				error,
			});
		}
		return { outcome };
	},
});
