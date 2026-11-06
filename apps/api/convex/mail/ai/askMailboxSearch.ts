/**
 * The mail an Ask your mailbox answer may read: a keyword search over the
 * reader's own mailboxes through the text index the search page uses
 * (`mail/searchBody.textSearchQuery`), one folder at a time.
 *
 * Which mailboxes is the whole privacy decision, so it is made here and only
 * here:
 *   - a personal mailbox only for its owner. `loadAccessibleMailboxes` also
 *     returns mailboxes reached through a membership row, and a personal
 *     mailbox's only legitimate row is its owner's, so any other is ignored;
 *   - a team inbox only for its members (the membership rows), and only when
 *     the caller allows team inbox mail at all;
 *   - mailboxes of the reader's active organization only;
 *   - active mailboxes only, and never Spam or Trash, whose text is the most
 *     likely to be written by an attacker.
 *
 * Which text is the other one: a mailbox with deep body search
 * (`mail/searchBody.resolveBodySearchMode`) contributes its stored excerpt,
 * any other only the snippet. An excerpt still on a row while body search is
 * off is never read.
 */

import { v } from 'convex/values';
import { internalQuery, type QueryCtx } from '../../_generated/server';
import type { Doc, Id } from '../../_generated/dataModel';
import { scrubForInjection } from '../../assistant/prompt';
import { loadAccessibleMailboxes } from '../permissions';
import { readSession } from '../mailbox/shared';
import { resolveBodySearchMode, textSearchQuery } from '../searchBody';
import {
	ASK_MAILBOX_EXCERPT_CHARS,
	ASK_MAILBOX_MAX_MESSAGES,
	askMailboxSearchText,
	type AskMailboxSearchResult,
	type AskMailboxSource,
} from './askMailboxText';

/**
 * The search index can filter a folder in but not out, so each eligible folder
 * is searched on its own: Spam and Trash matches never take a slot that an
 * Inbox or custom-folder match needs.
 *
 * Reads stay bounded: at most `MAX_MAILBOXES` mailboxes, at most
 * `MAX_FOLDER_SEARCHES` folder searches across them, and
 * `ASK_MAILBOX_MAX_MESSAGES` matches from each, so at most 64 × 8 = 512 rows of
 * about 10 KB (the body excerpt), well under what one query may read. A
 * folder never contributes more than the answer cites, so the per-folder take
 * loses nothing the final cap would keep.
 */
const MAX_MAILBOXES = 10;
const MAX_FOLDER_SEARCHES = 64;

interface Reader {
	userId: string;
	organizationId: string;
}

/** The mailboxes `reader` may ask about, under the rules in the module comment. */
async function askableMailboxes(
	ctx: QueryCtx,
	reader: Reader,
	includeTeamInboxes: boolean
): Promise<Doc<'mailboxes'>[]> {
	const reachable = await loadAccessibleMailboxes(ctx, reader.userId, reader.organizationId);
	return reachable.filter((mailbox) => {
		if (mailbox.status !== 'active') return false;
		// `loadAccessibleMailboxes` checks the organization only for membership
		// rows; a mailbox the user owns in another organization is not this turn's.
		if (mailbox.organizationId !== reader.organizationId) return false;
		if (mailbox.scope === 'shared') return includeTeamInboxes;
		return mailbox.userId === reader.userId;
	});
}

/** Search order: every Inbox first, then the other system folders, then custom ones. */
function folderTier(folder: Doc<'mailFolders'>): number {
	if (folder.role === 'inbox') return 0;
	return folder.role ? 1 : 2;
}

/**
 * The folders of `mailboxes` an answer may read, everything but Spam and Trash,
 * custom folders included, in search order and cut to `MAX_FOLDER_SEARCHES`.
 */
async function askableFolders(
	ctx: QueryCtx,
	mailboxes: readonly Doc<'mailboxes'>[]
): Promise<Doc<'mailFolders'>[]> {
	const folders: Doc<'mailFolders'>[] = [];
	for (const mailbox of mailboxes) {
		const own = await ctx.db
			.query('mailFolders')
			.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailbox._id))
			.collect(); // bounded: one mailbox's folders
		folders.push(...own.filter((folder) => folder.role !== 'spam' && folder.role !== 'trash'));
	}
	// A stable sort keeps the mailbox order inside a tier, so a mailbox with many
	// custom folders cannot push another mailbox's Inbox out of the cut.
	return folders
		.sort((left, right) => folderTier(left) - folderTier(right))
		.slice(0, MAX_FOLDER_SEARCHES);
}

function newestFirst(left: Doc<'mailMessages'>, right: Doc<'mailMessages'>): number {
	if (left.receivedAt !== right.receivedAt) return right.receivedAt - left.receivedAt;
	return left._id < right._id ? 1 : left._id > right._id ? -1 : 0;
}

function toSource(message: Doc<'mailMessages'>, isBodyMode: boolean): AskMailboxSource {
	const body = isBodyMode ? message.searchBody?.slice(0, ASK_MAILBOX_EXCERPT_CHARS) : undefined;
	return {
		messageId: message._id,
		mailboxId: message.mailboxId,
		folderId: message.folderId,
		threadId: message.threadId,
		subject: scrubForInjection(message.subject ?? ''),
		...(message.fromName ? { fromName: scrubForInjection(message.fromName) } : {}),
		fromAddress: message.fromAddress,
		receivedAt: message.receivedAt,
		excerpt: scrubForInjection(body || message.snippet),
		isBodyExcerpt: Boolean(body),
	};
}

/** Search `reader`'s askable mailboxes for `question`, newest match first. */
export async function searchMailForAsk(
	ctx: QueryCtx,
	reader: Reader,
	args: { question: string; includeTeamInboxes: boolean }
): Promise<AskMailboxSearchResult> {
	const mailboxes = (await askableMailboxes(ctx, reader, args.includeTeamInboxes)).slice(
		0,
		MAX_MAILBOXES
	);
	const modes = new Map<Id<'mailboxes'>, 'body' | 'snippet'>();
	for (const mailbox of mailboxes) {
		modes.set(mailbox._id, await resolveBodySearchMode(ctx, mailbox._id));
	}
	const bodySearchUsed =
		mailboxes.length > 0 && [...modes.values()].every((mode) => mode === 'body');
	const text = askMailboxSearchText(args.question);
	if (!text || mailboxes.length === 0) return { sources: [], bodySearchUsed };

	const matches: Doc<'mailMessages'>[] = [];
	for (const folder of await askableFolders(ctx, mailboxes)) {
		const hits = await textSearchQuery(ctx, modes.get(folder.mailboxId) ?? 'snippet', {
			mailboxId: folder.mailboxId,
			folderId: folder._id,
			text,
		}).take(ASK_MAILBOX_MAX_MESSAGES);
		matches.push(...hits.filter((message) => !message.flagDeleted));
	}
	const sources = matches
		.sort(newestFirst)
		.slice(0, ASK_MAILBOX_MAX_MESSAGES)
		.map((message) => toSource(message, modes.get(message.mailboxId) === 'body'));
	return { sources, bodySearchUsed };
}

const searchArgs = { question: v.string() };

/** The caller's own session decides the reader; team inboxes they belong to are included. */
export const searchAsCaller = internalQuery({
	args: searchArgs,
	handler: async (ctx, args): Promise<AskMailboxSearchResult> => {
		const session = await readSession(ctx);
		if (!session) return { sources: [], bodySearchUsed: false };
		return searchMailForAsk(
			ctx,
			{ userId: session.userId, organizationId: session.activeOrganizationId },
			{ question: args.question, includeTeamInboxes: true }
		);
	},
});

/**
 * For a caller with no session (the assistant's scheduled turn): the reader is
 * the turn's user, passed by the runner, never by the model.
 */
export const searchForReader = internalQuery({
	args: {
		...searchArgs,
		userId: v.string(),
		organizationId: v.string(),
		includeTeamInboxes: v.boolean(),
	},
	handler: async (ctx, args): Promise<AskMailboxSearchResult> =>
		searchMailForAsk(
			ctx,
			{ userId: args.userId, organizationId: args.organizationId },
			{ question: args.question, includeTeamInboxes: args.includeTeamInboxes }
		),
});
