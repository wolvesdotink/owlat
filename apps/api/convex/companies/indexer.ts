/**
 * Keeps the company index (`companyThreads`) in step with the conversations.
 *
 * Six code paths write a Postbox thread's participants and two more write
 * Team Inbox threads, so instead of hooking each of them the index is swept:
 * every run walks each mailbox's threads by `lastMessageAt` from that
 * mailbox's cursor, and the Team Inbox's threads from its own. A thread that
 * gained a message has a later `lastMessageAt`, so it comes round again and is
 * re-indexed. The first runs on an existing install are the backfill.
 *
 * The index is read-side data and may lag a sweep interval behind the mail.
 * Rows whose thread was deleted since are skipped by the readers.
 */

import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { mailThreadCompanies, teamThreadCompanies } from './eligibility';
import { loadOwnDomains } from './ownDomains';

/** Threads one mailbox may index per run, so one busy mailbox cannot starve the rest. */
export const MAILBOX_BATCH = 50;
/** Threads one run indexes across every mailbox and the Team Inbox. */
export const RUN_BUDGET = 500;
/** Mailboxes one run looks at; a run starts at a rotating offset into them. */
const MAX_MAILBOXES = 1000;

type Target =
	| { kind: 'mail'; thread: Doc<'mailThreads'>; mailbox: Doc<'mailboxes'> }
	| { kind: 'team'; thread: Doc<'conversationThreads'> };

/** Bring one thread's rows in line with the companies it involves now. */
async function reindexThread(
	ctx: MutationCtx,
	target: Target,
	ownDomains: ReadonlySet<string>
): Promise<void> {
	const desired =
		target.kind === 'mail'
			? mailThreadCompanies(target.thread, ownDomains)
			: teamThreadCompanies(target.thread, ownDomains);
	const existing =
		target.kind === 'mail'
			? await ctx.db
					.query('companyThreads')
					.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', target.thread._id))
					.take(50)
			: await ctx.db
					.query('companyThreads')
					.withIndex('by_conversation_thread', (q) =>
						q.eq('conversationThreadId', target.thread._id)
					)
					.take(50);
	const lastMessageAt = target.thread.lastMessageAt;
	const kept = new Set<string>();
	for (const row of existing) {
		const addresses = desired.get(row.companyKey);
		if (!addresses || kept.has(row.companyKey)) {
			await ctx.db.delete(row._id);
			continue;
		}
		kept.add(row.companyKey);
		if (row.lastMessageAt !== lastMessageAt || row.addresses.join('\n') !== addresses.join('\n')) {
			await ctx.db.patch(row._id, { addresses, lastMessageAt });
		}
	}
	for (const [companyKey, addresses] of desired) {
		if (kept.has(companyKey)) continue;
		if (target.kind === 'mail') {
			const personal = target.mailbox.scope !== 'shared';
			await ctx.db.insert('companyThreads', {
				companyKey,
				kind: 'mail',
				mailboxId: target.mailbox._id,
				mailThreadId: target.thread._id,
				...(personal ? { ownerUserId: target.mailbox.userId } : {}),
				addresses,
				lastMessageAt,
			});
		} else {
			await ctx.db.insert('companyThreads', {
				companyKey,
				kind: 'team',
				conversationThreadId: target.thread._id,
				addresses,
				lastMessageAt,
			});
		}
	}
}

async function loadCursor(ctx: MutationCtx, mailboxId: Id<'mailboxes'> | undefined) {
	return await ctx.db
		.query('companyIndexCursors')
		.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailboxId))
		.first();
}

/**
 * The next cursor after a batch. Threads with the same `lastMessageAt` as the
 * cursor are read again next run (the range is inclusive), which is harmless;
 * only a full batch that never moved past the cursor steps over it, or the
 * sweep would read the same batch forever.
 */
export function nextCursor(
	from: number,
	batch: readonly { lastMessageAt: number }[],
	limit: number
) {
	const last = batch[batch.length - 1];
	if (!last) return from;
	if (last.lastMessageAt === from && batch.length >= limit) return from + 1;
	return last.lastMessageAt;
}

async function saveCursor(
	ctx: MutationCtx,
	mailboxId: Id<'mailboxes'> | undefined,
	existing: Doc<'companyIndexCursors'> | null,
	lastMessageAt: number
): Promise<void> {
	const now = Date.now();
	if (existing) {
		if (existing.lastMessageAt !== lastMessageAt) {
			await ctx.db.patch(existing._id, { lastMessageAt, updatedAt: now });
		}
		return;
	}
	await ctx.db.insert('companyIndexCursors', {
		...(mailboxId ? { mailboxId } : {}),
		lastMessageAt,
		updatedAt: now,
	});
}

async function sweepMailbox(
	ctx: MutationCtx,
	mailbox: Doc<'mailboxes'>,
	ownDomains: ReadonlySet<string>,
	limit: number
): Promise<number> {
	const cursor = await loadCursor(ctx, mailbox._id);
	const from = cursor?.lastMessageAt ?? 0;
	const threads = await ctx.db
		.query('mailThreads')
		.withIndex('by_mailbox_and_last_message', (q) =>
			q.eq('mailboxId', mailbox._id).gte('lastMessageAt', from)
		)
		.order('asc')
		.take(limit);
	for (const thread of threads) {
		await reindexThread(ctx, { kind: 'mail', thread, mailbox }, ownDomains);
	}
	await saveCursor(ctx, mailbox._id, cursor, nextCursor(from, threads, limit));
	return threads.length;
}

async function sweepTeamInbox(
	ctx: MutationCtx,
	ownDomains: ReadonlySet<string>,
	limit: number
): Promise<number> {
	const cursor = await loadCursor(ctx, undefined);
	const from = cursor?.lastMessageAt ?? 0;
	const threads = await ctx.db
		.query('conversationThreads')
		.withIndex('by_last_message_at', (q) => q.gte('lastMessageAt', from))
		.order('asc')
		.take(limit);
	for (const thread of threads) {
		await reindexThread(ctx, { kind: 'team', thread }, ownDomains);
	}
	await saveCursor(ctx, undefined, cursor, nextCursor(from, threads, limit));
	return threads.length;
}

export async function runSweep(ctx: MutationCtx, now: number): Promise<{ indexed: number }> {
	const ownDomains = await loadOwnDomains(ctx);
	const mailboxes = (
		await ctx.db
			.query('mailboxes')
			.withIndex('by_status', (q) => q.eq('status', 'active'))
			.take(MAX_MAILBOXES)
	).filter((m) => m.scope !== 'seed');
	let budget = RUN_BUDGET;
	let indexed = 0;
	// Rotate where a run starts, so a backlog in the first mailboxes cannot
	// keep the later ones waiting run after run.
	const start = mailboxes.length > 0 ? Math.floor(now / 60_000) % mailboxes.length : 0;
	for (let i = 0; i < mailboxes.length && budget > 0; i++) {
		const mailbox = mailboxes[(start + i) % mailboxes.length]!;
		const n = await sweepMailbox(ctx, mailbox, ownDomains, Math.min(budget, MAILBOX_BATCH));
		budget -= n;
		indexed += n;
	}
	if (budget > 0) indexed += await sweepTeamInbox(ctx, ownDomains, Math.min(budget, MAILBOX_BATCH));
	return { indexed };
}

export const sweep = internalMutation({
	args: {},
	handler: async (ctx) => await runSweep(ctx, Date.now()),
});
