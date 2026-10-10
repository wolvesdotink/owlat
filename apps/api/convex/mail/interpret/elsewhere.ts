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
 * The scan never touches a row the viewer could not open. It reads, per
 * person, one index range per scope the viewer has: each mailbox they own or
 * are a member of (`loadAccessibleMailboxes`, the same set the mailbox
 * switcher lists, so an admin's view of a teammate's private mailbox is not
 * part of it), and the Team Inbox for a shared-inbox reader with the inbox
 * on. So nothing about other people's mail reaches the answer, not even a
 * count or a position. Unconfirmed proposals ("Check this") and this thread's
 * own items are left out. `limit` (at most {@link ELSEWHERE_MAX_ITEMS}) is
 * what "Show more" raises; `isMore` says readable items remain beyond it.
 */

import { v, type Infer } from 'convex/values';
import type { Doc, Id } from '../../_generated/dataModel';
import type { QueryCtx } from '../../_generated/server';
import { publicQuery } from '../../lib/authedFunctions';
import {
	getBetterAuthSessionWithRole,
	getSingletonOrganizationId,
} from '../../lib/sessionOrganization';
import { isFeatureEnabled } from '../../lib/featureFlags';
import { isSharedInboxReader } from '../../inbox/access';
import { loadAccessibleMailboxes, loadReadableMailbox } from '../permissions';
import { openMessageBody } from '../../lib/messageBody';
import { appLocaleOf, type AppLocale } from '@owlat/shared/appLocales';
import { threadRefValidator, type ThreadRef } from '../../lib/validators/threadRef';
import { itemResponsibilityValidator } from '../../lib/validators/threadBrief';

/** People of this thread looked up (the most frequent counterparties first). */
export const ELSEWHERE_PEOPLE = 2;
/** Items shown per person, and the most "Show more" asks for. */
export const ELSEWHERE_ITEMS = 5;
export const ELSEWHERE_MAX_ITEMS = 25;
/** Rows read per person across the viewer's scopes before the answer says `isPartial`. */
export const ROWS_PER_PERSON = 200;
/** This thread's items read to find its counterparties. */
const OWN_ITEM_SCAN = 60;

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
	// The row budget ran out before every one of the viewer's own scopes was
	// read: there may be more. Says nothing about anyone else's mail.
	isPartial: v.boolean(),
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

/** One scope the viewer can read: a mailbox of theirs, or the Team Inbox. */
export type Scope = { kind: 'mailbox'; mailboxId: Id<'mailboxes'> } | { kind: 'team' };

async function scopesOf(ctx: QueryCtx, session: Session): Promise<Scope[]> {
	const orgId = session.activeOrganizationId;
	if (!orgId) return [];
	// Only the active organization's mailboxes: a user can own one elsewhere.
	const mailboxes = await loadAccessibleMailboxes(ctx, session.userId, orgId);
	const scopes: Scope[] = mailboxes
		.filter((m) => m.status === 'active' && m.organizationId === orgId)
		.map((m) => ({ kind: 'mailbox' as const, mailboxId: m._id }));
	// The Team Inbox belongs to the instance's one organization.
	if (
		isSharedInboxReader(session) &&
		(await isFeatureEnabled(ctx, 'inbox')) &&
		orgId === (await getSingletonOrganizationId(ctx))
	) {
		scopes.push({ kind: 'team' });
	}
	return scopes;
}

async function sourceOf(ctx: QueryCtx, item: Doc<'threadItems'>): Promise<ItemSource | null> {
	if (item.mailThreadId) {
		const thread = await ctx.db.get(item.mailThreadId);
		if (!thread) return null;
		return {
			ref: { kind: 'mail', id: thread._id },
			subject: thread.latestSubject,
			mailboxId: thread.mailboxId,
			...(thread.latestMessageId ? { messageId: thread.latestMessageId } : {}),
		};
	}
	if (!item.conversationThreadId) return null;
	const thread = await ctx.db.get(item.conversationThreadId);
	return thread ? { ref: { kind: 'team', id: thread._id }, subject: thread.subject } : null;
}

type Found = { item: Doc<'threadItems'>; source: ItemSource };

/**
 * The newest `want` listable items with this person in one scope. Every row
 * read belongs to the scope (index range), so skipping one tells nothing.
 */
/** Rows fetched per read inside one scope. */
const SCAN_CHUNK = 25;

/**
 * The newest `want` listable items with this person in one scope. Every row
 * read belongs to the scope (index range), so skipping one tells nothing.
 * Rows are fetched in chunks no larger than what is left of `budget`, so the
 * person's whole scan never reads more than {@link ROWS_PER_PERSON} rows;
 * `isCut` says the budget ended it before the scope did.
 */
export async function scopeItems(
	ctx: QueryCtx,
	key: string,
	scope: Scope,
	here: ThreadRef,
	want: number,
	budget: { rows: number }
): Promise<{ found: Found[]; isCut: boolean }> {
	const found: Found[] = [];
	const mailboxId = scope.kind === 'mailbox' ? scope.mailboxId : undefined;
	// The position after the last row read, as the full index order: by
	// updatedAt, then creation time (rows tied on updatedAt are walked through
	// by creation time, never re-read).
	let from: { at: number; creation: number } | null = null;
	let isTieDone = true;
	while (budget.rows > 0) {
		const n = Math.min(budget.rows, SCAN_CHUNK);
		const after: { at: number; creation: number } | null = from;
		const isTie = after !== null && !isTieDone;
		const rows: Doc<'threadItems'>[] = await ctx.db
			.query('threadItems')
			.withIndex('by_counterparty', (q) => {
				const range = q.eq('counterpartyKey', key).eq('status', 'open').eq('mailboxId', mailboxId);
				if (!after) return range;
				return isTie
					? range.eq('updatedAt', after.at).lt('_creationTime', after.creation)
					: range.lt('updatedAt', after.at);
			})
			.order('desc')
			.take(n);
		budget.rows -= rows.length;
		for (const item of rows) {
			from = { at: item.updatedAt, creation: item._creationTime };
			if (item.verify === 'proposal') continue;
			if (item.mailThreadId === here.id || item.conversationThreadId === here.id) continue;
			// The team scope holds the items without a mailbox: Team Inbox ones only.
			if (scope.kind === 'team' && !item.conversationThreadId) continue;
			const source = await sourceOf(ctx, item);
			if (!source) continue;
			found.push({ item, source });
			if (found.length >= want) return { found, isCut: false };
		}
		if (rows.length < n) {
			// This tie is walked through: go on with older rows; past those, done.
			if (isTie) {
				isTieDone = true;
				continue;
			}
			return { found, isCut: false };
		}
		// A full chunk: the next one first finishes the last row's timestamp.
		isTieDone = false;
	}
	return { found, isCut: true };
}

/** May the session read THIS thread (the brief's reader rule)? */
async function canReadThread(ctx: QueryCtx, ref: ThreadRef, session: Session): Promise<boolean> {
	if (ref.kind === 'mail') {
		const thread = await ctx.db.get(ref.id);
		return thread ? (await loadReadableMailbox(ctx, thread.mailboxId)) !== null : false;
	}
	// The same gate as requireThreadReader: the reader role AND the Team Inbox on,
	// in the organization the Team Inbox belongs to.
	if (!isSharedInboxReader(session) || !(await isFeatureEnabled(ctx, 'inbox'))) return false;
	if (session.activeOrganizationId !== (await getSingletonOrganizationId(ctx))) return false;
	return (await ctx.db.get(ref.id)) !== null;
}

async function groupFor(
	ctx: QueryCtx,
	key: string,
	here: ThreadRef,
	locale: AppLocale,
	scopes: readonly Scope[],
	limit: number
): Promise<{ items: ElsewhereGroup['items']; isMore: boolean; isPartial: boolean }> {
	const found: Found[] = [];
	// One row budget per person across the viewer's scopes (rows read, not
	// items kept): proposals, this thread's items and gone threads count too.
	const budget = { rows: ROWS_PER_PERSON };
	let isPartial = false;
	for (const scope of scopes) {
		// No scope is opened once the budget is spent: say so instead.
		if (budget.rows <= 0) {
			isPartial = true;
			break;
		}
		const read = await scopeItems(ctx, key, scope, here, limit + 1, budget);
		found.push(...read.found);
		if (read.isCut) isPartial = true;
	}
	found.sort((a, b) => b.item.updatedAt - a.item.updatedAt);
	const items: ElsewhereGroup['items'] = [];
	for (const { item, source } of found.slice(0, limit)) {
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
	return { items, isMore: found.length > limit, isPartial };
}

// public: soft-auth — returns null for anonymous callers and for anyone this
// thread's reader rule refuses; the scan reads only the viewer's own scopes.
// authz: canReadThread (loadReadableMailbox / isSharedInboxReader + inbox flag)
// for this thread; scopesOf (loadAccessibleMailboxes, the Team Inbox reader
// gate) bounds every row read for the items.
export const list = publicQuery({
	args: {
		threadRef: threadRefValidator,
		locale: v.string(),
		// "Show more": items per person, up to ELSEWHERE_MAX_ITEMS (default ELSEWHERE_ITEMS).
		limit: v.optional(v.number()),
	},
	returns: v.union(v.object({ groups: v.array(elsewhereGroupValidator) }), v.null()),
	handler: async (ctx, args) => {
		const session = await getBetterAuthSessionWithRole(ctx);
		if (!session) return null;
		if (!(await canReadThread(ctx, args.threadRef, session))) return null;
		const own = await ownItems(ctx, args.threadRef);
		const keys = counterpartiesOf(own).slice(0, ELSEWHERE_PEOPLE);
		const scopes = await scopesOf(ctx, session);
		const limit = Math.max(
			1,
			Math.min(ELSEWHERE_MAX_ITEMS, Math.floor(args.limit ?? ELSEWHERE_ITEMS))
		);
		const locale = appLocaleOf(args.locale);
		const groups: ElsewhereGroup[] = [];
		for (const key of keys) {
			const found = await groupFor(ctx, key, args.threadRef, locale, scopes, limit);
			// An empty group is shown only when the scan of the viewer's own
			// scopes was cut, so the truncation is never hidden.
			if (found.items.length === 0 && !found.isPartial) continue;
			const name = nameOf(key, own);
			groups.push({ counterpartyKey: key, ...(name ? { name } : {}), ...found });
		}
		return { groups };
	},
});
