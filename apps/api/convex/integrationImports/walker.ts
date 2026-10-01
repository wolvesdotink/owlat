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
 * Internals:
 *   - `processIntegrationPage` (internalAction) — fetches one page from the
 *     per-provider adapter and hands it to `commitIntegrationPage`
 *     (`pageCommit.ts`), which writes the page's effects, its counts and the
 *     next hop (or the terminal status) in one fenced transaction.
 *   - `completeImport`, `getImportById` — terminal patch and hop-entry read.
 *     `updateImportProgress` is kept only for hops of the previous release.
 *   - `recovery.ts` re-issues a page whose hop was lost.
 *
 * The walker never branches on `provider`. Per-provider HTTP knowledge
 * lives behind the **Integration import provider adapter (module)** seam
 * dispatched by `providerFor(kind)`.
 *
 * Per ADR-0027.
 */

import { v } from 'convex/values';
import { internalAction, internalQuery } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { authedQuery, authedMutation } from '../lib/authedFunctions';
import { internal } from '../_generated/api';
import { requireOrgPermission } from '../lib/sessionOrganization';
import { assertFeatureEnabled } from '../lib/featureFlags';
import { throwInvalidInput, throwInvalidState, getOrThrow } from '../_utils/errors';
import { providerFor } from './providers';
import {
	addSuppressionCounts,
	integrationProviderConfigValidator,
	RetryableProviderError,
	ZERO_SUPPRESSION_COUNTS,
	suppressionCountsValidator,
	type FetchPageResult,
	type IntegrationProviderConfig,
	type IntegrationProviderKind,
} from './_common';
import {
	finishImport,
	isCurrentPage,
	resumableConfig,
	schedulePage,
	type PageIdentity,
} from './pageCommit';
import { sealImportCredential, openImportCredential } from './credentialSeal';
import type { FeatureFlagKey } from '@owlat/shared/featureFlags';
import { duplicateHandlingValidator, completedOrFailedValidator } from '../lib/literalValidators';

const MAX_RETRIES = 2;

/**
 * Seal the provider's API key (when the provider has one) BEFORE the config
 * enters scheduled-function args, so the live third-party credential never sits
 * in the `_scheduled_functions` table in plaintext across the import's hops.
 * Mandrill carries no key and passes through unchanged.
 */
async function sealConfigCredential(
	config: IntegrationProviderConfig
): Promise<IntegrationProviderConfig> {
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
	config: IntegrationProviderConfig
): Promise<IntegrationProviderConfig> {
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

		// Seal the provider credential so the scheduled-function args carry
		// ciphertext, not a live API key, for the life of the run. Validation
		// above ran on the plaintext config, so sealing does not weaken any
		// check.
		const scheduledConfig = await sealConfigCredential(args.config);

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
			pagesCommitted: 0,
			resumeConfig: resumableConfig(scheduledConfig),
		});

		await schedulePage(ctx, importId, { config: scheduledConfig, cursor: '', page: 0 });

		return importId;
	},
});

/**
 * User-initiated cancellation of a `'running'` import. Patches the row to
 * `'failed'` with a `Cancelled by user` error. A page whose fetch is in flight
 * finds the run ended when it commits and writes nothing; a page committed
 * before this mutation stays counted. A hop still queued sees the status at
 * entry and does not fetch.
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

		await finishImport(ctx, importRecord, 'failed', [...importRecord.errors, 'Cancelled by user']);
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

		const run = running ?? (await ctx.db.query('integrationImports').order('desc').first());
		if (!run) return null;
		// The sealed provider config is for the recovery sweep, not the browser.
		const { resumeConfig: _resumeConfig, ...visible } = run;
		return visible;
	},
});

// ─── Internal action: page-by-page worker ───────────────────────────────────

/**
 * Process one page of an in-flight **Integration import**:
 *   1. Entry check — skip a cancelled run, or a page another hop already
 *      committed, without fetching. Only an optimisation: the commit re-checks.
 *   2. Open the sealed credential and `adapter.fetchPage`, retrying on
 *      `RetryableProviderError`. Any other failure ends the run as `failed`,
 *      unless the run has moved past this page meanwhile.
 *   3. Hand the page to `commitIntegrationPage`, which writes its contacts,
 *      suppressions and counts and schedules the next hop (or completes) in one
 *      fenced transaction.
 *
 * `page` is absent on a hop the previous release queued; it reads as 0, which
 * is also what a row that release started holds.
 */
export const processIntegrationPage = internalAction({
	args: {
		importId: v.id('integrationImports'),
		config: integrationProviderConfigValidator,
		cursor: v.string(),
		page: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const identity: PageIdentity = { cursor: args.cursor, page: args.page ?? 0 };
		const importRecord = await ctx.runQuery(internal.integrationImports.walker.getImportById, {
			importId: args.importId,
		});
		if (!importRecord || !isCurrentPage(importRecord, identity)) return;

		const failRun = (errorMessage: string) =>
			ctx.runMutation(internal.integrationImports.walker.completeImport, {
				importId: args.importId,
				status: 'failed',
				errorMessage,
				...identity,
			});

		const adapter = providerFor(args.config.provider);

		// Unseal the provider credential in memory for this hop's outbound call
		// only. `args.config` stays sealed and is what the commit schedules the
		// next hop with, so the plaintext key never re-enters scheduled args. A
		// credential that no longer opens (the instance secret changed) can never
		// succeed on a retry, so it ends the run with a reason instead of leaving
		// it running with nothing behind it.
		let liveConfig: IntegrationProviderConfig;
		try {
			liveConfig = await openConfigCredential(args.config);
		} catch (err) {
			await failRun(
				`Could not open the stored provider credential: ${err instanceof Error ? err.message : 'Unknown error'}`
			);
			return;
		}

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
				await failRun(err instanceof Error ? err.message : 'Unknown error');
				return;
			}
		}
		if (!result) return;

		await ctx.runMutation(internal.integrationImports.pageCommit.commitIntegrationPage, {
			importId: args.importId,
			...identity,
			config: args.config,
			rows: result.rows,
			suppressions: result.suppressions ?? [],
			suppressionsSkipped: result.suppressionsSkipped ?? 0,
			nextCursor: result.nextCursor,
			...(result.totalEstimate !== undefined ? { totalEstimate: result.totalEstimate } : {}),
		});
	},
});

// ─── Internal mutations / queries ───────────────────────────────────────────

// ============== v0.6.5 compatibility shim — remove after release N+1 ==============

/**
 * Patch per-page counter sums and the next opaque cursor, for a page hop of
 * the previous release that is still running when this one deploys (it calls
 * this after its own contact and suppression writes, before it schedules the
 * next hop). Nothing in this release calls it.
 *
 * It only touches a row that release started: a row with a page count belongs
 * to this release's commit, and counting a legacy hop into it as well would
 * count one page twice when the recovery sweep has already re-issued it.
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
		if (record.status !== 'running' || record.pagesCommitted !== undefined) return;

		const mergedErrors = [...record.errors, ...args.errors].slice(0, 20);

		await ctx.db.patch(args.importId, {
			imported: record.imported + args.imported,
			updated: record.updated + args.updated,
			skipped: record.skipped + args.skipped,
			failed: record.failed + args.failed,
			errors: mergedErrors,
			cursor: args.newCursor,
			lastPageAt: Date.now(),
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

// ============== end of v0.6.5 compatibility shim ==============

/**
 * Terminal patch — flips `status` from `'running'` to `'completed'` or
 * `'failed'`. Appends an `errorMessage` when supplied.
 *
 * A hop names its page (`cursor` + `page`) and then ends the run only while
 * that page is still the current one: a duplicate hop whose page another hop
 * already committed must not fail a run that has moved on. The previous
 * release's hops call it without a page and get the status check alone.
 */
export const completeImport = internalMutation({
	args: {
		importId: v.id('integrationImports'),
		status: completedOrFailedValidator,
		errorMessage: v.optional(v.string()),
		cursor: v.optional(v.string()),
		page: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const record = await ctx.db.get(args.importId);
		if (!record) return;

		// A concurrent user cancellation (or a prior terminal state) must win:
		// only a still-running import may transition to completed/failed, so a
		// late terminal hop can't clobber 'cancelled'/'failed' back to 'completed'.
		if (record.status !== 'running') return;
		if (
			args.cursor !== undefined &&
			!isCurrentPage(record, { cursor: args.cursor, page: args.page ?? 0 })
		) {
			return;
		}

		const errors = args.errorMessage
			? [...record.errors, args.errorMessage].slice(0, 20)
			: record.errors;
		await finishImport(ctx, record, args.status, errors);
	},
});

/**
 * Read the current import row. Used by `processIntegrationPage` at every
 * hop entry to skip a cancelled run or a superseded page before issuing the
 * next HTTP call.
 */
export const getImportById = internalQuery({
	args: {
		importId: v.id('integrationImports'),
	},
	handler: async (ctx, args) => {
		return await ctx.db.get(args.importId);
	},
});
