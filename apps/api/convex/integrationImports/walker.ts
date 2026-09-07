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

import { v, type Infer } from 'convex/values';
import { internalAction, internalMutation, internalQuery } from '../_generated/server';
import { authedQuery, authedMutation } from '../lib/authedFunctions';
import { internal } from '../_generated/api';
import { requireOrgPermission } from '../lib/sessionOrganization';
import { assertFeatureEnabled } from '../lib/featureFlags';
import { throwInvalidInput, throwInvalidState, getOrThrow } from '../_utils/errors';
import { providerFor } from './providers';
import {
	addSuppressionCounts,
	RetryableProviderError,
	ZERO_SUPPRESSION_COUNTS,
	suppressionCountsValidator,
	type FetchPageResult,
	type IntegrationProviderKind,
	type SuppressionImportCounts,
} from './_common';
import { recordImportSummary } from './suppressions';
import { sealImportCredential, openImportCredential } from './credentialSeal';
import type { FeatureFlagKey } from '@owlat/shared/featureFlags';
import { duplicateHandlingValidator, completedOrFailedValidator } from '../lib/convexValidators';

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
		// Opt-in suppression carry-over (plan D9). Absent = the pre-P4.1
		// behavior: non-subscribed members are skipped and nothing is suppressed.
		importSuppressions: v.optional(v.boolean()),
	}),
	v.object({
		provider: v.literal('stripe'),
		apiKey: v.string(),
	}),
	// No credential field: the Mandrill rejects import reads `MANDRILL_API_KEY`
	// from the deployment environment (plan D2 — send-provider credentials are
	// env-only, and a key pasted here would be a second credential model for an
	// account that already has one). See `providers/mandrill/index.ts`.
	v.object({
		provider: v.literal('mandrill'),
	})
);

type IntegrationImportConfig = Infer<typeof integrationProviderConfigValidator>;

/**
 * Seal the provider's API key (when the provider has one) BEFORE the config
 * enters scheduled-function args, so the live third-party credential never sits
 * in the `_scheduled_functions` table in plaintext across the import's hops
 * (plan L9). Mandrill carries no key and passes through unchanged.
 */
async function sealConfigCredential(
	config: IntegrationImportConfig
): Promise<IntegrationImportConfig> {
	if ('apiKey' in config) {
		return { ...config, apiKey: await sealImportCredential(config.apiKey) };
	}
	return config;
}

/**
 * Reverse of {@link sealConfigCredential}: unseal the API key in memory for the
 * one outbound HTTP call. The scheduled args stay sealed — the next hop is
 * re-scheduled with the still-sealed config.
 */
async function openConfigCredential(
	config: IntegrationImportConfig
): Promise<IntegrationImportConfig> {
	if ('apiKey' in config) {
		return { ...config, apiKey: await openImportCredential(config.apiKey) };
	}
	return config;
}

/**
 * Per-provider Settings toggle. The flag must actually gate the import, not
 * just exist — a table rather than a ternary chain so a new provider is one
 * line and cannot silently inherit another provider's flag.
 */
const PROVIDER_FEATURE_FLAGS = {
	mailchimp: 'imports.mailchimp',
	stripe: 'imports.stripe',
	mandrill: 'imports.mandrill',
} as const satisfies Record<IntegrationProviderKind, FeatureFlagKey>;

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
		handleDuplicates: duplicateHandlingValidator,
		topicId: v.optional(v.id('topics')),
	},
	handler: async (ctx, args) => {
		await requireOrgPermission(ctx, 'imports:manage', 'Only owners and admins can start imports');

		// Per-provider feature flags — the Settings toggles must actually gate
		// the import, not just exist.
		await assertFeatureEnabled(ctx, PROVIDER_FEATURE_FLAGS[args.config.provider]);

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

		// Seal the provider credential so the scheduled-function args carry
		// ciphertext, not a live API key, for the life of the run (plan L9).
		// Validation above ran on the plaintext config, so sealing does not
		// weaken any check.
		const scheduledConfig = await sealConfigCredential(args.config);

		await ctx.scheduler.runAfter(0, internal.integrationImports.walker.processIntegrationPage, {
			importId,
			config: scheduledConfig,
			cursor: '',
		});

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
		const importRecord = await getOrThrow(ctx, args.importId, 'Import');

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
		const importRecord = await ctx.runQuery(internal.integrationImports.walker.getImportById, {
			importId: args.importId,
		});
		if (!importRecord || importRecord.status !== 'running') return;

		const adapter = providerFor(args.config.provider);

		// Unseal the provider credential in memory for this hop's outbound call
		// only (plan L9). `args.config` stays sealed and is what re-schedules the
		// next hop below, so the plaintext key never re-enters scheduled args.
		const liveConfig = await openConfigCredential(args.config);

		// Retry loop. `RetryableProviderError` → backoff + retry up to
		// MAX_RETRIES. Any other thrown `Error` → fail the import.
		let result: FetchPageResult | null = null;
		for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
			try {
				result = await adapter.fetchPage({
					config: liveConfig,
					cursor: args.cursor,
				});
				break;
			} catch (err) {
				if (err instanceof RetryableProviderError && attempt < MAX_RETRIES) {
					await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
					continue;
				}
				await ctx.runMutation(internal.integrationImports.walker.completeImport, {
					importId: args.importId,
					status: 'failed',
					errorMessage: err instanceof Error ? err.message : 'Unknown error',
				});
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

		// `contactSource` is what makes a suppression-only provider expressible:
		// an adapter that declares none (Mandrill's rejection blacklist) never
		// reaches the Contact import module at all.
		if (result.rows.length > 0 && adapter.contactSource) {
			const contactSource = adapter.contactSource;
			try {
				const batchResults = await ctx.runMutation(internal.contacts.import.importBatch, {
					rows: result.rows,
					source: contactSource,
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
				});
				batchImported = batchResults.imported;
				batchUpdated = batchResults.updated;
				batchSkipped = batchResults.skipped;
				batchFailed = batchResults.failed;
				batchErrors.push(...batchResults.errors.slice(0, 10));
			} catch (error) {
				batchFailed = result.rows.length;
				batchErrors.push(
					`Batch at cursor "${args.cursor}" failed: ${error instanceof Error ? error.message : 'Unknown error'}`
				);
			}
		}

		// Suppression carry-over (plan D9). A separate hop from `importBatch`
		// because it is a different kind of write to a different table with a
		// different idempotency story — and because a contacts import that
		// carries no suppressions must be able to fail without one, and the
		// reverse. Errors are recorded, never thrown: an address we could not
		// suppress is a fact the operator needs on the run, not a reason to
		// abandon the rest of the list.
		let pageSuppressions: SuppressionImportCounts | null = null;
		const carried = result.suppressions ?? [];
		const adapterSkipped = result.suppressionsSkipped ?? 0;
		if (carried.length > 0 || adapterSkipped > 0) {
			try {
				pageSuppressions = await ctx.runMutation(
					internal.integrationImports.suppressions.applySuppressionBatch,
					{
						provider: args.config.provider,
						entries: carried,
						skipped: adapterSkipped,
					}
				);
			} catch (error) {
				batchErrors.push(
					`Suppression batch at cursor "${args.cursor}" failed: ${error instanceof Error ? error.message : 'Unknown error'}`
				);
			}
		}

		await ctx.runMutation(internal.integrationImports.walker.updateImportProgress, {
			importId: args.importId,
			imported: batchImported,
			updated: batchUpdated,
			skipped: batchSkipped,
			failed: batchFailed,
			errors: batchErrors,
			...(result.totalEstimate !== undefined ? { totalEstimate: result.totalEstimate } : {}),
			...(pageSuppressions ? { suppressionCounts: pageSuppressions } : {}),
			newCursor: result.nextCursor ?? args.cursor,
		});

		if (result.nextCursor !== null) {
			await ctx.scheduler.runAfter(0, internal.integrationImports.walker.processIntegrationPage, {
				importId: args.importId,
				config: args.config,
				cursor: result.nextCursor,
			});
		} else {
			await ctx.runMutation(internal.integrationImports.walker.completeImport, {
				importId: args.importId,
				status: 'completed',
			});
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
		suppressionCounts: v.optional(suppressionCountsValidator),
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
			...(args.totalEstimate !== undefined ? { totalEstimate: args.totalEstimate } : {}),
			...(args.suppressionCounts
				? {
						suppressionCounts: addSuppressionCounts(
							record.suppressionCounts ?? ZERO_SUPPRESSION_COUNTS,
							args.suppressionCounts
						),
					}
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
		status: completedOrFailedValidator,
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

		// ONE aggregated audit row per run that actually carried something over —
		// including a run that failed halfway, because the addresses it did
		// suppress are suppressed either way. Gated on having changed something,
		// so an idempotent re-run adds nothing to the trail.
		await recordImportSummary(ctx, { ...record, status: args.status, errors });
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
