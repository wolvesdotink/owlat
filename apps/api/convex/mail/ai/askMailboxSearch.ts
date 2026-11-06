/**
 * The mail an Ask your mailbox answer may read: a keyword search over the
 * reader's own mailboxes through the same fan-out search the search page uses
 * (`mail/mailbox/search.searchMailboxes`).
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
import { searchMailboxes } from '../mailbox/search';
import { normalizeClause } from '../mailbox/searchClause';
import { resolveBodySearchMode } from '../searchBody';
import {
	ASK_MAILBOX_EXCERPT_CHARS,
	ASK_MAILBOX_MAX_MESSAGES,
	askMailboxSearchText,
	type AskMailboxSearchResult,
	type AskMailboxSource,
} from './askMailboxText';

/**
 * Matches read per mailbox before Spam and Trash are dropped. The search index
 * can filter a folder in but not out, so a window the size of the answer
 * would fill with junk before an Inbox match is reached. The over-fetch stays
 * bounded: a fan-out reads at most ten mailboxes, and 640 rows of about 10 KB
 * (the body excerpt) is well under what one query may read.
 */
const SCAN_PER_MAILBOX = ASK_MAILBOX_MAX_MESSAGES * 8;

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

/** Spam and Trash folder ids of one mailbox. */
async function excludedFolders(
	ctx: QueryCtx,
	mailboxId: Id<'mailboxes'>
): Promise<Set<Id<'mailFolders'>>> {
	const ids = new Set<Id<'mailFolders'>>();
	for (const role of ['spam', 'trash'] as const) {
		const folder = await ctx.db
			.query('mailFolders')
			.withIndex('by_mailbox_and_role', (q) => q.eq('mailboxId', mailboxId).eq('role', role))
			.first();
		if (folder) ids.add(folder._id);
	}
	return ids;
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
	const mailboxes = await askableMailboxes(ctx, reader, args.includeTeamInboxes);
	const modes = new Map<Id<'mailboxes'>, 'body' | 'snippet'>();
	for (const mailbox of mailboxes) {
		modes.set(mailbox._id, await resolveBodySearchMode(ctx, mailbox._id));
	}
	const bodySearchUsed =
		mailboxes.length > 0 && [...modes.values()].every((mode) => mode === 'body');
	const text = askMailboxSearchText(args.question);
	if (!text || mailboxes.length === 0) return { sources: [], bodySearchUsed };

	const page = await searchMailboxes(
		ctx,
		mailboxes.map((mailbox) => mailbox._id),
		[normalizeClause({ text })],
		SCAN_PER_MAILBOX,
		undefined
	);
	const excluded = new Map<Id<'mailboxes'>, Set<Id<'mailFolders'>>>();
	const sources: AskMailboxSource[] = [];
	for (const message of page.messages) {
		if (message.flagDeleted) continue;
		let skip = excluded.get(message.mailboxId);
		if (!skip) {
			skip = await excludedFolders(ctx, message.mailboxId);
			excluded.set(message.mailboxId, skip);
		}
		if (skip.has(message.folderId)) continue;
		sources.push(toSource(message, modes.get(message.mailboxId) === 'body'));
		if (sources.length === ASK_MAILBOX_MAX_MESSAGES) break;
	}
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
