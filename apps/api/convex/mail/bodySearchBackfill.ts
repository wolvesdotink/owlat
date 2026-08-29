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
 * THE PURGE IS THE OTHER HALF OF THE OPT-OUT. Turning the instance switch off
 * has to REMOVE the widened plaintext, not merely stop adding to it, or "off"
 * would be a promise about future mail only. `purgeSearchBodies` is scheduled
 * by `workspaces/settings.update` on the true→false transition: a
 * cursor-carrying internal mutation over the whole table (no blob reads needed
 * to clear a column), self-rescheduling in the same shape as
 * `mail/labels.stripLabelReferences`.
 */

import { v } from 'convex/values';
import { internalQuery, internalMutation, internalAction } from '../_generated/server';
import { authedMutation, publicQuery } from '../lib/authedFunctions';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { requireMailboxAccess } from './permissions';
import { throwForbidden, throwInvalidInput } from '../_utils/errors';
import { readMailMessageText, openMailMessageInlineBody } from '../lib/messageBody';
import { buildSearchBody, isBodySearchIndexingEnabled } from './searchBody';

/**
 * Messages read per page. Smaller than the attachment backfill's 128: every row
 * here may cost a storage round-trip to unseal a body blob, so the ACTION's
 * wall-clock, not the transaction's write budget, is the binding constraint.
 */
export const BODY_SEARCH_BACKFILL_BATCH = 48;

/** Rows cleared per transaction by the purge. No blob reads, so it can be wider. */
export const BODY_SEARCH_PURGE_BATCH = 256;

/**
 * The current backfill job for a mailbox, or null. Drives the settings screen's
 * progress strip; absent means "never run here", which is the state every
 * mailbox starts in.
 */
// public: soft-auth — returns null for anonymous; mailbox access is still enforced in-handler
export const status = publicQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId);
		if (!owned.ok) return null;
		return ctx.db
			.query('mailBodySearchBackfillJobs')
			.withIndex('by_mailbox', (q) => q.eq('mailboxId', args.mailboxId))
			.first();
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
 * double click cannot produce two walks racing over one cursor.
 */
export const start = authedMutation({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args): Promise<{ started: boolean }> => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId, 'owner');
		if (!owned.ok) throwForbidden('Mailbox not accessible');
		if (!(await isBodySearchIndexingEnabled(ctx))) {
			throwInvalidInput('Body search indexing is turned off for this instance');
		}

		const existing = await ctx.db
			.query('mailBodySearchBackfillJobs')
			.withIndex('by_mailbox', (q) => q.eq('mailboxId', args.mailboxId))
			.first();
		if (existing?.status === 'running') return { started: false };

		const now = Date.now();
		if (existing) {
			await ctx.db.patch(existing._id, {
				mode: 'index' as const,
				status: 'running' as const,
				cursor: undefined,
				scannedCount: 0,
				indexedCount: 0,
				startedAt: now,
				updatedAt: now,
				finishedAt: undefined,
				errorMessage: undefined,
			});
		} else {
			await ctx.db.insert('mailBodySearchBackfillJobs', {
				mailboxId: args.mailboxId,
				mode: 'index',
				status: 'running',
				scannedCount: 0,
				indexedCount: 0,
				startedAt: now,
				updatedAt: now,
			});
		}
		await ctx.scheduler.runAfter(0, internal.mail.bodySearchBackfill.runBatch, {
			mailboxId: args.mailboxId,
		});
		return { started: true };
	},
});

/**
 * Stop a running walk. Every excerpt written so far stays — a cancelled
 * backfill is a PARTIAL index, never a corrupt one, and because the read path
 * only switches over on `completed`, a cancelled walk simply leaves search
 * exactly where it was.
 */
export const cancel = authedMutation({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args): Promise<void> => {
		const owned = await requireMailboxAccess(ctx, args.mailboxId, 'owner');
		if (!owned.ok) throwForbidden('Mailbox not accessible');
		const job = await ctx.db
			.query('mailBodySearchBackfillJobs')
			.withIndex('by_mailbox', (q) => q.eq('mailboxId', args.mailboxId))
			.first();
		if (!job || job.status !== 'running') return;
		const now = Date.now();
		await ctx.db.patch(job._id, { status: 'cancelled', updatedAt: now, finishedAt: now });
	},
});

/**
 * One page of body material: the INLINE parts already unsealed (a query can do
 * that), the text BLOB left as an id because only an action can read its bytes.
 * The projection is named `textInline` / `htmlInline` rather than after the
 * columns, matching `mail/migrationIndexing.getMessageForExtraction` — these are
 * opened bodies, not the stored shape. `authz: internal-only`, called by
 * `runBatch`.
 */
export const loadBatch = internalQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => {
		const job = await ctx.db
			.query('mailBodySearchBackfillJobs')
			.withIndex('by_mailbox', (q) => q.eq('mailboxId', args.mailboxId))
			.first();
		if (!job || job.status !== 'running' || job.mode !== 'index') return null;

		const { page, isDone, continueCursor } = await ctx.db
			.query('mailMessages')
			.withIndex('by_mailbox_and_received', (q) => q.eq('mailboxId', args.mailboxId))
			.paginate({ cursor: job.cursor ?? null, numItems: BODY_SEARCH_BACKFILL_BATCH });

		const rows = [];
		for (const m of page) {
			const { text, html } = await openMailMessageInlineBody(m);
			rows.push({
				messageId: m._id,
				textInline: text,
				textStorageId: m.textBodyStorageId,
				htmlInline: html,
				snippet: m.snippet,
				hasExcerpt: m.searchBody !== undefined,
			});
		}
		return { isDone, continueCursor, rows };
	},
});

/** Write one page's excerpts and advance the cursor. `authz: internal-only`. */
export const commitBatch = internalMutation({
	args: {
		mailboxId: v.id('mailboxes'),
		excerpts: v.array(v.object({ messageId: v.id('mailMessages'), searchBody: v.string() })),
		scanned: v.number(),
		cursor: v.union(v.string(), v.null()),
	},
	handler: async (ctx, args): Promise<void> => {
		const job = await ctx.db
			.query('mailBodySearchBackfillJobs')
			.withIndex('by_mailbox', (q) => q.eq('mailboxId', args.mailboxId))
			.first();
		if (!job || job.status !== 'running' || job.mode !== 'index') return;

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
		await ctx.db.patch(job._id, {
			cursor: args.cursor ?? undefined,
			scannedCount: job.scannedCount + args.scanned,
			indexedCount: job.indexedCount + written,
			status: isDone ? ('completed' as const) : ('running' as const),
			updatedAt: now,
			...(isDone ? { finishedAt: now } : {}),
		});
	},
});

/**
 * One page of the walk, then reschedule. `authz: internal-only`.
 *
 * A row that already carries an excerpt is skipped, so a restarted walk is
 * cheap and can never write a different excerpt over a good one. A body that
 * normalizes to nothing falls back to the snippet: the message stays findable
 * by everything it was findable by before, which is the floor this whole
 * feature promises never to go below.
 */
export const runBatch = internalAction({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args): Promise<void> => {
		const batch = await ctx.runQuery(internal.mail.bodySearchBackfill.loadBatch, {
			mailboxId: args.mailboxId,
		});
		if (!batch) return; // cancelled, finished, or never started

		const excerpts: { messageId: Id<'mailMessages'>; searchBody: string }[] = [];
		for (const row of batch.rows) {
			if (row.hasExcerpt) continue;
			// `readMailMessageText` (given an already-opened inline part, or the blob
			// id) is the single sanctioned body-blob reader — the `check-body-access`
			// ratchet forbids a second one, and it covers the TEXT blob only. So an
			// html-only message whose body spilled into a blob falls back to its
			// snippet below: less depth than we would like, never less than today.
			const text = await readMailMessageText(ctx.storage, {
				textBodyInline: row.textInline,
				textBodyStorageId: row.textStorageId,
			});
			const searchBody = buildSearchBody(text || undefined, row.htmlInline) || row.snippet;
			if (searchBody) excerpts.push({ messageId: row.messageId, searchBody });
		}

		await ctx.runMutation(internal.mail.bodySearchBackfill.commitBatch, {
			mailboxId: args.mailboxId,
			excerpts,
			scanned: batch.rows.length,
			cursor: batch.isDone ? null : batch.continueCursor,
		});

		if (!batch.isDone) {
			await ctx.scheduler.runAfter(0, internal.mail.bodySearchBackfill.runBatch, {
				mailboxId: args.mailboxId,
			});
		}
	},
});

/**
 * Clear every stored excerpt, one page at a time. Scheduled by
 * `workspaces/settings.update` when an operator turns the instance switch OFF.
 * `authz: internal-only`.
 *
 * Instance-wide and index-free on purpose: the switch is instance-wide, and
 * "which mailboxes happen to have excerpts" is exactly the question a full,
 * cursor-paginated walk answers without needing an index for it. Idempotent —
 * a row with no `searchBody` costs a read and no write — so a second disable
 * while a sweep is still running is harmless.
 *
 * It also drops each mailbox's completed INDEX job, because leaving one behind
 * would tell `resolveBodySearchMode` the body index is ready for a mailbox
 * whose excerpts have just been erased.
 */
export const purgeSearchBodies = internalMutation({
	args: { cursor: v.union(v.string(), v.null()) },
	handler: async (ctx, args): Promise<void> => {
		// Re-read the switch every page: an operator who flips it back ON
		// mid-sweep should not have the rest of their corpus erased behind them.
		if (await isBodySearchIndexingEnabled(ctx)) return;

		const { page, isDone, continueCursor } = await ctx.db
			.query('mailMessages')
			.paginate({ cursor: args.cursor, numItems: BODY_SEARCH_PURGE_BATCH });
		for (const message of page) {
			if (message.searchBody === undefined) continue;
			await ctx.db.patch(message._id, { searchBody: undefined });
		}

		if (!isDone) {
			await ctx.scheduler.runAfter(0, internal.mail.bodySearchBackfill.purgeSearchBodies, {
				cursor: continueCursor,
			});
			return;
		}

		// Last page: retire the index jobs so no mailbox still claims a ready index.
		// Without this, disable → purge → re-enable would read the body index for a
		// mailbox whose excerpts have just been erased.
		// bounded: one row per mailbox on a single-org deployment, so this is the
		// mailbox count — the same order as the fan-out search already reads.
		const jobs = await ctx.db.query('mailBodySearchBackfillJobs').collect();
		const now = Date.now();
		for (const job of jobs) {
			if (job.mode === 'purge' && job.status === 'completed') continue;
			await ctx.db.patch(job._id, {
				mode: 'purge' as const,
				status: 'completed' as const,
				cursor: undefined,
				updatedAt: now,
				finishedAt: now,
			});
		}
	},
});
