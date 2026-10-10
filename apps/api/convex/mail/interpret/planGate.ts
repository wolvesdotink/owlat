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
 *   - `outgoingCoverageHold`: the same check in the transaction that creates
 *     the Send (`inbox/replyAttachments.intakeAgentReply`), against the exact
 *     outgoing text and attachment set; it holds only while the gate enforces.
 *     Shadow mode never relaxes another gate and never holds.
 *
 * Coverage counts only when every value it is bound to equals the send's
 * (review D1): the plan revision it was computed for, the draft hash, the
 * attachment-set hash, the thread revision and every item revision.
 *
 * Restrict-only: nothing here can approve or widen a send.
 */

import { v } from 'convex/values';
import type { Doc } from '../../_generated/dataModel';
import type { QueryCtx } from '../../_generated/server';
import { internalQuery } from '../../_generated/server';
import { internalMutation } from '../../lib/writeFence';
import { extractEmail } from '../../lib/emailAddress';
import { attachmentSetHashOf, draftHashOf } from '@owlat/shared/threadBriefRules';
import { loadBriefRow } from './briefRow';
import { loadPlanItems, outgoingTeamAttachments, readPlanRow } from './responsePlanState';
import {
	itemCoverageObjections,
	itemCoverageReason,
	type ItemCoverageObjection,
} from './responsePlanRules';

export interface ItemCoverageCheck {
	objections: ItemCoverageObjection[];
	reason: string | null;
	isEnforced: boolean;
}

type ReadCtx = Pick<QueryCtx, 'db'>;

export async function isItemCoverageEnforced(ctx: ReadCtx): Promise<boolean> {
	const config = await ctx.db.query('agentConfig').first();
	return config?.isItemCoverageEnforced === true;
}

/**
 * The objections to sending `draftText` with `attachmentIds` as the reply to
 * `message`: the stored plan of its draft against exactly these.
 */
export async function checkOutgoing(
	ctx: ReadCtx,
	message: Doc<'inboundMessages'> | null,
	outgoing: { draftText: string | undefined; attachmentIds: readonly string[] }
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
		// A stored commitment keeps its deadline as `due.phrase` (review r2 F1).
		plan: plan
			? {
					...plan,
					newPromises: plan.newPromises.map((p) => ({
						...(p.itemId ? { itemId: p.itemId } : {}),
						...(p.amount ? { amount: p.amount } : {}),
						...(p.due ? { duePhrase: p.due.phrase } : {}),
					})),
				}
			: null,
		draftHash: outgoing.draftText ? await draftHashOf(outgoing.draftText) : null,
		attachmentSetHash: await attachmentSetHashOf(outgoing.attachmentIds),
		threadRevision: brief?.interpretationRevision ?? null,
		completeness: brief?.completeness ?? null,
		items: loaded.rows.map((row) => ({
			id: row._id,
			revision: row.revision,
			responsibility: row.responsibility,
			...(row.due ? { duePhrase: row.due.phrase } : {}),
			...(row.amount ? { amount: row.amount } : {}),
		})),
		isItemsOverflow: loaded.isOverflow,
	});
	return { objections, reason: itemCoverageReason(objections) };
}

/** Route time: the draft on the message and the files an autonomous send would carry. */
export const itemCoverageCheck = internalQuery({
	args: { inboundMessageId: v.id('inboundMessages') },
	handler: async (ctx, args): Promise<ItemCoverageCheck> => {
		const isEnforced = await isItemCoverageEnforced(ctx);
		const message = await ctx.db.get(args.inboundMessageId);
		const thread = message?.threadId ? await ctx.db.get(message.threadId) : null;
		const attachmentIds = message
			? outgoingTeamAttachments(message, thread?.replyAttachments).map((a) => a.id)
			: [];
		const check = await checkOutgoing(ctx, message, {
			draftText: message?.draftResponse,
			attachmentIds,
		});
		return { ...check, isEnforced };
	},
});

/**
 * In the transaction that creates an autonomous Send: why it must not go out,
 * or null. Null whenever the gate only observes (shadow mode).
 */
export async function outgoingCoverageHold(
	ctx: ReadCtx,
	message: Doc<'inboundMessages'>,
	outgoing: { draftText: string; attachmentIds: readonly string[] }
): Promise<string | null> {
	if (!(await isItemCoverageEnforced(ctx))) return null;
	return (await checkOutgoing(ctx, message, outgoing)).reason;
}

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
