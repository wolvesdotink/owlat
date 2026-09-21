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
import {
	getOrThrow,
	throwAlreadyExists,
	throwForbidden,
	throwInvalidInput,
} from '../_utils/errors';
import { requireMailboxAccess } from './permissions';
import { applyLabelToMessage, reconcileThreadLabel } from './labelsMembership';
import {
	LABEL_MAX_DEPTH,
	LABEL_PATH_SEPARATOR,
	findOrCreateSegment,
	labelDepth,
	wouldCycle,
} from './labelsTree';

/** Per-batch row cap for the scheduled label-reference cleanup. */
const LABEL_CLEANUP_BATCH = 256;

/** Labels carry a chip colour; anything but a 6-digit hex is refused. */
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * Create a label, optionally nested.
 *
 * `name` may be a PATH (`Work/Clients/Acme`): every missing ancestor is created
 * on the way down and the leaf is returned, so nesting is one action instead of
 * three. Existing ancestors are reused, which also makes the whole call
 * idempotent for a path that already exists except for its leaf.
 *
 * `parentId` roots the path under an existing label; passing both means
 * "`Clients/Acme` under Work".
 */
export const create = authedMutation({
	args: {
		mailboxId: v.id('mailboxes'),
		name: v.string(),
		color: v.optional(v.string()),
		parentId: v.optional(v.id('mailLabels')),
	},
	handler: async (ctx, args): Promise<Id<'mailLabels'>> => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId);
		if (!owned.ok) throwForbidden('Mailbox not accessible');

		if (args.color && !HEX_COLOR.test(args.color)) {
			throwInvalidInput('Color must be a 6-digit hex string');
		}

		const segments = args.name
			.split(LABEL_PATH_SEPARATOR)
			.map((part) => part.trim())
			.filter(Boolean);
		if (segments.length === 0) throwInvalidInput('Label name required');

		let parentId = args.parentId;
		let baseDepth = 0;
		if (parentId) {
			const parent = await ctx.db.get(parentId);
			if (!parent || parent.mailboxId !== args.mailboxId) {
				throwInvalidInput('Parent label does not belong to this mailbox');
			}
			baseDepth = (await labelDepth(ctx, parentId)) + 1;
		}
		if (baseDepth + segments.length - 1 > LABEL_MAX_DEPTH) {
			throwInvalidInput(`Labels nest at most ${LABEL_MAX_DEPTH} levels deep`);
		}

		let leafId!: Id<'mailLabels'>;
		let leafCreated = false;
		for (const [index, segment] of segments.entries()) {
			// Only the leaf carries the colour — an ancestor created on the way
			// down is scaffolding, not a label the user chose a colour for.
			const isLeaf = index === segments.length - 1;
			const { id, created } = await findOrCreateSegment(
				ctx,
				args.mailboxId,
				segment,
				parentId,
				isLeaf ? args.color : undefined
			);
			parentId = id;
			leafId = id;
			leafCreated = created;
		}
		// A single-segment name that already exists is the old duplicate error.
		// A PATH is allowed to be partly present — that is how nesting under an
		// existing branch works — so only the leaf's existence is a conflict.
		if (!leafCreated) throwAlreadyExists(`Label "${segments.join('/')}" already exists`);
		return leafId;
	},
});

export const update = authedMutation({
	args: {
		labelId: v.id('mailLabels'),
		name: v.optional(v.string()),
		color: v.optional(v.string()),
		/** `null` detaches to a root; omitted leaves the parent alone. */
		parentId: v.optional(v.union(v.id('mailLabels'), v.null())),
		order: v.optional(v.number()),
		isPinned: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		const label = await getOrThrow(ctx, args.labelId, 'Label');
		const owned = await requireMailboxAccess(ctx, label.mailboxId);
		if (!owned.ok) throwForbidden('Label not accessible');

		const patch: Record<string, unknown> = {};
		if (args.name !== undefined) {
			const trimmed = args.name.trim();
			if (!trimmed) throwInvalidInput('Label name required');
			// Uniqueness is per PARENT, matching create: `Work/Archive` and
			// `Personal/Archive` are two different labels, and a mailbox-wide check
			// would refuse the second one.
			const siblings = await ctx.db
				.query('mailLabels')
				.withIndex('by_mailbox_and_parent', (q) =>
					q.eq('mailboxId', label.mailboxId).eq('parentId', label.parentId)
				)
				.collect(); // bounded: one parent's children
			if (siblings.some((row) => row._id !== label._id && row.name === trimmed)) {
				throwAlreadyExists(`Label "${trimmed}" already exists`);
			}
			patch['name'] = trimmed;
		}
		if (args.parentId !== undefined) {
			if (args.parentId === null) {
				patch['parentId'] = undefined;
			} else {
				const parent = await ctx.db.get(args.parentId);
				if (!parent || parent.mailboxId !== label.mailboxId) {
					throwInvalidInput('Parent label does not belong to this mailbox');
				}
				if (
					args.parentId === args.labelId ||
					(await wouldCycle(ctx, args.labelId, args.parentId))
				) {
					throwInvalidInput('A label cannot be nested inside itself');
				}
				if ((await labelDepth(ctx, args.parentId)) + 1 > LABEL_MAX_DEPTH) {
					throwInvalidInput(`Labels nest at most ${LABEL_MAX_DEPTH} levels deep`);
				}
				patch['parentId'] = args.parentId;
			}
		}
		if (args.order !== undefined) patch['order'] = args.order;
		if (args.isPinned !== undefined) patch['isPinned'] = args.isPinned;
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
		// A deleted branch's children are RE-PARENTED to the deleted label's own
		// parent, not deleted with it. Cascading would make one click destroy an
		// arbitrary amount of work with nothing to undo it; promoting the children
		// loses only the grouping level the user explicitly removed.
		const children = await ctx.db
			.query('mailLabels')
			.withIndex('by_mailbox_and_parent', (q) =>
				q.eq('mailboxId', label.mailboxId).eq('parentId', args.labelId)
			)
			.collect(); // bounded: one parent's children
		for (const child of children) {
			await ctx.db.patch(child._id, { parentId: label.parentId });
		}

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
 * Write a new sibling order in one transaction.
 *
 * Takes the ids in their intended order and stamps 0..n-1, so the caller sends
 * the outcome it wants rather than a delta the server has to replay. Ids from
 * another mailbox are skipped rather than fatal — a stale rail can't sink the
 * whole reorder.
 */
export const reorder = authedMutation({
	args: {
		mailboxId: v.id('mailboxes'),
		/** Sibling ids, first to last, all sharing one parent. */
		labelIds: v.array(v.id('mailLabels')),
	},
	handler: async (ctx, args): Promise<void> => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId);
		if (!owned.ok) throwForbidden('Mailbox not accessible');
		for (const [index, labelId] of args.labelIds.entries()) {
			const label = await ctx.db.get(labelId);
			if (!label || label.mailboxId !== args.mailboxId) continue;
			if (label.order === index) continue;
			await ctx.db.patch(labelId, { order: index });
		}
	},
});

/**
 * How far back the unread-per-label tally reads.
 *
 * `labelIds` is an array, and Convex has no element-containment index for one,
 * so a per-label count means scanning messages and tallying in-query — the same
 * constraint (and the same honest bound) as `mailbox/queries.listByLabel`. The
 * scan runs over `by_mailbox_and_unseen`, so it only ever touches UNREAD rows:
 * on a mailbox that is anywhere near read, that is a handful of documents, not
 * a window into the archive.
 */
const UNREAD_TALLY_WINDOW = 2000;

/**
 * Unread count per label for the folder rail.
 *
 * Returns a sparse record — labels with no unread mail are simply absent, which
 * is what the rail renders as "no badge". `truncated` reports that the scan hit
 * its cap, so the UI can say "999+" rather than assert an undercount as fact.
 */
// public: soft-auth — returns empty for anonymous; mailbox access is still enforced in-handler
export const unreadCounts = publicQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args): Promise<{ counts: Record<string, number>; isTruncated: boolean }> => {
		const empty = { counts: {}, isTruncated: false };
		const owned = await requireMailboxAccess(ctx, args.mailboxId);
		if (!owned.ok) return empty;

		const unread = await ctx.db
			.query('mailMessages')
			.withIndex('by_mailbox_and_unseen', (q) =>
				q.eq('mailboxId', args.mailboxId).eq('flagSeen', false)
			)
			.take(UNREAD_TALLY_WINDOW);

		const counts: Record<string, number> = {};
		for (const message of unread) {
			for (const labelId of message.labelIds) {
				counts[labelId] = (counts[labelId] ?? 0) + 1;
			}
		}
		return { counts, isTruncated: unread.length === UNREAD_TALLY_WINDOW };
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
