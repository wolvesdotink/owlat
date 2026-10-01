/**
 * Resumable backfill (and purge) of `mailMessages.searchBody` over EXISTING
 * mail — the migration half of deep body search (idea 32, ADR-0059).
 *
 * The write path only ever sees mail delivered after the instance opt-in was
 * turned on. Without this walk, "search whole bodies" would mean "search whole
 * bodies of everything since Tuesday", which for the question the feature
 * exists to answer ("where was that penalty clause?") is the wrong half of the
 * mailbox. It is also why the read path refuses the body index until this job
 * reports `completed` (`mail/searchBody.isBodySearchIndexComplete`).
 *
 * WHY AN ACTION, unlike `mail/attachmentBackfill.ts`. A large body lives in a
 * storage blob and blob contents are unreadable from a query or a mutation. So
 * the walk is a three-step loop per page: an internal QUERY reads the page's
 * body refs, the ACTION resolves + unseals them and builds the excerpts, and an
 * internal MUTATION writes them back and advances the cursor. The job row is
 * re-read every page, so `cancel` between pages actually stops the walk.
 *
 * THE COMMIT IS FENCED. The action's blob reads take time, and in that time the
 * job can be cancelled and restarted on the SAME row, or the instance switch
 * can be turned off. So a page is loaded together with the job's `generation`
 * and the cursor it was read from, and `commitBatch` writes nothing unless the
 * job is still running that generation at that cursor AND the switch is still
 * on, all checked in the transaction that writes the excerpts. An accepted
 * commit schedules the next page itself and records it as the job's lease, so
 * no crash between "progress saved" and "next page scheduled" can leave a
 * running job with nothing to run it.
 *
 * THE PURGE IS THE OTHER HALF OF THE OPT-OUT. Turning the instance switch off
 * has to REMOVE the widened plaintext, not merely stop adding to it, or "off"
 * would be a promise about future mail only. `workspaces/settings.update` calls
 * `beginSearchBodyPurge` (`./_bodySearchLifecycle`) whenever it writes the
 * switch off: that retires every index walk in the same transaction and starts
 * a fenced, cursor-carrying sweep over the whole table (no blob reads needed to
 * clear a column), whose progress lives on the `mailBodySearchPurges`
 * singleton.
 */

import { v } from 'convex/values';
import { internalQuery, internalAction } from '../_generated/server';
import type { QueryCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { publicQuery } from '../lib/authedFunctions';
import { postboxMutation } from './_helpers';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { requireMailboxAccess } from './permissions';
import { throwForbidden, throwInvalidInput } from '../_utils/errors';
import { readMailMessageText } from '../lib/messageBody';
import { openStoredInlineBody } from '../lib/messageBodyStore';
import { logError } from '../lib/runtimeLog';
import { buildSearchBody, isBodySearchIndexingEnabled } from './searchBody';
import { cancelJob, readJob, startJob } from './_jobLifecycle';
import { generationOf, isLeaseLive, purgeSearchBodyPage } from './_bodySearchLifecycle';

/**
 * Messages read per page. Smaller than the attachment backfill's 128: every row
 * here may cost a storage round-trip to unseal a body blob, so the ACTION's
 * wall-clock, not the transaction's write budget, is the binding constraint.
 */
const BODY_SEARCH_BACKFILL_BATCH = 48;

/** Recorded on a walk whose scheduled batch ended without finishing the job. */
const BODY_SEARCH_STALLED_ERROR = 'Indexing stopped before it finished';

/** Recorded when the action could not read a page's bodies. */
const BODY_SEARCH_READ_ERROR = 'A message body could not be read';

/** A running index walk whose batch will never run again. */
async function isIndexWalkStalled(
	ctx: { db: QueryCtx['db'] },
	job: Doc<'mailBodySearchBackfillJobs'>
): Promise<boolean> {
	return (
		job.status === 'running' &&
		job.mode === 'index' &&
		!(await isLeaseLive(ctx, job.batchFunctionId))
	);
}

/**
 * The current backfill job for a mailbox, or null. Drives the settings screen's
 * progress strip; absent means "never run here", which is the state every
 * mailbox starts in. `isStalled` marks a walk that still says `running` but
 * whose next batch will never run, so the screen can offer a restart instead of
 * a spinner that never ends.
 */
// public: soft-auth — returns null for anonymous; mailbox access is still enforced in-handler
export const status = publicQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId);
		if (!owned.ok) return null;
		const job = await readJob(ctx, { table: 'mailBodySearchBackfillJobs', key: args.mailboxId });
		if (!job) return null;
		return { ...job, isStalled: await isIndexWalkStalled(ctx, job) };
	},
});

/**
 * Start (or restart) the excerpt walk for one mailbox. Owner-grade: it reads
 * every body in the mailbox and writes a plaintext excerpt for each, which is
 * not something a shared-inbox member should be able to set in motion.
 *
 * Refuses outright while the instance switch is off — starting it then would
 * write exactly the plaintext the switch exists to withhold.
 *
 * Re-entrant: a job already `running` is left alone rather than forked, so a
 * double click cannot produce two walks racing over one cursor. A running job
 * whose lease is dead is the exception: it is marked failed and restarted,
 * because nothing else would ever finish it.
 */
export const start = postboxMutation({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args): Promise<{ started: boolean }> => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId, 'owner');
		if (!owned.ok) throwForbidden('Mailbox not accessible');
		if (!(await isBodySearchIndexingEnabled(ctx))) {
			throwInvalidInput('Body search indexing is turned off for this instance');
		}

		const locator = { table: 'mailBodySearchBackfillJobs' as const, key: args.mailboxId };
		const existing = await readJob(ctx, locator);
		if (existing && (await isIndexWalkStalled(ctx, existing))) {
			const now = Date.now();
			await ctx.db.patch(existing._id, {
				status: 'failed',
				errorMessage: BODY_SEARCH_STALLED_ERROR,
				batchFunctionId: undefined,
				updatedAt: now,
				finishedAt: now,
			});
		}
		// A new generation per start: a batch the previous run still has in
		// flight can then never commit into this one.
		const generation = (existing ? generationOf(existing) : 0) + 1;
		let batchFunctionId: Id<'_scheduled_functions'> | undefined;
		const result = await startJob(ctx, {
			...locator,
			insertFields: { mailboxId: args.mailboxId, mode: 'index', indexedCount: 0, generation },
			// A restart after a purge turns the row back into an index walk.
			resetFields: { mode: 'index', indexedCount: 0, generation },
			schedule: async () => {
				batchFunctionId = await ctx.scheduler.runAfter(
					0,
					internal.mail.bodySearchBackfill.runBatch,
					{ mailboxId: args.mailboxId, generation }
				);
			},
		});
		const job = result.started ? await readJob(ctx, locator) : null;
		if (job) await ctx.db.patch(job._id, { batchFunctionId });
		return result;
	},
});

/**
 * Stop a running walk. Every excerpt written so far stays — a cancelled
 * backfill is a PARTIAL index, never a corrupt one, and because the read path
 * only switches over on `completed`, a cancelled walk simply leaves search
 * exactly where it was. A batch still in flight is refused at its commit.
 */
export const cancel = postboxMutation({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args): Promise<void> => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId, 'owner');
		if (!owned.ok) throwForbidden('Mailbox not accessible');
		await cancelJob(ctx, { table: 'mailBodySearchBackfillJobs', key: args.mailboxId });
	},
});

/**
 * One page of body material: the INLINE parts already unsealed (a query can do
 * that), the text BLOB left as an id because only an action can read its bytes.
 * The projection is named `textInline` / `htmlInline` rather than after the
 * columns, matching `mail/migrationIndexing.getMessageForExtraction` — these are
 * opened bodies, not the stored shape. `generation` and `expectedCursor` are
 * what the commit is checked against. `authz: internal-only`, called by
 * `runBatch`.
 */
export const loadBatch = internalQuery({
	args: {
		mailboxId: v.id('mailboxes'),
		// Optional: a batch queued before generations existed carries none and
		// runs as the current generation. Remove the optionality after release N+1.
		generation: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const job = await readJob(ctx, { table: 'mailBodySearchBackfillJobs', key: args.mailboxId });
		if (!job || job.status !== 'running' || job.mode !== 'index') return null;
		if (args.generation !== undefined && args.generation !== generationOf(job)) return null;
		// Saves unsealing bodies that could not be committed anyway. The check
		// that protects the data is the one in `commitBatch`.
		if (!(await isBodySearchIndexingEnabled(ctx))) return null;

		const { page, isDone, continueCursor } = await ctx.db
			.query('mailMessages')
			.withIndex('by_mailbox_and_received', (q) => q.eq('mailboxId', args.mailboxId))
			.paginate({ cursor: job.cursor ?? null, numItems: BODY_SEARCH_BACKFILL_BATCH });

		const rows = [];
		for (const m of page) {
			const { text, html } = await openStoredInlineBody(ctx.db, m);
			rows.push({
				messageId: m._id,
				textInline: text,
				textStorageId: m.textBodyStorageId,
				htmlInline: html,
				snippet: m.snippet,
				hasExcerpt: m.searchBody !== undefined,
			});
		}
		return {
			generation: generationOf(job),
			expectedCursor: job.cursor ?? null,
			isDone,
			continueCursor,
			rows,
		};
	},
});

/** What a commit did: `rejected` means it wrote nothing and scheduled nothing. */
type CommitOutcome = 'committed' | 'completed' | 'rejected';

/**
 * Write one page's excerpts, advance the cursor and schedule the next page, all
 * in this one transaction. `authz: internal-only`.
 *
 * Refused, with no write at all, when the job is no longer running an index
 * walk, when the batch belongs to another generation or was read from another
 * cursor (a cancelled-and-restarted run, a duplicate, an out-of-order replay),
 * or when the instance switch is off. The switch is read HERE, in the writing
 * transaction, because this is the only place a check cannot be overtaken by
 * an opt-out that lands while the action is reading bodies.
 */
export const commitBatch = internalMutation({
	args: {
		mailboxId: v.id('mailboxes'),
		excerpts: v.array(v.object({ messageId: v.id('mailMessages'), searchBody: v.string() })),
		scanned: v.number(),
		cursor: v.union(v.string(), v.null()),
		// Optional only so a batch an older action loaded still validates; such a
		// commit carries no fence and is refused. Remove after release N+1.
		generation: v.optional(v.number()),
		expectedCursor: v.optional(v.union(v.string(), v.null())),
	},
	handler: async (ctx, args): Promise<CommitOutcome> => {
		const job = await readJob(ctx, { table: 'mailBodySearchBackfillJobs', key: args.mailboxId });
		if (!job || job.status !== 'running' || job.mode !== 'index') return 'rejected';
		if (args.generation === undefined || args.generation !== generationOf(job)) return 'rejected';
		if (args.expectedCursor === undefined || args.expectedCursor !== (job.cursor ?? null)) {
			return 'rejected';
		}
		if (!(await isBodySearchIndexingEnabled(ctx))) return 'rejected';

		const now = Date.now();
		let written = 0;
		for (const excerpt of args.excerpts) {
			const message = await ctx.db.get(excerpt.messageId);
			// The row may have been expunged or moved out from under the walk
			// between the read and this write; skipping it is correct, not an error.
			if (!message || message.mailboxId !== args.mailboxId) continue;
			await ctx.db.patch(excerpt.messageId, { searchBody: excerpt.searchBody });
			written += 1;
		}

		const isDone = args.cursor === null;
		const batchFunctionId = isDone
			? undefined
			: await ctx.scheduler.runAfter(0, internal.mail.bodySearchBackfill.runBatch, {
					mailboxId: args.mailboxId,
					generation: args.generation,
				});
		await ctx.db.patch(job._id, {
			cursor: args.cursor ?? undefined,
			scannedCount: job.scannedCount + args.scanned,
			indexedCount: job.indexedCount + written,
			status: isDone ? ('completed' as const) : ('running' as const),
			batchFunctionId,
			updatedAt: now,
			...(isDone ? { finishedAt: now } : {}),
		});
		return isDone ? 'completed' : 'committed';
	},
});

/**
 * End a walk whose action could not build its page, so the settings screen
 * shows it stopped and `start` can run it again. Fenced like `commitBatch`: a
 * failure from an older generation leaves the current run alone.
 * `authz: internal-only`.
 */
export const failBatch = internalMutation({
	args: { mailboxId: v.id('mailboxes'), generation: v.number(), errorMessage: v.string() },
	handler: async (ctx, args): Promise<void> => {
		const job = await readJob(ctx, { table: 'mailBodySearchBackfillJobs', key: args.mailboxId });
		if (!job || job.status !== 'running' || job.mode !== 'index') return;
		if (generationOf(job) !== args.generation) return;
		const now = Date.now();
		await ctx.db.patch(job._id, {
			status: 'failed',
			errorMessage: args.errorMessage,
			batchFunctionId: undefined,
			updatedAt: now,
			finishedAt: now,
		});
	},
});

/**
 * One page of the walk. `authz: internal-only`.
 *
 * A row that already carries an excerpt is skipped, so a restarted walk is
 * cheap and can never write a different excerpt over a good one. A body that
 * normalizes to nothing falls back to the snippet: the message stays findable
 * by everything it was findable by before, which is the floor this whole
 * feature promises never to go below.
 *
 * The next page is scheduled by `commitBatch`, not here: a refused commit must
 * not continue the walk, and an accepted one must not depend on this action
 * surviving past it.
 */
export const runBatch = internalAction({
	args: {
		mailboxId: v.id('mailboxes'),
		// Optional: see `loadBatch`. Remove the optionality after release N+1.
		generation: v.optional(v.number()),
	},
	handler: async (ctx, args): Promise<void> => {
		const batch = await ctx.runQuery(internal.mail.bodySearchBackfill.loadBatch, {
			mailboxId: args.mailboxId,
			generation: args.generation,
		});
		if (!batch) return; // cancelled, restarted, finished, switched off, or never started

		const excerpts: { messageId: Id<'mailMessages'>; searchBody: string }[] = [];
		try {
			for (const row of batch.rows) {
				if (row.hasExcerpt) continue;
				// `readMailMessageText` (given an already-opened inline part, or the
				// blob id) is the single sanctioned body-blob reader — the
				// `check-body-access` ratchet forbids a second one, and it covers the
				// TEXT blob only. So an html-only message whose body spilled into a
				// blob falls back to its snippet below: less depth than we would
				// like, never less than today.
				const text = await readMailMessageText(ctx.storage, {
					textBodyInline: row.textInline,
					textBodyStorageId: row.textStorageId,
				});
				const searchBody = buildSearchBody(text || undefined, row.htmlInline) || row.snippet;
				if (searchBody) excerpts.push({ messageId: row.messageId, searchBody });
			}
		} catch (error) {
			logError(`[bodySearchBackfill] page failed for ${args.mailboxId}: ${String(error)}`);
			await ctx.runMutation(internal.mail.bodySearchBackfill.failBatch, {
				mailboxId: args.mailboxId,
				generation: batch.generation,
				errorMessage: BODY_SEARCH_READ_ERROR,
			});
			return;
		}

		await ctx.runMutation(internal.mail.bodySearchBackfill.commitBatch, {
			mailboxId: args.mailboxId,
			generation: batch.generation,
			expectedCursor: batch.expectedCursor,
			excerpts,
			scanned: batch.rows.length,
			cursor: batch.isDone ? null : batch.continueCursor,
		});
	},
});

/**
 * One page of the opt-out sweep that clears every stored excerpt; the sweep is
 * started by `workspaces/settings.update` through `beginSearchBodyPurge`, and
 * the page itself is `purgeSearchBodyPage` (both in `./_bodySearchLifecycle`).
 * `authz: internal-only`.
 */
export const purgeSearchBodies = internalMutation({
	args: {
		cursor: v.union(v.string(), v.null()),
		// Optional: a page queued before sweeps were fenced carries none. Such a
		// page hands over to a fenced sweep instead of clearing on its own
		// cursor. Remove the optionality after release N+1.
		generation: v.optional(v.number()),
	},
	handler: async (ctx, args): Promise<void> => {
		await purgeSearchBodyPage(ctx, args);
	},
});
