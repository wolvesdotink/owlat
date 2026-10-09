/**
 * "With this contact elsewhere" (ADR-0072, plan §4.3): the open items the
 * people of this thread have with you in OTHER threads, so "Jonas still owes
 * you the signed NDA" shows up next to the thread about something else.
 *
 * The key is `threadItems.counterpartyKey`, the other side's normalized
 * address the reducer writes on every item (`parties.ts counterpartyKeyOf`).
 * Matching is exact on that address: an alias or a second address of the
 * same person is not joined, which can only hide an item, never show one
 * about someone else.
 *
 * Every item shown passes the reader rule of ITS OWN thread, checked here
 * for each source: mailbox access for a Postbox thread (the same
 * `loadReadableMailbox` as `brief.get`), the shared-inbox reader role for a
 * Team Inbox thread. An item the viewer could not open is never counted or
 * hinted at. Unconfirmed proposals ("Check this") are left out: they are not
 * tracked anywhere yet.
 */

import { v, type Infer } from 'convex/values';
import type { Doc, Id } from '../../_generated/dataModel';
import type { QueryCtx } from '../../_generated/server';
import { publicQuery } from '../../lib/authedFunctions';
import { getBetterAuthSessionWithRole } from '../../lib/sessionOrganization';
import { isFeatureEnabled } from '../../lib/featureFlags';
import { isSharedInboxReader } from '../../inbox/access';
import { loadReadableMailbox } from '../permissions';
import { openMessageBody } from '../../lib/messageBody';
import { appLocaleOf, type AppLocale } from '@owlat/shared/appLocales';
import { threadRefValidator, type ThreadRef } from '../../lib/validators/threadRef';
import { itemResponsibilityValidator } from '../../lib/validators/threadBrief';
import { decodeHistoryCursor, encodeHistoryCursor, isPastCursor } from './backfillSources';

/** People of this thread looked up (the most frequent counterparties first). */
export const ELSEWHERE_PEOPLE = 2;
/** Items shown per person. */
export const ELSEWHERE_ITEMS = 5;
/** This thread's items read to find its counterparties. */
const OWN_ITEM_SCAN = 60;
/** Open items read per person before the scan stops and hands back a cursor. */
export const PERSON_SCAN = 200;

const elsewhereItemValidator = v.object({
	itemId: v.id('threadItems'),
	threadRef: threadRefValidator,
	// Where a Postbox thread opens (the reader routes by message).
	messageId: v.optional(v.id('mailMessages')),
	mailboxId: v.optional(v.id('mailboxes')),
	subject: v.string(),
	text: v.string(),
	responsibility: itemResponsibilityValidator,
	dueAt: v.optional(v.number()),
});

const elsewhereGroupValidator = v.object({
	counterpartyKey: v.string(),
	name: v.optional(v.string()),
	items: v.array(elsewhereItemValidator),
	// More readable open items exist than are listed.
	isMore: v.boolean(),
	// The scan stopped before it reached every open item with this person (the
	// rest belongs to threads it could not show, or was not read yet): pass it
	// back as `more` to read on from there.
	continueCursor: v.optional(v.string()),
});

export type ElsewhereGroup = Infer<typeof elsewhereGroupValidator>;

type Session = NonNullable<Awaited<ReturnType<typeof getBetterAuthSessionWithRole>>>;

/** The thread's counterparties, most frequent first (open items count double). Pure. */
export function counterpartiesOf(
	items: readonly Pick<Doc<'threadItems'>, 'counterpartyKey' | 'status'>[]
): string[] {
	const weight = new Map<string, number>();
	for (const item of items) {
		if (!item.counterpartyKey) continue;
		const add = item.status === 'open' ? 2 : 1;
		weight.set(item.counterpartyKey, (weight.get(item.counterpartyKey) ?? 0) + add);
	}
	return [...weight.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([key]) => key);
}

/** The name the thread's items give a counterparty, if any. Pure. */
export function nameOf(
	key: string,
	items: readonly Pick<Doc<'threadItems'>, 'requester' | 'responsible'>[]
): string | undefined {
	for (const item of items) {
		for (const party of [item.requester, item.responsible]) {
			if (!party.isUs && party.name && party.email?.trim().toLowerCase() === key) {
				return party.name;
			}
		}
	}
	return undefined;
}

function ownItems(ctx: QueryCtx, ref: ThreadRef) {
	return ref.kind === 'mail'
		? ctx.db
				.query('threadItems')
				.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', ref.id))
				.take(OWN_ITEM_SCAN)
		: ctx.db
				.query('threadItems')
				.withIndex('by_conversation_thread', (q) => q.eq('conversationThreadId', ref.id))
				.take(OWN_ITEM_SCAN);
}

/** The thread an item lives in, as the card links to it. */
interface ItemSource {
	ref: ThreadRef;
	subject: string;
	messageId?: Id<'mailMessages'>;
	mailboxId?: Id<'mailboxes'>;
}

/**
 * Per-request reader rule over the threads items come from, memoized: a
 * mailbox is checked once, the Team Inbox once.
 */
function readerOf(ctx: QueryCtx, session: Session) {
	const mailboxes = new Map<string, boolean>();
	let team: boolean | undefined;
	return async (item: Doc<'threadItems'>): Promise<ItemSource | null> => {
		if (item.mailThreadId) {
			const thread = await ctx.db.get(item.mailThreadId);
			if (!thread) return null;
			let isReadable = mailboxes.get(thread.mailboxId);
			if (isReadable === undefined) {
				isReadable = (await loadReadableMailbox(ctx, thread.mailboxId)) !== null;
				mailboxes.set(thread.mailboxId, isReadable);
			}
			if (!isReadable) return null;
			return {
				ref: { kind: 'mail', id: thread._id },
				subject: thread.latestSubject,
				mailboxId: thread.mailboxId,
				...(thread.latestMessageId ? { messageId: thread.latestMessageId } : {}),
			};
		}
		if (item.conversationThreadId) {
			team ??= isSharedInboxReader(session) && (await isFeatureEnabled(ctx, 'inbox'));
			if (!team) return null;
			const thread = await ctx.db.get(item.conversationThreadId);
			return thread ? { ref: { kind: 'team', id: thread._id }, subject: thread.subject } : null;
		}
		return null;
	};
}

/** May the session read THIS thread (the brief's reader rule)? */
async function canReadThread(ctx: QueryCtx, ref: ThreadRef, session: Session): Promise<boolean> {
	if (ref.kind === 'mail') {
		const thread = await ctx.db.get(ref.id);
		return thread ? (await loadReadableMailbox(ctx, thread.mailboxId)) !== null : false;
	}
	// The same gate as requireThreadReader: the reader role AND the Team Inbox on.
	if (!isSharedInboxReader(session) || !(await isFeatureEnabled(ctx, 'inbox'))) return false;
	return (await ctx.db.get(ref.id)) !== null;
}

async function groupFor(
	ctx: QueryCtx,
	key: string,
	here: ThreadRef,
	locale: AppLocale,
	read: ReturnType<typeof readerOf>,
	startCursor: string | null
): Promise<{ items: ElsewhereGroup['items']; isMore: boolean; continueCursor?: string }> {
	const items: ElsewhereGroup['items'] = [];
	const from = decodeHistoryCursor(startCursor);
	let scanned = 0;
	let lastCursor: string | undefined;
	// Rows are read until enough readable items are found, the index ends, or
	// the scan budget is spent; the last case hands back where it stopped.
	for await (const item of ctx.db
		.query('threadItems')
		.withIndex('by_counterparty', (q) => {
			const open = q.eq('counterpartyKey', key).eq('status', 'open');
			return from ? open.lte('updatedAt', from.at) : open;
		})
		.order('desc')) {
		if (!isPastCursor({ at: item.updatedAt, creation: item._creationTime }, from)) continue;
		if (scanned >= PERSON_SCAN) {
			return { items, isMore: false, ...(lastCursor ? { continueCursor: lastCursor } : {}) };
		}
		scanned++;
		lastCursor = encodeHistoryCursor(item.updatedAt, item._creationTime);
		if (item.verify === 'proposal') continue;
		if (item.mailThreadId === here.id || item.conversationThreadId === here.id) continue;
		const source = await read(item);
		if (!source) continue;
		if (items.length >= ELSEWHERE_ITEMS) return { items, isMore: true };
		items.push({
			itemId: item._id,
			threadRef: source.ref,
			...(source.messageId ? { messageId: source.messageId } : {}),
			...(source.mailboxId ? { mailboxId: source.mailboxId } : {}),
			subject: source.subject,
			text: await openMessageBody(item.display[locale]),
			responsibility: item.responsibility,
			...(item.due?.at !== undefined ? { dueAt: item.due.at } : {}),
		});
	}
	return { items, isMore: false };
}

// public: soft-auth — returns null for anonymous callers and for anyone this
// thread's reader rule refuses; every listed item passes its own thread's rule.
// authz: canReadThread (loadReadableMailbox / isSharedInboxReader) for this
// thread, readerOf (the same two, plus the `inbox` flag) for every item.
export const list = publicQuery({
	args: {
		threadRef: threadRefValidator,
		locale: v.string(),
		// Read on for one person from a group's `continueCursor`.
		more: v.optional(v.object({ counterpartyKey: v.string(), cursor: v.string() })),
	},
	returns: v.union(v.object({ groups: v.array(elsewhereGroupValidator) }), v.null()),
	handler: async (ctx, args) => {
		const session = await getBetterAuthSessionWithRole(ctx);
		if (!session) return null;
		if (!(await canReadThread(ctx, args.threadRef, session))) return null;
		const own = await ownItems(ctx, args.threadRef);
		const keys = args.more
			? [args.more.counterpartyKey]
			: counterpartiesOf(own).slice(0, ELSEWHERE_PEOPLE);
		const read = readerOf(ctx, session);
		const locale = appLocaleOf(args.locale);
		const groups: ElsewhereGroup[] = [];
		for (const key of keys) {
			const found = await groupFor(
				ctx,
				key,
				args.threadRef,
				locale,
				read,
				args.more?.cursor ?? null
			);
			if (found.items.length === 0 && !found.continueCursor) continue;
			const name = nameOf(key, own);
			groups.push({ counterpartyKey: key, ...(name ? { name } : {}), ...found });
		}
		return { groups };
	},
});
