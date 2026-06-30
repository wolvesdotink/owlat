/**
 * Abuse gate (module) — single reader of `instanceSettings.abuseStatus`
 * for sending-allowed predicates. Sibling of **Abuse status (module)**
 * (which owns the writes).
 *
 * Two surfaces:
 *   - requireSendingAllowed(ctx) — mutation-hot-path; throws ConvexError
 *                                 on `suspended` / `banned`.
 *   - isSendingAllowed(status)    — pure predicate; used in actions/HTTP
 *                                 handlers that already have the status
 *                                 in hand.
 *
 * Replaces the pre-deepening `lib/abuseHelpers.ts` (same two functions
 * lived there). Co-located with `abuseStatus.ts` so the gate semantics
 * sit alongside the legal-edges graph.
 *
 * See docs/adr/0011-abuse-status-modules.md.
 */

import type { MutationCtx } from '../_generated/server';
import { throwInvalidState } from '../_utils/errors';
import type { AbuseStatus } from './abuseStatus';

/**
 * Pure predicate: returns true when sending is permitted under the given
 * abuse status. Used in actions and HTTP handlers that already have the
 * status from a prior query.
 *
 * `null` / `undefined` are treated as `clean` (deployments early enough
 * that no status was ever written).
 */
export function isSendingAllowed(
	status: AbuseStatus | string | null | undefined,
): boolean {
	if (!status) return true;
	return status !== 'suspended' && status !== 'banned';
}

/**
 * Mutation-context helper: fetches `instanceSettings` and throws
 * `ConvexError` on `suspended` / `banned`. Used in send-path hot
 * spots (campaigns/send, transactional/send) so the gate check is one
 * line per call site.
 *
 * Unlike billing checks, this always runs — no feature flag.
 */
export async function requireSendingAllowed(ctx: MutationCtx): Promise<void> {
	const settings = await ctx.db.query('instanceSettings').first();
	const status = settings?.abuseStatus;

	if (status === 'suspended') {
		throwInvalidState(
			'Your account has been suspended due to policy violations. Please contact support for assistance.',
		);
	}

	if (status === 'banned') {
		throwInvalidState(
			'Your account has been permanently disabled. Please contact support for more information.',
		);
	}
}
