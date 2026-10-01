/**
 * Integration import page commit — the one transaction a provider page's
 * effects go through, and the fence around it.
 *
 * A page is identified by the cursor it was fetched at and the number of pages
 * the run had committed when its hop was issued. `processIntegrationPage`
 * fetches in an action, where nothing is atomic, and hands the page to
 * `commitIntegrationPage`, which in ONE transaction:
 *
 *   1. checks that the run is still `'running'` and that the row's cursor and
 *      page count still name this page (the fence);
 *   2. imports the page's contacts through the **Contact import (module)** and
 *      applies its carried-over suppressions;
 *   3. adds the page's counts, moves the cursor and the page count on;
 *   4. schedules the next page's hop and records it as the run's lease, or ends
 *      the run on the last page.
 *
 * So a cancel accepted before the commit leaves no trace of the page, a page
 * committed before the cancel is fully counted, a hop that fetched a page some
 * other hop already committed changes nothing, and a committed cursor always
 * has a scheduled hop (or a terminal status) behind it. What remains — a hop
 * that died, or a schedule that never ran — is the recovery sweep's job
 * (`recovery.ts`).
 *
 * Per ADR-0027 (#996/#999 amendment).
 */

import { v } from 'convex/values';
import type { MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import { importRowValidator } from '../contacts/import';
import { providerFor } from './providers';
import {
	addSuppressionCounts,
	integrationProviderConfigValidator,
	ZERO_SUPPRESSION_COUNTS,
	type IntegrationProviderConfig,
	type SuppressionImportCounts,
} from './_common';
import { recordImportSummary, suppressionEntryValidator } from './suppressions';
import { isSealedImportCredential } from './credentialSeal';

/** Errors kept on a run row; later ones are dropped. */
const MAX_RUN_ERRORS = 20;

/**
 * Which page a hop is for: the cursor it fetches and how many pages the run had
 * committed when the hop was issued. A hop a previous release queued carries no
 * page number, and a row that release started carries no count; both read as 0.
 */
export type PageIdentity = { cursor: string; page: number };

/** Is this hop's page the one the run is waiting for? */
export function isCurrentPage(record: Doc<'integrationImports'>, identity: PageIdentity): boolean {
	return (
		record.status === 'running' &&
		record.cursor === identity.cursor &&
		(record.pagesCommitted ?? 0) === identity.page
	);
}

/**
 * The config a run may keep on its row for recovery: one whose API key is
 * sealed, or one with no key at all (Mandrill). On an instance without
 * `INSTANCE_SECRET`, sealing passes the key through in plaintext; that config
 * is never persisted, so such a run cannot be resumed and the sweep ends it
 * visibly instead.
 */
export function resumableConfig(
	config: IntegrationProviderConfig
): IntegrationProviderConfig | undefined {
	if (!('apiKey' in config)) return config;
	return isSealedImportCredential(config.apiKey) ? config : undefined;
}

/**
 * Schedule the hop for one page and record it as the run's lease, inside the
 * caller's transaction (the start mutation, a page commit, the recovery sweep).
 * Whatever moved the row onto a page therefore also queued the work for it.
 */
export async function schedulePage(
	ctx: MutationCtx,
	importId: Id<'integrationImports'>,
	hop: PageIdentity & { config: IntegrationProviderConfig }
): Promise<void> {
	const pageJobId = await ctx.scheduler.runAfter(
		0,
		internal.integrationImports.walker.processIntegrationPage,
		{ importId, config: hop.config, cursor: hop.cursor, page: hop.page }
	);
	await ctx.db.patch(importId, { pageJobId });
}

/**
 * End a run: the one terminal transition, shared by the last page's commit, a
 * hop that failed, the user's cancel and the recovery sweep. Drops the lease
 * and the sealed config, and writes the run's suppression summary (a run that
 * stopped halfway still suppressed what it suppressed).
 */
export async function finishImport(
	ctx: MutationCtx,
	record: Doc<'integrationImports'>,
	status: 'completed' | 'failed',
	errors: string[]
): Promise<void> {
	await ctx.db.patch(record._id, {
		status,
		errors,
		completedAt: Date.now(),
		pageJobId: undefined,
		resumeConfig: undefined,
	});
	await recordImportSummary(ctx, { ...record, status, errors });
}

/**
 * Commit one fetched page (see the module header). Returns whether it was
 * committed; `false` means the run was cancelled or ended, or another hop has
 * already committed this page, and nothing was written.
 */
export const commitIntegrationPage = internalMutation({
	args: {
		importId: v.id('integrationImports'),
		cursor: v.string(),
		page: v.number(),
		/** As scheduled: the API key stays sealed for the next hop. */
		config: integrationProviderConfigValidator,
		rows: v.array(importRowValidator),
		suppressions: v.array(suppressionEntryValidator),
		suppressionsSkipped: v.number(),
		nextCursor: v.union(v.string(), v.null()),
		totalEstimate: v.optional(v.number()),
	},
	handler: async (ctx, args): Promise<{ isCommitted: boolean }> => {
		const record = await ctx.db.get(args.importId);
		if (!record || !isCurrentPage(record, args)) return { isCommitted: false };

		const adapter = providerFor(record.provider);
		let imported = 0;
		let updated = 0;
		let skipped = 0;
		let failed = 0;
		const pageErrors: string[] = [];

		// Each stage runs as a nested mutation: one that throws rolls back its
		// own writes and is recorded on the run, and the rest of the page still
		// commits — the same outcome as when the stages were separate
		// transactions. `contactSource` is what makes a suppression-only provider
		// expressible: an adapter that declares none (Mandrill's rejection
		// blacklist) never reaches the Contact import module at all.
		if (args.rows.length > 0 && adapter.contactSource) {
			try {
				const batch = await ctx.runMutation(internal.contacts.import.importBatch, {
					rows: args.rows,
					source: adapter.contactSource,
					handleDuplicates: record.handleDuplicates,
					...(record.topicId
						? { topicAssignments: { kind: 'single' as const, topicId: record.topicId } }
						: {}),
					...(adapter.defaultDoiAttest
						? { doiAttest: { attestSource: adapter.defaultDoiAttest } }
						: {}),
				});
				imported = batch.imported;
				updated = batch.updated;
				skipped = batch.skipped;
				failed = batch.failed;
				pageErrors.push(...batch.errors.slice(0, 10));
			} catch (error) {
				failed = args.rows.length;
				pageErrors.push(
					`Batch at cursor "${args.cursor}" failed: ${error instanceof Error ? error.message : 'Unknown error'}`
				);
			}
		}

		// Suppression carry-over: a different write to a different table with its
		// own idempotency story, so a page whose contacts failed still carries its
		// suppressions over, and the reverse. Errors are recorded, never thrown:
		// an address we could not suppress is a fact the operator needs on the
		// run, not a reason to abandon the rest of the list.
		let pageSuppressions: SuppressionImportCounts | null = null;
		if (args.suppressions.length > 0 || args.suppressionsSkipped > 0) {
			try {
				pageSuppressions = await ctx.runMutation(
					internal.integrationImports.suppressions.applySuppressionBatch,
					{
						provider: record.provider,
						entries: args.suppressions,
						skipped: args.suppressionsSkipped,
					}
				);
			} catch (error) {
				pageErrors.push(
					`Suppression batch at cursor "${args.cursor}" failed: ${error instanceof Error ? error.message : 'Unknown error'}`
				);
			}
		}

		const pagesCommitted = args.page + 1;
		const progress = {
			imported: record.imported + imported,
			updated: record.updated + updated,
			skipped: record.skipped + skipped,
			failed: record.failed + failed,
			errors: [...record.errors, ...pageErrors].slice(0, MAX_RUN_ERRORS),
			cursor: args.nextCursor ?? args.cursor,
			pagesCommitted,
			lastPageAt: Date.now(),
			pageRecoveries: undefined,
			totalEstimate: args.totalEstimate ?? record.totalEstimate,
			suppressionCounts: pageSuppressions
				? addSuppressionCounts(
						record.suppressionCounts ?? ZERO_SUPPRESSION_COUNTS,
						pageSuppressions
					)
				: record.suppressionCounts,
			// A run a previous release started has no sealed config on its row
			// until its first page commits here.
			resumeConfig: record.resumeConfig ?? resumableConfig(args.config),
		};
		await ctx.db.patch(record._id, progress);

		if (args.nextCursor === null) {
			await finishImport(ctx, { ...record, ...progress }, 'completed', progress.errors);
		} else {
			await schedulePage(ctx, record._id, {
				config: args.config,
				cursor: args.nextCursor,
				page: pagesCommitted,
			});
		}
		return { isCommitted: true };
	},
});
