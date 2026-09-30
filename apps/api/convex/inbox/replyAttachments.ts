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
import { internalAction, internalMutation, type QueryCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { MAX_ATTACHMENT_BYTES, ATTACHMENT_COMPOSE_LIMITS } from '@owlat/shared/attachments';
import { adminMutation, publicQuery } from '../lib/authedFunctions';
import { getBetterAuthSessionWithRole } from '../lib/sessionOrganization';
import { STRING_LIMITS, validateStringLength } from '../lib/inputGuards';
import {
	existingAttachmentBytesValidator,
	existingAttachmentSourceValidator,
	readExistingAttachmentBytes,
	resolveReadableExistingAttachment,
} from '../lib/existingAttachments';
import type { TeamReplyAttachment } from '../lib/validators/teamReplyAttachment';
import { consumeUpload, storedFileSize } from '../storage/uploads';
import { getOrThrow, throwInvalidInput, throwInvalidState } from '../_utils/errors';
import { logError } from '../lib/runtimeLog';
import type { NonCampaignIntakeOutcome } from '../delivery/nonCampaignIntake';
import { isSharedInboxReader } from './access';
import {
	assertReplyAttachmentFits,
	purgeReplyAttachments,
	replyAttachmentRefs,
	replyAttachmentStatus,
	replyUploadResourceKey,
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

/** The thread, if a reply on it can carry files: email only. */
async function loadAttachableThread(
	ctx: QueryCtx,
	threadId: Id<'conversationThreads'>
): Promise<Doc<'conversationThreads'>> {
	const thread = await getOrThrow(ctx, threadId, 'Thread');
	if (thread.channel !== undefined && thread.channel !== 'email') {
		throwInvalidState('Attachments can only be sent on email threads');
	}
	return thread;
}

function cleanFilename(filename: string | undefined): string {
	const name = filename?.trim() ?? '';
	if (name === '') return 'attachment';
	validateStringLength(name, STRING_LIMITS.FILENAME, 'Filename');
	// A path in a filename means nothing to the recipient's client and can
	// mislead a careless one; keep the last segment.
	return name.split(/[/\\]/).pop() || 'attachment';
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
		const thread = await loadAttachableThread(ctx, args.threadId);
		const entries = thread.replyAttachments ?? [];
		const filename = cleanFilename(args.filename);
		if (args.contentType !== undefined) {
			validateStringLength(args.contentType, STRING_LIMITS.MIME_TYPE, 'Content type');
		}
		// Binding and the limit checks share the transaction: a refused file
		// leaves its receipt unclaimed, so the upload cleanup still reclaims it.
		await consumeUpload(ctx, args.storageId, session, replyUploadResourceKey(args.threadId));
		const size = await storedFileSize(ctx, args.storageId);
		assertReplyAttachmentFits(entries, size);
		const stored = await ctx.db.system.get(args.storageId);
		const next: TeamReplyAttachment[] = [
			...entries,
			{
				id: crypto.randomUUID(),
				storageId: args.storageId,
				filename,
				contentType: args.contentType || stored?.contentType || 'application/octet-stream',
				size,
				origin: 'upload',
				addedBy: session.userId,
				addedAt: Date.now(),
			},
		];
		await ctx.db.patch(args.threadId, { replyAttachments: next });
		return await viewOf(ctx, next);
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
		const thread = await loadAttachableThread(ctx, args.threadId);
		const entries = thread.replyAttachments ?? [];
		if (entries.some((entry) => entry.origin === args.source && entry.sourceId === args.id)) {
			return await viewOf(ctx, entries);
		}
		const file = await resolveReadableExistingAttachment(ctx, args, session);
		assertReplyAttachmentFits(entries, file.size);
		const entry: TeamReplyAttachment = {
			id: crypto.randomUUID(),
			filename: file.filename,
			contentType: file.contentType,
			size: file.size,
			origin: file.source,
			sourceId: file.id,
			addedBy: session.userId,
			addedAt: Date.now(),
		};
		const next = [...entries, entry];
		await ctx.db.patch(args.threadId, { replyAttachments: next });
		await ctx.scheduler.runAfter(0, internal.inbox.replyAttachments.copyExisting, {
			threadId: args.threadId,
			entryId: entry.id,
			bytes: file.bytes,
			contentType: file.contentType,
		});
		return await viewOf(ctx, next);
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
 * `attachmentSuggestions` never are, so the autonomous path can take the same
 * route without sending anything nobody confirmed.
 */
export const intakeAgentReply = internalMutation({
	args: {
		inboundMessageId: v.id('inboundMessages'),
		email: v.string(),
		contactId: v.optional(v.id('contacts')),
		subject: v.string(),
		html: v.string(),
		from: v.string(),
		headers: v.optional(v.record(v.string(), v.string())),
	},
	handler: async (ctx, args): Promise<NonCampaignIntakeOutcome> => {
		const message = await ctx.db.get(args.inboundMessageId);
		if (!message) throw new Error('The message this reply answers no longer exists');
		const thread = message.threadId ? await ctx.db.get(message.threadId) : null;
		const ready = (thread?.replyAttachments ?? []).filter(
			(entry) => replyAttachmentStatus(entry) === 'ready'
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
			await takeReadyReplyAttachments(ctx, thread);
			await ctx.db.patch(args.inboundMessageId, { replyAttachments: carried });
		}
		return outcome;
	},
});
