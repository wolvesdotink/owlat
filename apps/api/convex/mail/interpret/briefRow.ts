/**
 * The per-thread `threadBriefs` row (SPEC §2): find it, create it, and decide
 * which mode a thread interprets in.
 *
 * Mode (SPEC §0): a Team Inbox thread and a thread of a shared-scope mailbox
 * run in `actions` mode; a personal Postbox thread runs in `brief` mode. The
 * row is created lazily by the first writer (the reducer, an activity append,
 * a viewer marking it seen), so every thread that never had interpretation or
 * activity simply has no row.
 *
 * Isolate-safe helpers, no Convex functions.
 */

import type { Doc } from '../../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../../_generated/server';
import type { InterpretMode } from '@owlat/shared/threadBrief';
import { threadRefToFields, type ThreadRef } from '../../lib/validators/threadRef';
import { mailboxScope } from '../mailbox/shared';

type ReadCtx = Pick<QueryCtx, 'db'>;

/** The brief row of a thread, or null when nothing was written for it yet. */
export async function loadBriefRow(
	ctx: ReadCtx,
	ref: ThreadRef
): Promise<Doc<'threadBriefs'> | null> {
	return ref.kind === 'mail'
		? ctx.db
				.query('threadBriefs')
				.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', ref.id))
				.first()
		: ctx.db
				.query('threadBriefs')
				.withIndex('by_conversation_thread', (q) => q.eq('conversationThreadId', ref.id))
				.first();
}

/**
 * The mode a thread interprets in, from its source of truth: `actions` for a
 * Team Inbox thread or a shared-scope mailbox, `brief` for a personal one.
 * Null when the thread (or its mailbox) is gone.
 */
export async function resolveThreadMode(
	ctx: ReadCtx,
	ref: ThreadRef
): Promise<InterpretMode | null> {
	if (ref.kind === 'team') return (await ctx.db.get(ref.id)) ? 'actions' : null;
	const thread = await ctx.db.get(ref.id);
	if (!thread) return null;
	const mailbox = await ctx.db.get(thread.mailboxId);
	if (!mailbox) return null;
	return mailboxScope(mailbox) === 'shared' ? 'actions' : 'brief';
}

/** A fresh brief row's fields: nothing interpreted, nothing appended. */
export function emptyBriefRow(ref: ThreadRef, mode: InterpretMode, now: number) {
	return {
		...threadRefToFields(ref),
		mode,
		sourceRevision: 0,
		interpretationRevision: 0,
		lastActivitySeq: 0,
		completeness: 'none' as const,
		deletionEpoch: 0,
		updatedAt: now,
	};
}

/**
 * The thread's brief row, created when missing. `mode` defaults to the
 * thread's own ({@link resolveThreadMode}); a thread that no longer exists
 * gets no row and returns null.
 */
export async function ensureBriefRow(
	ctx: MutationCtx,
	ref: ThreadRef,
	mode?: InterpretMode
): Promise<Doc<'threadBriefs'> | null> {
	const existing = await loadBriefRow(ctx, ref);
	if (existing) return existing;
	const resolved = mode ?? (await resolveThreadMode(ctx, ref));
	if (!resolved) return null;
	const id = await ctx.db.insert('threadBriefs', emptyBriefRow(ref, resolved, Date.now()));
	return ctx.db.get(id);
}
