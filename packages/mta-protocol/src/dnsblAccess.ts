/**
 * The MTA <-> Convex `/dnsbl-access` exchange: how blocklist lookups reach
 * Spamhaus, and the operator's optional Data Query Service key.
 *
 * The key only ever travels TOWARD the MTA (`PUT`), which seals it at rest.
 * Nothing sent back carries more than its last four characters, so the Convex
 * action relaying it has nothing to store and the browser nothing to leak.
 */

import { isRecord } from '@owlat/shared/utils/guards';
import { isDnsblUnknownReason, type DnsblUnknownReason } from '@owlat/shared/dnsbl';

export type DnsblResolverKind = 'bundled' | 'system';

export interface MtaDnsblAccess {
	resolver: {
		/** `bundled` when DNSBL_RESOLVER points at the shipped resolver. */
		configured: DnsblResolverKind;
		/** Which resolver answered the last sweep (the bundled one may fall back). */
		lastPath?: DnsblResolverKind;
	};
	spamhaus: {
		access: 'public' | 'dqs';
		/** Last four characters of the configured key. */
		keyHint?: string;
		/** `pending` until a sweep has run since the MTA started or the key changed. */
		status: 'ok' | 'unknown' | 'pending';
		reason?: DnsblUnknownReason;
		checkedAt?: number;
	};
}

/** `PUT /dnsbl-access` refuses a key it could not verify, with the reason. */
export type DnsblAccessKeyRejection = DnsblUnknownReason | 'invalid_key';

export type MtaDnsblAccessUpdate =
	| { ok: true; access: MtaDnsblAccess }
	| { ok: false; reason: DnsblAccessKeyRejection };

function isResolverKind(value: unknown): value is DnsblResolverKind {
	return value === 'bundled' || value === 'system';
}

/** Validate an MTA answer; anything malformed reads as `null`. */
export function normalizeDnsblAccess(value: unknown): MtaDnsblAccess | null {
	if (!isRecord(value) || !isRecord(value['resolver']) || !isRecord(value['spamhaus'])) {
		return null;
	}
	const resolver = value['resolver'];
	const spamhaus = value['spamhaus'];
	const status = spamhaus['status'];
	if (
		!isResolverKind(resolver['configured']) ||
		(spamhaus['access'] !== 'public' && spamhaus['access'] !== 'dqs') ||
		(status !== 'ok' && status !== 'unknown' && status !== 'pending')
	) {
		return null;
	}
	const keyHint = spamhaus['keyHint'];
	const checkedAt = spamhaus['checkedAt'];
	return {
		resolver: {
			configured: resolver['configured'],
			...(isResolverKind(resolver['lastPath']) ? { lastPath: resolver['lastPath'] } : {}),
		},
		spamhaus: {
			access: spamhaus['access'],
			...(typeof keyHint === 'string' && /^[a-zA-Z0-9]{1,4}$/.test(keyHint) ? { keyHint } : {}),
			status,
			...(isDnsblUnknownReason(spamhaus['reason']) ? { reason: spamhaus['reason'] } : {}),
			...(typeof checkedAt === 'number' && Number.isFinite(checkedAt) ? { checkedAt } : {}),
		},
	};
}
