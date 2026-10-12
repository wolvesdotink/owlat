/**
 * The re-embed job's actions (ADR-0073, Phase 1a, D8 and Phase 5; #1334).
 *
 *   - `kickoff` runs from the cron and after every event that changes what is
 *     searchable (a settings save, a space switch, an attestation). With a
 *     local embedder it measures the configured space (one free probe call),
 *     activates it (the D8 switch path) and starts or resumes the local
 *     re-embed. A hosted embedder never re-embeds from here: an admin starts it
 *     (`embeddingReembedJobs.startReembed`), and it waits for admission.
 *   - `runBatch` embeds one page of a job and commits it, then schedules the
 *     next. A paid batch is admitted first.
 *
 * Every embedding call goes through `embedForIndex`, the one place the ledger
 * lane meters (task `embedding.index`).
 */

import { v } from 'convex/values';
import { internal } from '../_generated/api';
import { internalAction } from '../_generated/server';
import { logInfo } from '../lib/runtimeLog';
import {
	configuredEmbedderOrNull,
	embedForIndex,
	resolveEmbedderForSpace,
} from '../lib/aiRouting/embedderForSpace';
import { admitPaidEmbeddingBatch } from '../lib/aiRouting/embeddingAdmission';
import { embeddingSpaceIdentityKey } from '../lib/aiRouting/embeddingKeys';
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

export const runBatch = internalAction({
	args: { jobId: v.id('embeddingReembedJobs'), generation: v.number() },
	handler: async (ctx, args): Promise<void> => {
		const page = await ctx.runQuery(internal.aiRouting.embeddingReembedJobs.reembedPage, args);
		if (page.kind === 'stop') return;
		const pause = (reason: 'budget' | 'provider_unavailable', lastError: string) =>
			ctx.runMutation(internal.aiRouting.embeddingReembedJobs.pauseJob, {
				...args,
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
			for (const item of page.items) {
				try {
					const embedded = await embedForIndex(embedder, item.text);
					// One space per page: a vector measured elsewhere fails the page's commit.
					if (
						space &&
						embeddingSpaceIdentityKey(space) !== embeddingSpaceIdentityKey(embedded.space)
					) {
						failed += 1;
						continue;
					}
					space = embedded.space;
					results.push({ id: item.id, vector: embedded.vector, fingerprint: item.fingerprint });
				} catch (error) {
					failed += 1;
					logInfo('[embedding.reembed] embed failed', { error: String(error) });
				}
			}
			await settle?.({ inputTokens: undefined });
			if (results.length === 0) {
				// Nothing embedded: keep the cursor and let the kickoff resume later.
				await pause('provider_unavailable', 'Every embedding call in the batch failed.');
				return;
			}
		}

		const { isContinuing } = await ctx.runMutation(
			internal.aiRouting.embeddingReembedJobs.reembedCommit,
			{
				...args,
				phase: page.phase,
				continueCursor: page.continueCursor,
				isDone: page.isDone,
				scanned: page.scanned,
				failed,
				space,
				results,
			}
		);
		if (isContinuing)
			await ctx.scheduler.runAfter(0, internal.aiRouting.embeddingReembed.runBatch, args);
	},
});
