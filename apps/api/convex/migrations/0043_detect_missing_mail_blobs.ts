/**
 * Detect mail rows whose shared raw blob was deleted before reference-aware
 * purging shipped. The bytes are unrecoverable, so this migration reports the
 * damage instead of pretending to repair it:
 *
 *   npx convex run migrations/0043_detect_missing_mail_blobs:run
 *
 * Rows are ordered by `rawStorageId`; adjacent copies share one metadata read,
 * including when a group crosses a page boundary. The returned sample is
 * bounded, while every missing row contributes to the counts and structured
 * log entry.
 */

import { v } from 'convex/values';
import { internalAction, internalQuery, type ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { logInfo } from '../lib/runtimeLog';

const PAGE_SIZE = 100;
const SAMPLE_SIZE = 100;

export const rawBlobPage = internalQuery({
	args: { cursor: v.union(v.string(), v.null()) },
	handler: async (ctx, { cursor }) => {
		const result = await ctx.db
			.query('mailMessages')
			.withIndex('by_raw_storage')
			.paginate({ numItems: PAGE_SIZE, cursor });
		return {
			rows: result.page.map((message) => ({
				messageId: message._id,
				mailboxId: message.mailboxId,
				rawStorageId: message.rawStorageId,
			})),
			cursor: result.continueCursor,
			isDone: result.isDone,
		};
	},
});

interface MissingMessage {
	messageId: Id<'mailMessages'>;
	mailboxId: Id<'mailboxes'>;
	rawStorageId: Id<'_storage'>;
}

export async function detectMissingMailBlobs(
	ctx: Pick<ActionCtx, 'runQuery' | 'storage'>
): Promise<{
	checkedBlobs: number;
	missingBlobs: number;
	missingMessages: number;
	sample: MissingMessage[];
}> {
	let cursor: string | null = null;
	let previousStorageId: Id<'_storage'> | undefined;
	let previousMissing = false;
	let checkedBlobs = 0;
	let missingBlobs = 0;
	let missingMessages = 0;
	const sample: MissingMessage[] = [];

	for (;;) {
		const page: {
			rows: MissingMessage[];
			cursor: string;
			isDone: boolean;
		} = await ctx.runQuery(internal.migrations['0043_detect_missing_mail_blobs'].rawBlobPage, {
			cursor,
		});
		for (const row of page.rows) {
			if (row.rawStorageId !== previousStorageId) {
				previousStorageId = row.rawStorageId;
				checkedBlobs++;
				previousMissing = (await ctx.storage.getMetadata(row.rawStorageId)) === null;
				if (previousMissing) missingBlobs++;
			}
			if (!previousMissing) continue;
			missingMessages++;
			if (sample.length < SAMPLE_SIZE) sample.push(row);
		}
		if (page.isDone) break;
		cursor = page.cursor;
	}
	return { checkedBlobs, missingBlobs, missingMessages, sample };
}

export const run = internalAction({
	args: {},
	handler: async (
		ctx
	): Promise<{
		checkedBlobs: number;
		missingBlobs: number;
		missingMessages: number;
		sample: MissingMessage[];
	}> => {
		const { checkedBlobs, missingBlobs, missingMessages, sample } =
			await detectMissingMailBlobs(ctx);

		logInfo('migration.0043_detect_missing_mail_blobs', {
			checkedBlobs,
			missingBlobs,
			missingMessages,
			sample,
			sampleTruncated: missingMessages > sample.length,
		});
		return { checkedBlobs, missingBlobs, missingMessages, sample };
	},
});
