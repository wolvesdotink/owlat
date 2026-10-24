/**
 * Read on arrival, Fix: "That's wrong" on a sorted message.
 *
 * | destination                   | `message` scope            | `sender` scope                        |
 * |-------------------------------|----------------------------|---------------------------------------|
 * | `needs_me`, `today`, `updates` | thread `placementOverride` | sender `placementOverride` + `keep`/`user` |
 * | `digest`                      | thread `placementOverride` | status `digest`                       |
 * | `auto_archive`                | archive the thread's Inbox | status `auto_archive` (+ archive)     |
 *
 * Everything one Fix changes is ONE operation (`mailArrivalOperations`, kind
 * `fix`, actor `user`) whose change rows are written in this mutation, next to
 * the change, through `arrivalChangeRow`. The thread is stamped
 * `lastArrivalOperationId`, the profile `lastOperationId` (the undo ABA
 * guards). No category is written: `recategorize` is sender-wide and is never
 * called. Statuses are `statusSource: 'user'`, which learning never overrides.
 *
 * Sender scope re-sorts by itself, because placement is derived: the new
 * status or override plus a recompute of the sender's newest ≤200 Inbox
 * threads (`by_folder_from_received`, lane senders' helpers), the first batch
 * in this mutation and the rest by a bounded chain (§16).
 * `auto_archive` archives those same messages through `moveMessagesToFolder`
 * (provider writeback included), each a `messageFolder` change. Older mail is
 * left where it is; there is no continuation.
 *
 * Two choices beyond the table, both logged and undoable:
 *   - A sender-scope placement over a sender that files mail away (digest,
 *     auto-archive, unsubscribed) sets the status back to `keep`: status
 *     outranks the sender override, so the override would otherwise do nothing.
 *   - A destination that keeps mail visible brings the fixed message back to
 *     the Inbox when it sits in Archive (it was auto-archived), so the person
 *     sees it land where they said.
 *   - A sender-scope Fix clears a thread override on the fixed thread, so the
 *     thread follows the sender-wide choice the person just made.
 *
 * The optional `reason` is stored on the operation (sealed) and, when given,
 * starts an async compile into a `mailRuleDrafts` row (origin `fix`): a
 * disabled draft rule for review, never enabled by itself (`./fixCompile.ts`).
 */

import { v } from 'convex/values';
import { doesThreadOverrideHold } from '@owlat/shared/arrivalPlacement';
import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import { throwForbidden, throwInvalidInput, throwNotFound } from '../../_utils/errors';
import { sealBodyAtWrite } from '../../lib/messageBody';
import { literalUnion } from '../../lib/literalUnion';
import type { PlacementOverrideRow } from '../../lib/validators/arrival';
import { postboxMutation } from '../_helpers';
import { moveMessagesToFolder } from '../messageActions';
import { isFromMailboxOwner } from '../needsReplyHeuristic';
import { isPersonalMailbox, requireMailboxAccess } from '../permissions';
import {
	SENDER_RESORT_LIMIT,
	addOperationChanges,
	archiveSenderInbox,
	folderId,
	resortSenderThreads,
	startSenderOperation,
	writeSenderStatus,
} from '../senders/operations';
import { ensureSenderProfile } from '../senders/profiles';
import { ARRIVAL_RETENTION_MS, arrivalChangeRow } from './changeRows';
import { refreshArrivalProjection } from './projection';
import { newestArrivalRecord } from './records';

export const FIX_DESTINATIONS = ['needs_me', 'today', 'updates', 'digest', 'auto_archive'] as const;
export type FixDestination = (typeof FIX_DESTINATIONS)[number];
type ThreadPlacement = Exclude<FixDestination, 'auto_archive'>;

/** The longest Fix reason kept (what a person types in one field). */
export const MAX_FIX_REASON_CHARS = 500;

interface FixContext {
	ctx: MutationCtx;
	message: Doc<'mailMessages'>;
	thread: Doc<'mailThreads'>;
	operationId: Id<'mailArrivalOperations'>;
	now: number;
}

/** What one Fix did, for the toast and its Undo. */
export interface FixResult {
	operationId: Id<'mailArrivalOperations'> | null;
	/** Messages archived (auto-archive), for "Archived N recent mails from X". */
	archived: number;
	/** Inbox messages the sender-scope re-sort covered. */
	resorted: number;
	address: string;
	displayName?: string;
	/** An archive cleared a reply reminder that Undo cannot bring back. */
	isNeedsReplyCleared: boolean;
	ruleDraftId: Id<'mailRuleDrafts'> | null;
}

/**
 * Whether the thread's override no longer places its newest message: a digest
 * or updates Fix older than an exact-wording candidate (#1384).
 */
async function isThreadOverrideOverruled(fix: FixContext): Promise<boolean> {
	const override = fix.thread.placementOverride;
	if (!override) return false;
	const record = await newestArrivalRecord(fix.ctx, fix.thread._id);
	if (!record) return false;
	return !doesThreadOverrideHold(
		{
			...(record.isExactWordingCandidate ? { isExactWordingCandidate: true } : {}),
			arrivedAt: record.createdAt,
		},
		override
	);
}

/**
 * Set (or clear) the thread's placement override, logged. Returns 1 when it
 * changed. Choosing the same destination again renews an override the wording
 * overruled, so the person's newer choice places the message.
 */
async function writeThreadOverride(
	fix: FixContext,
	placement: ThreadPlacement | null
): Promise<number> {
	const { ctx, thread, operationId, now } = fix;
	const before = thread.placementOverride ?? null;
	if ((before?.placement ?? null) === placement) {
		if (placement === null || !(await isThreadOverrideOverruled(fix))) return 0;
	}
	const after: PlacementOverrideRow | null = placement
		? { placement, setAt: now, operationId }
		: null;
	await ctx.db.patch(thread._id, {
		placementOverride: after ?? undefined,
		lastArrivalOperationId: operationId,
		updatedAt: now,
	});
	await ctx.db.insert(
		'mailArrivalOperationChanges',
		arrivalChangeRow({
			operationId,
			mailboxId: thread.mailboxId,
			change: { kind: 'threadPlacementOverride', threadId: thread._id, before, after },
			now,
		})
	);
	return 1;
}

/**
 * Move messages and log each move as a `messageFolder` change; the first row
 * of a thread whose reply reminder the move clears says so.
 */
async function moveLogged(
	fix: FixContext,
	messages: Doc<'mailMessages'>[],
	targetFolderId: Id<'mailFolders'>
): Promise<{ moved: number; isNeedsReplyCleared: boolean }> {
	const { ctx, operationId, now } = fix;
	if (messages.length === 0) return { moved: 0, isNeedsReplyCleared: false };
	const target = await ctx.db.get(targetFolderId);
	const clears = target?.role === 'archive' || target?.role === 'trash';
	const pending = new Set<Id<'mailThreads'>>();
	for (const threadId of new Set(messages.map((m) => m.threadId))) {
		if (clears && (await ctx.db.get(threadId))?.needsReply) pending.add(threadId);
	}
	const threadOf = new Map(messages.map((m) => [m._id, m.threadId]));
	const { moved } = await moveMessagesToFolder(ctx, {
		messageIds: messages.map((m) => m._id),
		targetFolderId,
	});
	let isNeedsReplyCleared = false;
	for (const row of moved) {
		const threadId = threadOf.get(row.messageId);
		const isCleared = threadId !== undefined && pending.delete(threadId);
		isNeedsReplyCleared ||= isCleared;
		await ctx.db.insert(
			'mailArrivalOperationChanges',
			arrivalChangeRow({
				operationId,
				mailboxId: fix.message.mailboxId,
				change: {
					kind: 'messageFolder',
					messageId: row.messageId,
					before: row.sourceFolderId,
					after: targetFolderId,
				},
				isNeedsReplyCleared: isCleared,
				now,
			})
		);
	}
	return { moved: moved.length, isNeedsReplyCleared };
}

/** Bring the fixed message back from Archive when the destination keeps mail visible. */
async function restoreFromArchive(fix: FixContext): Promise<number> {
	const { ctx, message } = fix;
	const archiveId = await folderId(ctx, message.mailboxId, 'archive');
	if (!archiveId || message.folderId !== archiveId) return 0;
	const inboxId = await folderId(ctx, message.mailboxId, 'inbox');
	if (!inboxId) return 0;
	return (await moveLogged(fix, [message], inboxId)).moved;
}

/** The thread's newest ≤200 messages that sit in the Inbox. */
async function threadInboxMessages(fix: FixContext): Promise<Doc<'mailMessages'>[]> {
	const { ctx, thread } = fix;
	const inboxId = await folderId(ctx, thread.mailboxId, 'inbox');
	if (!inboxId) return [];
	return await ctx.db
		.query('mailMessages')
		.withIndex('by_thread_folder_received', (q) =>
			q.eq('threadId', thread._id).eq('folderId', inboxId)
		)
		.order('desc')
		.take(SENDER_RESORT_LIMIT);
}

type ScopeOutcome = Pick<FixResult, 'archived' | 'resorted' | 'isNeedsReplyCleared'> & {
	changes: number;
};

async function fixThread(fix: FixContext, destination: FixDestination): Promise<ScopeOutcome> {
	if (destination !== 'auto_archive') {
		const changes = (await writeThreadOverride(fix, destination)) + (await restoreFromArchive(fix));
		return { changes, archived: 0, resorted: 0, isNeedsReplyCleared: false };
	}
	const archiveId = await folderId(fix.ctx, fix.thread.mailboxId, 'archive');
	if (!archiveId) throwInvalidInput('This mailbox has no Archive folder');
	const { moved, isNeedsReplyCleared } = await moveLogged(
		fix,
		await threadInboxMessages(fix),
		archiveId
	);
	return { changes: moved, archived: moved, resorted: 0, isNeedsReplyCleared };
}

/** Set the sender's placement override, logged. Returns 1 when it changed. */
async function writeSenderOverride(
	fix: FixContext,
	profile: Doc<'mailSenderProfiles'>,
	placement: 'needs_me' | 'today' | 'updates'
): Promise<number> {
	const { ctx, operationId, now } = fix;
	const before = profile.placementOverride ?? null;
	if (before === placement) return 0;
	await ctx.db.patch(profile._id, {
		placementOverride: placement,
		placementOverrideOperationId: operationId,
		lastOperationId: operationId,
		updatedAt: now,
	});
	await ctx.db.insert(
		'mailArrivalOperationChanges',
		arrivalChangeRow({
			operationId,
			mailboxId: profile.mailboxId,
			change: {
				kind: 'senderPlacementOverride',
				senderDigest: profile.senderDigest,
				before,
				after: placement,
			},
			now,
		})
	);
	return 1;
}

async function fixSender(
	fix: FixContext,
	profile: Doc<'mailSenderProfiles'>,
	destination: FixDestination
): Promise<ScopeOutcome> {
	const { ctx, operationId, now } = fix;
	let changes = await writeThreadOverride(fix, null);
	const setStatus = async (status: 'keep' | 'digest' | 'auto_archive') => {
		const isChanged = await writeSenderStatus(ctx, {
			profile,
			status,
			statusSource: 'user',
			operationId,
			now,
		});
		if (isChanged) changes += 1;
	};
	if (destination === 'auto_archive') {
		await setStatus('auto_archive');
		const before = changes;
		const archived = await archiveSenderInbox(ctx, { profile, operationId, now });
		changes += archived;
		const cleared = await ctx.db
			.query('mailArrivalOperationChanges')
			.withIndex('by_operation', (q) => q.eq('operationId', operationId))
			.take(before + archived);
		return {
			changes,
			archived,
			resorted: 0,
			isNeedsReplyCleared: cleared.some((row) => row.isNeedsReplyCleared === true),
		};
	}
	if (destination === 'digest') {
		await setStatus('digest');
	} else {
		// Always `keep` set by the person: a default or learned `keep` would stay
		// learnable, and a later learned digest would undo "Always here".
		await setStatus('keep');
		changes += await writeSenderOverride(fix, profile, destination);
		changes += await restoreFromArchive(fix);
	}
	const { resorted } = await resortSenderThreads(ctx, profile);
	return { changes, archived: 0, resorted, isNeedsReplyCleared: false };
}

/** The rule-draft row a Fix reason compiles into, and its scheduled compile. */
async function startRuleDraft(fix: FixContext, reason: string): Promise<Id<'mailRuleDrafts'>> {
	const { ctx, message, now } = fix;
	const draftId = await ctx.db.insert('mailRuleDrafts', {
		mailboxId: message.mailboxId,
		sourceText: await sealBodyAtWrite(reason),
		status: 'compiling',
		origin: 'fix',
		fromMessageId: message._id,
		createdAt: now,
		expiresAt: now + ARRIVAL_RETENTION_MS.ruleDraft,
	});
	await ctx.scheduler.runAfter(0, internal.mail.arrival.fixCompile.compile, { draftId });
	return draftId;
}

/** Fix one message's sorting (see the module doc). */
// authz: requireMailboxAccess on the message's mailbox, personal mailboxes only.
export const apply = postboxMutation({
	args: {
		messageId: v.id('mailMessages'),
		destination: literalUnion(FIX_DESTINATIONS),
		scope: v.union(v.literal('message'), v.literal('sender')),
		reason: v.optional(v.string()),
	},
	handler: async (ctx, args, session): Promise<FixResult> => {
		const message = await ctx.db.get(args.messageId);
		if (!message) throwNotFound('Message');
		const owned = await requireMailboxAccess(ctx, message.mailboxId, 'member', session);
		if (!owned.ok) throwForbidden('Mailbox not accessible');
		if (!isPersonalMailbox(owned.mailbox)) throwInvalidInput('Fix is for personal mail only');
		if (isFromMailboxOwner(message, owned.mailbox.address)) {
			throwInvalidInput('That is your own mail');
		}
		const thread = await ctx.db.get(message.threadId);
		if (!thread) throwNotFound('Thread');
		const reason = args.reason?.trim().slice(0, MAX_FIX_REASON_CHARS) || undefined;
		const now = Date.now();
		const profile =
			args.scope === 'sender'
				? await ensureSenderProfile(ctx, {
						mailboxId: message.mailboxId,
						address: message.fromAddress,
						displayName: message.fromName,
						now,
					})
				: null;
		const operationId = await startSenderOperation(ctx, {
			mailboxId: message.mailboxId,
			kind: 'fix',
			actor: 'user',
			...(profile ? { senderDigest: profile.senderDigest } : {}),
			threadId: thread._id,
			messageId: message._id,
			...(reason ? { reason: await sealBodyAtWrite(reason) } : {}),
			now,
		});
		const fix: FixContext = { ctx, message, thread, operationId, now };
		const outcome = profile
			? await fixSender(fix, profile, args.destination)
			: await fixThread(fix, args.destination);
		await refreshArrivalProjection(ctx, thread._id);
		const ruleDraftId = reason ? await startRuleDraft(fix, reason) : null;
		if (outcome.changes === 0 && !reason) {
			// Nothing changed and nothing to keep: no empty operation to undo.
			await ctx.db.delete(operationId);
		} else {
			await addOperationChanges(ctx, operationId, outcome.changes);
		}
		return {
			operationId: outcome.changes === 0 && !reason ? null : operationId,
			archived: outcome.archived,
			resorted: outcome.resorted,
			address: profile?.address ?? message.fromAddress,
			...(message.fromName ? { displayName: message.fromName } : {}),
			isNeedsReplyCleared: outcome.isNeedsReplyCleared,
			ruleDraftId,
		};
	},
});
