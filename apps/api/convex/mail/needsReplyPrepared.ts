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
import { postboxQuery } from './_helpers';
import { loadReadableMailbox } from './permissions';

export const getPreparedDraft = postboxQuery({
	args: { threadId: v.id('mailThreads') },
	handler: async (
		ctx,
		args
	): Promise<{ clarificationDraft: string | null; slotDraft: string | null } | null> => {
		const thread = await ctx.db.get(args.threadId);
		const flag = thread?.needsReply;
		if (!thread || !flag) return null;
		const mailbox = await loadReadableMailbox(ctx, thread.mailboxId);
		if (!mailbox) return null;
		return {
			clarificationDraft: flag.clarification?.draft?.trim() || null,
			slotDraft: flag.draftSlot?.draft.trim() || null,
		};
	},
});
