/**
 * The reply the AI already wrote for one flagged thread, for a fresh reply in
 * Answer mode (web: useAnswerPreparedDraft): the Reply Queue's clarification
 * draft, written from the owner's answers, and the draft-on-arrival slot.
 *
 * One thread's read. Answer mode used to subscribe to the whole mailbox's
 * `needsReply.listQueue` (up to its cap of rows, each with its counterpart
 * lookups) to find this one row on every fresh reply. Lives beside
 * `needsReply.ts`, which is at the file-size cap.
 */
import { v } from 'convex/values';
import type { QueryCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { postboxQuery } from './_helpers';
import { loadReadableMailbox } from './permissions';

/** A file the owner gave as a Reply Queue answer, for the web to attach. */
interface PreparedFile {
	source: 'upload' | 'semanticFile' | 'mailAttachment';
	id: string;
	filename: string;
}

/**
 * The files answered on the Reply Queue card that can still go on the reply.
 * No draft exists when the card is answered, so the web attaches these when it
 * applies the prepared text (`drafts.attachExisting` for a Files row or a mail
 * attachment, `drafts.addAttachment` for an upload). Rows whose bytes are gone
 * are left out, and so is an upload unless it is the caller's own and its
 * receipt is still live: nothing else could bind it.
 */
async function answeredFiles(
	ctx: QueryCtx,
	flag: NonNullable<Doc<'mailThreads'>['needsReply']>,
	userId: string
): Promise<PreparedFile[]> {
	const files: PreparedFile[] = [];
	for (const question of flag.clarification?.questions ?? []) {
		const file = question.answer?.file;
		if (!file || files.some((f) => f.source === file.source && f.id === file.id)) continue;
		if (file.source === 'semanticFile') {
			const row = await ctx.db.get(file.id as Id<'semanticFiles'>);
			if (!row?.storageId) continue;
		} else if (file.source === 'mailAttachment') {
			if (!(await ctx.db.get(file.id as Id<'mailAttachments'>))) continue;
		} else {
			const storageId = ctx.db.system.normalizeId('_storage', file.id);
			const receipt = storageId
				? await ctx.db
						.query('storageUploads')
						.withIndex('by_storage', (q) => q.eq('storageId', storageId))
						.unique()
				: null;
			const isLive =
				receipt?.status === 'uploaded' &&
				receipt.userId === userId &&
				(receipt.expiresAt ?? 0) > Date.now();
			if (!isLive) continue;
		}
		files.push({ source: file.source, id: file.id, filename: file.filename });
	}
	return files;
}

// all-members: the thread's mailbox must be readable by the caller (loadReadableMailbox).
export const getPreparedDraft = postboxQuery({
	args: { threadId: v.id('mailThreads') },
	handler: async (
		ctx,
		args,
		session
	): Promise<{
		clarificationDraft: string | null;
		slotDraft: string | null;
		files: PreparedFile[];
	} | null> => {
		const thread = await ctx.db.get(args.threadId);
		const flag = thread?.needsReply;
		if (!thread || !flag) return null;
		const mailbox = await loadReadableMailbox(ctx, thread.mailboxId);
		if (!mailbox) return null;
		return {
			clarificationDraft: flag.clarification?.draft?.trim() || null,
			slotDraft: flag.draftSlot?.draft.trim() || null,
			files: await answeredFiles(ctx, flag, session.userId),
		};
	},
});
