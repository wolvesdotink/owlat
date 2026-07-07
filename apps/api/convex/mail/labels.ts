/**
 * Gmail-style labels (orthogonal to folders).
 *
 * A message can carry many labels at once; labels are filterable and
 * displayed as colored chips in the thread reader. Labels are mailbox-
 * scoped — they do not leak across mailboxes within an org.
 */

import { v } from 'convex/values';
import { authedMutation, publicQuery } from '../lib/authedFunctions';
import { internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { loadOwnedMailbox } from './permissions';

/** Per-batch row cap for the scheduled label-reference cleanup. */
const LABEL_CLEANUP_BATCH = 256;
import {
	throwAlreadyExists,
	throwForbidden,
	throwInvalidInput,
	throwNotFound,
} from '../_utils/errors';

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export const create = authedMutation({
	args: {
		mailboxId: v.id('mailboxes'),
		name: v.string(),
		color: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const owned = await loadOwnedMailbox(ctx, args.mailboxId);
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
		const label = await ctx.db.get(args.labelId);
		if (!label) throwNotFound('Label');
		const owned = await loadOwnedMailbox(ctx, label.mailboxId);
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
		const owned = await loadOwnedMailbox(ctx, label.mailboxId);
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

// public: soft-auth — returns empty for anonymous; mailbox ownership is still enforced in-handler
export const list = publicQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => {
		const owned = await loadOwnedMailbox(ctx, args.mailboxId);
		if (!owned.ok) return [];
		return ctx.db
			.query('mailLabels')
			.withIndex('by_mailbox', (q) => q.eq('mailboxId', args.mailboxId))
			.collect(); // bounded: one mailbox's labels
	},
});

/** Add or remove a label on a single message. */
export const toggleOnMessage = authedMutation({
	args: {
		messageId: v.id('mailMessages'),
		labelId: v.id('mailLabels'),
		add: v.boolean(),
	},
	handler: async (ctx, args) => {
		const message = await ctx.db.get(args.messageId);
		if (!message) throwNotFound('Message');
		const owned = await loadOwnedMailbox(ctx, message.mailboxId);
		if (!owned.ok) throwForbidden('Message not accessible');

		const label = await ctx.db.get(args.labelId);
		if (!label || label.mailboxId !== message.mailboxId) {
			throwInvalidInput('Label does not belong to this mailbox');
		}

		const has = message.labelIds.includes(args.labelId);
		if (args.add && has) return;
		if (!args.add && !has) return;

		const now = Date.now();
		const newLabels = args.add
			? [...message.labelIds, args.labelId]
			: message.labelIds.filter((id) => id !== args.labelId);

		// Bump modseq so IMAP CONDSTORE clients pick up the change
		const folder = await ctx.db.get(message.folderId);
		if (!folder) return;
		const modseq = folder.highestModseq + 1;
		await ctx.db.patch(folder._id, { highestModseq: modseq, updatedAt: now });

		await ctx.db.patch(args.messageId, {
			labelIds: newLabels,
			modseq,
			updatedAt: now,
		});

		// Reflect on thread aggregate
		const thread = await ctx.db.get(message.threadId);
		if (thread) {
			const threadLabels = new Set(thread.labelIds);
			if (args.add) {
				threadLabels.add(args.labelId);
			} else {
				// Only remove from the thread if no other message still carries it
				const siblings = await ctx.db
					.query('mailMessages')
					.withIndex('by_thread', (q) => q.eq('threadId', message.threadId))
					.collect(); // bounded: one thread's messages
				const stillUsed = siblings.some(
					(m) => m._id !== args.messageId && m.labelIds.includes(args.labelId)
				);
				if (!stillUsed) threadLabels.delete(args.labelId);
			}
			await ctx.db.patch(thread._id, {
				labelIds: Array.from(threadLabels),
				updatedAt: now,
			});
		}
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
		const thread = await ctx.db.get(args.threadId);
		if (!thread) throwNotFound('Thread');
		const owned = await loadOwnedMailbox(ctx, thread.mailboxId);
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
