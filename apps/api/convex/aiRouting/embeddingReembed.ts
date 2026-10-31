/**
 * The re-embed job's actions (#1334).
 *
 *   - `kickoff` runs from the cron and after every event that changes what is
 *     searchable (a settings save, a space switch, an attestation). With a
 *     local embedder it measures the configured space (one free probe call),
 *     activates it (the embedding switch path) and starts or resumes the local
 *     re-embed. A hosted embedder never re-embeds from here: an admin starts it
 *     (`startReembed`), and every batch is admitted.
 *   - `startReembed` is the admin start, and the bootstrap of a corpus with no
 *     searchable space yet (a hosted deployment's first upgrade): it measures
 *     the configured space (one call, admitted when paid), activates it and
 *     starts the job.
 *   - `runBatch` embeds one page of a job and commits it together with the
 *     next batch, a retry or a pause. A paid batch is admitted first.
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
import { embeddingTargetKey, secretFreeErrorText } from '../lib/embeddingSpace';
import { anchorActionDeadline } from '../lib/llm/actionDeadline';
import { rootRequest } from '../lib/llm/requestMeter';
import {
	configuredEmbedderOrNull,
	embedForIndex,
	embedTextsForIndex,
	resolveEmbedderForSpace,
} from '../lib/aiRouting/embedderForSpace';
import { buildIndexEmbedder, readEmbeddingConfigSnapshot } from '../lib/llmProvider';
import { PAID_EMBEDDING_REFUSAL } from './embeddingReembedJobs';
import { isPaidEmbeddingAdmissionAvailable } from '../lib/aiRouting/embeddingAdmission';
import { runAdmittedEmbedding, type DispatchCounter } from '../lib/aiRouting/embeddingDispatch';
import { embeddingTableValidator } from '../lib/validators/embedding';
import {
	assertExpectedSpace,
	assertExpectedTarget,
	identityOf,
	isIdentityOfTarget,
	type MeasuredSpace,
} from '../lib/aiRouting/embeddingRegistry';

/** The text a local embedder is measured with (dimensions, digest). Never stored. */
export const SPACE_PROBE_TEXT = 'Owlat embedding space probe';

export const kickoff = internalAction({
	args: { isForced: v.optional(v.boolean()) },
	handler: async (ctx, args): Promise<void> => {
		// One model budget for this action, from its start.
		anchorActionDeadline(ctx);
		// checkpoint: a best-effort cache refresh. It schedules a coverage count only
		// when the stored one is stale (or forced), whatever the kickoff does next.
		await ctx.runMutation(internal.aiRouting.embeddingCoverage.requestScan, {
			isForced: args.isForced ?? false,
		});
		let space: MeasuredSpace;
		try {
			const embedder = await configuredEmbedderOrNull(ctx);
			if (!embedder || !embedder.target.isLocal) return;
			space = (
				await embedForIndex(ctx, embedder, SPACE_PROBE_TEXT, {
					feature: 'embedding_knowledge',
					task: 'embedding.index',
					root: { rootRequestId: `embedding:kickoff:${crypto.randomUUID()}` },
				})
			).space;
		} catch (error) {
			// A misconfigured embedder fails loudly where it is used; the local
			// server may just be down. Either way the next cron run tries again.
			logInfo('[embedding.kickoff] local embedder unavailable', {
				error: secretFreeErrorText(error),
			});
			return;
		}
		const outcome = await ctx.runMutation(
			internal.aiRouting.embeddingReembedCommit.activateLocalSpace,
			{
				space,
				isForced: args.isForced ?? false,
			}
		);
		if (outcome === 'inactive') return;
		logInfo('[embedding.kickoff] local re-embed', { outcome });
	},
});

/**
 * Re-embed now into the configured space (admin). With a hosted embedder this
 * is the only way a paid re-embed starts, and it needs spend admission: it
 * is refused while admission is absent. When no space is searchable yet (a
 * hosted deployment's first upgrade, with no new content since), it first
 * measures the configured space with one admitted call and activates it.
 * Payment is decided by the embedder about to be called, never by an earlier
 * configuration read; the job itself derives it from its target space.
 */
// authz: admin-only; assertAdmin runs first, startReembedJob checks again
export const startReembed = authedAction({
	/**
	 * `expectedSpaceId`: the searchable space the caller confirmed re-embedding
	 * into. `expectedTargetKey`: the configured target confirmed
	 * (`status.configured.targetKey`), for a switch with no space to name yet.
	 */
	args: {
		expectedSpaceId: v.optional(v.id('embeddingSpaces')),
		expectedTargetKey: v.optional(v.string()),
	},
	handler: async (ctx, args): Promise<Id<'embeddingReembedJobs'>> => {
		// One model budget for this action, from its start.
		anchorActionDeadline(ctx);
		await ctx.runQuery(internal.aiRouting.embeddingSpaces.assertAdmin, {});
		const { active } = await ctx.runQuery(internal.aiRouting.embeddingSpaces.getSpaces, {});
		// The configuration is read ONCE: this snapshot's target is the one checked
		// against the confirmation, judged for payment and searchability, and the
		// one whose endpoint and credential (from the same read) the bootstrap uses.
		const snapshot = await readEmbeddingConfigSnapshot(ctx);
		const target = snapshot.target;
		// Before any credential or provider call: the target and the space
		// confirmed are the configured target and its searchable space.
		assertExpectedTarget(target ? embeddingTargetKey(target) : null, args.expectedTargetKey);
		const isActiveConfigured =
			active !== null && target !== null && isIdentityOfTarget(identityOf(active), target);
		assertExpectedSpace(isActiveConfigured ? active : null, args.expectedSpaceId);
		if (!target) throwInvalidState('No embedding model is configured.');
		// The dispatch below and the job's own derivation decide again from what
		// they really use; this refuses early.
		if (!target.isLocal && !isPaidEmbeddingAdmissionAvailable()) {
			throwInvalidState(PAID_EMBEDDING_REFUSAL);
		}
		if (!isActiveConfigured) {
			const embedder = buildIndexEmbedder(await snapshot.plane(), target);
			const rootRequestId = `embedding:bootstrap:${crypto.randomUUID()}`;
			const probe = await runAdmittedEmbedding(
				ctx,
				embedder,
				{
					rootRequestId,
					task: 'embedding.index',
					jobKind: 'probe',
					items: 1,
					inputChars: SPACE_PROBE_TEXT.length,
				},
				(counter) =>
					embedForIndex(
						ctx,
						embedder,
						SPACE_PROBE_TEXT,
						{ feature: 'embedding_knowledge', task: 'embedding.index', root: { rootRequestId } },
						counter
					)
			);
			if (!probe.isAdmitted) throwInvalidState(probe.reason);
			// Activated only while the configuration still names the confirmed
			// target (refused in the transaction when it was confirmed).
			const active = await ctx.runMutation(internal.aiRouting.embeddingSpaces.ensureConfigured, {
				space: probe.value.space,
				expectedTargetKey: args.expectedTargetKey,
			});
			if (!active) throwInvalidState('The embedding configuration changed. Try again.');
		}
		return await ctx.runMutation(internal.aiRouting.embeddingReembedJobs.startReembedJob, {
			expectedSpaceId: args.expectedSpaceId,
			expectedTargetKey: args.expectedTargetKey,
		});
	},
});

/**
 * Re-embed one row whose input an edit changed (it has no vector in any column
 * now). Local embedders only: a hosted one waits for the admin re-embed.
 */
export const reembedRow = internalAction({
	args: { table: embeddingTableValidator, id: v.string() },
	handler: async (ctx, args): Promise<void> => {
		// One model budget for this action, from its start.
		anchorActionDeadline(ctx);
		const row = await ctx.runQuery(internal.aiRouting.embeddingRowReembed.rowForReembed, args);
		if (!row) return;
		try {
			const embedder = await configuredEmbedderOrNull(ctx);
			// Classified from the embedder about to be called: never a paid call here.
			if (!embedder || !embedder.target.isLocal) return;
			const { vector, space } = await embedForIndex(ctx, embedder, row.text, {
				feature: args.table === 'knowledgeEntries' ? 'embedding_knowledge' : 'embedding_file',
				task: 'embedding.index',
				root: rootRequest(args.table === 'knowledgeEntries' ? 'knowledge' : 'file', args.id),
			});
			await ctx.runMutation(internal.aiRouting.embeddingRowReembed.commitRowVector, {
				...args,
				fingerprint: row.fingerprint,
				vector,
				space,
			});
		} catch (error) {
			// The daily local pass embeds it instead.
			logInfo('[embedding.reembedRow] failed', { error: secretFreeErrorText(error) });
		}
	},
});

export const runBatch = internalAction({
	args: {
		jobId: v.id('embeddingReembedJobs'),
		generation: v.number(),
		/** 1-based attempt at the job's current page (absent: 1). */
		attempt: v.optional(v.number()),
	},
	handler: async (ctx, args): Promise<void> => {
		// One model budget for this action, from its start.
		anchorActionDeadline(ctx);
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
			let embedder: Awaited<ReturnType<typeof resolveEmbedderForSpace>>;
			try {
				embedder = await resolveEmbedderForSpace(ctx, page.target);
			} catch (error) {
				embedder = null;
				logInfo('[embedding.reembed] embedder unavailable', { error: secretFreeErrorText(error) });
			}
			if (!embedder) {
				await pause('provider_unavailable', 'No embedder can be built for the target space.');
				return;
			}
			const resolved = embedder;
			const texts = page.items.map((item) => item.text);
			const runBatchCalls = async (counter: DispatchCounter) => {
				try {
					return await embedTextsForIndex(
						ctx,
						resolved,
						texts,
						{
							feature: page.phase === 'knowledgeEntries' ? 'embedding_knowledge' : 'embedding_file',
							task: 'embedding.index',
							root: { rootRequestId: page.rootRequestId },
						},
						counter
					);
				} catch (error) {
					// The revision probe could not reach the server: the whole page failed.
					logInfo('[embedding.reembed] revision probe failed', {
						error: secretFreeErrorText(error),
					});
					return { vectors: texts.map(() => null), space: null };
				}
			};
			const batchRequest = {
				rootRequestId: page.rootRequestId,
				task: 'embedding.index' as const,
				jobKind: page.jobKind,
				items: texts.length,
				inputChars: texts.reduce((sum, text) => sum + text.length, 0),
			};
			// Admitted when the job is paid OR the embedder about to be called is
			// hosted (`runAdmittedEmbedding` classifies it); settled once, whatever
			// happens, with the calls started.
			const outcome = await runAdmittedEmbedding(ctx, resolved, batchRequest, runBatchCalls, {
				isPaid: page.isPaid,
			});
			if (!outcome.isAdmitted) {
				await pause('budget', outcome.reason);
				return;
			}
			const batch = outcome.value;
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

		await ctx.runMutation(internal.aiRouting.embeddingReembedCommit.commitBatch, {
			...job,
			attempt,
			phase: page.phase,
			continueCursor: page.continueCursor,
			isDone: page.isDone,
			scanned: page.scanned,
			failed,
			space,
			results,
		});
	},
});
