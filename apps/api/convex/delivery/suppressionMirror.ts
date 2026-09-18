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
 * `blockedEmails` insert schedules `mirror`, an action that POSTs the address to
 * the MTA `POST /suppression` endpoint. It is fire-and-forget defense-in-depth;
 * the daily reconcile action repairs a missed write from the durable table.
 *
 * Runs in the default Convex runtime (not `'use node'`) — `fetch` is available
 * there (cf. domains/trackingDomains.ts's DoH lookup).
 */

import { v, type Validator } from 'convex/values';
import { internalAction, internalQuery } from '../_generated/server';
import { internal } from '../_generated/api';
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

type MarketingOnlyBlockReason = (typeof MARKETING_ONLY_BLOCK_REASONS)[number];

/** The reasons that DO reach the MTA backstop — everything not marketing-only. */
export type MirroredBlockReason = Exclude<BlockReason, MarketingOnlyBlockReason>;

/**
 * The mirrored reasons as VALUES, so the `mirror` action's validator is derived
 * from the same exclusion the type expresses instead of hand-listing it. The
 * `satisfies` is what makes the derivation load-bearing: adding a second
 * marketing-only reason narrows `MirroredBlockReason` and fails this line rather
 * than leaving a validator that still accepts the excluded reason.
 */
const MIRRORED_BLOCK_REASONS = [
	'bounced',
	'complained',
	'manual',
] as const satisfies readonly MirroredBlockReason[];

/**
 * Convex validator over the mirrored reasons. Spreading into `v.union` loses
 * literal narrowing, so it is cast back once here (cf.
 * `contactActivities/catalog.ts`'s `contactActivityTypeValidator`).
 */
const mirroredBlockReasonValidator = v.union(
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
type MtaSuppressionReason = 'hard_bounce' | 'soft_bounce' | 'complaint' | 'manual';

/**
 * Map a Convex `blockedEmails.reason` (+ optional bounceType) onto the MTA's
 * `SuppressionReason`. The mapping is load-bearing for TTL: only
 * `soft_bounce` expires; explicit manual blocks, hard bounces and complaints
 * remain until the durable source of truth removes them.
 */
export function toMtaSuppressionReason(
	reason: MirroredBlockReason,
	bounceType?: 'hard' | 'soft'
): MtaSuppressionReason {
	if (reason === 'complained') return 'complaint';
	if (reason === 'bounced') {
		return bounceType === 'soft' ? 'soft_bounce' : 'hard_bounce';
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

/** Remove a durable block's last-hop copy after an operator unblocks it. */
export const unmirror = internalAction({
	args: { email: v.string() },
	handler: async (_ctx, { email }) => {
		const mta = getMtaConfig();
		if (!mta) return;
		try {
			const res = await fetch(`${mta.baseUrl}/suppression/${encodeURIComponent(email)}`, {
				method: 'DELETE',
				headers: { Authorization: `Bearer ${mta.apiKey}` },
			});
			if (!res.ok) {
				logError(`[suppressionMirror] MTA unmirror returned ${res.status} for ${email}`);
				return;
			}
			logInfo(`[suppressionMirror] removed ${email} from MTA`);
		} catch (error) {
			logError('[suppressionMirror] failed to remove MTA mirror:', error);
		}
	},
});

/** Bounded source-of-truth page for the daily Redis reconciliation. */
export const blockedEmailPage = internalQuery({
	args: { cursor: v.union(v.string(), v.null()) },
	handler: async (ctx, { cursor }) => {
		const result = await ctx.db.query('blockedEmails').paginate({ numItems: 500, cursor });
		return {
			rows: result.page.map((row) => ({
				email: row.email,
				reason: row.reason,
				bounceType: row.bounceType,
			})),
			cursor: result.continueCursor,
			isDone: result.isDone,
		};
	},
});

type ReconcileRow = {
	email: string;
	reason: BlockReason;
	bounceType?: 'hard' | 'soft';
};

/** Prefer the strictest durable record when historical duplicates exist. */
function reconcilePriority(row: ReconcileRow): number {
	if (isMarketingOnlyBlockReason(row.reason)) return 0;
	const reason = toMtaSuppressionReason(row.reason, row.bounceType);
	return { soft_bounce: 1, manual: 2, hard_bounce: 3, complaint: 4 }[reason];
}

async function requireMtaResponse(response: Response, operation: string): Promise<void> {
	if (!response.ok) throw new Error(`${operation} returned HTTP ${response.status}`);
}

/**
 * Rebuild the MTA copy from Convex and remove Redis-only entries. This repairs
 * failed fire-and-forget writes, Redis loss, legacy metadata-less orphans and
 * unmirrors that failed while the MTA was unavailable.
 */
export const reconcile = internalAction({
	args: {},
	handler: async (ctx): Promise<{ mirrored: number; removed: number }> => {
		const mta = getMtaConfig();
		if (!mta) return { mirrored: 0, removed: 0 };

		const authoritative = new Map<string, ReconcileRow>();
		let cursor: string | null = null;
		for (;;) {
			const page: { rows: ReconcileRow[]; cursor: string; isDone: boolean } = await ctx.runQuery(
				internal.delivery.suppressionMirror.blockedEmailPage,
				{ cursor }
			);
			for (const row of page.rows) {
				const existing = authoritative.get(row.email);
				if (!existing || reconcilePriority(row) > reconcilePriority(existing)) {
					authoritative.set(row.email, row);
				}
			}
			if (page.isDone) break;
			cursor = page.cursor;
		}

		const entries = [...authoritative.values()].flatMap((row) =>
			isMarketingOnlyBlockReason(row.reason)
				? []
				: [
						{
							email: row.email,
							reason: toMtaSuppressionReason(row.reason, row.bounceType),
							source: 'convex-reconcile',
						},
					]
		);
		for (let index = 0; index < entries.length; index += 1000) {
			await requireMtaResponse(
				await fetch(`${mta.baseUrl}/suppression/bulk`, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						Authorization: `Bearer ${mta.apiKey}`,
					},
					body: JSON.stringify({ entries: entries.slice(index, index + 1000) }),
				}),
				'MTA suppression bulk reconcile'
			);
		}

		const removals: string[] = [];
		let exportCursor: string | undefined;
		do {
			const url = new URL(`${mta.baseUrl}/suppression/export`);
			url.searchParams.set('limit', '10000');
			if (exportCursor) url.searchParams.set('cursor', exportCursor);
			const response = await fetch(url, {
				headers: { Authorization: `Bearer ${mta.apiKey}` },
			});
			await requireMtaResponse(response, 'MTA suppression export');
			const page = (await response.json()) as {
				entries: Array<{ email: string }>;
				nextCursor?: string;
			};
			for (const entry of page.entries) {
				const row = authoritative.get(entry.email);
				if (row && !isMarketingOnlyBlockReason(row.reason)) continue;
				removals.push(entry.email);
			}
			exportCursor = page.nextCursor;
		} while (exportCursor);

		// Do not mutate the Redis set while its SSCAN cursor is still in flight;
		// deleting during a scan can reshuffle buckets and skip an orphan forever.
		for (const email of removals) {
			await requireMtaResponse(
				await fetch(`${mta.baseUrl}/suppression/${encodeURIComponent(email)}`, {
					method: 'DELETE',
					headers: { Authorization: `Bearer ${mta.apiKey}` },
				}),
				`MTA suppression delete ${email}`
			);
		}

		logInfo('[suppressionMirror] reconciliation complete', {
			mirrored: entries.length,
			removed: removals.length,
		});
		return { mirrored: entries.length, removed: removals.length };
	},
});
