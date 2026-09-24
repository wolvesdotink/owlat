/**
 * Contact-erasure phases for the person's correspondence and the knowledge
 * derived from it: threads, messages, form submissions, knowledge entries and
 * semantic files. Every parent drains its own children before it is deleted,
 * so a transaction that runs out of budget midway leaves the parent in place
 * and the next one finds it again.
 */

import type { Doc, Id } from '../../_generated/dataModel';
import { deleteBlobQuietly } from '../../lib/storageBlobs';
import { detachContactJunctionLink, SEMANTIC_FILE_JUNCTION } from '../../lib/contactJunctions';
import {
	deleteAll,
	drainEach,
	drainParents,
	type PhaseContext,
	type PhaseRunner,
} from './phaseKit';

const LOG_TAG = '[contacts] erasure';

type MessageRow = Doc<'unifiedMessages'> | Doc<'inboundMessages'> | Doc<'formSubmissions'>;

/**
 * Delete one message-like row and the bytes it owns. A team-inbox row carries
 * the WHOLE received message as a sealed `.eml` in `_storage`; deleting the row
 * alone would leave the person's words in storage with nothing pointing at
 * them (the retention sweep finds blobs by walking the rows). Older and swept
 * rows have no blob.
 */
async function deleteMessageRow({ ctx }: PhaseContext, row: MessageRow): Promise<void> {
	if ('rawStorageId' in row && row.rawStorageId) {
		await deleteBlobQuietly(ctx.storage, row.rawStorageId, LOG_TAG, { rowId: row._id });
	}
	await ctx.db.delete(row._id);
}

/**
 * The agent's work on an erased message is about the message: its step inputs
 * and outputs (the model's reading of the mail and the reply it drafted) and
 * the shadow-mode decision (sender address plus a draft snapshot) are deleted.
 * Autonomy feedback trains the organization's rules and carries no message
 * content, so it only loses the pointer. Returns whether all of it is done.
 */
async function eraseInboundMessageDescendants(
	phase: PhaseContext,
	inboundMessageId: Id<'inboundMessages'>
): Promise<boolean> {
	const { ctx, budget } = phase;
	const actionsGone = await deleteAll(phase, (n) =>
		ctx.db
			.query('agentActions')
			.withIndex('by_inbound_message', (q) => q.eq('inboundMessageId', inboundMessageId))
			.take(n)
	);
	if (!actionsGone) return false;
	const shadowsGone = await deleteAll(phase, (n) =>
		ctx.db
			.query('agentShadowDecisions')
			.withIndex('by_message', (q) => q.eq('inboundMessageId', inboundMessageId))
			.take(n)
	);
	if (!shadowsGone) return false;
	return drainEach(
		budget,
		(n) =>
			ctx.db
				.query('autonomyFeedback')
				.withIndex('by_inbound_message', (q) => q.eq('inboundMessageId', inboundMessageId))
				.take(n),
		(row) => ctx.db.patch(row._id, { inboundMessageId: undefined })
	);
}

/**
 * Threads with the contact go with every message in them, including
 * organization replies that quote the person, and with the team's follow-ups
 * written to them. A follow-up still inside its undo window has its dispatch
 * cancelled; one already handed to a Send finds no row when that Send lands
 * (`inbox/followUps.ts completeSend` returns on a missing follow-up).
 */
export const eraseConversationThreads: PhaseRunner = (phase) => {
	const { ctx, contactId, budget } = phase;
	return drainParents(
		budget,
		() =>
			ctx.db
				.query('conversationThreads')
				.withIndex('by_contact', (q) => q.eq('contactId', contactId))
				.first(),
		async (thread) => {
			const messagesGone = await drainEach(
				budget,
				(n) =>
					ctx.db
						.query('unifiedMessages')
						.withIndex('by_thread', (q) => q.eq('threadId', thread._id))
						.take(n),
				(message) => deleteMessageRow(phase, message)
			);
			if (!messagesGone) return false;
			const followUpsGone = await drainEach(
				budget,
				(n) =>
					ctx.db
						.query('inboxFollowUps')
						.withIndex('by_thread', (q) => q.eq('threadId', thread._id))
						.take(n),
				async (followUp) => {
					if (followUp.status === 'scheduled' && followUp.scheduledFnId) {
						await ctx.scheduler.cancel(followUp.scheduledFnId);
					}
					await ctx.db.delete(followUp._id);
				}
			);
			if (!followUpsGone) return false;
			await ctx.db.delete(thread._id);
			return true;
		}
	);
};

/** Channel messages outside a thread of the contact's. */
export const eraseUnifiedMessages: PhaseRunner = async (phase) => {
	const { ctx, contactId, budget } = phase;
	const isDone = await drainEach(
		budget,
		(n) =>
			ctx.db
				.query('unifiedMessages')
				.withIndex('by_contact', (q) => q.eq('contactId', contactId))
				.take(n),
		(message) => deleteMessageRow(phase, message)
	);
	return { isDone };
};

/** Received mail, its sealed raw message, and the agent's work on it. */
export const eraseInboundMessages: PhaseRunner = (phase) => {
	const { ctx, contactId, budget } = phase;
	return drainParents(
		budget,
		() =>
			ctx.db
				.query('inboundMessages')
				.withIndex('by_contact', (q) => q.eq('contactId', contactId))
				.first(),
		async (message) => {
			if (!(await eraseInboundMessageDescendants(phase, message._id))) return false;
			await deleteMessageRow(phase, message);
			return true;
		}
	);
};

export const eraseFormSubmissions: PhaseRunner = async (phase) => {
	const { ctx, contactId, budget } = phase;
	const isDone = await drainEach(
		budget,
		(n) =>
			ctx.db
				.query('formSubmissions')
				.withIndex('by_contact', (q) => q.eq('contactId', contactId))
				.take(n),
		(submission) => deleteMessageRow(phase, submission)
	);
	return { isDone };
};

/**
 * Knowledge about the contact, junction-driven. An entry scoped to this contact
 * alone is torn down — graph edges, every junction row, then the entry (its
 * embedding dies with the row) — and the contact's own junction row goes LAST,
 * so a teardown cut short by the budget is found again through it. A shared
 * entry only loses the link.
 */
export const eraseKnowledge: PhaseRunner = (phase) => {
	const { ctx, contactId, budget } = phase;
	return drainParents(
		budget,
		() =>
			ctx.db
				.query('knowledgeEntryContacts')
				.withIndex('by_contact', (q) => q.eq('contactId', contactId))
				.first(),
		async (link) => {
			const entry = await ctx.db.get(link.entryId);
			const remaining = (entry?.contactIds ?? []).filter((c) => c !== contactId);
			if (entry && remaining.length > 0) {
				await ctx.db.patch(entry._id, { contactIds: remaining });
				await ctx.db.delete(link._id);
				return true;
			}

			for (const index of ['by_from', 'by_to'] as const) {
				const field = index === 'by_from' ? 'fromEntryId' : 'toEntryId';
				const edgesGone = await deleteAll(phase, (n) =>
					ctx.db
						.query('knowledgeRelations')
						.withIndex(index, (q) => q.eq(field, link.entryId))
						.take(n)
				);
				if (!edgesGone) return false;
			}
			// Other junction rows of a sole-subject entry only exist through
			// drift; they go too. This contact's own row is skipped here and
			// deleted last.
			const othersGone = await drainEach(
				budget,
				async (n) => {
					const rows = await ctx.db
						.query('knowledgeEntryContacts')
						.withIndex('by_entry', (q) => q.eq('entryId', link.entryId))
						.take(n + 1);
					return rows.filter((row) => row._id !== link._id).slice(0, n);
				},
				(row) => ctx.db.delete(row._id)
			);
			if (!othersGone) return false;
			if (entry) await ctx.db.delete(entry._id);
			await ctx.db.delete(link._id);
			return true;
		}
	);
};

/**
 * Semantic files split two ways. An INBOUND CAPTURE scoped to nobody but this
 * contact is a file the person attached to their own mail — their data, like
 * the message body — and is deleted, bytes and all. Everything else, an
 * organization upload or a capture another contact is also scoped to, keeps
 * the "unlink, don't delete" rule for documents the organization owns.
 */
export const eraseSemanticFiles: PhaseRunner = (phase) => {
	const { ctx, contactId, budget } = phase;
	return drainParents(
		budget,
		() =>
			ctx.db
				.query('semanticFileContacts')
				.withIndex('by_contact', (q) => q.eq('contactId', contactId))
				.first(),
		async (link) => {
			const file = await ctx.db.get(link.fileId);
			if (!file) {
				await ctx.db.delete(link._id);
				return true;
			}
			const othersRemain = (file.contactIds ?? []).some((c) => c !== contactId);
			if (file.captureSource && !othersRemain) {
				// Junction rows of other contacts on a file scoped to this contact
				// alone only exist through drift; they go with the file. This
				// contact's own row goes last, so a cut-short pass finds it again.
				const othersGone = await drainEach(
					budget,
					async (n) => {
						const rows = await ctx.db
							.query('semanticFileContacts')
							.withIndex('by_file', (q) => q.eq('fileId', file._id))
							.take(n + 1);
						return rows.filter((row) => row._id !== link._id).slice(0, n);
					},
					(row) => ctx.db.delete(row._id)
				);
				if (!othersGone) return false;
				await ctx.db.delete(link._id);
				// Released by the inbound retention sweep already ⇒ no blob left.
				if (file.storageId) {
					await deleteBlobQuietly(ctx.storage, file.storageId, LOG_TAG, { fileId: file._id });
				}
				await ctx.db.delete(file._id);
				return true;
			}
			await detachContactJunctionLink(ctx, SEMANTIC_FILE_JUNCTION, link, contactId);
			return true;
		}
	);
};
