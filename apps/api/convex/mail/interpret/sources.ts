/**
 * Source snapshots, written when interpretation is ENQUEUED (review F9, F15):
 *
 *   - `captureInterpretSource(ctx, {source, isLive, precedence?, listId?})`
 *     computes the eligibility signals once, from what the enqueueing write
 *     knows (live delivery or backfill, the ingest-only headers), and stores
 *     them. Every run and every retry decides on this snapshot; a source
 *     without one is NOT interpreted (`no_snapshot`). The first snapshot wins.
 *   - `captureTeamReplySnapshot(ctx, {sendId, subject, text})` stores the
 *     reply text exactly as the team send was finalized, sealed, for the
 *     `teamReply` source: the inbound row's draft can change or be cleared
 *     afterwards. Call it in the transaction that finalizes the send.
 *
 * Both have internal-mutation twins for callers in an action.
 */

import { v } from 'convex/values';
import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import { internalMutation } from '../../lib/writeFence';
import {
	interpretationSourceKey,
	interpretationSourceValidator,
	type InterpretationSource,
} from '../../lib/validators/threadBrief';
import { threadRefToFields, type ThreadRef } from '../../lib/validators/threadRef';
import { sealBodyAtWrite } from '../../lib/messageBody';
import {
	loadInboundEligibilitySignals,
	loadMailEligibilitySignals,
	type InterpretEligibilitySignals,
} from './eligibility';

type ReadCtx = Pick<MutationCtx, 'db'>;

/** The stored snapshot of a source, or null. */
export async function loadInterpretSource(
	ctx: ReadCtx,
	source: InterpretationSource
): Promise<Doc<'interpretSources'> | null> {
	return ctx.db
		.query('interpretSources')
		.withIndex('by_source_key', (q) => q.eq('sourceKey', interpretationSourceKey(source)))
		.first();
}

async function threadOfSource(
	ctx: ReadCtx,
	source: InterpretationSource
): Promise<ThreadRef | null> {
	switch (source.kind) {
		case 'mail':
		case 'outboundMail': {
			const row = await ctx.db.get(source.id);
			return row ? { kind: 'mail', id: row.threadId } : null;
		}
		case 'inbound': {
			const row = await ctx.db.get(source.id);
			return row?.threadId ? { kind: 'team', id: row.threadId } : null;
		}
		case 'teamReply': {
			const send = await ctx.db.get(source.id);
			const inbound = send?.inboundMessageId ? await ctx.db.get(send.inboundMessageId) : null;
			return inbound?.threadId ? { kind: 'team', id: inbound.threadId } : null;
		}
	}
}

async function signalsOf(
	ctx: ReadCtx,
	source: InterpretationSource,
	opts: { isLive: boolean; precedence?: string; listId?: string }
): Promise<InterpretEligibilitySignals | null> {
	if (source.kind === 'mail' || source.kind === 'outboundMail') {
		const row = await ctx.db.get(source.id);
		return row ? loadMailEligibilitySignals(ctx, row, opts) : null;
	}
	if (source.kind === 'inbound') {
		const row = await ctx.db.get(source.id);
		if (!row) return null;
		return { ...(await loadInboundEligibilitySignals(ctx, row)), isLive: opts.isLive };
	}
	return { isLive: opts.isLive, isThreadMuted: false, isBulkHeaderPresent: false, isSenderKnown: true };
}

/** Snapshot a source's eligibility at enqueue (first call wins). Null when it is gone. */
export async function captureInterpretSource(
	ctx: MutationCtx,
	args: { source: InterpretationSource; isLive: boolean; precedence?: string; listId?: string }
): Promise<Id<'interpretSources'> | null> {
	const existing = await loadInterpretSource(ctx, args.source);
	if (existing) return existing._id;
	const ref = await threadOfSource(ctx, args.source);
	const eligibility = await signalsOf(ctx, args.source, args);
	if (!ref || !eligibility) return null;
	const now = Date.now();
	return ctx.db.insert('interpretSources', {
		...threadRefToFields(ref),
		source: args.source,
		sourceKey: interpretationSourceKey(args.source),
		eligibility,
		createdAt: now,
		updatedAt: now,
	});
}

/** Snapshot the text a team send went out with (call at send finalization). */
export async function captureTeamReplySnapshot(
	ctx: MutationCtx,
	args: { sendId: Id<'transactionalSends'>; subject: string; text: string }
): Promise<Id<'interpretSources'> | null> {
	const source = { kind: 'teamReply' as const, id: args.sendId };
	const ref = await threadOfSource(ctx, source);
	if (!ref) return null;
	const now = Date.now();
	const snapshot = {
		subject: args.subject,
		text: await sealBodyAtWrite(args.text),
		capturedAt: now,
	};
	const existing = await loadInterpretSource(ctx, source);
	if (existing) {
		// The send is immutable once finalized: keep the first snapshot.
		if (!existing.snapshot) await ctx.db.patch(existing._id, { snapshot, updatedAt: now });
		return existing._id;
	}
	return ctx.db.insert('interpretSources', {
		...threadRefToFields(ref),
		source,
		sourceKey: interpretationSourceKey(source),
		eligibility: { isLive: true, isThreadMuted: false, isBulkHeaderPresent: false, isSenderKnown: true },
		snapshot,
		createdAt: now,
		updatedAt: now,
	});
}

/** {@link captureInterpretSource} for callers in an action. */
export const captureSource = internalMutation({
	args: {
		source: interpretationSourceValidator,
		isLive: v.boolean(),
		precedence: v.optional(v.string()),
		listId: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		await captureInterpretSource(ctx, args);
		return null;
	},
});

/** {@link captureTeamReplySnapshot} for callers in an action. */
export const captureTeamReply = internalMutation({
	args: { sendId: v.id('transactionalSends'), subject: v.string(), text: v.string() },
	handler: async (ctx, args) => {
		await captureTeamReplySnapshot(ctx, args);
		return null;
	},
});
