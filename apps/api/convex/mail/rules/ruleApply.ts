/**
 * Read on arrival (SPEC §6.2, §6.3): what matched rules do to ONE message, in
 * two halves shared by the arrival hook pass and the late AI answers.
 *
 * PLANNING (pure). Filters are folded in priority order into a plan. The
 * exclusive actions (folder via `moveToFolder`, `pinToSection`, placement via
 * `sendToDigest` / `placeInUpdates` / `placeInNeedsMe`) go through ONE
 * persisted resolution, the record's `exclusiveWinners`: a writer takes a
 * field only with a priority number LOWER than the recorded winner's, and a
 * tie stays with the earlier writer. The manual pre-insert pass, the hook
 * pass, sender-status enforcement (`Number.MAX_SAFE_INTEGER`) and the AI
 * answers all record there. The other actions (labels, flag, read, notify,
 * `archiveAfter`) always apply.
 *
 * COMMITTING (one mutation). Every change is restrict-only and logged as a
 * `rule_apply` operation with its change rows, written with the change.
 * Folder moves go through `moveSingleMessage` (provider writeback, and the
 * thread keeps its Reply Queue state while it has other Inbox mail). The
 * placement is returned for the arrival record (`rulePlacement`), which the
 * caller writes; its change row is logged here.
 *
 * Isolate-safe; not a Convex function.
 */

import type { Placement } from '@owlat/shared/arrival';
import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import { FolderFlagWrites, writeMessageFlags, type Flag } from '../flagWrites';
import { applyThreadFlagDeltas, type ThreadFlagDeltas } from '../threadAggregates';
import { recordRemoteChanges } from '../external/remoteOps';
import { applyLabelToMessage, reconcileThreadLabel } from '../labelsMembership';
import { recordMessageCounters } from '../messageCounters';
import { moveSingleMessage } from '../archiveSingleMessage';
import { isAllowedHookTarget } from '../filterValidation';
import { enqueuePush } from '../../push/events';
import { createDelayedArchive } from './delayedActions';
import { RuleOperationLog } from './operationLog';

export type ExclusiveWinners = NonNullable<Doc<'mailArrivalRecords'>['exclusiveWinners']>;
type ExclusiveWinner = NonNullable<ExclusiveWinners['folder']>;
type FilterRow = Doc<'mailFilters'>;

/** Folder roles a late (AI-answered) move may take a message out of. */
const LATE_MOVE_FROM_ROLES: ReadonlySet<string> = new Set(['inbox', 'archive']);

const PLACEMENT_OF: Readonly<Record<string, Placement>> = {
	sendToDigest: 'digest',
	placeInUpdates: 'updates',
	placeInNeedsMe: 'needs_me',
};

/**
 * Take an exclusive field for `claim` when it outranks the recorded winner
 * (a LOWER priority number; ties stay with the earlier writer). Mutates
 * `winners`. Pure otherwise.
 */
export function claimExclusive(
	winners: ExclusiveWinners,
	field: keyof ExclusiveWinners,
	claim: ExclusiveWinner
): boolean {
	const current = winners[field];
	if (current && !(claim.priority < current.priority)) return false;
	winners[field] = claim;
	return true;
}

/** Everything the matched filters of one pass do to one message. */
export interface RulePlan {
	labelIds: Id<'mailLabels'>[];
	isMarkRead: boolean;
	isMarkFlagged: boolean;
	section?: string;
	folderId?: Id<'mailFolders'>;
	placement?: Placement;
	archiveAfter?: { hours: number; filterId: Id<'mailFilters'> };
	isNotify: boolean;
	/** The filters that contributed, in priority order (the first names the operation). */
	filterIds: Id<'mailFilters'>[];
}

export function emptyRulePlan(): RulePlan {
	return { labelIds: [], isMarkRead: false, isMarkFlagged: false, isNotify: false, filterIds: [] };
}

/**
 * Fold one matched filter into the plan. Call in priority order. Actions a
 * hook filter may not carry (forward, delete, discard) are ignored here as
 * well as refused at save. Pure (mutates `plan` and `winners`).
 */
export function addFilterToPlan(
	plan: RulePlan,
	winners: ExclusiveWinners,
	filter: Pick<FilterRow, '_id' | 'priority' | 'actions'>,
	source: 'hook' | 'ai'
): void {
	const claim: ExclusiveWinner = { source, filterId: filter._id, priority: filter.priority };
	plan.filterIds.push(filter._id);
	for (const action of filter.actions) {
		switch (action.type) {
			case 'addLabel':
				if (action.labelId && !plan.labelIds.includes(action.labelId)) {
					plan.labelIds.push(action.labelId);
				}
				break;
			case 'markRead':
				plan.isMarkRead = true;
				break;
			case 'markFlagged':
				plan.isMarkFlagged = true;
				break;
			case 'notify':
				plan.isNotify = true;
				break;
			case 'archiveAfter':
				if (!plan.archiveAfter && action.hours) {
					plan.archiveAfter = { hours: action.hours, filterId: filter._id };
				}
				break;
			case 'moveToFolder':
				if (action.folderId && claimExclusive(winners, 'folder', claim)) {
					plan.folderId = action.folderId;
				}
				break;
			case 'pinToSection':
				if (action.sectionName && claimExclusive(winners, 'section', claim)) {
					plan.section = action.sectionName;
				}
				break;
			case 'sendToDigest':
			case 'placeInUpdates':
			case 'placeInNeedsMe':
				if (claimExclusive(winners, 'placement', claim)) {
					plan.placement = PLACEMENT_OF[action.type];
				}
				break;
			default:
				break;
		}
	}
}

/** What committing a plan did. */
export interface RuleCommit {
	operationId: Id<'mailArrivalOperations'> | null;
	/** The placement now on the record, when this pass changed it (logged). */
	rulePlacement?: Placement;
	delayedActions: Id<'mailDelayedActions'>[];
}

async function writeFlags(
	ctx: MutationCtx,
	message: Doc<'mailMessages'>,
	plan: RulePlan,
	log: RuleOperationLog
): Promise<void> {
	const deltas: Partial<Record<Flag, boolean>> = {};
	if (plan.isMarkRead && !message.flagSeen) deltas.seen = true;
	if (plan.isMarkFlagged && !message.flagFlagged) deltas.flagged = true;
	if (Object.keys(deltas).length === 0) return;
	const folders = new FolderFlagWrites(ctx);
	const threads: ThreadFlagDeltas = new Map();
	const remote = await writeMessageFlags(ctx, folders, threads, message, deltas);
	await folders.flush();
	await applyThreadFlagDeltas(ctx, threads);
	if (remote) await recordRemoteChanges(ctx, [remote]);
	if (deltas.seen) {
		await log.add({ kind: 'messageRead', messageId: message._id, before: false, after: true });
	}
	if (deltas.flagged) {
		await log.add({ kind: 'messageFlag', messageId: message._id, before: false, after: true });
	}
}

async function writeLabels(
	ctx: MutationCtx,
	messageId: Id<'mailMessages'>,
	plan: RulePlan,
	log: RuleOperationLog,
	now: number
): Promise<void> {
	for (const labelId of plan.labelIds) {
		const message = await ctx.db.get(messageId);
		const label = await ctx.db.get(labelId);
		if (!message || !label || label.mailboxId !== message.mailboxId) continue;
		if (!(await applyLabelToMessage(ctx, message, labelId, true, now))) continue;
		await reconcileThreadLabel(ctx, message.threadId, labelId, now);
		await log.add({ kind: 'messageLabel', messageId, labelId, before: false, after: true });
	}
}

async function writeSection(
	ctx: MutationCtx,
	message: Doc<'mailMessages'>,
	section: string,
	log: RuleOperationLog,
	now: number
): Promise<void> {
	if (message.pinnedSection === section) return;
	const folder = await ctx.db.get(message.folderId);
	const modseq = Math.max(folder?.highestModseq ?? 0, message.modseq) + 1;
	if (folder) await ctx.db.patch(folder._id, { highestModseq: modseq, updatedAt: now });
	await ctx.db.patch(message._id, { pinnedSection: section, modseq, updatedAt: now });
	await recordMessageCounters(ctx, message, { ...message, pinnedSection: section });
	await log.add({
		kind: 'messageSection',
		messageId: message._id,
		before: message.pinnedSection ?? null,
		after: section,
	});
}

async function writeFolder(
	ctx: MutationCtx,
	message: Doc<'mailMessages'>,
	folderId: Id<'mailFolders'>,
	opts: { isLate: boolean },
	log: RuleOperationLog
): Promise<void> {
	if (message.folderId === folderId) return;
	const target = await ctx.db.get(folderId);
	if (!target || target.mailboxId !== message.mailboxId || !isAllowedHookTarget(target)) return;
	if (opts.isLate) {
		// A late answer moves mail only out of where delivery left it, never
		// back out of a folder the person (or anything else) filed it into.
		const current = await ctx.db.get(message.folderId);
		if (current?.role === undefined || !LATE_MOVE_FROM_ROLES.has(current.role)) return;
	}
	const move = await moveSingleMessage(ctx, message._id, folderId);
	if (!move) return;
	await log.add(
		{ kind: 'messageFolder', messageId: message._id, before: move.sourceFolderId, after: folderId },
		move.isNeedsReplyCleared
	);
}

/**
 * Apply a plan to one message, logging every change under one `rule_apply`
 * operation. `placementBefore` is the record's current `rulePlacement`
 * (null when none or no record yet). The caller writes the returned
 * placement to the record and stamps `lastOperationId` with it.
 */
export async function commitRulePlan(
	ctx: MutationCtx,
	args: {
		messageId: Id<'mailMessages'>;
		plan: RulePlan;
		isLate: boolean;
		placementBefore: Placement | null;
		now: number;
	}
): Promise<RuleCommit> {
	const { plan, now } = args;
	const result: RuleCommit = { operationId: null, delayedActions: [] };
	const first = await ctx.db.get(args.messageId);
	if (!first || plan.filterIds.length === 0) return result;
	const log = new RuleOperationLog(
		ctx,
		{
			mailboxId: first.mailboxId,
			kind: 'rule_apply',
			actor: 'rule',
			threadId: first.threadId,
			messageId: first._id,
			filterId: plan.filterIds[0],
		},
		now
	);
	await writeFlags(ctx, first, plan, log);
	await writeLabels(ctx, first._id, plan, log, now);
	const labelled = await ctx.db.get(first._id);
	if (labelled && plan.section) await writeSection(ctx, labelled, plan.section, log, now);
	// The move goes last so the writes above act on the row in its first folder.
	const sectioned = await ctx.db.get(first._id);
	if (sectioned && plan.folderId) {
		await writeFolder(ctx, sectioned, plan.folderId, { isLate: args.isLate }, log);
	}
	if (plan.placement && plan.placement !== args.placementBefore) {
		await log.add({
			kind: 'recordRulePlacement',
			messageId: first._id,
			before: args.placementBefore,
			after: plan.placement,
		});
		result.rulePlacement = plan.placement;
	}
	const settled = await ctx.db.get(first._id);
	if (settled && plan.archiveAfter) {
		const delayed = await createDelayedArchive(ctx, {
			message: settled,
			hours: plan.archiveAfter.hours,
			source: 'rule',
			filterId: plan.archiveAfter.filterId,
			now,
		});
		if (delayed) {
			// Undo of this operation cancels it while it is pending (§6.4).
			await ctx.db.patch(delayed, { createdByOperationId: await log.ensure() });
			result.delayedActions.push(delayed);
		}
	}
	if (settled && plan.isNotify) {
		const mailbox = await ctx.db.get(settled.mailboxId);
		if (mailbox) {
			await enqueuePush(ctx, mailbox.userId, {
				kind: 'mail',
				messageId: settled._id,
				isRuleNotify: true,
			});
		}
	}
	result.operationId = await log.finish();
	return result;
}
