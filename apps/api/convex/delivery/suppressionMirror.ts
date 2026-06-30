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
 * This module is the bridge: every `blockedEmails` insert schedules
 * `mirror`, an action that POSTs the address to the MTA `POST /suppression`
 * endpoint. It is fire-and-forget defense-in-depth — a failed mirror is
 * logged, never thrown, so it can't roll back the originating mutation or
 * block a user action. (Once PR-08 lands the single send-time chokepoint
 * check this becomes pure belt-and-suspenders.)
 *
 * Runs in the default Convex runtime (not `'use node'`) — `fetch` is available
 * there (cf. domains/trackingDomains.ts's DoH lookup), and keeping it out of
 * the Node bundle lets the non-node mutation modules import
 * `scheduleSuppressionMirror` without crossing the runtime boundary.
 */

import { v } from 'convex/values';
import { internalAction, type MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { logError, logInfo } from '../lib/runtimeLog';
import { getMtaConfig } from '../mail/mtaClient';

// blockedEmails.reason — the Convex-side suppression vocabulary.
export type BlockReason = 'bounced' | 'complained' | 'manual';

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
	reason: BlockReason,
	bounceType?: 'hard' | 'soft',
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
 * Schedule a mirror of a single blocked address to the MTA suppression list.
 *
 * Called from every `blockedEmails` insert site (the sendLifecycle
 * `blocklist_insert` effect and the `blockedEmails` mutations). Scheduled with
 * `runAfter(0, …)` so it runs in its own transaction-free action after the
 * originating mutation commits — Convex mutations can't `fetch`, and a failed
 * push must not roll back the insert.
 */
export async function scheduleSuppressionMirror(
	ctx: MutationCtx,
	args: { email: string; reason: BlockReason; bounceType?: 'hard' | 'soft' },
): Promise<void> {
	await ctx.scheduler.runAfter(0, internal.delivery.suppressionMirror.mirror, {
		email: args.email,
		reason: args.reason,
		...(args.bounceType ? { bounceType: args.bounceType } : {}),
	});
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
		reason: v.union(
			v.literal('bounced'),
			v.literal('complained'),
			v.literal('manual'),
		),
		bounceType: v.optional(v.union(v.literal('hard'), v.literal('soft'))),
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
				logError(
					`[suppressionMirror] MTA /suppression returned ${res.status} for ${args.email}`,
				);
				return;
			}
			logInfo(`[suppressionMirror] mirrored ${args.email} (${mtaReason}) to MTA`);
		} catch (err) {
			logError('[suppressionMirror] failed to mirror to MTA:', err);
		}
	},
});
