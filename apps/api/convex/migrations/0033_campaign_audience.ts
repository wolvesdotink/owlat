/**
 * ADR-0033 phase 2 — Backfill the four flat audience columns
 * (`audienceType`, `topicId`, `segmentId`, `segmentFilters`) into the single
 * discriminated `audience` field on every `campaigns` row, then drop the
 * legacy columns so the row matches the migrated schema.
 *
 * Mapping:
 *   audienceType 'topic'   + topicId    → { kind: 'topic', topicId }
 *   audienceType 'segment' + segmentId  → { kind: 'segment', segmentId,
 *                                           frozenFilters: segmentFilters }
 *   anything else (no/partial audience) → audience left undefined
 *
 * Idempotent: a row that already carries `audience` is skipped, so re-running
 * is a no-op. Pre-prod, single org per deployment — the row set is bounded, so
 * this runs synchronously against `.collect()`. Mirrors ADR-0032 phase 1.
 *
 * Deploy ordering (atomic pre-prod pattern, same as ADR-0032): this change also
 * drops the four legacy columns from `schema/campaigns.ts` in one shot. Convex
 * cannot both backfill and drop against legacy rows in a single push (it
 * validates existing rows against the new schema), so the pre-prod deployments
 * this targets — single org, resettable — are seeded fresh: the push sees no
 * legacy rows and this backfill is a no-op record of intent. If a deployment
 * ever does carry legacy rows, reset/reseed it before deploying. A segment row
 * this cannot map (segmentFilters but no segmentId) throws, halting the rollout
 * loudly instead of silently dropping audience targeting.
 */

import { internalMutation } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import type { StoredAudience } from '../campaigns/audience';

type LegacyCampaign = {
	audience?: StoredAudience;
	audienceType?: 'topic' | 'segment';
	topicId?: Id<'topics'>;
	segmentId?: Id<'segments'>;
	segmentFilters?: Extract<StoredAudience, { kind: 'segment' }>['frozenFilters'];
};

export const run = internalMutation({
	args: {},
	handler: async (ctx) => {
		let updated = 0;
		const campaigns = await ctx.db.query('campaigns').collect(); // bounded: one-shot pre-prod migration (single org per deployment)
		for (const campaign of campaigns) {
			const legacy = campaign as unknown as LegacyCampaign;
			if (legacy.audience !== undefined) continue; // already migrated

			let audience: StoredAudience | undefined;
			if (legacy.audienceType === 'topic' && legacy.topicId) {
				audience = { kind: 'topic', topicId: legacy.topicId };
			} else if (legacy.audienceType === 'segment' && legacy.segmentId) {
				audience = {
					kind: 'segment',
					segmentId: legacy.segmentId,
					...(legacy.segmentFilters ? { frozenFilters: legacy.segmentFilters } : {}),
				};
			} else if (legacy.audienceType === 'segment' && legacy.segmentFilters) {
				// A segment Campaign carrying a filter snapshot but NO segmentId —
				// the pre-ADR-0033 `duplicate()` copied `segmentFilters` without
				// `segmentId`. Such a row was sendable before this migration (the old
				// send path resolved straight from `segmentFilters`) but the
				// discriminated `audience` requires a `segmentId`, so it cannot be
				// represented. Fail loudly — the whole mutation rolls back — rather
				// than silently drop the targeting. Re-point the campaign to a live
				// segment (or delete it), then re-run.
				throw new Error(
					`Migration 0033: campaign ${campaign._id} has audienceType 'segment' with ` +
						`segmentFilters but no segmentId (legacy duplicate() artifact). Re-point it ` +
						`to a segment or delete it, then re-run the migration.`,
				);
			}

			await ctx.db.patch(campaign._id, {
				audience,
				// Drop the legacy flat columns from the row.
				audienceType: undefined,
				topicId: undefined,
				segmentId: undefined,
				segmentFilters: undefined,
			} as unknown as Partial<Doc<'campaigns'>>);
			updated++;
		}
		return { updated };
	},
});
