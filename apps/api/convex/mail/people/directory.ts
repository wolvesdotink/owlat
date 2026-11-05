/**
 * The People view's reads: the directory of a mailbox's recent conversations
 * grouped by who they are with (`assemble.ts`), and a person's or company
 * account's older conversations beyond that window.
 *
 * Threads are not indexed by participant, so the directory folds the newest
 * {@link DIRECTORY_SCAN} threads, the same bounded posture as the
 * conversation list (`mailbox/queries.ts listThreads`). `earlierTopics` then
 * reaches back through the sender index for one address.
 */

import { v } from 'convex/values';
import type { QueryCtx } from '../../_generated/server';
import type { Doc, Id } from '../../_generated/dataModel';
import { postboxQuery } from '../_helpers';
import { requireMailboxAccess } from '../permissions';
import { mailboxOwnAddresses } from '../ownAddresses';
import { isThreadLatestSnoozed } from '../threadLatestSnooze';
import { isThreadMuted } from '../../lib/mailMute';
import { openMessageBody } from '../../lib/messageBody';
import { openBriefTop, modeOfMailbox } from '../interpret/briefTop';
import { isFencedThread } from '../interpret/staleFence';
import { visibleThreadDraftSlot } from '../needsReplySlot';
import { withSenderLogos } from '../senderLogos/cache';
import { loadSenderProfile, senderKeyOf } from '../senders/profiles';
import { mailboxScope } from '../mailbox/shared';
import { assembleDirectory, type AddressInput, type ThreadInput } from './assemble';
import { isTitleShown } from './topicTitle';
import { counterpartsOf, isArchivedThread, isOutOfView } from './classify';

/** How many of the newest threads the directory folds. */
export const DIRECTORY_SCAN = 300;
/** Addresses whose name and evidence are looked up; later ones read from the address. */
const ADDRESS_LOOKUPS = 150;
/** Sender-index rows one `earlierTopics` page reads for one address. */
const EARLIER_PAGE = 100;
/**
 * Outstanding threads read past the window, per kind (in the Answer queue, a
 * follow-up armed or overdue), so nothing either side owes drops out of view.
 */
const OWED_SCAN = 200;

/** One thread as the directory folds it; brief texts are opened only when asked. */
async function threadInput(
	thread: Doc<'mailThreads'>,
	mode: ReturnType<typeof modeOfMailbox>,
	isOpeningBrief: boolean,
	isShared: boolean
): Promise<ThreadInput> {
	const fenced = isFencedThread(thread);
	const stored = fenced ? undefined : thread.briefTop;
	const input: ThreadInput = {
		id: thread._id,
		participants: thread.participants,
		latestFromAddress: thread.latestFromAddress,
		latestSubject: thread.latestSubject,
		latestSnippet: thread.latestSnippet,
		...(thread.latestMessageId ? { latestMessageId: thread.latestMessageId } : {}),
		lastMessageAt: thread.lastMessageAt,
		firstMessageAt: thread.firstMessageAt,
		messageCount: thread.messageCount,
		unreadCount: thread.unreadCount,
		hasAttachments: thread.hasAttachments,
		hasFlagged: thread.hasFlagged,
		...(thread.category ? { category: thread.category.label } : {}),
		isPinned: thread.pinnedAt !== undefined,
		isMuted: isThreadMuted(thread),
		isArchived: isArchivedThread(thread.folderRoles),
		isOwedByUs: thread.needsReply !== undefined,
		isAskDetected: thread.needsReply?.source === 'llm',
		isDismissed:
			thread.needsReplyClearedAt !== undefined &&
			thread.needsReplyClearedAt >= thread.lastMessageAt,
		// A follow-up watch, armed or overdue, is a reply still expected.
		isOwedToUs: (stored?.waiting ?? 0) > 0 || thread.followUp !== undefined,
		...(visibleThreadDraftSlot(thread) ? { hasSuggestedReply: true } : {}),
	};
	// The model's summary of the ask is the Answer queue's: never on a team
	// surface, nor from a fenced thread.
	const askSummary = thread.needsReply?.askSummary;
	if (askSummary && !isShared && !fenced) input.askSummary = askSummary;
	if (thread.topicTitle && isTitleShown(thread)) {
		input.title = {
			text: await openMessageBody(thread.topicTitle.text),
			source: thread.topicTitle.source,
		};
	}
	if (isOpeningBrief) {
		const brief = await openBriefTop(thread, mode);
		if (brief?.top) {
			input.openItem = {
				text: brief.top.text,
				...(brief.top.dueAt !== undefined ? { dueAt: brief.top.dueAt } : {}),
				isOurs: brief.top.bucket !== 'waitingOnOthers',
			};
		}
		if (brief?.latest) input.latestLine = brief.latest;
	}
	return input;
}

/** Name, organisation, evidence and (for a system sender) the logo of one address. */
async function addressInput(
	ctx: QueryCtx,
	mailbox: Doc<'mailboxes'>,
	email: string
): Promise<{ info: AddressInput; latest: Doc<'mailMessages'> | null }> {
	const [contact, override, latest] = await Promise.all([
		ctx.db
			.query('mailContacts')
			.withIndex('by_mailbox_and_email', (q) => q.eq('mailboxId', mailbox._id).eq('email', email))
			.first(),
		ctx.db
			.query('mailSenderCategoryOverrides')
			.withIndex('by_mailbox_and_sender', (q) =>
				q.eq('mailboxId', mailbox._id).eq('senderEmail', email)
			)
			.first(),
		ctx.db
			.query('mailMessages')
			.withIndex('by_mailbox_and_from', (q) =>
				q.eq('mailboxId', mailbox._id).eq('fromAddress', email)
			)
			.order('desc')
			.first(),
	]);
	const profile =
		mailboxScope(mailbox) === 'personal'
			? await loadSenderProfile(ctx, mailbox._id, senderKeyOf(email).senderDigest)
			: null;
	const name =
		contact?.displayName?.trim() || latest?.fromName?.trim() || profile?.displayName?.trim();
	const organization = contact?.organization?.trim();
	return {
		info: {
			...(name ? { name } : {}),
			...(organization ? { organization } : {}),
			...(override ? { override: override.label } : {}),
			isKnownCorrespondent: (contact?.useCount ?? 0) > 0,
			isVip: contact?.isVip === true,
		},
		latest,
	};
}

/**
 * The newest threads plus every outstanding one, however old: in the Answer
 * queue (owed by us) or with a follow-up armed or overdue (owed to us). The
 * window keeps the read bounded; the outstanding reads, bounded the same way,
 * keep a conversation that still waits on either side from dropping out of it.
 */
async function windowWithOwed(
	ctx: QueryCtx,
	mailboxId: Id<'mailboxes'>,
	scan: number
): Promise<{ threads: Doc<'mailThreads'>[]; isOutstandingCapped: boolean }> {
	const [recent, owed, armed, due] = await Promise.all([
		ctx.db
			.query('mailThreads')
			.withIndex('by_mailbox_and_last_message', (q) => q.eq('mailboxId', mailboxId))
			.order('desc')
			.take(scan),
		ctx.db
			.query('mailThreads')
			.withIndex('by_mailbox_needs_reply', (q) =>
				q.eq('mailboxId', mailboxId).gt('needsReply.detectedAt', 0)
			)
			.order('desc')
			.take(OWED_SCAN),
		ctx.db
			.query('mailThreads')
			.withIndex('by_mailbox_follow_up_remind', (q) =>
				q.eq('mailboxId', mailboxId).gt('followUpRemindAt', 0)
			)
			.take(OWED_SCAN),
		ctx.db
			.query('mailThreads')
			.withIndex('by_mailbox_follow_up_due', (q) =>
				q.eq('mailboxId', mailboxId).gt('followUp.dueAt', 0)
			)
			.order('desc')
			.take(OWED_SCAN),
	]);
	const byId = new Map(recent.map((t) => [t._id, t] as const));
	for (const t of [...owed, ...armed, ...due]) if (!byId.has(t._id)) byId.set(t._id, t);
	return {
		threads: [...byId.values()],
		// A full read may have left some out: the view says so instead of a total.
		isOutstandingCapped: [owed, armed, due].some((list) => list.length >= OWED_SCAN),
	};
}

/** Unresolved: owed by us, or with open items either way. Its brief texts are shown. */
function isUnresolved(thread: Doc<'mailThreads'>): boolean {
	const top = isFencedThread(thread) ? undefined : thread.briefTop;
	return thread.needsReply !== undefined || (top?.forYou ?? 0) > 0 || (top?.waiting ?? 0) > 0;
}

/** The threads a person's view may show: in view, not snoozed. */
async function visibleThreads(
	ctx: QueryCtx,
	threads: readonly Doc<'mailThreads'>[],
	now: number
): Promise<Doc<'mailThreads'>[]> {
	const out: Doc<'mailThreads'>[] = [];
	for (const thread of threads) {
		if (isOutOfView(thread.folderRoles)) continue;
		if (await isThreadLatestSnoozed(ctx, thread, now)) continue;
		out.push(thread);
	}
	return out;
}

/**
 * The directory: people, company accounts, companies and the topics they
 * share, from the mailbox's newest threads. Null when the mailbox is not the
 * caller's to read.
 */
export const directory = postboxQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args, session) => {
		const access = await requireMailboxAccess(ctx, args.mailboxId, 'member', session);
		if (!access.ok) return null;
		const mailbox = access.mailbox;
		const now = Date.now();
		const mode = modeOfMailbox(mailbox);
		const isShared = mailboxScope(mailbox) === 'shared';
		const own = await mailboxOwnAddresses(ctx, mailbox);

		const { threads: recent, isOutstandingCapped } = await windowWithOwed(
			ctx,
			mailbox._id,
			DIRECTORY_SCAN
		);
		const threads = await visibleThreads(ctx, recent, now);

		// Brief texts for what the cards show: recent threads and every unresolved one.
		const inputs = await Promise.all(
			threads.map((thread) =>
				threadInput(
					thread,
					mode,
					isUnresolved(thread) || now - thread.lastMessageAt < 30 * 24 * 60 * 60 * 1000,
					isShared
				)
			)
		);

		// Addresses in recency order, so the lookups go to the rows on screen first.
		const order: string[] = [];
		const seen = new Set<string>();
		for (const thread of threads) {
			for (const key of counterpartsOf(thread.participants, own)) {
				if (!seen.has(key)) {
					seen.add(key);
					order.push(key);
				}
			}
		}
		const looked = await Promise.all(
			order.slice(0, ADDRESS_LOOKUPS).map((email) => addressInput(ctx, mailbox, email))
		);
		const addresses = new Map<string, AddressInput>();
		for (const [i, { info }] of looked.entries()) addresses.set(order[i]!, info);

		// A logo only rides on a message that proved its sender (`senderLogos/eligibility.ts`).
		const withLogos = await withSenderLogos(
			ctx,
			looked.flatMap(({ latest }) => (latest ? [latest] : []))
		);
		for (const message of withLogos) {
			if (!message.senderLogoUrl) continue;
			const info = addresses.get(message.fromAddress.toLowerCase());
			if (info) info.logoUrl = message.senderLogoUrl;
		}

		return {
			scope: isShared ? ('shared' as const) : ('personal' as const),
			mailboxAddress: mailbox.address,
			isWindowFull: recent.length >= DIRECTORY_SCAN,
			isOutstandingCapped,
			...assembleDirectory({ threads: inputs, ownAddresses: own, addresses }),
		};
	},
});

/**
 * One address's conversations, a page at a time back through the sender index:
 * what the directory's window no longer holds. Each call reads one page of the
 * address's messages and returns the conversations they belong to (the client
 * drops the ones it already shows); `isDone` says the address has no older
 * mail, which is the only time the page may say so.
 */
export const earlierTopics = postboxQuery({
	args: {
		mailboxId: v.id('mailboxes'),
		email: v.string(),
		cursor: v.union(v.string(), v.null()),
	},
	handler: async (ctx, args, session) => {
		const empty = { topics: [], continueCursor: null as string | null, isDone: true };
		const access = await requireMailboxAccess(ctx, args.mailboxId, 'member', session);
		if (!access.ok) return empty;
		const mailbox = access.mailbox;
		const email = args.email.trim().toLowerCase();
		const page = await ctx.db
			.query('mailMessages')
			.withIndex('by_mailbox_and_from', (q) =>
				q.eq('mailboxId', mailbox._id).eq('fromAddress', email)
			)
			.order('desc')
			.paginate({ numItems: EARLIER_PAGE, cursor: args.cursor });
		const ids = [...new Set(page.page.map((m) => m.threadId))];
		const loaded = await Promise.all(ids.map((id) => ctx.db.get(id)));
		const now = Date.now();
		const threads = await visibleThreads(
			ctx,
			loaded.filter((t): t is Doc<'mailThreads'> => t !== null && t.mailboxId === mailbox._id),
			now
		);
		const own = await mailboxOwnAddresses(ctx, mailbox);
		const mode = modeOfMailbox(mailbox);
		const isShared = mailboxScope(mailbox) === 'shared';
		const inputs = await Promise.all(threads.map((t) => threadInput(t, mode, false, isShared)));
		const { topics } = assembleDirectory({
			threads: inputs,
			ownAddresses: own,
			addresses: new Map(),
		});
		return {
			topics: topics.sort((a, b) => b.lastMessageAt - a.lastMessageAt),
			continueCursor: page.isDone ? null : page.continueCursor,
			isDone: page.isDone,
		};
	},
});
