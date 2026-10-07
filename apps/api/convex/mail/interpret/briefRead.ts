/**
 * Loaders behind `brief.ts get`: each reads one part of a thread's brief and
 * opens its sealed text for one locale. No authorization here: the caller
 * (`brief.ts`) has already decided the viewer may read the thread.
 *
 * Every read is bounded (items per status, facts, the activity tail, the
 * newest messages for participants and files).
 */

import type { Doc, Id } from '../../_generated/dataModel';
import type { QueryCtx } from '../../_generated/server';
import { normalizeEmail } from '@owlat/shared';
import type { AppLocale } from '@owlat/shared/appLocales';
import type { Evidence } from '../../lib/validators/threadBrief';
import type { ThreadRef } from '../../lib/validators/threadRef';
import { openMessageBody } from '../../lib/messageBody';
import { mailboxOwnAddresses } from '../identities';
import { readResult, recentlyClosedItems } from './load';
import type { EXACT_WORDING_REASONS } from './schema';
import type { SourceCounts } from './counters';

type ExactWordingReason = (typeof EXACT_WORDING_REASONS)[number];
import type {
	ActivityView,
	EvidenceView,
	FactView,
	FileView,
	LatestLineView,
	ParticipantView,
} from './briefShape';
import { gapReasonOf, type GapReason, type OpenedItem } from './briefProject';

type ReadCtx = Pick<QueryCtx, 'db'>;

const FACTS_READ = 60;
/** Activity rows scanned for the tail and for "since you last looked". */
const ACTIVITY_SCAN = 100;
const ACTIVITY_SHOWN = 5;
/** Messages read for participants and files. */
const MESSAGES_READ = 30;
const INTERPRETATIONS_READ = 200;

export async function openEvidence(evidence: readonly Evidence[]): Promise<EvidenceView[]> {
	return Promise.all(
		evidence.map(async ({ quote, ...rest }) => ({
			...rest,
			...(quote !== undefined ? { quote: await openMessageBody(quote) } : {}),
		}))
	);
}

/** Open items per page of `get`. */
export const OPEN_ITEMS_PAGE = 100;
/** Items changed within the closed lookback read with the first page. */
const CLOSED_READ = 100;

export interface ItemsPage {
	items: OpenedItem[];
	page: { cursor: string | null; isDone: boolean; isClosedTruncated: boolean };
}

/**
 * One page of the thread's open items, plus (first page only) the items
 * closed within the lookback, opened in `locale`. Untracked items are only
 * counted. Nothing is dropped silently: a further page has a cursor and a cut
 * closed list sets `isClosedTruncated`.
 */
export async function readItemsPage(
	ctx: QueryCtx,
	ref: ThreadRef,
	locale: AppLocale,
	cursor: string | null,
	now: number
): Promise<ItemsPage> {
	const opts = { cursor, numItems: OPEN_ITEMS_PAGE };
	const open =
		ref.kind === 'mail'
			? await ctx.db
					.query('threadItems')
					.withIndex('by_mail_thread_and_status', (q) =>
						q.eq('mailThreadId', ref.id).eq('status', 'open')
					)
					.paginate(opts)
			: await ctx.db
					.query('threadItems')
					.withIndex('by_conversation_thread_and_status', (q) =>
						q.eq('conversationThreadId', ref.id).eq('status', 'open')
					)
					.paginate(opts);
	let closed: Doc<'threadItems'>[] = [];
	let isClosedTruncated = false;
	if (cursor === null) {
		const recent = await recentlyClosedItems(
			ctx,
			ref,
			['done', 'declined', 'superseded'],
			now,
			CLOSED_READ
		);
		isClosedTruncated = recent.isCut;
		closed = recent.rows;
	}
	return {
		items: await Promise.all([...open.page, ...closed].map((row) => openItem(row, locale))),
		page: {
			cursor: open.isDone ? null : open.continueCursor,
			isDone: open.isDone,
			isClosedTruncated,
		},
	};
}

export async function openItem(row: Doc<'threadItems'>, locale: AppLocale): Promise<OpenedItem> {
	return {
		id: row._id,
		revision: row.revision,
		intent: row.intent,
		facets: row.facets,
		...(row.consequences ? { consequences: row.consequences } : {}),
		responsibility: row.responsibility,
		status: row.status,
		disposition: row.disposition,
		...(row.completion ? { completion: row.completion } : {}),
		text: await openMessageBody(row.display[locale]),
		requester: row.requester,
		responsible: row.responsible,
		...(row.beneficiary ? { beneficiary: row.beneficiary } : {}),
		...(row.assigneeUserId ? { assigneeUserId: row.assigneeUserId } : {}),
		...(row.due ? { due: row.due } : {}),
		...(row.amount ? { amount: row.amount } : {}),
		...(row.options ? { options: row.options } : {}),
		evidence: await openEvidence(row.evidence),
		verify: row.verify,
		isReviewNeeded: row.isReviewNeeded === true,
		...(row.correction ? { correction: { kind: row.correction.kind, at: row.correction.at } } : {}),
		...(row.remindAt !== undefined ? { remindAt: row.remindAt } : {}),
		...(row.replacedById ? { replacedById: row.replacedById } : {}),
		...(row.possibleDuplicateOfId ? { possibleDuplicateOfId: row.possibleDuplicateOfId } : {}),
		...(row.commitmentId ? { commitmentId: row.commitmentId } : {}),
		askedAt: row.askedAt,
		updatedAt: row.updatedAt,
	};
}

/** The current facts of a mail thread, opened in `locale`. */
export async function readFacts(
	ctx: ReadCtx,
	threadId: Id<'mailThreads'>,
	locale: AppLocale
): Promise<FactView[]> {
	const rows = await ctx.db
		.query('threadFacts')
		.withIndex('by_mail_thread_and_status', (q) =>
			q.eq('mailThreadId', threadId).eq('status', 'current')
		)
		.take(FACTS_READ);
	return Promise.all(
		rows.map(async (row) => {
			let value: FactView['value'];
			if (row.value) {
				value =
					row.value.kind === 'date' || row.value.kind === 'money'
						? row.value
						: { kind: row.value.kind, text: await openMessageBody(row.value.text) };
			}
			return {
				id: row._id,
				key: row.factKey,
				text: await openMessageBody(row.display[locale]),
				...(value ? { value } : {}),
				status: row.status,
				provenance: row.provenance,
				evidence: await openEvidence(row.evidence),
				...(row.supersedesId ? { supersedesId: row.supersedesId } : {}),
				...(row.conflictsWithId ? { conflictsWithId: row.conflictsWithId } : {}),
			};
		})
	);
}

/** The newest activity rows (newest first), bounded. */
export async function readActivityTail(ctx: ReadCtx, ref: ThreadRef) {
	return ref.kind === 'mail'
		? ctx.db
				.query('threadActivity')
				.withIndex('by_mail_thread_and_seq', (q) => q.eq('mailThreadId', ref.id))
				.order('desc')
				.take(ACTIVITY_SCAN)
		: ctx.db
				.query('threadActivity')
				.withIndex('by_conversation_thread_and_seq', (q) => q.eq('conversationThreadId', ref.id))
				.order('desc')
				.take(ACTIVITY_SCAN);
}

async function activityText(row: Doc<'threadActivity'>): Promise<string | undefined> {
	if (!row.payload) return undefined;
	try {
		const parsed: unknown = JSON.parse(await openMessageBody(row.payload));
		if (parsed && typeof parsed === 'object' && 'text' in parsed) {
			const text = (parsed as { text: unknown }).text;
			return typeof text === 'string' ? text : undefined;
		}
	} catch {
		// A payload that does not parse renders without detail.
	}
	return undefined;
}

/** The latest substance rows as the brief's "Activity" block. */
export async function toActivityViews(
	rows: readonly Doc<'threadActivity'>[]
): Promise<ActivityView[]> {
	const shown = rows.filter((r) => r.visibility === 'substance').slice(0, ACTIVITY_SHOWN);
	return Promise.all(
		shown.map(async (row) => {
			const text = await activityText(row);
			return {
				id: row._id,
				seq: row.seq,
				type: row.type,
				actor: row.actor,
				provenance: row.provenance,
				visibility: row.visibility,
				...(row.itemId ? { itemId: row.itemId } : {}),
				...(row.itemRevision !== undefined ? { itemRevision: row.itemRevision } : {}),
				...(row.delta ? { delta: row.delta } : {}),
				...(row.opRef ? { opRef: row.opRef } : {}),
				...(text !== undefined ? { text } : {}),
				eventAt: row.eventAt,
			};
		})
	);
}

/** "Since you last looked", from the activity tail past the viewer's seen seq. Pure. */
export function sinceLastSeenOf(
	rows: readonly Pick<Doc<'threadActivity'>, 'seq' | 'type' | 'itemId' | 'visibility'>[],
	seenActivitySeq: number
) {
	const newItemIds = new Set<Id<'threadItems'>>();
	const changedItemIds = new Set<Id<'threadItems'>>();
	let newActivityCount = 0;
	for (const row of rows) {
		if (row.seq <= seenActivitySeq) continue;
		if (row.visibility === 'substance') newActivityCount++;
		if (!row.itemId) continue;
		if (row.type === 'item_opened') newItemIds.add(row.itemId);
		else if (row.type.startsWith('item_') || row.type === 'proposal_confirmed') {
			changedItemIds.add(row.itemId);
		}
	}
	for (const id of newItemIds) changedItemIds.delete(id);
	return { newItemIds: [...newItemIds], changedItemIds: [...changedItemIds], newActivityCount };
}

/** The viewer's state row on a thread, or null. */
export async function readViewerState(
	ctx: ReadCtx,
	ref: ThreadRef,
	userId: string
): Promise<Doc<'threadViewerState'> | null> {
	return ref.kind === 'mail'
		? ctx.db
				.query('threadViewerState')
				.withIndex('by_user_and_mail_thread', (q) =>
					q.eq('userId', userId).eq('mailThreadId', ref.id)
				)
				.first()
		: ctx.db
				.query('threadViewerState')
				.withIndex('by_user_and_conversation_thread', (q) =>
					q.eq('userId', userId).eq('conversationThreadId', ref.id)
				)
				.first();
}

/** Participants and files of a mail thread, from its newest messages. */
export async function readMailPeopleAndFiles(
	ctx: QueryCtx,
	thread: Doc<'mailThreads'>,
	mailbox: Doc<'mailboxes'>
): Promise<{ participants: ParticipantView[]; files: FileView[] }> {
	const messages = await ctx.db
		.query('mailMessages')
		.withIndex('by_thread_and_received', (q) => q.eq('threadId', thread._id))
		.order('desc')
		.take(MESSAGES_READ);
	const own = await mailboxOwnAddresses(ctx, mailbox);
	const people = new Map<string, ParticipantView>();
	const add = (role: ParticipantView['role'], email: string, name?: string) => {
		const key = normalizeEmail(email);
		if (!key || people.has(key)) return;
		const isUs = own.has(key);
		people.set(key, { email: key, ...(name ? { name } : {}), isUs, role: isUs ? 'us' : role });
	};
	const files: FileView[] = [];
	for (const m of messages) {
		add('from', m.fromAddress, m.fromName);
		for (const to of m.toAddresses) add('to', to);
		for (const cc of m.ccAddresses) add('cc', cc);
		const isOut = m.outbound !== undefined || own.has(normalizeEmail(m.fromAddress));
		for (const att of m.attachments) {
			if (att.contentId) continue; // inline image, not a file
			files.push({
				attachmentId: `${m._id}:${att.partIndex}`,
				filename: att.filename,
				mimeType: att.contentType,
				size: att.size,
				messageId: m._id,
				direction: isOut ? 'out' : 'in',
				at: m.receivedAt,
			});
		}
	}
	return { participants: [...people.values()], files };
}

/** The thread's extraction rows (newest first), bounded. */
export async function readInterpretations(ctx: ReadCtx, ref: ThreadRef) {
	return ref.kind === 'mail'
		? ctx.db
				.query('messageInterpretations')
				.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', ref.id))
				.order('desc')
				.take(INTERPRETATIONS_READ)
		: ctx.db
				.query('messageInterpretations')
				.withIndex('by_conversation_thread', (q) => q.eq('conversationThreadId', ref.id))
				.order('desc')
				.take(INTERPRETATIONS_READ);
}

/** "Latest update" lines of the checkpoint's extraction in `locale`. */
export async function readLatest(
	row: Doc<'messageInterpretations'> | null,
	locale: AppLocale
): Promise<{ lines?: LatestLineView[]; suppressed?: 'short' | 'security' }> {
	if (!row || row.mode !== 'brief') return {};
	const result = await readResult(row);
	if (!result) return {};
	if (result.latestSuppressed) return { suppressed: result.latestSuppressed };
	const lines = result.latest?.[locale] ?? [];
	return {
		lines: lines.map((line) => ({
			text: line.text,
			evidence: line.evidence.map((e) => ({
				source: row.source,
				segmentId: e.segmentId,
				start: e.start,
				end: e.end,
				contentRevision: row.contentRevision,
				quote: e.quote,
				...(e.occurrence !== undefined ? { occurrence: e.occurrence } : {}),
				...(e.occurrenceCount !== undefined ? { occurrenceCount: e.occurrenceCount } : {}),
			})),
		})),
	};
}

/** The incomplete-banner numbers and reason. Pure over the extraction rows. */
export function gapOf(
	rows: readonly Pick<
		Doc<'messageInterpretations'>,
		'sourceKey' | 'status' | 'skipReason' | 'errorCode' | 'updatedAt'
	>[],
	opts: {
		totalMessages: number;
		isPending: boolean;
		suppressed?: 'short' | 'security';
		/** The brief's maintained source counters: the authority on counts. */
		sourceCounts?: SourceCounts;
	}
): { interpretedMessages: number; totalMessages: number; reason?: GapReason } {
	const newest = new Map<string, (typeof rows)[number]>();
	for (const row of rows) {
		const seen = newest.get(row.sourceKey);
		if (!seen || row.updatedAt > seen.updatedAt) newest.set(row.sourceKey, row);
	}
	let interpretedMessages = 0;
	let problem: (typeof rows)[number] | undefined;
	for (const row of newest.values()) {
		if (row.status === 'complete' || row.status === 'partial') interpretedMessages++;
		const isProblem =
			row.status === 'failed' ||
			row.status === 'partial' ||
			(row.status === 'skipped' && row.skipReason === 'undecryptable');
		if (isProblem && (!problem || row.updatedAt > problem.updatedAt)) problem = row;
	}
	const counts = opts.sourceCounts;
	if (counts) interpretedMessages = counts.complete + counts.partial;
	const hasUnseenProblem =
		!problem && !!counts && counts.partial + counts.failed + counts.unreadable > 0;
	const reason: GapReason | undefined = problem
		? gapReasonOf(problem)
		: hasUnseenProblem
			? 'failed'
			: opts.isPending
				? 'pending'
				: opts.suppressed;
	return {
		interpretedMessages,
		totalMessages: Math.max(opts.totalMessages, interpretedMessages),
		...(reason ? { reason } : {}),
	};
}

/** Interpretation rows read for the per-message "Latest update" lines. */
const MESSAGE_LATEST_READ = 50;

/**
 * Each interpreted Postbox message's own first "Latest update" line in
 * `locale` (the collapsed rows of Conversation show it). Newest extraction per
 * source; skipped, failed and suppressed ones have none.
 */
export async function readMessageLatest(
	rows: readonly Doc<'messageInterpretations'>[],
	locale: AppLocale
): Promise<{ messageId: string; text: string }[]> {
	const newest = new Map<string, Doc<'messageInterpretations'>>();
	for (const row of rows) {
		if (
			row.mode !== 'brief' ||
			(row.source.kind !== 'mail' && row.source.kind !== 'outboundMail')
		) {
			continue;
		}
		const seen = newest.get(row.sourceKey);
		if (!seen || row.updatedAt > seen.updatedAt) newest.set(row.sourceKey, row);
	}
	const out: { messageId: string; text: string }[] = [];
	for (const row of [...newest.values()].slice(0, MESSAGE_LATEST_READ)) {
		if (row.status !== 'complete' && row.status !== 'partial') continue;
		const result = await readResult(row);
		const text = result?.latestSuppressed ? undefined : result?.latest?.[locale][0]?.text;
		if (text) out.push({ messageId: row.source.id, text });
	}
	return out;
}

/** Flagged sources one brief read lists ("Read the exact wording"). */
export const EXACT_WORDING_PAGE = 100;

/**
 * The messages of a mail thread whose CURRENT extraction asked for the exact
 * wording to stay in view (legal notices, changed terms, payment details). The
 * reducer keeps the flag on current rows only (`exactWording.ts`), so this is
 * one indexed page, independent of how many other messages the thread has;
 * `isTruncated` says the thread has more than the page.
 */
export async function readExactWording(
	ctx: Pick<QueryCtx, 'db'>,
	mailThreadId: Id<'mailThreads'>
): Promise<{
	messages: { messageId: string; reason?: ExactWordingReason }[];
	isTruncated: boolean;
}> {
	const page = await ctx.db
		.query('messageInterpretations')
		.withIndex('by_mail_thread_exact_wording', (q) =>
			q.eq('mailThreadId', mailThreadId).eq('isExactWordingRequired', true)
		)
		.take(EXACT_WORDING_PAGE + 1);
	const messages = page
		.slice(0, EXACT_WORDING_PAGE)
		.filter((row) => row.mode === 'brief' && row.source.kind === 'mail' && row.isCurrent !== false)
		.map((row) => ({
			messageId: row.source.id,
			...(row.exactWordingReason ? { reason: row.exactWordingReason } : {}),
		}));
	return { messages, isTruncated: page.length > EXACT_WORDING_PAGE };
}
