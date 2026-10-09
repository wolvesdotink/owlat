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
 * Both are helpers for the enqueueing mutation's own transaction (delivery,
 * the send finalization); an action reaches them through its own mutation.
 */

import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../../_generated/server';
import {
	interpretationSourceKey,
	type InterpretationSource,
} from '../../lib/validators/threadBrief';
import {
	threadRefFromFields,
	threadRefToFields,
	type ThreadRef,
} from '../../lib/validators/threadRef';
import { ensureBriefRow, loadBriefRow } from './briefRow';
import { sealBodyAtWrite } from '../../lib/messageBody';
import {
	loadInboundEligibilitySignals,
	loadMailEligibilitySignals,
	type InterpretEligibilitySignals,
} from './eligibility';

type ReadCtx = Pick<QueryCtx, 'db'>;

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

/**
 * A team send and the inbound message it answers: through `inboundMessageId`,
 * or, for a human follow-up (no inbound message of its own), through its
 * `inboxFollowUps` row (`inReplyToMessageId`, `threadId`). Null when either
 * is gone or they name different threads.
 */
export async function teamReplyContext(
	ctx: ReadCtx,
	sendId: Id<'transactionalSends'>
): Promise<{
	send: Doc<'transactionalSends'>;
	inbound: Doc<'inboundMessages'>;
	threadId: Id<'conversationThreads'>;
} | null> {
	const send = await ctx.db.get(sendId);
	if (!send) return null;
	if (send.inboundMessageId) {
		const inbound = await ctx.db.get(send.inboundMessageId);
		return inbound?.threadId ? { send, inbound, threadId: inbound.threadId } : null;
	}
	if (!send.followUpId) return null;
	const followUp = await ctx.db.get(send.followUpId);
	if (!followUp) return null;
	const inbound = await ctx.db.get(followUp.inReplyToMessageId);
	if (!inbound || (inbound.threadId && inbound.threadId !== followUp.threadId)) return null;
	return { send, inbound, threadId: followUp.threadId };
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
			const reply = await teamReplyContext(ctx, source.id);
			return reply ? { kind: 'team', id: reply.threadId } : null;
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
	return {
		isLive: opts.isLive,
		isThreadMuted: false,
		isBulkHeaderPresent: false,
		isSenderKnown: true,
	};
}

/**
 * Snapshot a source's eligibility at enqueue (first call wins), and mark it
 * outstanding: every caller enqueues its interpretation next. Null when it
 * is gone.
 */
export async function captureInterpretSource(
	ctx: MutationCtx,
	args: { source: InterpretationSource; isLive: boolean; precedence?: string; listId?: string }
): Promise<Id<'interpretSources'> | null> {
	const existing = await loadInterpretSource(ctx, args.source);
	if (existing) {
		await markSourceOutstanding(ctx, existing);
		return existing._id;
	}
	const ref = await threadOfSource(ctx, args.source);
	const eligibility = await signalsOf(ctx, args.source, args);
	if (!ref || !eligibility) return null;
	const now = Date.now();
	const id = await ctx.db.insert('interpretSources', {
		...threadRefToFields(ref),
		source: args.source,
		sourceKey: interpretationSourceKey(args.source),
		eligibility,
		createdAt: now,
		updatedAt: now,
	});
	const inserted = await ctx.db.get(id);
	if (inserted) await markSourceOutstanding(ctx, inserted);
	return id;
}

// ── Outstanding sources (p4 final review F2) ────────────────────────────────
//
// A source enqueued for interpretation is outstanding until it records an
// outcome, any outcome (complete, partial, failed, skipped). The thread's
// brief counts them (`threadBriefs.pendingSources`) and `briefCompleteness`
// never reads complete while one is left, so one finished source cannot
// clear the auto-send hold while another is unread. Both moves are keyed by
// the source's snapshot flag (`interpretSources.isOutstanding`), so a
// repeated enqueue or a retried run counts once.

/** Mark an enqueued source outstanding (idempotent). */
export async function markSourceOutstanding(
	ctx: MutationCtx,
	snapshot: Doc<'interpretSources'>
): Promise<void> {
	if (snapshot.isOutstanding) return;
	await ctx.db.patch(snapshot._id, { isOutstanding: true });
	const brief = await ensureBriefRow(ctx, threadRefFromFields(snapshot));
	if (!brief) return;
	await ctx.db.patch(brief._id, { pendingSources: (brief.pendingSources ?? 0) + 1 });
}

/**
 * The source recorded an outcome, or is being purged: no longer outstanding
 * (idempotent). Call in the transaction that records it; the caller
 * recomputes completeness (the reducer and the purge both do).
 */
export async function settleSource(
	ctx: MutationCtx,
	snapshot: Doc<'interpretSources'> | null
): Promise<void> {
	if (!snapshot?.isOutstanding) return;
	await ctx.db.patch(snapshot._id, { isOutstanding: undefined });
	const brief = await loadBriefRow(ctx, threadRefFromFields(snapshot));
	if (!brief) return;
	const left = Math.max(0, (brief.pendingSources ?? 0) - 1);
	await ctx.db.patch(brief._id, { pendingSources: left > 0 ? left : undefined });
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
		eligibility: {
			isLive: true,
			isThreadMuted: false,
			isBulkHeaderPresent: false,
			isSenderKnown: true,
		},
		snapshot,
		createdAt: now,
		updatedAt: now,
	});
}
