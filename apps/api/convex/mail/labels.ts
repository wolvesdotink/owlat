/**
 * Gmail-style labels (orthogonal to folders).
 *
 * A message can carry many labels at once; labels are filterable and
 * displayed as colored chips in the thread reader. Labels are mailbox-
 * scoped — they do not leak across mailboxes within an org.
 */

import { v } from 'convex/values';
import { authedMutation, publicQuery } from '../lib/authedFunctions';
import { internalMutation, type MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { requireMailboxAccess } from './permissions';

/** Per-batch row cap for the scheduled label-reference cleanup. */
const LABEL_CLEANUP_BATCH = 256;
import {
	getOrThrow,
	throwAlreadyExists,
	throwForbidden,
	throwInvalidInput,
} from '../_utils/errors';

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export const create = authedMutation({
	args: {
		mailboxId: v.id('mailboxes'),
		name: v.string(),
		color: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId);
		if (!owned.ok) throwForbidden('Mailbox not accessible');

		const trimmed = args.name.trim();
		if (!trimmed) throwInvalidInput('Label name required');
		if (args.color && !HEX_COLOR.test(args.color)) {
			throwInvalidInput('Color must be a 6-digit hex string');
		}

		const conflict = await ctx.db
			.query('mailLabels')
			.withIndex('by_mailbox_and_name', (q) =>
				q.eq('mailboxId', args.mailboxId).eq('name', trimmed)
			)
			.first();
		if (conflict) throwAlreadyExists(`Label "${trimmed}" already exists`);

		return ctx.db.insert('mailLabels', {
			mailboxId: args.mailboxId,
			name: trimmed,
			color: args.color,
			createdAt: Date.now(),
		});
	},
});

export const update = authedMutation({
	args: {
		labelId: v.id('mailLabels'),
		name: v.optional(v.string()),
		color: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const label = await getOrThrow(ctx, args.labelId, 'Label');
		const owned = await requireMailboxAccess(ctx, label.mailboxId);
		if (!owned.ok) throwForbidden('Label not accessible');

		const patch: Record<string, unknown> = {};
		if (args.name !== undefined) {
			const trimmed = args.name.trim();
			if (!trimmed) throwInvalidInput('Label name required');
			const conflict = await ctx.db
				.query('mailLabels')
				.withIndex('by_mailbox_and_name', (q) =>
					q.eq('mailboxId', label.mailboxId).eq('name', trimmed)
				)
				.first();
			if (conflict && conflict._id !== label._id) {
				throwAlreadyExists(`Label "${trimmed}" already exists`);
			}
			patch['name'] = trimmed;
		}
		if (args.color !== undefined) {
			if (args.color && !HEX_COLOR.test(args.color)) {
				throwInvalidInput('Color must be a 6-digit hex string');
			}
			patch['color'] = args.color || undefined;
		}
		if (Object.keys(patch).length > 0) {
			await ctx.db.patch(args.labelId, patch);
		}
	},
});

export const remove = authedMutation({
	args: { labelId: v.id('mailLabels') },
	handler: async (ctx, args) => {
		const label = await ctx.db.get(args.labelId);
		if (!label) return;
		const owned = await requireMailboxAccess(ctx, label.mailboxId);
		if (!owned.ok) throwForbidden('Label not accessible');

		// Delete the label row immediately — read paths ignore unresolved labelIds,
		// so the chip simply stops rendering. Stripping the (unindexed-array)
		// labelId from every message + thread that carries it is detached into a
		// scheduled, cursor-paginated continuation so a long-lived mailbox
		// (potentially millions of rows) can't blow the per-mutation read/write
		// budget on a single whole-mailbox collect — which made the label
		// undeletable at scale.
		await ctx.db.delete(args.labelId);
		await ctx.scheduler.runAfter(0, internal.mail.labels.stripLabelReferences, {
			mailboxId: label.mailboxId,
			labelId: args.labelId,
			phase: 'messages',
			cursor: null,
		});
	},
});

/**
 * Scheduled continuation that strips a deleted label's id from messages then
 * threads, one bounded page per invocation, rescheduling itself until both are
 * drained. Each transaction touches at most LABEL_CLEANUP_BATCH rows.
 */
export const stripLabelReferences = internalMutation({
	args: {
		mailboxId: v.id('mailboxes'),
		labelId: v.id('mailLabels'),
		phase: v.union(v.literal('messages'), v.literal('threads')),
		cursor: v.union(v.string(), v.null()),
	},
	handler: async (ctx, args) => {
		const now = Date.now();

		if (args.phase === 'messages') {
			const { page, isDone, continueCursor } = await ctx.db
				.query('mailMessages')
				.withIndex('by_mailbox_and_received', (q) => q.eq('mailboxId', args.mailboxId))
				.paginate({ cursor: args.cursor, numItems: LABEL_CLEANUP_BATCH });
			for (const m of page) {
				if (m.labelIds.includes(args.labelId)) {
					await ctx.db.patch(m._id, {
						labelIds: m.labelIds.filter((id) => id !== args.labelId),
						updatedAt: now,
					});
				}
			}
			await ctx.scheduler.runAfter(0, internal.mail.labels.stripLabelReferences, {
				mailboxId: args.mailboxId,
				labelId: args.labelId,
				phase: isDone ? 'threads' : 'messages',
				cursor: isDone ? null : continueCursor,
			});
			return;
		}

		// phase === 'threads'
		const { page, isDone, continueCursor } = await ctx.db
			.query('mailThreads')
			.withIndex('by_mailbox_and_last_message', (q) => q.eq('mailboxId', args.mailboxId))
			.paginate({ cursor: args.cursor, numItems: LABEL_CLEANUP_BATCH });
		for (const t of page) {
			if (t.labelIds.includes(args.labelId)) {
				await ctx.db.patch(t._id, {
					labelIds: t.labelIds.filter((id) => id !== args.labelId),
					updatedAt: now,
				});
			}
		}
		if (!isDone) {
			await ctx.scheduler.runAfter(0, internal.mail.labels.stripLabelReferences, {
				mailboxId: args.mailboxId,
				labelId: args.labelId,
				phase: 'threads',
				cursor: continueCursor,
			});
		}
	},
});

// public: soft-auth — returns empty for anonymous; mailbox access is still enforced in-handler
export const list = publicQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId);
		if (!owned.ok) return [];
		return ctx.db
			.query('mailLabels')
			.withIndex('by_mailbox', (q) => q.eq('mailboxId', args.mailboxId))
			.collect(); // bounded: one mailbox's labels
	},
});

/**
 * Write one message's label membership. Returns false when the message already
 * had the requested state (nothing patched), so batch callers can skip the
 * thread reconciliation for a no-op.
 */
async function applyLabelToMessage(
	ctx: MutationCtx,
	message: Doc<'mailMessages'>,
	labelId: Id<'mailLabels'>,
	add: boolean,
	now: number
): Promise<boolean> {
	const has = message.labelIds.includes(labelId);
	if (add === has) return false;

	// Bump modseq so IMAP CONDSTORE clients pick up the change
	const folder = await ctx.db.get(message.folderId);
	if (!folder) return false;
	const modseq = folder.highestModseq + 1;
	await ctx.db.patch(folder._id, { highestModseq: modseq, updatedAt: now });

	await ctx.db.patch(message._id, {
		labelIds: add ? [...message.labelIds, labelId] : message.labelIds.filter((id) => id !== labelId),
		modseq,
		updatedAt: now,
	});
	return true;
}

/**
 * Re-derive whether a thread still carries a label from its messages, AFTER
 * their rows have been written. Done once per touched thread (not once per
 * message) so a batch that labels twenty messages of one conversation pays a
 * single sibling scan.
 */
async function reconcileThreadLabel(
	ctx: MutationCtx,
	threadId: Id<'mailThreads'>,
	labelId: Id<'mailLabels'>,
	now: number
): Promise<void> {
	const thread = await ctx.db.get(threadId);
	if (!thread) return;
	const siblings = await ctx.db
		.query('mailMessages')
		.withIndex('by_thread', (q) => q.eq('threadId', threadId))
		.collect(); // bounded: one thread's messages
	const stillUsed = siblings.some((m) => m.labelIds.includes(labelId));
	if (stillUsed === thread.labelIds.includes(labelId)) return;
	const threadLabels = new Set(thread.labelIds);
	if (stillUsed) threadLabels.add(labelId);
	else threadLabels.delete(labelId);
	await ctx.db.patch(threadId, { labelIds: Array.from(threadLabels), updatedAt: now });
}

/** Add or remove a label on a single message. */
export const toggleOnMessage = authedMutation({
	args: {
		messageId: v.id('mailMessages'),
		labelId: v.id('mailLabels'),
		add: v.boolean(),
	},
	handler: async (ctx, args) => {
		const message = await getOrThrow(ctx, args.messageId, 'Message');
		const owned = await requireMailboxAccess(ctx, message.mailboxId);
		if (!owned.ok) throwForbidden('Message not accessible');

		const label = await ctx.db.get(args.labelId);
		if (!label || label.mailboxId !== message.mailboxId) {
			throwInvalidInput('Label does not belong to this mailbox');
		}

		const now = Date.now();
		if (!(await applyLabelToMessage(ctx, message, args.labelId, args.add, now))) return;
		await reconcileThreadLabel(ctx, message.threadId, args.labelId, now);
	},
});

/**
 * Per-call ceiling on a batch label write, matching
 * `mailbox/selection.BULK_SELECTION_CAP`: a selection that query hands out is
 * always one this mutation can apply in a single transaction.
 */
const LABEL_BATCH_CAP = 500;

/**
 * Add or remove ONE label across many messages in a single transaction — the
 * write behind the thread list's bulk "Label" action, which previously fired
 * `toggleOnMessage` once per selected row (N round trips, N partial states
 * visible to the live query, and no way to fail as a unit).
 *
 * Access is checked per message rather than once for the batch: a selection is
 * client-supplied and may name ids from another mailbox. An unreachable or
 * missing id is SKIPPED, not fatal — the same shape `messageActions.setFlags`
 * uses, so a stale row in a selection can't sink the whole action. The count of
 * messages actually changed comes back for the caller's toast.
 */
export const setOnMessages = authedMutation({
	args: {
		messageIds: v.array(v.id('mailMessages')),
		labelId: v.id('mailLabels'),
		add: v.boolean(),
	},
	handler: async (ctx, args): Promise<{ changed: number }> => {
		if (args.messageIds.length > LABEL_BATCH_CAP) {
			throwInvalidInput(`At most ${LABEL_BATCH_CAP} messages per batch`);
		}
		const label = await getOrThrow(ctx, args.labelId, 'Label');
		const owned = await requireMailboxAccess(ctx, label.mailboxId);
		if (!owned.ok) throwForbidden('Label not accessible');

		const now = Date.now();
		const touchedThreads = new Set<Id<'mailThreads'>>();
		let changed = 0;
		for (const id of args.messageIds) {
			const message = await ctx.db.get(id);
			// Cross-mailbox ids are the reason this is a per-message check: the
			// label's mailbox is the authority, so a message from anywhere else is
			// simply not part of this batch.
			if (!message || message.mailboxId !== label.mailboxId) continue;
			if (await applyLabelToMessage(ctx, message, args.labelId, args.add, now)) {
				changed += 1;
				touchedThreads.add(message.threadId);
			}
		}
		for (const threadId of touchedThreads) {
			await reconcileThreadLabel(ctx, threadId, args.labelId, now);
		}
		return { changed };
	},
});

/** Apply a label to every message in a thread. */
export const toggleOnThread = authedMutation({
	args: {
		threadId: v.id('mailThreads'),
		labelId: v.id('mailLabels'),
		add: v.boolean(),
	},
	handler: async (ctx, args) => {
		const thread = await getOrThrow(ctx, args.threadId, 'Thread');
		const owned = await requireMailboxAccess(ctx, thread.mailboxId);
		if (!owned.ok) throwForbidden('Thread not accessible');

		const label = await ctx.db.get(args.labelId);
		if (!label || label.mailboxId !== thread.mailboxId) {
			throwInvalidInput('Label does not belong to this mailbox');
		}

		const messages = await ctx.db
			.query('mailMessages')
			.withIndex('by_thread', (q) => q.eq('threadId', args.threadId))
			.collect(); // bounded: one thread's messages

		const now = Date.now();
		const folderModseqBumps = new Map<Id<'mailFolders'>, number>();

		for (const m of messages) {
			const has = m.labelIds.includes(args.labelId);
			if (args.add === has) continue;
			const newLabels = args.add
				? [...m.labelIds, args.labelId]
				: m.labelIds.filter((id) => id !== args.labelId);
			const folder = await ctx.db.get(m.folderId);
			if (!folder) continue;
			const nextModseq = folderModseqBumps.get(folder._id) ?? folder.highestModseq + 1;
			folderModseqBumps.set(folder._id, nextModseq + 1);
			await ctx.db.patch(folder._id, { highestModseq: nextModseq, updatedAt: now });
			await ctx.db.patch(m._id, {
				labelIds: newLabels,
				modseq: nextModseq,
				updatedAt: now,
			});
		}

		const threadLabels = new Set(thread.labelIds);
		if (args.add) {
			threadLabels.add(args.labelId);
		} else {
			threadLabels.delete(args.labelId);
		}
		await ctx.db.patch(args.threadId, {
			labelIds: Array.from(threadLabels),
			updatedAt: now,
		});
	},
});
