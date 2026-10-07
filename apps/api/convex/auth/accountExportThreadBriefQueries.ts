import { paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';
import { internalQuery } from '../_generated/server';
import { requireSelf } from '../lib/sessionOrganization';
import { throwNotFound } from '../_utils/errors';
import { openMessageBody } from '../lib/messageBody';
import { loadPersonalMailboxForUser } from '../mail/permissions';
import { loadBriefRow } from '../mail/interpret/briefRow';
import { openEvidence } from '../mail/interpret/briefRead';

// Thread brief resources of "Export my data" (SPEC §5 Erasure: "Export
// includes authorized derived content"), next to accountExportQueries.ts.
//
// What the interpretation derived from the member's own personal mail: per
// thread its items, facts and activity, unsealed. Only personal mailboxes the
// member owns, like the mail itself (a team inbox is org infrastructure).
// Internal notes and discussion messages never appear here: the activity log
// does not hold them, and their own resources export what the member wrote.

/** Threads per export page: each one carries its items, facts and activity. */
const THREADS_PER_PAGE = 25;
/** Rows per thread and kind; a longer list says so (`is…Truncated`). */
const ITEMS_PER_THREAD = 200;
const FACTS_PER_THREAD = 200;
const ACTIVITY_PER_THREAD = 500;

async function openPair(pair: { en: string; de: string }) {
	return { en: await openMessageBody(pair.en), de: await openMessageBody(pair.de) };
}

async function exportItem(row: Doc<'threadItems'>) {
	return {
		_id: row._id,
		revision: row.revision,
		intent: row.intent,
		facets: row.facets,
		...(row.consequences ? { consequences: row.consequences } : {}),
		assertion: await openMessageBody(row.assertion),
		display: await openPair(row.display),
		requester: row.requester,
		responsible: row.responsible,
		...(row.beneficiary ? { beneficiary: row.beneficiary } : {}),
		responsibility: row.responsibility,
		status: row.status,
		disposition: row.disposition,
		...(row.completion ? { completion: row.completion } : {}),
		...(row.due ? { due: row.due } : {}),
		...(row.amount ? { amount: row.amount } : {}),
		...(row.options ? { options: row.options } : {}),
		evidence: await openEvidence(row.evidence),
		...(row.pendingUpdate
			? {
					pendingUpdate: {
						...row.pendingUpdate,
						evidence: await openEvidence(row.pendingUpdate.evidence),
					},
				}
			: {}),
		...(row.correction ? { correction: row.correction } : {}),
		verify: row.verify,
		...(row.remindAt !== undefined ? { remindAt: row.remindAt } : {}),
		...(row.commitmentId ? { commitmentId: row.commitmentId } : {}),
		askedAt: row.askedAt,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

async function exportFact(row: Doc<'threadFacts'>) {
	const value = row.value;
	return {
		_id: row._id,
		factKey: row.factKey,
		assertion: await openMessageBody(row.assertion),
		display: await openPair(row.display),
		...(value
			? {
					value:
						value.kind === 'date' || value.kind === 'money'
							? value
							: { kind: value.kind, text: await openMessageBody(value.text) },
				}
			: {}),
		evidence: await openEvidence(row.evidence),
		provenance: row.provenance,
		status: row.status,
		...(row.supersedesId ? { supersedesId: row.supersedesId } : {}),
		...(row.conflictsWithId ? { conflictsWithId: row.conflictsWithId } : {}),
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

async function exportActivity(row: Doc<'threadActivity'>) {
	const { payload, payloadVersion: _version, idempotencyKey: _key, ...rest } = row;
	return {
		...rest,
		...(payload !== undefined
			? { payload: JSON.parse(await openMessageBody(payload)) as unknown }
			: {}),
	};
}

/** Take up to `limit` rows and say whether more were left behind. */
function capped<T>(rows: T[], limit: number): { rows: T[]; isTruncated: boolean } {
	return { rows: rows.slice(0, limit), isTruncated: rows.length > limit };
}

/**
 * The thread briefs of one of the member's personal mailboxes, one row per
 * thread that has one, newest thread first.
 */
export const listMailboxThreadBriefs = internalQuery({
	args: {
		userId: v.string(),
		mailboxId: v.id('mailboxes'),
		paginationOpts: paginationOptsValidator,
	},
	handler: async (ctx, args) => {
		await requireSelf(ctx, args.userId);
		const mailbox = await loadPersonalMailboxForUser(ctx, args.mailboxId, args.userId);
		if (!mailbox) throwNotFound('Personal mailbox');
		const result = await ctx.db
			.query('mailThreads')
			.withIndex('by_mailbox_and_last_message', (q) => q.eq('mailboxId', mailbox._id))
			.order('desc')
			.paginate({
				...args.paginationOpts,
				numItems: Math.min(args.paginationOpts.numItems, THREADS_PER_PAGE),
			});
		const page = [];
		for (const thread of result.page) {
			const ref = { kind: 'mail' as const, id: thread._id };
			const brief = await loadBriefRow(ctx, ref);
			if (!brief) continue;
			const items = capped(
				await ctx.db
					.query('threadItems')
					.withIndex('by_mail_thread_and_status', (q) => q.eq('mailThreadId', thread._id))
					.take(ITEMS_PER_THREAD + 1),
				ITEMS_PER_THREAD
			);
			const facts = capped(
				await ctx.db
					.query('threadFacts')
					.withIndex('by_mail_thread_and_status', (q) => q.eq('mailThreadId', thread._id))
					.take(FACTS_PER_THREAD + 1),
				FACTS_PER_THREAD
			);
			const activity = capped(
				await ctx.db
					.query('threadActivity')
					.withIndex('by_mail_thread_and_seq', (q) => q.eq('mailThreadId', thread._id))
					.take(ACTIVITY_PER_THREAD + 1),
				ACTIVITY_PER_THREAD
			);
			page.push({
				threadId: thread._id,
				subject: thread.subject,
				mode: brief.mode,
				completeness: brief.completeness,
				items: await Promise.all(items.rows.map(exportItem)),
				isItemsTruncated: items.isTruncated,
				facts: await Promise.all(facts.rows.map(exportFact)),
				isFactsTruncated: facts.isTruncated,
				activity: await Promise.all(activity.rows.map(exportActivity)),
				isActivityTruncated: activity.isTruncated,
			});
		}
		return { ...result, page };
	},
});

/** The member's own brief view state: per thread, the view they chose and what they last saw. */
export const listOwnThreadViewerState = internalQuery({
	args: { userId: v.string(), paginationOpts: paginationOptsValidator },
	handler: async (ctx, args) => {
		await requireSelf(ctx, args.userId);
		return ctx.db
			.query('threadViewerState')
			.withIndex('by_user_and_mail_thread', (q) => q.eq('userId', args.userId))
			.paginate(args.paginationOpts);
	},
});
