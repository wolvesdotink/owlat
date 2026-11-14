/**
 * Tracking domain verification — the verdict and the send-time choice, pure.
 *
 * A tracking domain is only worth rewriting links to when both halves hold:
 * its CNAME points at this deployment, and an HTTPS request to it, with a
 * certificate the client accepts, reaches this deployment's tracking handler.
 * A CNAME alone proves nothing about the reverse proxy or the certificate, and
 * a domain that fails either half breaks every link in the mail that uses it.
 *
 * The checker (`trackingDomainCheck.ts`) gathers the two observations; this
 * module turns them into what the row should say, and the commit
 * (`trackingDomains.ts:recordTrackingDomainCheck`) writes it.
 */

import type { Doc } from '../_generated/dataModel';
import { organizationalDomain } from '@owlat/shared/dnsZone';
import type { TrackingDomainCheckOutcome } from '../lib/literalValidators';
import { REGRESSION_CONFIRM_DELAY_MS } from './lifecycleVerdict';

/** What the CNAME lookup established. `unanswered` is a resolver failure, not evidence. */
export type TrackingCnameObservation = 'match' | 'mismatch' | 'unanswered';

/**
 * What the HTTPS probe established.
 *   - `ok`: this deployment's probe answer, over a certificate the client accepted.
 *   - `unreachable`: no HTTPS answer at all: connection refused, TLS or
 *     certificate failure, timeout, or a host on a private address.
 *   - `wrong_response`: something answered, but not this deployment's tracking
 *     handler (a non-2xx status, a redirect, or a body that is not the answer).
 *   - `unanswered`: the probe could not be judged (the host's name did not
 *     resolve for the fetch, or the probe route was rate limited).
 */
export type TrackingProbeObservation = 'ok' | 'unreachable' | 'wrong_response' | 'unanswered';

/**
 * Combine the two observations into one outcome. The probe is only consulted
 * once the CNAME matches, so a DNS failure is reported as DNS, and an HTTPS
 * failure is only ever reported for a domain whose DNS is right.
 */
export function trackingDomainCheckOutcome(
	cname: TrackingCnameObservation,
	probe: TrackingProbeObservation | null
): TrackingDomainCheckOutcome {
	if (cname === 'unanswered') return 'inconclusive';
	if (cname === 'mismatch') return 'dns_mismatch';
	switch (probe) {
		case 'ok':
			return 'verified';
		case 'unreachable':
			return 'https_unreachable';
		case 'wrong_response':
			return 'https_wrong_response';
		default:
			return 'inconclusive';
	}
}

type TrackingDomainState = Pick<
	Doc<'trackingDomains'>,
	'isVerified' | 'verifiedAt' | 'regressionSuspectedAt'
>;

export interface TrackingDomainCheckPlan {
	readonly patch: Partial<Doc<'trackingDomains'>>;
	/** Set when the row's verified state changes; the commit audits it. */
	readonly transition: 'verified' | 'unverified' | null;
	/** A verified domain's first failure: re-check after the confirmation delay. */
	readonly confirmAfterMs: number | null;
}

/**
 * Turn an outcome into the row's next state, with the caution sending domains
 * get (`lifecycleVerdict.ts:planVerificationTransition`):
 *   - an inconclusive check changes nothing but the recorded last check;
 *   - an unverified domain is verified by one passing check, and stays
 *     unverified on a failing one;
 *   - a verified domain leaves `verified` only on the second failing check, at
 *     least {@link REGRESSION_CONFIRM_DELAY_MS} after the first. The first one
 *     records the failure, stamps `regressionSuspectedAt` and asks for the
 *     confirming check; a pass clears the stamp.
 */
export function planTrackingDomainCheck(
	row: TrackingDomainState,
	outcome: TrackingDomainCheckOutcome,
	at: number
): TrackingDomainCheckPlan {
	const lastCheck = { at, outcome };
	if (outcome === 'inconclusive') {
		return { patch: { lastCheck }, transition: null, confirmAfterMs: null };
	}
	if (outcome === 'verified') {
		return {
			patch: {
				lastCheck,
				isVerified: true,
				verifiedAt: row.isVerified ? (row.verifiedAt ?? at) : at,
				regressionSuspectedAt: undefined,
			},
			transition: row.isVerified ? null : 'verified',
			confirmAfterMs: null,
		};
	}
	if (!row.isVerified) {
		return { patch: { lastCheck }, transition: null, confirmAfterMs: null };
	}
	const suspectedAt = row.regressionSuspectedAt;
	if (suspectedAt === undefined) {
		return {
			patch: { lastCheck, regressionSuspectedAt: at },
			transition: null,
			confirmAfterMs: REGRESSION_CONFIRM_DELAY_MS,
		};
	}
	if (at - suspectedAt < REGRESSION_CONFIRM_DELAY_MS) {
		return { patch: { lastCheck }, transition: null, confirmAfterMs: null };
	}
	return {
		patch: { lastCheck, isVerified: false, regressionSuspectedAt: undefined },
		transition: 'unverified',
		confirmAfterMs: null,
	};
}

/**
 * The tracking domain a send from `fromAddress` rewrites its links to, or
 * `null` for the deployment's default tracking base URL (the Convex site URL).
 *
 * Only a verified tracking domain under the same organisational domain as the
 * From address qualifies: a link host unrelated to the sender reads as a
 * mismatch to filters and recipients, and a domain verified for one brand must
 * not carry another brand's mail. When several qualify, the oldest one wins, so
 * the choice does not move when a second one is added.
 */
export function selectTrackingDomainForSender(
	rows: readonly Pick<Doc<'trackingDomains'>, 'domain' | 'isVerified' | 'createdAt'>[],
	fromAddress: string
): string | null {
	const fromDomain = senderDomain(fromAddress);
	const fromOrg = fromDomain === null ? null : organizationalDomain(fromDomain);
	if (fromOrg === null) return null;
	const candidates = rows
		.filter((row) => row.isVerified && organizationalDomain(row.domain) === fromOrg)
		.sort((a, b) => a.createdAt - b.createdAt || a.domain.localeCompare(b.domain));
	return candidates[0]?.domain ?? null;
}

/** The domain of a From value: a bare address or `Name <address>`. */
function senderDomain(fromAddress: string): string | null {
	const bracketed = /<([^<>]+)>\s*$/.exec(fromAddress);
	const address = (bracketed?.[1] ?? fromAddress).trim();
	const at = address.lastIndexOf('@');
	if (at < 0) return null;
	const domain = address.slice(at + 1).toLowerCase();
	return domain === '' ? null : domain;
}
