/**
 * Attachments on a Team inbox reply.
 *
 * The reply a person writes on a thread (an agent draft they approve, their own
 * text, or a follow-up) used to go out as text only. The thread now carries the
 * composer's attachment list (`conversationThreads.replyAttachments`) and every
 * send path takes it along (`./replyAttachmentStore.ts` has the rules):
 *
 * - `add` binds a fresh upload, with the Postbox draft's limits.
 * - `attachExisting` takes a file from Files or a received email. The caller
 *   must be able to read it (`lib/existingAttachments.ts`, shared with the
 *   Postbox draft), and the bytes are copied into a blob the reply owns by
 *   `copyExisting`; until that finishes the entry reads as "copying".
 * - `remove` drops one entry and deletes its blob.
 * - `suggestions` is the file the agent matched to the newest message's request
 *   (`inboundMessages.attachmentSuggestions`). It is only ever a suggestion:
 *   nothing reaches a send until a person attaches it here.
 *
 * Same access rule as the other reply mutations: writes are `adminMutation`,
 * reads are the soft-auth shared-inbox reader gate.
 */

import { v } from 'convex/values';
import { internalAction, type QueryCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { MAX_ATTACHMENT_BYTES, ATTACHMENT_COMPOSE_LIMITS } from '@owlat/shared/attachments';
import { adminMutation, publicQuery } from '../lib/authedFunctions';
import { getBetterAuthSessionWithRole } from '../lib/sessionOrganization';
import {
	existingAttachmentBytesValidator,
	existingAttachmentSourceValidator,
	readExistingAttachmentBytes,
} from '../lib/existingAttachments';
import type { TeamReplyAttachment } from '../lib/validators/teamReplyAttachment';
import { getOrThrow, throwInvalidInput } from '../_utils/errors';
import { logError } from '../lib/runtimeLog';
import type { NonCampaignIntakeOutcome } from '../delivery/nonCampaignIntake';
import { isSharedInboxReader } from './access';
import {
	attachExistingToThread,
	attachUploadToThread,
	purgeReplyAttachments,
	replyAttachmentRefs,
	replyAttachmentStatus,
	takeReadyReplyAttachments,
} from './replyAttachmentStore';

const LOG_TAG = '[team reply attachments]';

/** What the composer shows for each attachment, in list order. */
async function viewOf(ctx: QueryCtx, entries: readonly TeamReplyAttachment[] | undefined) {
	return Promise.all(
		(entries ?? []).map(async (entry, index) => ({
			index,
			id: entry.id,
			filename: entry.filename,
			contentType: entry.contentType,
			size: entry.size,
			origin: entry.origin,
			...(entry.sourceId !== undefined ? { sourceId: entry.sourceId } : {}),
			status: replyAttachmentStatus(entry),
			...(entry.copyError !== undefined ? { copyError: entry.copyError } : {}),
			url: entry.storageId ? await ctx.storage.getUrl(entry.storageId) : null,
			addedBy: entry.addedBy,
			addedAt: entry.addedAt,
		}))
	);
}

/** The composer's attachments on a thread, in order. */
// public: soft-auth — admin-only shared inbox; returns empty for non-admins
export const list = publicQuery({
	args: { threadId: v.id('conversationThreads') },
	handler: async (ctx, args) => {
		const session = await getBetterAuthSessionWithRole(ctx);
		if (!isSharedInboxReader(session)) return [];
		const thread = await ctx.db.get(args.threadId);
		return thread ? await viewOf(ctx, thread.replyAttachments) : [];
	},
});

/** Attach a fresh upload (an unclaimed `storageUploads` receipt of the caller's). */
export const add = adminMutation({
	args: {
		threadId: v.id('conversationThreads'),
		storageId: v.id('_storage'),
		// Pass the file's name: the blob does not know it.
		filename: v.optional(v.string()),
		contentType: v.optional(v.string()),
	},
	handler: async (ctx, args, session) => {
		const { threadId, ...upload } = args;
		return await viewOf(ctx, await attachUploadToThread(ctx, threadId, upload, session));
	},
});

/**
 * Attach a file from Files (`semanticFile`) or from a received email
 * (`mailAttachment`), after checking the caller may read it. The entry shows
 * as copying until `copyExisting` has stored the reply's own copy. Attaching
 * the same file twice is a no-op.
 */
export const attachExisting = adminMutation({
	args: {
		threadId: v.id('conversationThreads'),
		source: existingAttachmentSourceValidator,
		id: v.string(),
	},
	handler: async (ctx, args, session) => {
		const { threadId, ...file } = args;
		return await viewOf(ctx, await attachExistingToThread(ctx, threadId, file, session));
	},
});

/** Remove the attachment at `index` and delete its blob. */
export const remove = adminMutation({
	args: { threadId: v.id('conversationThreads'), index: v.number() },
	handler: async (ctx, args) => {
		const thread = await getOrThrow(ctx, args.threadId, 'Thread');
		const entries = [...(thread.replyAttachments ?? [])];
		if (!Number.isInteger(args.index) || args.index < 0 || args.index >= entries.length) {
			throwInvalidInput('There is no attachment at that position');
		}
		const [removed] = entries.splice(args.index, 1);
		await ctx.db.patch(args.threadId, {
			replyAttachments: entries.length > 0 ? entries : undefined,
		});
		await purgeReplyAttachments(ctx, removed ? [removed] : [], LOG_TAG);
		return await viewOf(ctx, entries);
	},
});

/**
 * The file(s) the agent matched to what the thread's newest message asked
 * for, in the shape `components/inbox/AttachSuggestion.vue` takes, or `null`.
 * Candidates whose bytes are gone are dropped, and a suggestion a person has
 * already acted on (one of its files attached, or sent) is not offered again.
 */
// public: soft-auth — admin-only shared inbox; returns empty for non-admins
export const suggestions = publicQuery({
	args: { threadId: v.id('conversationThreads') },
	handler: async (ctx, args) => {
		const session = await getBetterAuthSessionWithRole(ctx);
		if (!isSharedInboxReader(session)) return null;
		const thread = await ctx.db.get(args.threadId);
		if (!thread) return null;
		const latest = await ctx.db
			.query('inboundMessages')
			.withIndex('by_thread', (q) => q.eq('threadId', args.threadId))
			.order('desc')
			.first();
		const stored = latest?.attachmentSuggestions;
		if (!latest || !stored) return null;

		const attached = new Set(
			[...(thread.replyAttachments ?? []), ...(latest.replyAttachments ?? [])]
				.filter((entry) => entry.origin === 'semanticFile')
				.map((entry) => entry.sourceId)
		);
		if (stored.candidates.some((candidate) => attached.has(candidate.fileId))) return null;

		const candidates = [];
		for (const candidate of stored.candidates) {
			const file = await ctx.db.get(candidate.fileId);
			if (file?.storageId) candidates.push({ ...candidate, storageId: file.storageId });
		}
		if (candidates.length === 0) return null;
		return {
			inboundMessageId: latest._id,
			query: stored.query,
			ambiguous: stored.ambiguous && candidates.length > 1,
			candidates,
		};
	},
});

/**
 * Copy a picked file into a blob the reply owns. Runs as an action because
 * only actions read blob bytes; `finishCopy` records the outcome.
 */
export const copyExisting = internalAction({
	args: {
		threadId: v.id('conversationThreads'),
		entryId: v.string(),
		bytes: existingAttachmentBytesValidator,
		contentType: v.string(),
	},
	handler: async (ctx, args): Promise<void> => {
		let outcome: { storageId: Id<'_storage'>; size: number } | { error: string };
		try {
			const data = await readExistingAttachmentBytes(ctx.storage, args.bytes);
			if (!data) outcome = { error: 'The file is no longer stored' };
			else if (data.byteLength === 0 || data.byteLength > MAX_ATTACHMENT_BYTES) {
				outcome = { error: 'Attachment size exceeds the allowed limit' };
			} else {
				const blob = new Blob([data as BlobPart], { type: args.contentType });
				outcome = { storageId: await ctx.storage.store(blob), size: data.byteLength };
			}
		} catch (err) {
			logError(`${LOG_TAG} copy failed`, { threadId: args.threadId, err });
			outcome = { error: 'The file could not be copied' };
		}
		await ctx.runMutation(internal.inbox.replyAttachments.finishCopy, {
			threadId: args.threadId,
			entryId: args.entryId,
			...outcome,
		});
	},
});

export const finishCopy = internalMutation({
	args: {
		threadId: v.id('conversationThreads'),
		entryId: v.string(),
		storageId: v.optional(v.id('_storage')),
		size: v.optional(v.number()),
		error: v.optional(v.string()),
	},
	handler: async (ctx, args): Promise<void> => {
		const thread = await ctx.db.get(args.threadId);
		const entries = [...(thread?.replyAttachments ?? [])];
		const index = entries.findIndex(
			(entry) => entry.id === args.entryId && replyAttachmentStatus(entry) === 'copying'
		);
		const entry = entries[index];
		// Removed while it was copying, or the thread is gone: nothing wants the copy.
		if (!thread || !entry) {
			if (args.storageId) await ctx.storage.delete(args.storageId);
			return;
		}
		let error = args.error;
		if (args.storageId && args.size !== undefined) {
			const others = entries.reduce((sum, e, i) => (i === index ? sum : sum + e.size), 0);
			if (others + args.size > ATTACHMENT_COMPOSE_LIMITS.maxTotalBytes) {
				await ctx.storage.delete(args.storageId);
				error = 'Attachments exceed the total size limit';
			} else {
				entries[index] = { ...entry, storageId: args.storageId, size: args.size };
			}
		}
		if (error !== undefined || !args.storageId) {
			entries[index] = { ...entry, copyError: error ?? 'The file could not be copied' };
		}
		await ctx.db.patch(args.threadId, { replyAttachments: entries });
	},
});

/**
 * The approved reply's hand-off to the non-campaign intake, with the files the
 * composer holds. One transaction: the ready attachments move from the thread
 * onto the message only when the intake accepted the send, so a refusal leaves
 * them in the composer for the next try. Attachments already on the message (a
 * re-fired send) go out again.
 *
 * Only files a person attached are ever here; the agent's
 * `attachmentSuggestions` never are. The composer list belongs to the thread
 * and outlives the message it was staged for, so an autonomous send takes only
 * what was attached after this message arrived (a file answer to the agent's
 * question, say); a file someone staged earlier for a reply of their own stays
 * in the composer. A person approving the reply sees the list and sends it all.
 */
/**
 * The intake's outcome, or a hold: a file the reply carries is still being
 * copied (`sendApprovedReply` tries again) or could not be copied (the send is
 * stopped for a person to look at).
 */
export type AgentReplyIntakeOutcome =
	| NonCampaignIntakeOutcome
	| { ok: false; reason: 'attachment_copying' | 'attachment_failed'; detail?: undefined };

export const intakeAgentReply = internalMutation({
	args: {
		inboundMessageId: v.id('inboundMessages'),
		autonomous: v.optional(v.boolean()),
		email: v.string(),
		contactId: v.optional(v.id('contacts')),
		subject: v.string(),
		html: v.string(),
		from: v.string(),
		headers: v.optional(v.record(v.string(), v.string())),
	},
	handler: async (ctx, args): Promise<AgentReplyIntakeOutcome> => {
		const message = await ctx.db.get(args.inboundMessageId);
		if (!message) throw new Error('The message this reply answers no longer exists');
		const thread = message.threadId ? await ctx.db.get(message.threadId) : null;
		const include = (entry: TeamReplyAttachment) =>
			args.autonomous !== true || entry.addedAt >= message.receivedAt;
		// Never leave a file behind silently. Autonomous: a file attached for this
		// message is one the reply was told it carries (a file answer). A person's
		// approve: `approveDraft` refused while one was copying, but one attached
		// inside the undo window can still be copying when the send fires. Either
		// way the send waits for the copy, and a failed copy stops it.
		const pending = (thread?.replyAttachments ?? []).filter(
			(entry) => include(entry) && replyAttachmentStatus(entry) !== 'ready'
		);
		if (pending.some((entry) => replyAttachmentStatus(entry) === 'failed')) {
			return { ok: false, reason: 'attachment_failed' };
		}
		if (pending.length > 0) return { ok: false, reason: 'attachment_copying' };
		const ready = (thread?.replyAttachments ?? []).filter(
			(entry) => replyAttachmentStatus(entry) === 'ready' && include(entry)
		);
		const carried = [...(message.replyAttachments ?? []), ...ready];
		const attachmentRefs = await replyAttachmentRefs(ctx, carried);

		const outcome: NonCampaignIntakeOutcome = await ctx.runMutation(
			internal.delivery.nonCampaignIntake.intake,
			{
				kind: 'agent_reply',
				email: args.email,
				...(args.contactId ? { contactId: args.contactId } : {}),
				inboundMessageId: args.inboundMessageId,
				subject: args.subject,
				html: args.html,
				from: args.from,
				...(args.headers ? { headers: args.headers } : {}),
				...(attachmentRefs.length > 0 ? { attachmentRefs } : {}),
			}
		);
		if (outcome.ok && ready.length > 0) {
			await takeReadyReplyAttachments(ctx, thread, include);
			await ctx.db.patch(args.inboundMessageId, { replyAttachments: carried });
		}
		return outcome;
	},
});
