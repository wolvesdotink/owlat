/**
 * A relay's sending-domain identity, as a sentence — for WHICHEVER relay.
 *
 * Pure derivation over `providerRoutes.listRelayDomainIdentities`, kept out of
 * the component so the judgements can be pinned without a DOM. It replaces
 * `mandrillRelayStatus`'s display half, which said all of this in Mandrill's
 * name; the provider's name is now a value the row carries, from the catalog.
 *
 * THE SURPRISING JUDGEMENT, which is the reason this is derived at all: a
 * `verified` row whose evidence has aged past the kind's own
 * `proofMaxAgeMs` does NOT read "verified". Routing stops trusting a proof that
 * old — every relay applies the same rule against its own bound, and the query
 * hands that bound over rather than a verdict — so a screen still saying
 * "verified" would be telling the operator their relay is usable at the moment
 * it stopped being usable. It reads "re-checking" instead: not an error, because
 * nothing is wrong and nothing is required of them, the sweep is already asking
 * again. Only a multi-day outage keeps it there, which is exactly when an
 * operator should see it.
 *
 * THE CLOCK IS READ HERE, not in the query, and that is deliberate. A proof ages
 * with no write behind it, so a backend that returned `stale` would leave a page
 * open across an expiry showing "verified" until something unrelated changed the
 * row. The row carries the evidence date and the bound; the surface compares
 * them on every render.
 */

import type { FunctionReturnType } from 'convex/server';
import type { api } from '@owlat/api';

/** One row of the query's page, as the backend actually types it. */
type RelayDomainQueryRow = FunctionReturnType<
	typeof api.providerRoutes.listRelayDomainIdentities
>['page'][number];

/**
 * The half of a relay-domain row this module reads.
 *
 * `status` is the QUERY'S OWN union, not a `string`: the handler builds each
 * value with `as const`, and every branch below is checked against that
 * vocabulary — so a state added or renamed on the backend is a compile error
 * here rather than a row that silently falls through to no copy at all.
 */
export interface RelayDomainIdentityRow {
	readonly kind: string;
	readonly kindLabel: string;
	readonly domain: string;
	readonly status: RelayDomainQueryRow['status'];
	readonly spf?: { readonly isValid: boolean; readonly error?: string } | undefined;
	readonly dkim?: { readonly isValid: boolean; readonly error?: string } | undefined;
	readonly lastCheckedAt?: number | undefined;
	readonly proofMaxAgeMs?: number | undefined;
	readonly isOwnershipVerified?: boolean | undefined;
}

export type RelayDomainTone = 'success' | 'warning' | 'error' | 'neutral';

/**
 * A line this module hands to a screen: an i18n key, with the values the
 * sentence interpolates when it has any. Nothing here calls `useI18n` — the
 * component runs the value through `t(key, params)`.
 */
export type RelayDomainText = string | { key: string; params?: Record<string, unknown> };

export interface RelayDomainDisplay {
	readonly tone: RelayDomainTone;
	readonly label: string;
	/** One plain-language line: what this state means for sending. */
	readonly summary: RelayDomainText;
	/** True when the proof is verified but too old for routing to rely on. */
	readonly isProofStale: boolean;
	/** True when a ceremony at the provider is still outstanding. */
	readonly needsOwnership: boolean;
}

/**
 * Whether the last successful check is recent enough for routing to lean on.
 *
 * A relay that reports no bound (a kind whose adapter describes no freshness
 * rule) is never aged out here: inventing a window the router does not apply
 * would show "re-checking" for a proof routing is perfectly happy with. A
 * `lastCheckedAt` in the FUTURE is treated as stale rather than fresh — a clock
 * we cannot explain is not evidence.
 */
export function isRelayProofFresh(row: RelayDomainIdentityRow, now: number): boolean {
	if (row.proofMaxAgeMs === undefined || row.lastCheckedAt === undefined) return true;
	const age = now - row.lastCheckedAt;
	return age >= 0 && age <= row.proofMaxAgeMs;
}

/**
 * The state, worded for the relay that reported it.
 *
 * The provider's NAME is interpolated rather than written into each branch —
 * the same move `SignedWebhookCard.vue` made for the feedback ceremony. What is
 * genuinely per-vendor (an ownership ceremony's steps) is the component's
 * per-kind copy map, not this. The name reaches the sentence as the `relay`
 * interpolation, so a translation is free to put it wherever its grammar wants.
 */
export function relayDomainDisplay(row: RelayDomainIdentityRow, now: number): RelayDomainDisplay {
	const relay = row.kindLabel;
	// Ownership is only ever OUTSTANDING for a kind that reports one — `undefined`
	// means this relay verifies from the records themselves and has no separate
	// step an operator could go and complete.
	const needsOwnership = row.isOwnershipVerified === false;
	switch (row.status) {
		case 'awaiting_primary_verification':
			return {
				tone: 'neutral',
				label: 'shared.relayDomainDisplay.awaitingPrimary.label',
				summary: {
					key: 'shared.relayDomainDisplay.awaitingPrimary.summary',
					params: { relay },
				},
				isProofStale: false,
				needsOwnership: false,
			};
		case 'provisioning':
			return {
				tone: 'neutral',
				label: 'shared.relayDomainDisplay.provisioning.label',
				summary: { key: 'shared.relayDomainDisplay.provisioning.summary', params: { relay } },
				isProofStale: false,
				needsOwnership: false,
			};
		case 'verified': {
			if (!isRelayProofFresh(row, now)) {
				return {
					tone: 'warning',
					label: 'shared.relayDomainDisplay.reChecking.label',
					summary: { key: 'shared.relayDomainDisplay.reChecking.summary', params: { relay } },
					isProofStale: true,
					needsOwnership: false,
				};
			}
			return {
				tone: 'success',
				label: 'shared.relayDomainDisplay.verified.label',
				summary: { key: 'shared.relayDomainDisplay.verified.summary', params: { relay } },
				isProofStale: false,
				needsOwnership: false,
			};
		}
		case 'pending':
			return {
				tone: 'warning',
				label: 'shared.relayDomainDisplay.pending.label',
				summary: { key: 'shared.relayDomainDisplay.pending.summary', params: { relay } },
				isProofStale: false,
				needsOwnership,
			};
		case 'unverified':
			return {
				tone: 'neutral',
				label: 'shared.relayDomainDisplay.unverified.label',
				summary: { key: 'shared.relayDomainDisplay.unverified.summary', params: { relay } },
				isProofStale: false,
				needsOwnership,
			};
		case 'failed':
			return {
				tone: 'error',
				label: 'shared.relayDomainDisplay.failed.label',
				summary: { key: 'shared.relayDomainDisplay.failed.summary', params: { relay } },
				isProofStale: false,
				needsOwnership,
			};
	}
}

/**
 * The outstanding DNS/ownership items, in the order an operator works them.
 *
 * Only what the relay actually REPORTED: a kind that keeps no per-record
 * verdicts contributes nothing here rather than a row of invented failures, and
 * ownership appears only for the kinds that have such a step
 * ({@link RelayDomainIdentityRow.isOwnershipVerified}).
 *
 * Each item is an i18n key the caller runs through `t()`.
 */
export function relayDomainOutstanding(row: RelayDomainIdentityRow): string[] {
	return [
		...(row.spf === undefined || row.spf.isValid
			? []
			: ['shared.relayDomainDisplay.outstanding.spf']),
		...(row.dkim === undefined || row.dkim.isValid
			? []
			: ['shared.relayDomainDisplay.outstanding.dkim']),
		...(row.isOwnershipVerified === false
			? ['shared.relayDomainDisplay.outstanding.ownership']
			: []),
	];
}
