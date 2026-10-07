/**
 * The thread brief read and the viewer's own writes (SPEC §4 `brief.ts`):
 *
 *   - `get({threadRef, locale})` → `ThreadBriefView` (`briefShape.ts`), or
 *     null for a caller who may not read the thread. Deterministic: no model
 *     call, everything comes from the reducer's rows. Brief mode for personal
 *     Postbox threads, actions mode ("Open for the team") for Team Inbox and
 *     shared-mailbox threads. A thread with nothing interpreted yet returns
 *     `completeness: 'none'` and never an empty "nothing to do".
 *   - `markSeen({threadRef})`: the viewer has seen the brief as it stands
 *     (drives `sinceLastSeen` / `isNew` next time).
 *   - `setViewOverride({threadRef, view})`: this thread opens on Overview or
 *     Conversation for this viewer (personal mail threads only; `null` clears).
 *
 * Reader rule: a mail thread is readable with mailbox access
 * (`loadReadableMailbox` / `requireMailboxAccess`), a Team Inbox thread by a
 * shared-inbox reader (`isSharedInboxReader`). Every row read here inherits it;
 * the writes go through `threadAccess.ts requireThreadReader`.
 */

import { v } from 'convex/values';
import { normalizeCatchUpLocale } from '../ai/catchUpPrompt';
import { publicQuery } from '../../lib/authedFunctions';
import { getBetterAuthSessionWithRole } from '../../lib/sessionOrganization';
import { throwInvalidInput } from '../../_utils/errors';
import { isSharedInboxReader } from '../../inbox/access';
import { loadReadableMailbox } from '../permissions';
import { mailboxScope } from '../mailbox/shared';
import type { InterpretMode } from '@owlat/shared/threadBrief';
import { threadBriefMutation } from '../_helpers';
import { threadViewValidator, streamPositionValidator } from '../../lib/validators/threadBrief';
import {
	threadRefToFields,
	threadRefValidator,
	type ThreadRef,
} from '../../lib/validators/threadRef';
import { threadBriefViewValidator, type ThreadBriefView } from './briefShape';
import { loadBriefRow } from './briefRow';
import { projectBrief } from './briefProject';
import { readResult } from './load';
import {
	gapOf,
	readActivityTail,
	readFacts,
	readInterpretations,
	readItemsPage,
	readLatest,
	readMailPeopleAndFiles,
	readExactWording,
	readMessageLatest,
	readViewerState,
	sinceLastSeenOf,
	toActivityViews,
} from './briefRead';
import { isReplyExpectingIntent, type ReplyIntent } from '../ai/replyIntent';
import { openMessageBody } from '../../lib/messageBody';
import type { MutationCtx } from '../../_generated/server';
import { requireThreadReader } from './threadAccess';

// public: soft-auth — returns null for anonymous callers and for anyone the
// thread's reader rule refuses (mailbox access, or the shared-inbox reader gate).
export const get = publicQuery({
	args: {
		threadRef: threadRefValidator,
		locale: v.string(),
		// Next page of open items (`page.cursor` of the previous answer).
		cursor: v.optional(v.union(v.string(), v.null())),
	},
	returns: v.union(threadBriefViewValidator, v.null()),
	handler: async (ctx, args): Promise<ThreadBriefView | null> => {
		const ref = args.threadRef;
		const locale = normalizeCatchUpLocale(args.locale);
		const session = await getBetterAuthSessionWithRole(ctx);
		if (!session) return null;

		let totalMessages: number;
		// The mode is read from its source of truth at READ time (the mailbox's
		// scope; a team thread is always actions), never from the cached brief
		// row: a mailbox converted to a team inbox shows no personal overview,
		// latest line or facts from the moment it flips, whatever the async
		// scope-change cleanup has done yet (review F8).
		let mode: InterpretMode;
		let people: Awaited<ReturnType<typeof readMailPeopleAndFiles>> = {
			participants: [],
			files: [],
		};
		if (ref.kind === 'mail') {
			const thread = await ctx.db.get(ref.id);
			if (!thread) return null;
			const mailbox = await loadReadableMailbox(ctx, thread.mailboxId);
			if (!mailbox) return null;
			totalMessages = thread.messageCount;
			people = await readMailPeopleAndFiles(ctx, thread, mailbox);
			mode = mailboxScope(mailbox) === 'shared' ? 'actions' : 'brief';
		} else {
			if (!isSharedInboxReader(session)) return null;
			const thread = await ctx.db.get(ref.id);
			if (!thread) return null;
			totalMessages = thread.messageCount;
			mode = 'actions';
		}

		const brief = await loadBriefRow(ctx, ref);

		const [itemsPage, tail, interpretations, viewer] = await Promise.all([
			readItemsPage(ctx, ref, locale, args.cursor ?? null, Date.now()),
			readActivityTail(ctx, ref),
			readInterpretations(ctx, ref),
			readViewerState(ctx, ref, session.userId),
		]);
		const checkpointRow = brief?.checkpoint
			? (interpretations.find((r) => r._id === brief.checkpoint?.interpretationId) ??
				(await ctx.db.get(brief.checkpoint.interpretationId)))
			: null;
		const latest = await readLatest(checkpointRow, locale);
		const checkpointResult = checkpointRow ? await readResult(checkpointRow) : null;
		const facts =
			mode === 'brief' && ref.kind === 'mail' ? await readFacts(ctx, ref.id, locale) : [];
		const overview =
			mode === 'brief' &&
			brief?.overview &&
			brief.overview.revision === brief.interpretationRevision
				? brief.overview[locale]
				: undefined;

		return projectBrief({
			threadRef: ref,
			mode,
			interpretationRevision: brief?.interpretationRevision ?? 0,
			completeness: brief?.completeness ?? 'none',
			items: itemsPage.items,
			page: itemsPage.page,
			...(brief?.itemCounts ? { itemCounts: brief.itemCounts } : {}),
			facts,
			...(overview ? { overview: await openMessageBody(overview) } : {}),
			...(latest.lines ? { latest: latest.lines } : {}),
			activity: await toActivityViews(tail),
			participants: people.participants,
			files: people.files,
			...(viewer ? { sinceLastSeen: sinceLastSeenOf(tail, viewer.seenActivitySeq) } : {}),
			...(viewer?.viewOverride ? { viewOverride: viewer.viewOverride } : {}),
			...(mode === 'brief'
				? {
						messageLatest: await readMessageLatest(interpretations, locale),
						...(ref.kind === 'mail' ? exactWordingFields(await readExactWording(ctx, ref.id)) : {}),
					}
				: {}),
			gap: gapOf(interpretations, {
				totalMessages,
				isPending: brief?.completeness === 'pending',
				...(brief?.sourceCounts ? { sourceCounts: brief.sourceCounts } : {}),
				suppressed: latest.suppressed,
			}),
			isNoReplyNeeded: checkpointResult
				? !isReplyExpectingIntent(checkpointResult.replyIntent as ReplyIntent)
				: false,
			now: Date.now(),
		});
	},
});

async function upsertViewerState(
	ctx: MutationCtx,
	ref: ThreadRef,
	userId: string,
	patch: {
		seenInterpretationRevision?: number;
		seenActivitySeq?: number;
		viewOverride?: 'overview' | 'conversation' | null;
		streamPosition?: { at: number; key: string };
	}
): Promise<void> {
	const existing = await readViewerState(ctx, ref, userId);
	const now = Date.now();
	const { viewOverride, ...rest } = patch;
	const override =
		viewOverride === undefined
			? {}
			: { viewOverride: viewOverride === null ? undefined : viewOverride };
	if (existing) {
		await ctx.db.patch(existing._id, { ...rest, ...override, updatedAt: now });
		return;
	}
	await ctx.db.insert('threadViewerState', {
		...threadRefToFields(ref),
		userId,
		seenInterpretationRevision: rest.seenInterpretationRevision ?? 0,
		seenActivitySeq: rest.seenActivitySeq ?? 0,
		...(rest.streamPosition ? { streamPosition: rest.streamPosition } : {}),
		...(viewOverride ? { viewOverride } : {}),
		updatedAt: now,
	});
}

export const markSeen = threadBriefMutation({
	args: {
		threadRef: threadRefValidator,
		// The revision the viewer saw (default: the current one). Activity is
		// marked seen up to now either way.
		interpretationRevision: v.optional(v.number()),
		// Team stream: the last entry the viewer actually saw.
		streamPosition: v.optional(streamPositionValidator),
	},
	handler: async (ctx, args, session) => {
		// authz: requireThreadReader applies the thread's reader rule:
		// requireMailboxAccess for a mail thread, requirePermission(isSharedInboxReader) for a team one.
		await requireThreadReader(ctx, args.threadRef, session);
		const brief = await loadBriefRow(ctx, args.threadRef);
		await upsertViewerState(ctx, args.threadRef, session.userId, {
			seenInterpretationRevision: Math.min(
				args.interpretationRevision ?? Number.POSITIVE_INFINITY,
				brief?.interpretationRevision ?? 0
			),
			seenActivitySeq: brief?.lastActivitySeq ?? 0,
			...(args.streamPosition ? { streamPosition: args.streamPosition } : {}),
		});
		return null;
	},
});

export const setViewOverride = threadBriefMutation({
	args: { threadRef: threadRefValidator, view: v.union(threadViewValidator, v.null()) },
	handler: async (ctx, args, session) => {
		if (args.threadRef.kind !== 'mail') throwInvalidInput('Team threads have no Overview');
		// authz: requireThreadReader applies the thread's reader rule:
		// requireMailboxAccess for a mail thread, requirePermission(isSharedInboxReader) for a team one.
		await requireThreadReader(ctx, args.threadRef, session);
		await upsertViewerState(ctx, args.threadRef, session.userId, { viewOverride: args.view });
		return null;
	},
});
/** The brief's "Read the exact wording" fields from one indexed page. */
function exactWordingFields(read: Awaited<ReturnType<typeof readExactWording>>) {
	return {
		exactWording: read.messages,
		...(read.isTruncated ? { isExactWordingTruncated: true } : {}),
	};
}
