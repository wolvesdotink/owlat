/**
 * Integration import walker — owns the page-by-page execution of one
 * paginated **Integration import** run.
 *
 * Public surface:
 *   - `startIntegrationImport` (mutation) — single writer that opens a new
 *     run. Replaces the per-provider `startMailchimpImport` and
 *     `startStripeImport`.
 *   - `cancelImport` (mutation) — user-initiated cancellation.
 *   - `getImportProgress` (query) — progress polling for the UI.
 *
 * Internals (called by `processIntegrationPage` from itself):
 *   - `processIntegrationPage` (internalAction) — fetches one page from the
 *     per-provider adapter, delegates to `importBatch`, patches progress,
 *     schedules the next hop (or completes).
 *   - `updateImportProgress`, `completeImport`, `getImportById` — internal
 *     mutations/query for cursor + counter + status patches.
 *
 * The walker never branches on `provider`. Per-provider HTTP knowledge
 * lives behind the **Integration import provider adapter (module)** seam
 * dispatched by `providerFor(kind)`.
 *
 * Per ADR-0027.
 */

import { v } from 'convex/values';
import {
	internalAction,
	internalMutation,
	internalQuery,
} from '../_generated/server';
import { authedQuery, authedMutation } from '../lib/authedFunctions';
import { internal } from '../_generated/api';
import { requireOrgPermission } from '../lib/sessionOrganization';
import { assertFeatureEnabled } from '../lib/featureFlags';
import {
	throwInvalidInput,
	throwInvalidState,
	throwNotFound,
} from '../_utils/errors';
import { providerFor } from './providers';
import {
	RetryableProviderError,
	type FetchPageResult,
} from './_common';

const MAX_RETRIES = 2;

// ─── Validators ─────────────────────────────────────────────────────────────

/**
 * Discriminated union of per-provider config shapes. Each branch matches one
 * `IntegrationProviderConfig` variant in `_common.ts`. Adding a third
 * provider adds one branch here.
 */
export const integrationProviderConfigValidator = v.union(
	v.object({
		provider: v.literal('mailchimp'),
		apiKey: v.string(),
		listId: v.string(),
	}),
	v.object({
		provider: v.literal('stripe'),
		apiKey: v.string(),
	}),
);

// ─── Public mutations ───────────────────────────────────────────────────────

/**
 * Start one **Integration import** run. Validates the provider's config,
 * refuses if any other import is `'running'`, inserts the row, and
 * schedules the first page hop.
 *
 * Replaces the per-provider `startMailchimpImport` and `startStripeImport`
 * mutations.
 */
export const startIntegrationImport = authedMutation({
	args: {
		config: integrationProviderConfigValidator,
		handleDuplicates: v.union(v.literal('skip'), v.literal('update')),
		topicId: v.optional(v.id('topics')),
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(ctx, 'imports:manage', 'Only owners and admins can start imports');

		// Per-provider feature flags — the Settings toggles must actually gate
		// the import, not just exist.
		await assertFeatureEnabled(
			ctx,
			args.config.provider === 'mailchimp' ? 'imports.mailchimp' : 'imports.stripe',
		);

		// Adapter-validated config — keeps per-provider knowledge of which
		// fields are required out of this writer. Errors surface
		// synchronously to the caller.
		const adapter = providerFor(args.config.provider);
		const configCheck = adapter.validateConfig(args.config);
		if (!configCheck.ok) throwInvalidInput(configCheck.reason);

		if (args.topicId) {
			const topic = await ctx.db.get(args.topicId);
			if (!topic) throwInvalidInput('Topic not found');
		}

		const running = await ctx.db
			.query('integrationImports')
			.withIndex('by_status', (q) => q.eq('status', 'running'))
			.first();
		if (running) throwInvalidState('An import is already running');

		const importId = await ctx.db.insert('integrationImports', {
			provider: args.config.provider,
			status: 'running',
			cursor: '',
			imported: 0,
			updated: 0,
			skipped: 0,
			failed: 0,
			errors: [],
			handleDuplicates: args.handleDuplicates,
			topicId: args.topicId,
			startedAt: Date.now(),
		});

		await ctx.scheduler.runAfter(
			0,
			internal.integrationImports.walker.processIntegrationPage,
			{
				importId,
				config: args.config,
				cursor: '',
			},
		);

		return importId;
	},
});

/**
 * User-initiated cancellation of a `'running'` import. Patches the row to
 * `'failed'` with a `Cancelled by user` error; the next scheduled
 * `processIntegrationPage` hop sees the non-`'running'` status and
 * short-circuits without another fetch.
 */
export const cancelImport = authedMutation({
	args: {
		importId: v.id('integrationImports'),
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(ctx, 'imports:manage', 'Only owners and admins can cancel imports');
		const importRecord = await ctx.db.get(args.importId);

		if (!importRecord) {
			throwNotFound('Import');
		}
		if (importRecord.status !== 'running') {
			throwInvalidState('Import is not running');
		}

		await ctx.db.patch(args.importId, {
			status: 'failed',
			errors: [...importRecord.errors, 'Cancelled by user'],
			completedAt: Date.now(),
		});
	},
});

// ─── Public query ───────────────────────────────────────────────────────────

/**
 * Returns the most-recent running import (when one exists) or otherwise
 * the most-recent completed/failed one. Drives the import progress modal
 * in the frontend.
 */
export const getImportProgress = authedQuery({
	args: {},
	handler: async (ctx) => {
		const running = await ctx.db
			.query('integrationImports')
			.withIndex('by_status', (q) => q.eq('status', 'running'))
			.first();

		if (running) return running;

		const recent = await ctx.db.query('integrationImports').order('desc').first();

		return recent;
	},
});

// ─── Internal action: page-by-page worker ───────────────────────────────────

/**
 * Process one page of an in-flight **Integration import**:
 *   1. Status-check — short-circuit if cancelled.
 *   2. `adapter.fetchPage` with retry on `RetryableProviderError`.
 *   3. Delegate to **Contact import (module)** `importBatch`.
 *   4. Patch counters + cursor.
 *   5. Schedule the next page hop, or call `completeImport` on the terminal
 *      page (adapter returned `nextCursor: null`).
 */
export const processIntegrationPage = internalAction({
	args: {
		importId: v.id('integrationImports'),
		config: integrationProviderConfigValidator,
		cursor: v.string(),
	},
	handler: async (ctx, args) => {
		// Cancellation race: every scheduled hop checks status at entry.
		const importRecord = await ctx.runQuery(
			internal.integrationImports.walker.getImportById,
			{ importId: args.importId },
		);
		if (!importRecord || importRecord.status !== 'running') return;

		const adapter = providerFor(args.config.provider);

		// Retry loop. `RetryableProviderError` → backoff + retry up to
		// MAX_RETRIES. Any other thrown `Error` → fail the import.
		let result: FetchPageResult | null = null;
		for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
			try {
				result = await adapter.fetchPage({
					config: args.config,
					cursor: args.cursor,
				});
				break;
			} catch (err) {
				if (err instanceof RetryableProviderError && attempt < MAX_RETRIES) {
					await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
					continue;
				}
				await ctx.runMutation(
					internal.integrationImports.walker.completeImport,
					{
						importId: args.importId,
						status: 'failed',
						errorMessage: err instanceof Error ? err.message : 'Unknown error',
					},
				);
				return;
			}
		}
		if (!result) return;

		// Delegate to **Contact import (module)**.
		let batchImported = 0;
		let batchUpdated = 0;
		let batchSkipped = 0;
		let batchFailed = 0;
		const batchErrors: string[] = [];

		if (result.rows.length > 0) {
			try {
				const batchResults = await ctx.runMutation(
					internal.contacts.import.importBatch,
					{
						rows: result.rows,
						source: args.config.provider,
						handleDuplicates: importRecord.handleDuplicates,
						...(importRecord.topicId
							? {
									topicAssignments: {
										kind: 'single' as const,
										topicId: importRecord.topicId,
									},
								}
							: {}),
						...(adapter.defaultDoiAttest
							? { doiAttest: { attestSource: adapter.defaultDoiAttest } }
							: {}),
					},
				);
				batchImported = batchResults.imported;
				batchUpdated = batchResults.updated;
				batchSkipped = batchResults.skipped;
				batchFailed = batchResults.failed;
				batchErrors.push(...batchResults.errors.slice(0, 10));
			} catch (error) {
				batchFailed = result.rows.length;
				batchErrors.push(
					`Batch at cursor "${args.cursor}" failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
				);
			}
		}

		await ctx.runMutation(
			internal.integrationImports.walker.updateImportProgress,
			{
				importId: args.importId,
				imported: batchImported,
				updated: batchUpdated,
				skipped: batchSkipped,
				failed: batchFailed,
				errors: batchErrors,
				...(result.totalEstimate !== undefined
					? { totalEstimate: result.totalEstimate }
					: {}),
				newCursor: result.nextCursor ?? args.cursor,
			},
		);

		if (result.nextCursor !== null) {
			await ctx.scheduler.runAfter(
				0,
				internal.integrationImports.walker.processIntegrationPage,
				{
					importId: args.importId,
					config: args.config,
					cursor: result.nextCursor,
				},
			);
		} else {
			await ctx.runMutation(
				internal.integrationImports.walker.completeImport,
				{
					importId: args.importId,
					status: 'completed',
				},
			);
		}
	},
});

// ─── Internal mutations / queries ───────────────────────────────────────────

/**
 * Patch per-page counter sums and the next opaque cursor. Adapter-agnostic.
 */
export const updateImportProgress = internalMutation({
	args: {
		importId: v.id('integrationImports'),
		imported: v.number(),
		updated: v.number(),
		skipped: v.number(),
		failed: v.number(),
		errors: v.array(v.string()),
		totalEstimate: v.optional(v.number()),
		newCursor: v.string(),
	},
	handler: async (ctx, args) => {
		const record = await ctx.db.get(args.importId);
		if (!record) return;

		// Don't advance counters/cursor on an import the user already cancelled
		// (or that already reached a terminal state).
		if (record.status !== 'running') return;

		const mergedErrors = [...record.errors, ...args.errors].slice(0, 20);

		await ctx.db.patch(args.importId, {
			imported: record.imported + args.imported,
			updated: record.updated + args.updated,
			skipped: record.skipped + args.skipped,
			failed: record.failed + args.failed,
			errors: mergedErrors,
			cursor: args.newCursor,
			...(args.totalEstimate !== undefined
				? { totalEstimate: args.totalEstimate }
				: {}),
		});
	},
});

/**
 * Terminal patch — flips `status` from `'running'` to `'completed'` or
 * `'failed'`. Appends an `errorMessage` when supplied.
 */
export const completeImport = internalMutation({
	args: {
		importId: v.id('integrationImports'),
		status: v.union(v.literal('completed'), v.literal('failed')),
		errorMessage: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const record = await ctx.db.get(args.importId);
		if (!record) return;

		// A concurrent user cancellation (or a prior terminal state) must win:
		// only a still-running import may transition to completed/failed, so a
		// late terminal hop can't clobber 'cancelled'/'failed' back to 'completed'.
		if (record.status !== 'running') return;

		const errors = args.errorMessage
			? [...record.errors, args.errorMessage].slice(0, 20)
			: record.errors;

		await ctx.db.patch(args.importId, {
			status: args.status,
			errors,
			completedAt: Date.now(),
		});
	},
});

/**
 * Read the current import row. Used by `processIntegrationPage` at every
 * hop entry to detect user cancellation before issuing the next HTTP call.
 */
export const getImportById = internalQuery({
	args: {
		importId: v.id('integrationImports'),
	},
	handler: async (ctx, args) => {
		return await ctx.db.get(args.importId);
	},
});
