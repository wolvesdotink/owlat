/**
 * The Team Inbox thread as one stream (SPEC §7 "Team"): the customer's emails
 * as written, the team's replies (from what actually went out, with their
 * queued or failed status), the team's internal notes and the thread's
 * activity as system lines, in one order and paged together
 * (`mail/interpret/teamStreamMerge.ts`).
 *
 * Internal notes are part of this read, so it is for the thread page and
 * Answer mode only. Nothing that builds mail, an interpretation or an agent
 * prompt may call it (`mail/interpret/__tests__/teamStream.test.ts` guards that,
 * beside `notesStayInternal.test.ts`). The sources are in `teamStreamSources.ts`.
 *
 * Access follows the rest of the shared inbox (ADR-0040): a soft-auth read
 * that answers null for anyone who is not a Team Inbox reader or when the
 * `inbox` feature is off.
 */

import { v } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { publicQuery } from '../lib/authedFunctions';
import { isFeatureEnabled } from '../lib/featureFlags';
import { getBetterAuthSessionWithRole } from '../lib/sessionOrganization';
import { openMessageBody } from '../lib/messageBody';
import { throwInvalidInput } from '../_utils/errors';
import type { TeamThreadRef } from '../lib/validators/threadRef';
import { isSharedInboxReader } from './access';
import {
	teamStreamPageValidator,
	type TeamStreamEntry,
	type TeamStreamPage,
} from '../mail/interpret/briefShape';
import { decodeStreamCursor, mergeStreamPage } from '../mail/interpret/teamStreamMerge';
import { loadBriefRow } from '../mail/interpret/briefRow';
import {
	itemTextReader,
	readActivityBatch,
	readSeenPosition,
	STREAM_PAGE_SIZE,
	streamLocale,
} from '../mail/interpret/teamStreamRead';
import {
	readEmailBatch,
	readFollowUpBatch,
	readNoteBatch,
	readReplyBatch,
	type StreamContext,
} from './teamStreamSources';

/** The contact's display name, for "Ana Costa" instead of the bare address. */
async function contactNameOf(ctx: QueryCtx, thread: Doc<'conversationThreads'>) {
	const contact = thread.contactId ? await ctx.db.get(thread.contactId) : null;
	const name = `${contact?.firstName ?? ''} ${contact?.lastName ?? ''}`.trim();
	return name || undefined;
}

/**
 * One page of a Team Inbox thread's stream, newest page first (`cursor` from
 * the previous page walks back). Every source pages from the cursor along its
 * own index; nothing is capped. Null for a caller who may not read the Team
 * Inbox, a disabled feature or a missing thread.
 */
// public: soft-auth — admin-only shared inbox; returns null for non-admins
export const page = publicQuery({
	args: {
		threadId: v.id('conversationThreads'),
		locale: v.string(),
		cursor: v.optional(v.union(v.string(), v.null())),
	},
	returns: v.union(teamStreamPageValidator, v.null()),
	handler: async (ctx, args): Promise<TeamStreamPage | null> => {
		const session = await getBetterAuthSessionWithRole(ctx);
		if (!isSharedInboxReader(session) || !(await isFeatureEnabled(ctx, 'inbox'))) return null;
		const thread = await ctx.db.get(args.threadId);
		if (!thread) return null;
		const ref: TeamThreadRef = { kind: 'team', id: thread._id };
		const before = decodeStreamCursor(args.cursor);
		const itemText = itemTextReader(ctx, ref, streamLocale(args.locale));
		const s: StreamContext = { ctx, ref, before, contactName: await contactNameOf(ctx, thread) };
		const batches = await Promise.all([
			readEmailBatch(s),
			readReplyBatch(s),
			readFollowUpBatch(s),
			readNoteBatch(s, session.userId, itemText),
			readActivityBatch(ctx, ref, before, itemText),
		]);
		const merged = mergeStreamPage<TeamStreamEntry>(batches, STREAM_PAGE_SIZE);
		const seenPosition = await readSeenPosition(ctx, ref, session.userId);
		return { ...merged, ...(seenPosition ? { seenPosition } : {}) };
	},
});

/** Most threads one call names (a Workbench tab shows three). */
const MAX_TOP_ITEM_THREADS = 10;

/** The first row of a team thread's list, in compareForYou's order (`sortKey`). */
function firstOfBucket(
	ctx: QueryCtx,
	threadId: Id<'conversationThreads'>,
	bucket: 'forUs' | 'unclear'
) {
	return ctx.db
		.query('threadItems')
		.withIndex('by_conversation_thread_bucket_sort', (q) =>
			q.eq('conversationThreadId', threadId).eq('listBucket', bucket).gte('sortKey', '')
		)
		.first();
}

/**
 * The top open action of each of the given Team Inbox threads, for the
 * Workbench's team rows (SPEC §7: "team rows show the top item, sender and
 * raw preview"): the first of the team's own or nobody's list (not the
 * customer's, not an unconfirmed proposal) by due date, risk and age, read
 * from the bucket index in two reads. `count` is how many such actions the
 * thread holds (the maintained counters). Threads with none are left out.
 * Soft-auth: `[]` for anyone who cannot read the Team Inbox.
 */
// public: soft-auth — admin-only shared inbox; returns empty for non-admins
export const topItems = publicQuery({
	args: { threadIds: v.array(v.id('conversationThreads')), locale: v.string() },
	returns: v.array(
		v.object({
			threadId: v.id('conversationThreads'),
			text: v.string(),
			count: v.number(),
			dueAt: v.optional(v.number()),
		})
	),
	handler: async (ctx, args) => {
		const session = await getBetterAuthSessionWithRole(ctx);
		if (!isSharedInboxReader(session) || !(await isFeatureEnabled(ctx, 'inbox'))) return [];
		if (args.threadIds.length > MAX_TOP_ITEM_THREADS) {
			throwInvalidInput(`Ask for at most ${MAX_TOP_ITEM_THREADS} threads at once`);
		}
		const locale = streamLocale(args.locale);
		const rows = await Promise.all(
			args.threadIds.map(async (threadId) => {
				const [team, unclear] = await Promise.all([
					firstOfBucket(ctx, threadId, 'forUs'),
					firstOfBucket(ctx, threadId, 'unclear'),
				]);
				const top =
					team && unclear
						? (unclear.sortKey ?? '') < (team.sortKey ?? '')
							? unclear
							: team
						: (team ?? unclear);
				if (!top) return null;
				const counts = (await loadBriefRow(ctx, { kind: 'team', id: threadId }))?.itemCounts;
				return {
					threadId,
					text: await openMessageBody(top.display[locale]),
					count: Math.max(counts ? counts.us + counts.unclear : 1, 1),
					...(top.due?.at !== undefined ? { dueAt: top.due.at } : {}),
				};
			})
		);
		return rows.filter((row): row is NonNullable<typeof row> => row !== null && row.text !== '');
	},
});
