/**
 * Read on arrival, Undo (SPEC §4.4): restoring ONE change row.
 *
 * A row is restored only when BOTH hold:
 *   (a) the entity's current value deep-equals the row's `after`, and
 *   (b) the entity's operation marker still names this operation (the ABA
 *       guard): `mailThreads.lastArrivalOperationId` for a thread override,
 *       `mailSenderProfiles.lastOperationId` for a sender status, override or
 *       draft pause, `mailArrivalRecords.lastOperationId` for a rule placement.
 *
 * Messages carry no operation marker, so the message-level rows
 * (`messageFolder`, `messageRead`, `messageLabel`, `messageFlag`,
 * `messageSection`) check (a) ONLY: a message moved back by hand and then
 * re-archived by something else would be moved again. A label deleted since,
 * or a folder that is gone, skips its row. Anything else skips the row, and
 * the operation ends `undo_partial`.
 *
 * Undo leaves the markers naming the undone operation: an entity changed since
 * already names a newer one, so nothing older can match. Effects that need
 * more than the row (folder moves, flag writes, label reconciliation, the
 * projection, a sender re-sort) are collected in {@link UndoBatch} and applied
 * once per page by the caller.
 *
 * Isolate-safe helpers, no Convex functions.
 */

import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import type { ArrivalOperationChangeRow } from '../../lib/validators/arrival';
import { recordMessageCounters } from '../messageCounters';
import { applyLabelToMessage } from '../labelsMembership';
import { loadSenderProfile } from '../senders/profiles';
import { DO_NOT_RELEARN } from './learningSignals';
import { loadArrivalRecord } from './records';

type Operation = Doc<'mailArrivalOperations'>;
type ChangeRow = Doc<'mailArrivalOperationChanges'>;
type Change<K extends ArrivalOperationChangeRow['kind']> = Extract<
	ArrivalOperationChangeRow,
	{ kind: K }
>;

/** What one page of restored rows still has to apply. */
export interface UndoBatch {
	/** Messages to move back, by the folder they came from. */
	moves: Map<Id<'mailFolders'>, Id<'mailMessages'>[]>;
	/** Flag writes, one entry per message (later rows of a page merge in). */
	flags: Map<Id<'mailMessages'>, { seen?: boolean; flagged?: boolean }>;
	/** Thread label sets to re-derive after the message rows changed. */
	labels: Map<string, { threadId: Id<'mailThreads'>; labelId: Id<'mailLabels'> }>;
	/** Threads whose projection to recompute. */
	threads: Set<Id<'mailThreads'>>;
	/** Senders whose newest Inbox threads to re-sort. */
	senders: Set<Id<'mailSenderProfiles'>>;
	/** Messages whose delayed actions the operation may have created. */
	messages: Set<Id<'mailMessages'>>;
	/** A restored archive had cleared a reply reminder undo cannot restore. */
	isNeedsReplyCleared: boolean;
}

export function newUndoBatch(): UndoBatch {
	return {
		moves: new Map(),
		flags: new Map(),
		labels: new Map(),
		threads: new Set(),
		senders: new Set(),
		messages: new Set(),
		isNeedsReplyCleared: false,
	};
}

function placementOverrideEquals(
	a: Doc<'mailThreads'>['placementOverride'] | null,
	b: Change<'threadPlacementOverride'>['after']
): boolean {
	if (!a || !b) return !a && !b;
	return a.placement === b.placement && a.setAt === b.setAt && a.operationId === b.operationId;
}

async function liveMessage(
	ctx: MutationCtx,
	operation: Operation,
	messageId: Id<'mailMessages'>
): Promise<Doc<'mailMessages'> | null> {
	const message = await ctx.db.get(messageId);
	return message && message.mailboxId === operation.mailboxId ? message : null;
}

async function restoreFolder(
	ctx: MutationCtx,
	operation: Operation,
	row: ChangeRow,
	change: Change<'messageFolder'>,
	batch: UndoBatch
): Promise<boolean> {
	const message = await liveMessage(ctx, operation, change.messageId);
	if (!message || message.folderId !== change.after) return false;
	const folder = await ctx.db.get(change.before);
	if (!folder || folder.mailboxId !== message.mailboxId) return false;
	const ids = batch.moves.get(change.before) ?? [];
	ids.push(message._id);
	batch.moves.set(change.before, ids);
	batch.threads.add(message.threadId);
	if (row.isNeedsReplyCleared) batch.isNeedsReplyCleared = true;
	return true;
}

async function restoreFlag(
	ctx: MutationCtx,
	operation: Operation,
	change: Change<'messageRead'> | Change<'messageFlag'>,
	batch: UndoBatch
): Promise<boolean> {
	const message = await liveMessage(ctx, operation, change.messageId);
	if (!message) return false;
	const pending = batch.flags.get(message._id) ?? {};
	const field = change.kind === 'messageRead' ? 'seen' : 'flagged';
	const current = pending[field] ?? (field === 'seen' ? message.flagSeen : message.flagFlagged);
	if (current !== change.after) return false;
	batch.flags.set(message._id, { ...pending, [field]: change.before });
	batch.threads.add(message.threadId);
	return true;
}

async function restoreLabel(
	ctx: MutationCtx,
	operation: Operation,
	change: Change<'messageLabel'>,
	batch: UndoBatch
): Promise<boolean> {
	const message = await liveMessage(ctx, operation, change.messageId);
	if (!message) return false;
	// A label deleted since (or one from another mailbox) is not put back.
	const label = await ctx.db.get(change.labelId);
	if (!label || label.mailboxId !== message.mailboxId) return false;
	if (message.labelIds.includes(change.labelId) !== change.after) return false;
	await applyLabelToMessage(ctx, message, change.labelId, change.before, Date.now());
	batch.labels.set(`${message.threadId}:${change.labelId}`, {
		threadId: message.threadId,
		labelId: change.labelId,
	});
	return true;
}

async function restoreSection(
	ctx: MutationCtx,
	operation: Operation,
	change: Change<'messageSection'>
): Promise<boolean> {
	const message = await liveMessage(ctx, operation, change.messageId);
	if (!message || (message.pinnedSection ?? null) !== change.after) return false;
	const pinnedSection = change.before ?? undefined;
	await ctx.db.patch(message._id, { pinnedSection, updatedAt: Date.now() });
	await recordMessageCounters(ctx, message, { ...message, pinnedSection });
	return true;
}

async function restoreRulePlacement(
	ctx: MutationCtx,
	operation: Operation,
	change: Change<'recordRulePlacement'>,
	batch: UndoBatch
): Promise<boolean> {
	const record = await loadArrivalRecord(ctx, change.messageId);
	if (!record || record.lastOperationId !== operation._id) return false;
	if ((record.rulePlacement ?? null) !== change.after) return false;
	await ctx.db.patch(record._id, {
		rulePlacement: change.before ?? undefined,
		updatedAt: Date.now(),
	});
	batch.threads.add(record.threadId);
	return true;
}

async function restoreThreadOverride(
	ctx: MutationCtx,
	operation: Operation,
	change: Change<'threadPlacementOverride'>,
	batch: UndoBatch
): Promise<boolean> {
	const thread = await ctx.db.get(change.threadId);
	if (!thread || thread.mailboxId !== operation.mailboxId) return false;
	if (thread.lastArrivalOperationId !== operation._id) return false;
	if (!placementOverrideEquals(thread.placementOverride ?? null, change.after)) return false;
	await ctx.db.patch(thread._id, {
		placementOverride: change.before ?? undefined,
		updatedAt: Date.now(),
	});
	batch.threads.add(thread._id);
	return true;
}

/** The profile a sender row names, only while this operation is its last. */
async function guardedProfile(
	ctx: MutationCtx,
	operation: Operation,
	senderDigest: string
): Promise<Doc<'mailSenderProfiles'> | null> {
	const profile = await loadSenderProfile(ctx, operation.mailboxId, senderDigest);
	return profile && profile.lastOperationId === operation._id ? profile : null;
}

async function restoreSender(
	ctx: MutationCtx,
	operation: Operation,
	change: Change<'senderStatus'> | Change<'senderPlacementOverride'> | Change<'senderDraftPause'>,
	batch: UndoBatch
): Promise<boolean> {
	const profile = await guardedProfile(ctx, operation, change.senderDigest);
	if (!profile) return false;
	const now = Date.now();
	if (change.kind === 'senderStatus') {
		if (profile.status !== change.after.status) return false;
		if (profile.statusSource !== change.after.statusSource) return false;
		await ctx.db.patch(profile._id, {
			status: change.before.status,
			statusSource: change.before.statusSource,
			statusChangedAt: now,
			// Undoing a learned digest: never relearn it from the same evidence
			// (§4.3), and its notice has nothing left to say.
			...(change.after.statusSource === 'learned'
				? { unreadArchiveEvidence: DO_NOT_RELEARN, learnedNoticeAt: undefined }
				: {}),
			updatedAt: now,
		});
	} else if (change.kind === 'senderPlacementOverride') {
		if ((profile.placementOverride ?? null) !== change.after) return false;
		await ctx.db.patch(profile._id, {
			placementOverride: change.before ?? undefined,
			updatedAt: now,
		});
	} else {
		if (profile.autoDraftPausedAt !== change.after.autoDraftPausedAt) return false;
		if (profile.unusedDraftStreak !== change.after.unusedDraftStreak) return false;
		await ctx.db.patch(profile._id, {
			autoDraftPausedAt: change.before.autoDraftPausedAt,
			unusedDraftStreak: change.before.unusedDraftStreak,
			updatedAt: now,
		});
		return true; // a draft pause does not move mail: no re-sort
	}
	batch.senders.add(profile._id);
	return true;
}

/** Restore one change row if its guards hold. True when it was restored. */
export async function restoreChange(
	ctx: MutationCtx,
	operation: Operation,
	row: ChangeRow,
	batch: UndoBatch
): Promise<boolean> {
	const change = row.change;
	if (row.messageId) batch.messages.add(row.messageId);
	switch (change.kind) {
		case 'messageFolder':
			return restoreFolder(ctx, operation, row, change, batch);
		case 'messageRead':
		case 'messageFlag':
			return restoreFlag(ctx, operation, change, batch);
		case 'messageLabel':
			return restoreLabel(ctx, operation, change, batch);
		case 'messageSection':
			return restoreSection(ctx, operation, change);
		case 'recordRulePlacement':
			return restoreRulePlacement(ctx, operation, change, batch);
		case 'threadPlacementOverride':
			return restoreThreadOverride(ctx, operation, change, batch);
		case 'senderStatus':
		case 'senderPlacementOverride':
		case 'senderDraftPause':
			return restoreSender(ctx, operation, change, batch);
	}
}
