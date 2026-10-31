/**
 * The commit of one mailbox-migration indexing chunk (`migrationIndexing.ts`
 * `runIndexChunk`): the chunk's counter and cursor, and in the same
 * transaction either the next chunk or the migration's terminal state. Kept
 * apart from the runner for the ~500 LOC ratchet.
 */

import { v } from 'convex/values';
import type { MutationCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { markOnboardingStep } from '../auth/userOnboarding';

type Migration = Doc<'mailboxMigrations'>;

/** Advance an indexing migration's cursor and add the messages swept since. */
export async function addIndexProgress(
	ctx: MutationCtx,
	migration: Migration,
	progress: {
		deltaIndexed: number;
		cursorReceivedAt?: number;
		cursorId?: Id<'mailMessages'>;
	}
): Promise<void> {
	await ctx.db.patch(migration._id, {
		messagesIndexed: migration.messagesIndexed + progress.deltaIndexed,
		indexCursorReceivedAt: progress.cursorReceivedAt ?? migration.indexCursorReceivedAt,
		indexCursorId: progress.cursorId ?? migration.indexCursorId,
		updatedAt: Date.now(),
	});
}

/** Move an indexing migration to a terminal state. */
export async function finalizeIndexing(
	ctx: MutationCtx,
	migration: Migration,
	end: {
		status: 'completed' | 'failed' | 'cancelled';
		errorMessage?: string;
		/** True ONLY when the sweep reached its natural end. */
		indexingRanToCompletion?: boolean;
	}
): Promise<void> {
	const now = Date.now();
	await ctx.db.patch(migration._id, {
		status: end.status,
		completedAt: now,
		updatedAt: now,
		lastError: end.errorMessage ?? migration.lastError,
	});
	// Only a sweep that ran to its natural end counts as knowledge indexed for
	// the migration owner's onboarding checklist — a mid-sweep feature disable
	// finalizes with status 'completed' too, but leaves the step unmarked. A
	// `shared` migration indexed a TEAM inbox (org infrastructure, opt-in), so
	// it never counts toward the admin's personal checklist either.
	if (
		end.status === 'completed' &&
		end.indexingRanToCompletion === true &&
		migration.scope !== 'shared'
	) {
		await markOnboardingStep(ctx, migration.userId, 'knowledgeIndexed');
	}
}

/**
 * Commit one chunk. `more` counts it and schedules the next chunk, `done`
 * counts it and completes the migration, `disabled` completes it without
 * marking knowledge indexed (`ai.knowledge` went off mid-sweep), `failed`
 * ends it with `errorMessage`. A migration that left the indexing phase while
 * the chunk ran (a user Cancel) is left as it is and nothing is scheduled.
 */
export const commitIndexChunk = internalMutation({
	args: {
		migrationId: v.id('mailboxMigrations'),
		outcome: v.union(
			v.literal('more'),
			v.literal('done'),
			v.literal('disabled'),
			v.literal('failed')
		),
		deltaIndexed: v.number(),
		cursorReceivedAt: v.optional(v.number()),
		cursorId: v.optional(v.id('mailMessages')),
		errorMessage: v.optional(v.string()),
		// The next chunk's arguments, as `runIndexChunk` takes them.
		chunkSize: v.number(),
		interChunkDelayMs: v.optional(v.number()),
		nextChunkDelayMs: v.number(),
	},
	handler: async (ctx, args): Promise<'continued' | 'finished' | 'stopped'> => {
		const migration = await ctx.db.get(args.migrationId);
		if (!migration || migration.status !== 'indexing') return 'stopped';
		switch (args.outcome) {
			case 'more':
				await addIndexProgress(ctx, migration, args);
				await ctx.scheduler.runAfter(
					args.nextChunkDelayMs,
					internal.mail.migrationIndexing.runIndexChunk,
					{
						migrationId: args.migrationId,
						chunkSize: args.chunkSize,
						interChunkDelayMs: args.interChunkDelayMs,
					}
				);
				return 'continued';
			case 'done':
				await addIndexProgress(ctx, migration, args);
				await finalizeIndexing(ctx, migration, {
					status: 'completed',
					indexingRanToCompletion: true,
				});
				return 'finished';
			case 'disabled':
				// Sweep cut off mid-flight — import kept, but knowledge is incomplete.
				await finalizeIndexing(ctx, migration, {
					status: 'completed',
					indexingRanToCompletion: false,
				});
				return 'finished';
			case 'failed':
				await finalizeIndexing(ctx, migration, {
					status: 'failed',
					errorMessage: args.errorMessage,
				});
				return 'finished';
		}
	},
});
