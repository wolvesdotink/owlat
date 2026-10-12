/**
 * The re-embed job's actions (ADR-0073, Phase 1a, D8 and Phase 5; #1334).
 *
 *   - `kickoff` runs from the cron and after every event that changes what is
 *     searchable (a settings save, a space switch, an attestation). With a
 *     local embedder it measures the configured space (one free probe call),
 *     activates it (the D8 switch path) and starts or resumes the local
 *     re-embed. A hosted embedder never re-embeds from here: an admin starts it
 *     (`startReembed`), and every batch is admitted.
 *   - `startReembed` is the admin start, and the bootstrap of a corpus with no
 *     searchable space yet (a hosted deployment's first upgrade): it measures
 *     the configured space (one call, admitted when paid), activates it and
 *     starts the job.
 *   - `runBatch` embeds one page of a job and commits it, then schedules the
 *     next. A paid batch is admitted first.
 *
 * Every embedding call goes through `embedForIndex`, the one place the ledger
 * lane meters (task `embedding.index`).
 */

import { v } from 'convex/values';
import { internal } from '../_generated/api';
import { internalAction } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { authedAction } from '../lib/authedFunctions';
import { throwInvalidState } from '../_utils/errors';
import { logInfo } from '../lib/runtimeLog';
import {
	configuredEmbedderOrNull,
	embedForIndex,
	embedTextsForIndex,
	resolveEmbedderForSpace,
} from '../lib/aiRouting/embedderForSpace';
import { PAID_EMBEDDING_REFUSAL, REEMBED_PAGE_ATTEMPTS } from './embeddingReembedJobs';
import {
	admitPaidEmbeddingBatch,
	isPaidEmbeddingAdmissionAvailable,
} from '../lib/aiRouting/embeddingAdmission';
import type { MeasuredSpace } from '../lib/aiRouting/embeddingRegistry';

/** The text a local embedder is measured with (dimensions, digest). Never stored. */
export const SPACE_PROBE_TEXT = 'Owlat embedding space probe';

export const kickoff = internalAction({
	args: { isForced: v.optional(v.boolean()) },
	handler: async (ctx, args): Promise<void> => {
		await ctx.runMutation(internal.aiRouting.embeddingCoverage.requestScan, {
			isForced: args.isForced ?? false,
		});
		let space: MeasuredSpace;
		try {
			const embedder = await configuredEmbedderOrNull(ctx);
			if (!embedder || !embedder.target.isLocal) return;
			space = (await embedForIndex(embedder, SPACE_PROBE_TEXT)).space;
		} catch (error) {
			// A misconfigured embedder fails loudly where it is used; the local
			// server may just be down. Either way the next cron run tries again.
			logInfo('[embedding.kickoff] local embedder unavailable', { error: String(error) });
			return;
		}
		const active = await ctx.runMutation(internal.aiRouting.embeddingSpaces.ensureConfigured, {
			space,
		});
		if (!active) return;
		const outcome = await ctx.runMutation(
			internal.aiRouting.embeddingReembedJobs.startLocalReembed,
			{
				spaceId: active._id,
				isForced: args.isForced ?? false,
			}
		);
		logInfo('[embedding.kickoff] local re-embed', { outcome });
	},
});

/**
 * Re-embed now into the configured space (admin). With a hosted embedder this
 * is the only way a paid re-embed starts (D8), and it needs spend admission: it
 * is refused while admission is absent. When no space is searchable yet (a
 * hosted deployment's first upgrade, with no new content since), it first
 * measures the configured space with one admitted call and activates it.
 */
// authz: admin-only; assertAdmin runs first, startReembedJob checks again
export const startReembed = authedAction({
	args: {},
	handler: async (ctx): Promise<Id<'embeddingReembedJobs'>> => {
		await ctx.runQuery(internal.aiRouting.embeddingSpaces.assertAdmin, {});
		const { isActiveConfigured, isConfiguredLocal } = await ctx.runQuery(
			internal.aiRouting.embeddingSpaces.getSpaces,
			{}
		);
		if (isConfiguredLocal === null) throwInvalidState('No embedding model is configured.');
		// Refused before any credential is read or any provider is called.
		const isPaid = !isConfiguredLocal;
		if (isPaid && !isPaidEmbeddingAdmissionAvailable()) throwInvalidState(PAID_EMBEDDING_REFUSAL);
		if (!isActiveConfigured) {
			const embedder = await configuredEmbedderOrNull(ctx);
			if (!embedder) throwInvalidState('No embedding model is configured.');
			let settle: ((usage: { inputTokens: number | undefined }) => Promise<void>) | undefined;
			if (isPaid) {
				const admission = await admitPaidEmbeddingBatch(ctx, {
					rootRequestId: `embedding:bootstrap:${Date.now()}`,
					task: 'embedding.index',
					jobKind: 'probe',
					provider: embedder.target.provider,
					model: embedder.target.model,
					items: 1,
					inputChars: SPACE_PROBE_TEXT.length,
				});
				if (!admission.isAdmitted) throwInvalidState(admission.reason);
				settle = admission.settle;
			}
			const { space } = await embedForIndex(embedder, SPACE_PROBE_TEXT);
			await settle?.({ inputTokens: undefined });
			const active = await ctx.runMutation(internal.aiRouting.embeddingSpaces.ensureConfigured, {
				space,
			});
			if (!active) throwInvalidState('The embedding configuration changed. Try again.');
		}
		return await ctx.runMutation(internal.aiRouting.embeddingReembedJobs.startReembedJob, {
			isPaid,
		});
	},
});

/** Wait before retrying a page whose rows did not all land, per attempt. */
const RETRY_DELAY_MS = 30_000;

export const runBatch = internalAction({
	args: {
		jobId: v.id('embeddingReembedJobs'),
		generation: v.number(),
		/** 1-based attempt at the job's current page (absent: 1). */
		attempt: v.optional(v.number()),
	},
	handler: async (ctx, args): Promise<void> => {
		const job = { jobId: args.jobId, generation: args.generation };
		const attempt = args.attempt ?? 1;
		const page = await ctx.runQuery(internal.aiRouting.embeddingReembedJobs.reembedPage, job);
		if (page.kind === 'stop') return;
		const pause = (reason: 'budget' | 'provider_unavailable', lastError: string) =>
			ctx.runMutation(internal.aiRouting.embeddingReembedJobs.pauseJob, {
				...job,
				reason,
				lastError,
			});

		const results: { id: string; vector: number[]; fingerprint: string }[] = [];
		let failed = 0;
		let space: MeasuredSpace | undefined;
		if (page.items.length > 0) {
			// Admission first: a refused paid batch touches no provider and no secret.
			let settle: ((usage: { inputTokens: number | undefined }) => Promise<void>) | undefined;
			if (page.isPaid) {
				const admission = await admitPaidEmbeddingBatch(ctx, {
					rootRequestId: page.rootRequestId,
					task: 'embedding.index',
					jobKind: page.jobKind,
					provider: page.target.provider,
					model: page.target.model,
					items: page.items.length,
					inputChars: page.items.reduce((sum, item) => sum + item.text.length, 0),
				});
				if (!admission.isAdmitted) {
					await pause('budget', admission.reason);
					return;
				}
				settle = admission.settle;
			}
			let embedder: Awaited<ReturnType<typeof resolveEmbedderForSpace>>;
			try {
				embedder = await resolveEmbedderForSpace(ctx, page.target);
			} catch (error) {
				embedder = null;
				logInfo('[embedding.reembed] embedder unavailable', { error: String(error) });
			}
			if (!embedder) {
				await settle?.({ inputTokens: 0 });
				await pause('provider_unavailable', 'No embedder can be built for the target space.');
				return;
			}
			let batch: Awaited<ReturnType<typeof embedTextsForIndex>>;
			try {
				batch = await embedTextsForIndex(
					embedder,
					page.items.map((item) => item.text)
				);
			} catch (error) {
				// The revision probe could not reach the server: the whole page failed.
				logInfo('[embedding.reembed] revision probe failed', { error: String(error) });
				batch = { vectors: page.items.map(() => null), space: null };
			}
			await settle?.({ inputTokens: undefined });
			space = batch.space ?? undefined;
			for (const [index, item] of page.items.entries()) {
				const embedded = batch.vectors[index];
				if (embedded && batch.space) {
					results.push({ id: item.id, vector: embedded.vector, fingerprint: item.fingerprint });
				} else {
					failed += 1;
				}
			}
		}

		const commit = await ctx.runMutation(internal.aiRouting.embeddingReembedJobs.reembedCommit, {
			...job,
			phase: page.phase,
			continueCursor: page.continueCursor,
			isDone: page.isDone,
			scanned: page.scanned,
			failed,
			space,
			copies: page.copies,
			results,
		});
		if (commit.outcome === 'continue') {
			await ctx.scheduler.runAfter(0, internal.aiRouting.embeddingReembed.runBatch, job);
		} else if (commit.outcome === 'retry') {
			if (attempt >= REEMBED_PAGE_ATTEMPTS) {
				// Keep the cursor: a resume (the kickoff, or an admin) retries the page.
				await pause(
					'provider_unavailable',
					`${commit.unresolved} item(s) could not be embedded after ${attempt} attempts.`
				);
				return;
			}
			await ctx.scheduler.runAfter(
				RETRY_DELAY_MS * attempt,
				internal.aiRouting.embeddingReembed.runBatch,
				{ ...job, attempt: attempt + 1 }
			);
		}
	},
});
