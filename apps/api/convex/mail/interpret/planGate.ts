/**
 * The `item_coverage` auto-send gate's reads (SPEC §6, ADR-0051 amendment).
 *
 *   - `itemCoverageCheck`: the gate input at route time. The stored plan of
 *     the message's draft against the thread as it is now: the draft hash,
 *     the interpretation revision and every open item's revision, plus the
 *     plan's coverage, file claims and commitments
 *     (`responsePlanRules.itemCoverageObjections`). Says whether the gate
 *     enforces (`agentConfig.isItemCoverageEnforced`, off by default).
 *   - `recordShadow`: in shadow mode the gate lets the send through and logs
 *     what it objected to on the message's `agentShadowDecisions` row.
 *   - `dispatchHold`: the same check again immediately before an autonomous
 *     send (`agent/agentPipeline.sendApprovedReply`); it only holds while the
 *     gate enforces. Shadow mode never relaxes another gate and never holds.
 *
 * Restrict-only: nothing here can approve or widen a send.
 */

import { v } from 'convex/values';
import type { Doc } from '../../_generated/dataModel';
import type { QueryCtx } from '../../_generated/server';
import { internalQuery } from '../../_generated/server';
import { internalMutation } from '../../lib/writeFence';
import { extractEmail } from '../../lib/emailAddress';
import { loadBriefRow } from './briefRow';
import { loadPlanItems, readPlanRow } from './responsePlanState';
import {
	draftHashOf,
	itemCoverageObjections,
	itemCoverageReason,
	type ItemCoverageObjection,
} from './responsePlanRules';

export interface ItemCoverageCheck {
	objections: ItemCoverageObjection[];
	reason: string | null;
	isEnforced: boolean;
}

async function isEnforced(ctx: Pick<QueryCtx, 'db'>): Promise<boolean> {
	const config = await ctx.db.query('agentConfig').first();
	return config?.isItemCoverageEnforced === true;
}

async function checkMessage(
	ctx: Pick<QueryCtx, 'db'>,
	message: Doc<'inboundMessages'> | null
): Promise<Omit<ItemCoverageCheck, 'isEnforced'>> {
	if (!message?.threadId) {
		const objections: ItemCoverageObjection[] = ['no_plan'];
		return { objections, reason: itemCoverageReason(objections) };
	}
	const ref = { kind: 'team' as const, id: message.threadId };
	const [plan, loaded, brief] = await Promise.all([
		readPlanRow(ctx, { kind: 'inboundDraft', id: message._id }),
		loadPlanItems(ctx, ref),
		loadBriefRow(ctx, ref),
	]);
	const objections = itemCoverageObjections({
		plan,
		draftHash: message.draftResponse ? await draftHashOf(message.draftResponse) : null,
		threadRevision: brief?.interpretationRevision ?? null,
		completeness: brief?.completeness ?? null,
		items: loaded.rows.map((row) => ({
			id: row._id,
			revision: row.revision,
			responsibility: row.responsibility,
		})),
	});
	return { objections, reason: itemCoverageReason(objections) };
}

export const itemCoverageCheck = internalQuery({
	args: { inboundMessageId: v.id('inboundMessages') },
	handler: async (ctx, args): Promise<ItemCoverageCheck> => {
		const enforced = await isEnforced(ctx);
		return {
			...(await checkMessage(ctx, await ctx.db.get(args.inboundMessageId))),
			isEnforced: enforced,
		};
	},
});

/** Why an autonomous send must not go out now, or null; null whenever the gate only observes. */
export const dispatchHold = internalQuery({
	args: { inboundMessageId: v.id('inboundMessages') },
	handler: async (ctx, args): Promise<{ reason: string | null }> => {
		if (!(await isEnforced(ctx))) return { reason: null };
		const check = await checkMessage(ctx, await ctx.db.get(args.inboundMessageId));
		return { reason: check.reason };
	},
});

/**
 * Log a shadow-mode objection on the message's shadow observation. The gate
 * only runs on the auto-approve path, so a row created here records a
 * would-have-sent decision; the route step's own shadow write refreshes it
 * and keeps this field. Best-effort for the caller.
 */
export const recordShadow = internalMutation({
	args: {
		inboundMessageId: v.id('inboundMessages'),
		objections: v.array(v.string()),
		reason: v.string(),
	},
	handler: async (ctx, args): Promise<null> => {
		const message = await ctx.db.get(args.inboundMessageId);
		if (!message) return null;
		const now = Date.now();
		const itemCoverage = { objections: args.objections, reason: args.reason, at: now };
		const existing = await ctx.db
			.query('agentShadowDecisions')
			.withIndex('by_message', (q) => q.eq('inboundMessageId', args.inboundMessageId))
			.first();
		if (existing) {
			if (!existing.isResolved) await ctx.db.patch(existing._id, { itemCoverage });
			return null;
		}
		await ctx.db.insert('agentShadowDecisions', {
			inboundMessageId: args.inboundMessageId,
			category: message.classification?.category ?? 'unknown',
			sender: extractEmail(message.from ?? '') || 'unknown',
			isWouldHaveSent: true,
			reason: 'The item_coverage gate observed this auto-send in shadow mode.',
			confidence: message.classification?.confidence ?? 0,
			shadowDraft: message.draftResponse ?? '',
			isResolved: false,
			itemCoverage,
			createdAt: now,
		});
		return null;
	},
});
