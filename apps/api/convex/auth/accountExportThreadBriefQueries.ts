import { paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';
import { internalQuery } from '../_generated/server';
import { requireSelf } from '../lib/sessionOrganization';
import { throwInvalidInput, throwNotFound } from '../_utils/errors';
import { openMessageBody } from '../lib/messageBody';
import { loadPersonalMailboxForUser } from '../mail/permissions';
import { loadBriefRow } from '../mail/interpret/briefRow';
import { openEvidence } from '../mail/interpret/briefOpen';

// Thread brief resources of "Export my data" (SPEC §5 Erasure: "Export
// includes authorized derived content"), next to accountExportQueries.ts.
//
// What the interpretation derived from the member's own personal mail: per
// thread its items, facts and activity, unsealed and complete (paged through
// the export cursor, never capped). Only personal mailboxes the
// member owns, like the mail itself (a team inbox is org infrastructure).
// Internal notes and discussion messages never appear here: the activity log
// does not hold them, and their own resources export what the member wrote.

/** Threads scanned for a brief per export page. */
const THREAD_SCAN = 25;
/** Most thread ids a cursor carries (one scan's worth). */
const MAX_QUEUED_THREADS = THREAD_SCAN;
/** The three child resources of a thread, exported in this order. */
const PARTS = ['items', 'facts', 'activity'] as const;

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

/**
 * Where a thread brief export stands, carried in the export cursor (the
 * export's own durable progress: the client hands it back for the next page).
 *   - `threads`, `isThreadsDone`: the scan over the mailbox's threads;
 *   - `queue`: the scanned threads that have a brief, still to export (the
 *     first one is the current thread);
 *   - `part`, `partCursor`: which child resource of the current thread, and
 *     how far into it;
 *   - `isHeaderDone`: the current thread's header row was written.
 * The cursor stays on a thread until every item, fact and activity row of
 * it is exported: nothing is capped.
 */
interface BriefExportCursor {
	threads: string | null;
	isThreadsDone: boolean;
	queue: string[];
	part: number;
	partCursor: string | null;
	isHeaderDone: boolean;
}

const START: BriefExportCursor = {
	threads: null,
	isThreadsDone: false,
	queue: [],
	part: 0,
	partCursor: null,
	isHeaderDone: false,
};

/** Read a cursor this query wrote; anything else is refused. Pure. */
function decodeBriefExportCursor(cursor: string | null): BriefExportCursor {
	if (cursor === null || cursor === '') return START;
	let parsed: unknown;
	try {
		parsed = JSON.parse(cursor);
	} catch {
		throwInvalidInput('Unreadable thread brief export cursor');
	}
	const c = parsed as Partial<BriefExportCursor> | null;
	const isText = (x: unknown) => x === null || typeof x === 'string';
	if (
		!c ||
		!isText(c.threads) ||
		typeof c.isThreadsDone !== 'boolean' ||
		!Array.isArray(c.queue) ||
		c.queue.length > MAX_QUEUED_THREADS ||
		!c.queue.every((id) => typeof id === 'string') ||
		typeof c.part !== 'number' ||
		!(c.part >= 0 && c.part < PARTS.length) ||
		!isText(c.partCursor) ||
		typeof c.isHeaderDone !== 'boolean'
	) {
		throwInvalidInput('Unreadable thread brief export cursor');
	}
	return c as BriefExportCursor;
}

/** The first queued thread done: on to the next one. */
function nextThread(state: BriefExportCursor): BriefExportCursor {
	return { ...state, queue: state.queue.slice(1), part: 0, partCursor: null, isHeaderDone: false };
}

function page(rows: unknown[], next: BriefExportCursor) {
	return {
		page: rows,
		isDone: next.isThreadsDone && next.queue.length === 0,
		continueCursor: JSON.stringify(next),
	};
}

/**
 * The thread briefs of one of the member's personal mailboxes, newest thread
 * first, as flat rows: per thread one `{threadId, kind: 'thread', subject,
 * mode, completeness}` header, then every `kind: 'item'`, `'fact'` and
 * `'activity'` row of it, each with its `threadId`. One page does ONE
 * paginated read (Convex allows one per query): a scan of up to
 * {@link THREAD_SCAN} threads for the ones with a brief, or one page of the
 * current thread's current child resource. See {@link BriefExportCursor}.
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
		const state = decodeBriefExportCursor(args.paginationOpts.cursor);

		if (state.queue.length === 0) {
			if (state.isThreadsDone) return page([], state);
			const scan = await ctx.db
				.query('mailThreads')
				.withIndex('by_mailbox_and_last_message', (q) => q.eq('mailboxId', mailbox._id))
				.order('desc')
				.paginate({ cursor: state.threads, numItems: THREAD_SCAN });
			const queue: string[] = [];
			for (const thread of scan.page) {
				if (await loadBriefRow(ctx, { kind: 'mail', id: thread._id })) queue.push(thread._id);
			}
			return page([], {
				...START,
				threads: scan.continueCursor,
				isThreadsDone: scan.isDone,
				queue,
			});
		}

		const threadId = ctx.db.normalizeId('mailThreads', state.queue[0]!);
		const thread = threadId ? await ctx.db.get(threadId) : null;
		const brief =
			thread && thread.mailboxId === mailbox._id
				? await loadBriefRow(ctx, { kind: 'mail', id: thread._id })
				: null;
		// Gone since the scan (or not this mailbox's): nothing left to export of it.
		if (!thread || !brief) return page([], nextThread(state));

		const rows: unknown[] = [];
		if (!state.isHeaderDone) {
			rows.push({
				threadId: thread._id,
				kind: 'thread',
				subject: thread.latestSubject,
				mode: brief.mode,
				completeness: brief.completeness,
			});
		}
		const opts = { cursor: state.partCursor, numItems: args.paginationOpts.numItems };
		const part = PARTS[state.part]!;
		let isPartDone: boolean;
		let partCursor: string;
		if (part === 'items') {
			const result = await ctx.db
				.query('threadItems')
				.withIndex('by_mail_thread_and_status', (q) => q.eq('mailThreadId', thread._id))
				.paginate(opts);
			for (const row of result.page)
				rows.push({ threadId: thread._id, kind: 'item', ...(await exportItem(row)) });
			({ isDone: isPartDone, continueCursor: partCursor } = result);
		} else if (part === 'facts') {
			const result = await ctx.db
				.query('threadFacts')
				.withIndex('by_mail_thread_and_status', (q) => q.eq('mailThreadId', thread._id))
				.paginate(opts);
			for (const row of result.page)
				rows.push({ threadId: thread._id, kind: 'fact', ...(await exportFact(row)) });
			({ isDone: isPartDone, continueCursor: partCursor } = result);
		} else {
			const result = await ctx.db
				.query('threadActivity')
				.withIndex('by_mail_thread_and_seq', (q) => q.eq('mailThreadId', thread._id))
				.paginate(opts);
			for (const row of result.page)
				rows.push({ threadId: thread._id, kind: 'activity', ...(await exportActivity(row)) });
			({ isDone: isPartDone, continueCursor: partCursor } = result);
		}

		const advanced: BriefExportCursor = { ...state, isHeaderDone: true };
		if (!isPartDone) return page(rows, { ...advanced, partCursor });
		if (state.part + 1 < PARTS.length) {
			return page(rows, { ...advanced, part: state.part + 1, partCursor: null });
		}
		return page(rows, nextThread(state));
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
