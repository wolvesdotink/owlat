import { defineStep, DEFAULT_BATCH_SIZE } from './_common';
import { purgeReplyAttachments } from '../../../inbox/replyAttachmentStore';

const LOG_TAG = '[workspace deletion] team reply attachment';

/**
 * Storage-bearing steps for the two Team inbox tables whose rows hold reply
 * attachments: the thread (what the composer has attached so far) and the
 * follow-up (what it carried). The blobs belong to the reply
 * (`lib/validators/teamReplyAttachment.ts`), so a row-only sweep would leave
 * them in `_storage` with nothing pointing at them. The inbound message's
 * attachments go in `inboundMessagesStep`.
 */
export const conversationThreadsStep = defineStep({
	table: 'conversationThreads',
	async deleteBatch(ctx) {
		const rows = await ctx.db.query('conversationThreads').take(DEFAULT_BATCH_SIZE);
		for (const row of rows) {
			await purgeReplyAttachments(ctx, row.replyAttachments, LOG_TAG);
			await ctx.db.delete(row._id);
		}
		return { deletedCount: rows.length, hasMore: rows.length === DEFAULT_BATCH_SIZE };
	},
});

export const inboxFollowUpsStep = defineStep({
	table: 'inboxFollowUps',
	async deleteBatch(ctx) {
		const rows = await ctx.db.query('inboxFollowUps').take(DEFAULT_BATCH_SIZE);
		for (const row of rows) {
			await purgeReplyAttachments(ctx, row.attachments, LOG_TAG);
			await ctx.db.delete(row._id);
		}
		return { deletedCount: rows.length, hasMore: rows.length === DEFAULT_BATCH_SIZE };
	},
});
