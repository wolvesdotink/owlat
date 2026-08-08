/**
 * From "what Mandrill said" to "what the identity row holds" — the pure half of
 * the Mandrill sending-domain provider.
 *
 * Its own file because every rule here is a JUDGEMENT that has to be pinned by
 * a test rather than exercised through a network mock: what counts as verified,
 * how often we ask again, and what a failed call is allowed to overwrite.
 */

import { CURRENT_RELAY_IDENTITY_PROVIDER_DETAILS_VERSION } from '../../../lib/constants';
import { MANDRILL_DKIM_SELECTOR } from './records';
import type { MandrillDomainState } from './api';
import type { MandrillIdentity, RelayIdentityStatus } from '../types';

/**
 * The re-check cadence, by the state we last observed.
 *
 * The verified interval is what keeps a live relay proof inside
 * `MANDRILL_RELAY_PROOF_MAX_AGE_MS` (7 days) with a week of headroom for missed
 * ticks. `pending_dns` is short because it is the state an operator is actively
 * working in — they publish a record and want the screen to catch up — and one
 * HTTP call per waiting domain per hour is nothing. `failed` is slow on
 * purpose: it means a credential an operator must fix, so re-asking hard would
 * hammer Mandrill's auth surface with a key it already rejected.
 */
export const MANDRILL_CHECK_INTERVAL_MS = {
	verified: 24 * 60 * 60 * 1000,
	pending_dns: 60 * 60 * 1000,
	unverified: 60 * 60 * 1000,
	failed: 6 * 60 * 60 * 1000,
} as const satisfies Record<RelayIdentityStatus, number>;

/**
 * Retry delay after a call that told us NOTHING (Mandrill down, timeout,
 * gateway page). Shorter than any real cadence: there is no new information to
 * wait for, only an outage to ride out.
 */
export const MANDRILL_UNAVAILABLE_RETRY_MS = 15 * 60 * 1000;

/** The `providerDetails` blob for a Mandrill identity (D7, versioned). */
export interface MandrillProviderDetails {
	readonly kind: 'mandrill';
	/** Mandrill's aggregate signing verdict. */
	readonly isValidSigning: boolean;
	/** Ownership verification timestamp, when Mandrill has recorded one. */
	readonly verifiedAt?: number;
	/** The `mandrill_verify.<key>` TXT token, when this account offers one. */
	readonly verifyTxtKey?: string;
	/** Why the last call could not produce a verdict, when it could not. */
	readonly lastError?: string;
}

/**
 * Is this domain provably able to send signed mail through Mandrill?
 *
 * FOUR conditions, all of them Mandrill's own answer, and all four are load
 * bearing:
 *  - `spf.valid` / `dkim.valid` — the records are published and Mandrill can
 *    see them from where it sends;
 *  - `valid_signing` — Mandrill's own aggregate permission to sign for this
 *    domain, which can be false even with both records live (a suspended
 *    account, a domain claimed elsewhere);
 *  - `verified_at` — OWNERSHIP. Mandrill rejects mail from an unverified
 *    sender domain with `reject_reason: unsigned`, so treating a domain with
 *    perfect DNS but no ownership proof as verified would hand the relay a
 *    domain it is about to bounce.
 */
export function isMandrillDomainVerified(state: MandrillDomainState): boolean {
	return (
		state.spf.isValid &&
		state.dkim.isValid &&
		state.isValidSigning &&
		state.verifiedAt !== undefined
	);
}

/**
 * The status one observation implies.
 *
 * `unverified` is reserved for "Mandrill answered, but said nothing about
 * either record" — no evidence, distinct from `pending_dns`, which is the
 * ordinary state of a domain whose records are not published (or not visible)
 * YET. Neither is an error, and neither is `failed`: that word is kept for a
 * credential this deployment cannot use, which is the only failure an operator
 * can act on differently.
 */
export function deriveMandrillStatus(state: MandrillDomainState): RelayIdentityStatus {
	if (isMandrillDomainVerified(state)) return 'verified';
	if (!state.spf.isValid && !state.dkim.isValid && !state.spf.error && !state.dkim.error) {
		return 'unverified';
	}
	return 'pending_dns';
}

/** The typed identity payload for one observation. */
export function buildMandrillIdentity(state: MandrillDomainState, now: number): MandrillIdentity {
	return {
		kind: 'mandrill',
		dkimSelector: MANDRILL_DKIM_SELECTOR,
		status: deriveMandrillStatus(state),
		spf: state.spf,
		dkim: state.dkim,
		isValidSigning: state.isValidSigning,
		...(state.verifiedAt !== undefined ? { verifiedAt: state.verifiedAt } : {}),
		...(state.verifyTxtKey !== undefined ? { verifyTxtKey: state.verifyTxtKey } : {}),
		checkedAt: now,
	};
}

/** When to ask again, given the status we just recorded. */
export function nextMandrillCheckDueAt(status: RelayIdentityStatus, now: number): number {
	return now + MANDRILL_CHECK_INTERVAL_MS[status];
}

/** Serialize the versioned `providerDetails` blob. */
export function buildMandrillProviderDetails(
	identity: MandrillIdentity,
	lastError?: string
): string {
	const details: MandrillProviderDetails = {
		kind: 'mandrill',
		isValidSigning: identity.isValidSigning,
		...(identity.verifiedAt !== undefined ? { verifiedAt: identity.verifiedAt } : {}),
		...(identity.verifyTxtKey !== undefined ? { verifyTxtKey: identity.verifyTxtKey } : {}),
		...(lastError !== undefined ? { lastError } : {}),
	};
	return JSON.stringify(details);
}

/**
 * Read a stored blob back. Version-branching per CONVENTIONS.md "Schema
 * evolution": a row written by a FUTURE version is reported as unreadable
 * rather than reinterpreted under today's shape.
 */
export function parseMandrillProviderDetails(
	raw: string | undefined,
	version: number | undefined
): MandrillProviderDetails | null {
	if (raw === undefined) return null;
	if (
		(version ?? CURRENT_RELAY_IDENTITY_PROVIDER_DETAILS_VERSION) >
		CURRENT_RELAY_IDENTITY_PROVIDER_DETAILS_VERSION
	) {
		return null;
	}
	try {
		const parsed = JSON.parse(raw) as MandrillProviderDetails;
		return parsed.kind === 'mandrill' ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * The one-line description the generic register action logs.
 *
 * Names what is OUTSTANDING rather than only what is done: the log line is what
 * an operator reads when a registration "succeeded" but nothing can send yet.
 */
export function describeMandrillIdentity(identity: MandrillIdentity): string {
	if (identity.status === 'verified') return `selector ${identity.dkimSelector}, verified`;
	const outstanding = [
		...(identity.spf.isValid ? [] : ['SPF']),
		...(identity.dkim.isValid ? [] : ['DKIM']),
		...(identity.verifiedAt === undefined ? ['domain verification'] : []),
		...(identity.isValidSigning ? [] : ['signing enabled at Mandrill']),
	];
	return `selector ${identity.dkimSelector}, awaiting ${outstanding.join(' + ')}`;
}
