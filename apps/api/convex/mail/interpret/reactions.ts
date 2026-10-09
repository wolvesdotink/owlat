/**
 * What people do to a brief item (SPEC §5 "Reactions"). Each one:
 *
 *   - applies the thread's reader rule (`threadAccess.ts`): mailbox access for
 *     a Postbox thread, the shared-inbox reader gate for a Team Inbox thread;
 *   - bumps the item's `revision` and `updatedAt` (response plans and
 *     activity bind to the revision);
 *   - appends one `threadActivity` row in the same transaction, actor
 *     `{kind: 'user', id}`, keyed `react:<itemId>:<revision>`;
 *   - refreshes the list-row projection (`mailThreads.briefTop`) of a mail
 *     thread.
 *
 * Lifecycle reactions (markDone, markReceived, untrack, notARequest,
 * confirmProposal, undo) are the person's assertions about the item
 * (provenance `asserted`). One that moves the status records the person as
 * its `statusSource` (`user:<id>`) and stamps `lastTransitionAt`. They are
 * planned in `reactionRules.ts`, which also documents their exact edges and
 * what undo reverses. Each sets the item's
 * `correction`, which the reducer never flips.
 *
 * remind, assignItem and claimItem sit next to the lifecycle and never touch
 * it (provenance `recorded`, housekeeping activity):
 *   - remind sets or clears `remindAt` only.
 *   - assignItem / claimItem are team verbs (Team Inbox threads and shared
 *     mailboxes, i.e. `actions` mode). They change `assigneeUserId` only,
 *     never responsibility or completion. An assignee must be a live org
 *     member who can read the thread.
 *   - claimItem is atomic (one serializable transaction): it assigns the item
 *     to the caller when nobody holds it, is a no-op when the caller already
 *     does, and is refused (`conflict`) when someone else holds it. That
 *     includes the D4 default, the thread's assignee at item creation:
 *     taking over an item someone holds is an explicit `assignItem`.
 *
 * Commitments (`mailCommitments.threadItemId`) keep their own reminder state:
 * closing an item here does not touch the commitment linked to it.
 */

import { v } from 'convex/values';
import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import type { ActivityType } from '@owlat/shared/threadBrief';
import type { Infer } from 'convex/values';
import { threadBriefMutation } from '../_helpers';
import { throwConflict, throwInvalidInput, throwInvalidState } from '../../_utils/errors';
import {
	interpretationSourceKey,
	type activityDeltaValidator,
} from '../../lib/validators/threadBrief';
import { threadRefToFields, type ThreadRef } from '../../lib/validators/threadRef';
import type { MutationSessionContext } from '../../lib/sessionOrganization';
import { appendActivity } from './activity';
import { writeItemChange } from './counters';
import { refreshBriefTop } from './briefTop';
import { resolveThreadMode } from './briefRow';
import { canUserReadThread, requireItemReader } from './threadAccess';
import { planReaction, toDbPatch, type LifecycleReaction } from './reactionRules';
import {
	heldTransitionSources,
	liveHeldTransitions,
	restoreHeldTransitions,
	settleHeldTransitions,
} from './pendingMatch';
import { reconcileSendFailure } from './sendFailure';

/** How far ahead a reminder may be set. */
const MAX_REMIND_AHEAD_MS = 400 * 24 * 60 * 60 * 1000;
/** A reminder this far in the past is a client clock problem, not a reminder. */
const REMIND_PAST_SLACK_MS = 5 * 60 * 1000;
/** Upper bound on a user id argument. */
const MAX_USER_ID_LENGTH = 200;

const itemArgs = { itemId: v.id('threadItems') };
const reactionResult = v.object({ itemId: v.id('threadItems'), revision: v.number() });
type ReactionResult = Infer<typeof reactionResult>;

type ItemChange = {
	item: Doc<'threadItems'>;
	ref: ThreadRef;
	userId: string;
	patch: Partial<Omit<Doc<'threadItems'>, '_id' | '_creationTime' | 'listBucket'>>;
	type: ActivityType;
	provenance: 'asserted' | 'recorded';
	delta?: Infer<typeof activityDeltaValidator>;
	payload?: Record<string, unknown>;
};

/** Write one reaction: the item patch, its activity row, the list-row projection. */
async function recordChange(ctx: MutationCtx, change: ItemChange): Promise<ReactionResult> {
	const { item, ref } = change;
	const revision = item.revision + 1;
	await appendActivity(ctx, {
		threadRef: ref,
		idempotencyKey: `react:${item._id}:${revision}`,
		type: change.type,
		actor: { kind: 'user', id: change.userId },
		provenance: change.provenance,
		itemId: item._id,
		itemRevision: revision,
		...(change.delta ? { delta: change.delta } : {}),
		...(change.payload ? { payload: change.payload } : {}),
	});
	// The one write path outside the reducer: item, list bucket and counters.
	await writeItemChange(ctx, ref, item, { ...change.patch, revision, updatedAt: Date.now() });
	if (ref.kind === 'mail') await refreshBriefTop(ctx, ref.id);
	return { itemId: item._id, revision };
}

/** Load, authorize, plan and record one lifecycle reaction. */
async function runLifecycle(
	ctx: MutationCtx,
	itemId: Id<'threadItems'>,
	session: MutationSessionContext,
	reaction: LifecycleReaction
): Promise<{ result: ReactionResult; item: Doc<'threadItems'>; ref: ThreadRef }> {
	const { item: row, ref } = await requireItemReader(ctx, itemId, session);
	// A held transition whose message was re-read (or confirmed elsewhere)
	// since no longer stands: it is not applied (pendingMatch.ts).
	const held = row.pendingUpdate?.transitions;
	const live = reaction === 'confirmProposal' && held ? await liveHeldTransitions(ctx, held) : [];
	const item =
		held && reaction === 'confirmProposal'
			? { ...row, pendingUpdate: { ...row.pendingUpdate!, transitions: live } }
			: row;
	const plan = planReaction(item, reaction, { userId: session.userId, now: Date.now() });
	if (!plan.ok) throwInvalidState(plan.reason);
	const patch = toDbPatch(plan);
	const now = Date.now();
	const result = await recordChange(ctx, {
		item,
		ref,
		userId: session.userId,
		// A status the person set names them as its source (a purge of a message
		// never resets it, transitionSources.ts) and stamps the order of
		// transitions, so an older message cannot move it back (fold.ts).
		patch:
			plan.statusTo && !('statusSource' in patch)
				? {
						...patch,
						statusSource: { sourceKey: `user:${session.userId}`, at: now },
						lastTransitionAt: now,
					}
				: patch,
		type: plan.activity,
		provenance: 'asserted',
		...(plan.statusFrom
			? {
					delta: {
						statusFrom: plan.statusFrom,
						...(plan.statusTo ? { statusTo: plan.statusTo } : {}),
						...(patch.completion ? { completion: patch.completion } : {}),
					},
				}
			: {}),
	});
	if (live.length > 0) {
		await settleHeldTransitions(ctx, live);
		// A disposition now resting on a send that already failed is taken back
		// at once (round 7 F5): the send's failure has landed before.
		for (const source of await heldTransitionSources(ctx, live)) {
			if (source.kind === 'outboundMail' || source.kind === 'teamReply') {
				await reconcileSendFailure(ctx, source);
			}
		}
	}
	// Undoing a confirmation that settled pending transitions makes them pending
	// again on their extraction rows, so a new confirmation applies them (F2).
	const restored = reaction === 'undo' ? plan.patch.pendingUpdate?.transitions : undefined;
	if (restored?.length) await restoreHeldTransitions(ctx, restored);
	return { result, item, ref };
}

export const markDone = threadBriefMutation({
	args: itemArgs,
	returns: reactionResult,
	handler: async (ctx, args, session) => {
		// authz: requireItemReader (in runLifecycle) applies the item's thread reader rule:
		// requireMailboxAccess for a mail thread, requirePermission(isSharedInboxReader) for a team one.
		return (await runLifecycle(ctx, args.itemId, session, 'markDone')).result;
	},
});

export const markReceived = threadBriefMutation({
	args: itemArgs,
	returns: reactionResult,
	handler: async (ctx, args, session) => {
		// authz: requireItemReader (in runLifecycle) applies the item's thread reader rule:
		// requireMailboxAccess for a mail thread, requirePermission(isSharedInboxReader) for a team one.
		return (await runLifecycle(ctx, args.itemId, session, 'markReceived')).result;
	},
});

export const untrack = threadBriefMutation({
	args: itemArgs,
	returns: reactionResult,
	handler: async (ctx, args, session) => {
		// authz: requireItemReader (in runLifecycle) applies the item's thread reader rule:
		// requireMailboxAccess for a mail thread, requirePermission(isSharedInboxReader) for a team one.
		return (await runLifecycle(ctx, args.itemId, session, 'untrack')).result;
	},
});

export const confirmProposal = threadBriefMutation({
	args: itemArgs,
	returns: reactionResult,
	handler: async (ctx, args, session) => {
		// authz: requireItemReader (in runLifecycle) applies the item's thread reader rule:
		// requireMailboxAccess for a mail thread, requirePermission(isSharedInboxReader) for a team one.
		return (await runLifecycle(ctx, args.itemId, session, 'confirmProposal')).result;
	},
});

export const undo = threadBriefMutation({
	args: itemArgs,
	returns: reactionResult,
	handler: async (ctx, args, session) => {
		// authz: requireItemReader (in runLifecycle) applies the item's thread reader rule:
		// requireMailboxAccess for a mail thread, requirePermission(isSharedInboxReader) for a team one.
		return (await runLifecycle(ctx, args.itemId, session, 'undo')).result;
	},
});

/**
 * "Not a request": the model was wrong to make an item of this. The item is
 * untracked with a `notARequest` correction, and a `threadItemCorrections`
 * row records what kind of item the model got wrong (structure only, no text)
 * for the interpretation eval.
 */
export const notARequest = threadBriefMutation({
	args: itemArgs,
	returns: reactionResult,
	handler: async (ctx, args, session) => {
		// authz: requireItemReader (in runLifecycle) applies the item's thread reader rule:
		// requireMailboxAccess for a mail thread, requirePermission(isSharedInboxReader) for a team one.
		const { result, item, ref } = await runLifecycle(ctx, args.itemId, session, 'notARequest');
		const sources = new Map<string, { sourceKey: string; contentRevision: string }>();
		for (const evidence of item.evidence) {
			const sourceKey = interpretationSourceKey(evidence.source);
			sources.set(`${sourceKey}|${evidence.contentRevision}`, {
				sourceKey,
				contentRevision: evidence.contentRevision,
			});
		}
		await ctx.db.insert('threadItemCorrections', {
			...threadRefToFields(ref),
			itemId: item._id,
			itemRevision: item.revision,
			kind: 'notARequest',
			userId: session.userId,
			intent: item.intent,
			facets: item.facets,
			responsibility: item.responsibility,
			verify: item.verify,
			evidenceSources: [...sources.values()],
			createdAt: Date.now(),
		});
		return result;
	},
});

/** "Remind me": set (`remindAt`) or clear (`null`) the item's reminder. Never changes its status. */
export const remind = threadBriefMutation({
	args: { itemId: v.id('threadItems'), remindAt: v.union(v.number(), v.null()) },
	returns: reactionResult,
	handler: async (ctx, args, session) => {
		// authz: requireItemReader applies the item's thread reader rule:
		// requireMailboxAccess for a mail thread, requirePermission(isSharedInboxReader) for a team one.
		const { item, ref } = await requireItemReader(ctx, args.itemId, session);
		const now = Date.now();
		if (args.remindAt !== null) {
			if (
				!Number.isFinite(args.remindAt) ||
				args.remindAt < now - REMIND_PAST_SLACK_MS ||
				args.remindAt > now + MAX_REMIND_AHEAD_MS
			) {
				throwInvalidInput('Pick a reminder time within the next year');
			}
			if (item.status !== 'open') throwInvalidState('Only an open item can have a reminder');
		}
		return recordChange(ctx, {
			item,
			ref,
			userId: session.userId,
			patch: { remindAt: args.remindAt ?? undefined },
			type: 'item_reminder_set',
			provenance: 'recorded',
			payload: { remindAt: args.remindAt },
		});
	},
});

/** Refuse a personal thread: assignment is a team verb (actions mode). */
async function requireTeamSurface(ctx: MutationCtx, ref: ThreadRef): Promise<void> {
	if (ref.kind === 'team') return;
	if ((await resolveThreadMode(ctx, ref)) !== 'actions') {
		throwInvalidInput('Items of a personal thread have no assignee');
	}
}

/** Hand an item to a teammate (`null` unassigns). Never changes responsibility or completion. */
export const assignItem = threadBriefMutation({
	args: { itemId: v.id('threadItems'), assigneeUserId: v.union(v.string(), v.null()) },
	returns: reactionResult,
	handler: async (ctx, args, session) => {
		// authz: requireItemReader applies the item's thread reader rule:
		// requireMailboxAccess for a mail thread, requirePermission(isSharedInboxReader) for a team one;
		// the assignee must pass the same rule (canUserReadThread).
		const { item, ref } = await requireItemReader(ctx, args.itemId, session);
		await requireTeamSurface(ctx, ref);
		const next = args.assigneeUserId;
		if (next === (item.assigneeUserId ?? null)) {
			return { itemId: item._id, revision: item.revision };
		}
		if (next !== null) {
			if (next.length === 0 || next.length > MAX_USER_ID_LENGTH) {
				throwInvalidInput('Pick a teammate');
			}
			if (item.status !== 'open') throwInvalidState('Only an open item can be assigned');
			if (!(await canUserReadThread(ctx, ref, next))) {
				throwInvalidInput('That person cannot open this thread');
			}
		}
		return recordChange(ctx, {
			item,
			ref,
			userId: session.userId,
			patch: { assigneeUserId: next ?? undefined },
			type: 'item_assigned',
			provenance: 'recorded',
			payload: {
				assigneeUserId: next,
				...(item.assigneeUserId ? { previousAssigneeUserId: item.assigneeUserId } : {}),
			},
		});
	},
});

/** Take an item for yourself; refused when a teammate already holds it (see the module doc). */
export const claimItem = threadBriefMutation({
	args: itemArgs,
	returns: reactionResult,
	handler: async (ctx, args, session) => {
		// authz: requireItemReader applies the item's thread reader rule:
		// requireMailboxAccess for a mail thread, requirePermission(isSharedInboxReader) for a team one.
		const { item, ref } = await requireItemReader(ctx, args.itemId, session);
		await requireTeamSurface(ctx, ref);
		if (item.assigneeUserId === session.userId) {
			return { itemId: item._id, revision: item.revision };
		}
		if (item.assigneeUserId !== undefined) {
			throwConflict('A teammate already took this', { assigneeUserId: item.assigneeUserId });
		}
		if (item.status !== 'open') throwInvalidState('Only an open item can be claimed');
		return recordChange(ctx, {
			item,
			ref,
			userId: session.userId,
			patch: { assigneeUserId: session.userId },
			type: 'item_claimed',
			provenance: 'recorded',
			payload: { assigneeUserId: session.userId },
		});
	},
});
