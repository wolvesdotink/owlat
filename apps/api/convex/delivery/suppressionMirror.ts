/**
 * Mirror Convex-side suppressions to the MTA Redis suppression list.
 *
 * The `blockedEmails` table is the org-level suppression source of truth, but
 * the MTA keeps its OWN Redis suppression list as the last-hop deliverability
 * backstop (checked in the dispatch pipeline before every send). That list is
 * populated only from MTA-internal bounce/complaint events, so suppressions
 * that originate Convex-side — manual UI blocks, provider-webhook
 * complaints/bounces (Resend / SES), and the lifecycle's suppress-after-N
 * escalation — never reach it. As a result the MTA backstop can't catch the
 * automation/agent outbound paths that bypass the application-level blocklist
 * check.
 *
 * The sibling `suppressionMirrorScheduler.ts` is the bridge: every
 * `blockedEmails` insert schedules `mirror`, an action that POSTs the address to the MTA `POST /suppression`
 * endpoint. It is fire-and-forget defense-in-depth — a failed mirror is
 * logged, never thrown, so it can't roll back the originating mutation or
 * block a user action. (Once PR-08 lands the single send-time chokepoint
 * check this becomes pure belt-and-suspenders.)
 *
 * Runs in the default Convex runtime (not `'use node'`) — `fetch` is available
 * there (cf. domains/trackingDomains.ts's DoH lookup).
 */

import { v, type Validator } from 'convex/values';
import { internalAction } from '../_generated/server';
import { logError, logInfo } from '../lib/runtimeLog';
import { getMtaConfig } from '../mail/mtaClient';
import { bounceTypeValidator } from '../lib/convexValidators';

// blockedEmails.reason — the Convex-side suppression vocabulary.
export type BlockReason = 'bounced' | 'complained' | 'manual' | 'unengaged';

/**
 * The reasons that are a MARKETING-HYGIENE decision about bulk mail, not
 * evidence that the mailbox must never be written to again.
 *
 * `unengaged` (the sunset engine's auto-suppression) is the only one: it says
 * "this person has ignored nine months of campaigns", which is a reason to stop
 * sending campaigns and NOT a reason to stop sending the receipt, the password
 * reset or the double-opt-in confirmation the same person just asked for. A
 * hard bounce or a spam complaint is the opposite — those are evidence about
 * the mailbox itself and gate every scope.
 *
 * Two consequences, both enforced in one place each:
 *   - `lib/suppression.ts`'s `isSuppressed` ignores these reasons on the
 *     transactional scope;
 *   - they are never mirrored to the MTA's last-hop backstop (below), because
 *     that list sits UNDER Convex and would block the transactional mail the
 *     Convex-side gate just decided to allow.
 */
export const MARKETING_ONLY_BLOCK_REASONS = ['unengaged'] as const;

export type MarketingOnlyBlockReason = (typeof MARKETING_ONLY_BLOCK_REASONS)[number];

/** The reasons that DO reach the MTA backstop — everything not marketing-only. */
export type MirroredBlockReason = Exclude<BlockReason, MarketingOnlyBlockReason>;

/**
 * The mirrored reasons as VALUES, so the `mirror` action's validator is derived
 * from the same exclusion the type expresses instead of hand-listing it. The
 * `satisfies` is what makes the derivation load-bearing: adding a second
 * marketing-only reason narrows `MirroredBlockReason` and fails this line rather
 * than leaving a validator that still accepts the excluded reason.
 */
export const MIRRORED_BLOCK_REASONS = [
	'bounced',
	'complained',
	'manual',
] as const satisfies readonly MirroredBlockReason[];

/**
 * Convex validator over the mirrored reasons. Spreading into `v.union` loses
 * literal narrowing, so it is cast back once here (cf.
 * `contactActivities/catalog.ts`'s `contactActivityTypeValidator`).
 */
export const mirroredBlockReasonValidator = v.union(
	...MIRRORED_BLOCK_REASONS.map((reason) => v.literal(reason))
) as unknown as Validator<MirroredBlockReason>;

const MARKETING_ONLY_SET: ReadonlySet<string> = new Set(MARKETING_ONLY_BLOCK_REASONS);

export function isMarketingOnlyBlockReason(
	reason: BlockReason
): reason is MarketingOnlyBlockReason {
	return MARKETING_ONLY_SET.has(reason);
}

// SuppressionReason — the MTA-side vocabulary (apps/mta/.../suppressionList.ts).
// Kept in sync by hand: the two enums live in separate deploy units (Convex
// backend vs the MTA service) with no shared type.
export type MtaSuppressionReason = 'hard_bounce' | 'complaint' | 'manual';

/**
 * Map a Convex `blockedEmails.reason` (+ optional bounceType) onto the MTA's
 * `SuppressionReason`. The mapping is load-bearing for TTL: the MTA expires
 * `manual`-reason suppressions after 7 days but keeps `hard_bounce` /
 * `complaint` permanently, so a soft-bounce escalation must NOT masquerade as a
 * hard bounce (we let it ride the default `manual` TTL) while a real hard
 * bounce / complaint must map to its permanent counterpart.
 */
export function toMtaSuppressionReason(
	reason: MirroredBlockReason,
	bounceType?: 'hard' | 'soft'
): MtaSuppressionReason {
	if (reason === 'complained') return 'complaint';
	if (reason === 'bounced') {
		// A hard bounce is permanent; a soft-bounce escalation is recoverable, so
		// it rides the MTA's expiring `manual` reason rather than a permanent one.
		return bounceType === 'soft' ? 'manual' : 'hard_bounce';
	}
	return 'manual';
}

/**
 * POST a single address to the MTA `POST /suppression` endpoint.
 *
 * Fire-and-forget: if the MTA is not configured (self-host without the MTA, or
 * a non-MTA provider deployment) or the request fails, we log and return — the
 * blockedEmails row is already the authoritative suppression record, the MTA
 * copy is only the last-hop backstop.
 */
export const mirror = internalAction({
	args: {
		email: v.string(),
		reason: mirroredBlockReasonValidator,
		bounceType: v.optional(bounceTypeValidator),
	},
	handler: async (_ctx, args) => {
		const mta = getMtaConfig();
		if (!mta) {
			// No MTA in this deployment (e.g. a Resend/SES-only self-host) — the
			// provider's account-level suppression is the backstop instead.
			logInfo('[suppressionMirror] MTA not configured; skipping suppression mirror');
			return;
		}

		const mtaReason = toMtaSuppressionReason(args.reason, args.bounceType);

		try {
			const res = await fetch(`${mta.baseUrl}/suppression`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${mta.apiKey}`,
				},
				body: JSON.stringify({
					emails: [args.email],
					reason: mtaReason,
					source: 'convex-blocklist',
				}),
			});
			if (!res.ok) {
				logError(`[suppressionMirror] MTA /suppression returned ${res.status} for ${args.email}`);
				return;
			}
			logInfo(`[suppressionMirror] mirrored ${args.email} (${mtaReason}) to MTA`);
		} catch (err) {
			logError('[suppressionMirror] failed to mirror to MTA:', err);
		}
	},
});
