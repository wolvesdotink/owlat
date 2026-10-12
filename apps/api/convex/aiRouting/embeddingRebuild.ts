/**
 * The staged embedding rebuild's admin actions (ADR-0073, Phase 5): start,
 * validate, activate. The transactions are in `embeddingRebuildState.ts`.
 *
 * A rebuild targets a local embedder, or another model of the stored hosted
 * provider (its stored key). Hosted work is paid and needs spend admission,
 * which is refused while admission is absent.
 */

import { v } from 'convex/values';
import { internal } from '../_generated/api';
import type { ActionCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { authedAction } from '../lib/authedFunctions';
import { anchorActionDeadline } from '../lib/llm/actionDeadline';
import { throwInvalidState } from '../_utils/errors';
import {
	embedForIndex,
	resolveEmbedderForSelection,
	resolveEmbedderForSpace,
} from '../lib/aiRouting/embedderForSpace';
import { runAdmittedEmbedding } from '../lib/aiRouting/embeddingDispatch';
import { embeddingSpaceIdentityKey } from '../lib/aiRouting/embeddingKeys';
import { embeddingProviderKindValidator } from '../lib/validators/aiProviderConfig';
import { searchSpaceVectors } from '../knowledge/vectorSearch';
import { SPACE_PROBE_TEXT } from './embeddingReembed';
import {
	isStagedTransitionAllowed,
	REBUILD_VALIDATION_PASS_RATE,
	STAGED_TRANSITION_REFUSAL,
} from './embeddingRebuildState';

const VALIDATION_SAMPLE = 5;
/** A sampled row passes when its own text finds it among this many hits. */
const VALIDATION_TOP_K = 5;

/** Start a staged rebuild into the embedder `embeddingProviderKind` / `embeddingModel`. */
// authz: admin-only; assertAdmin runs before any credential, admission or provider call
export const startRebuild = authedAction({
	args: {
		embeddingProviderKind: embeddingProviderKindValidator,
		embeddingModel: v.optional(v.string()),
	},
	handler: async (ctx, args): Promise<Id<'embeddingSpaces'>> => {
		// One model budget for this action, from its start (ADR-0073).
		anchorActionDeadline(ctx);
		await ctx.runQuery(internal.aiRouting.embeddingSpaces.assertAdmin, {});
		const { storedEmbeddingKind } = await ctx.runQuery(
			internal.aiRouting.embeddingSpaces.getSpaces,
			{}
		);
		if (
			!storedEmbeddingKind ||
			!isStagedTransitionAllowed(storedEmbeddingKind, args.embeddingProviderKind)
		) {
			throwInvalidState(STAGED_TRANSITION_REFUSAL);
		}
		const embedder = await resolveEmbedderForSelection(ctx, {
			embeddingProviderKind: args.embeddingProviderKind,
			embeddingModel: args.embeddingModel?.trim() || undefined,
		});
		if (!embedder) throwInvalidState(STAGED_TRANSITION_REFUSAL);
		const rootRequestId = `embedding:stage:${crypto.randomUUID()}`;
		// One call measures the staged space (width, digest) before anything is
		// written; admitted when the resolved embedder is hosted, settled once.
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
		// The job's payment is derived from the staged space's own endpoint.
		return await ctx.runMutation(internal.aiRouting.embeddingRebuildState.stageSpace, {
			space: probe.value.space,
		});
	},
});

export interface RebuildValidation {
	spaceId: Id<'embeddingSpaces'>;
	sampled: number;
	passed: number;
	isPassing: boolean;
}

/**
 * The bounded sanity check: each sampled staged row's own text, embedded with
 * the staged model, must find that row among the top hits of the staged index.
 */
async function validateStagedSpace(ctx: ActionCtx): Promise<RebuildValidation> {
	anchorActionDeadline(ctx);
	await ctx.runQuery(internal.aiRouting.embeddingSpaces.assertAdmin, {});
	const { staged } = await ctx.runQuery(internal.aiRouting.embeddingSpaces.getSpaces, {});
	if (!staged) throwInvalidState('There is no staged embedding space.');
	const embedder = await resolveEmbedderForSpace(ctx, staged);
	if (!embedder) throwInvalidState('No embedder can be built for the staged space.');
	const sample = await ctx.runQuery(internal.aiRouting.embeddingRebuildState.stagedSample, {
		spaceId: staged._id,
		size: VALIDATION_SAMPLE,
	});
	// Admitted when the resolved embedder is hosted, and settled exactly once with
	// the calls started, even when an embedding or a search throws midway.
	const outcome = await runAdmittedEmbedding(
		ctx,
		embedder,
		{
			rootRequestId: `embedding:validate:${staged._id}`,
			task: 'embedding.index',
			jobKind: 'rebuild',
			items: sample.length,
			inputChars: sample.reduce((sum, row) => sum + row.text.length, 0),
		},
		async (counter) => {
			let found = 0;
			for (const row of sample) {
				const fresh = await embedForIndex(
					ctx,
					embedder,
					row.text,
					{
						feature: 'embedding_knowledge_search',
						task: 'embedding.query',
						root: { rootRequestId: `embedding:validate:${staged._id}` },
					},
					counter
				);
				if (embeddingSpaceIdentityKey(fresh.space) !== staged.identityKey) continue;
				const hits = await searchSpaceVectors(ctx, row.table, {
					vector: fresh.vector,
					embeddingSpaceId: staged._id,
					limit: VALIDATION_TOP_K,
					allowStaged: true,
				});
				if (hits.some((hit) => hit._id === row.id)) found += 1;
			}
			return found;
		}
	);
	if (!outcome.isAdmitted) throwInvalidState(outcome.reason);
	const passed = outcome.value;
	const sampled = sample.length;
	return {
		spaceId: staged._id,
		sampled,
		passed,
		isPassing: sampled > 0 && passed / sampled >= REBUILD_VALIDATION_PASS_RATE,
	};
}

/** Validate the staged space without activating it. */
// authz: admin-only; assertAdmin runs before any credential or provider call
export const validateStaged = authedAction({
	args: {},
	handler: async (ctx): Promise<RebuildValidation> => validateStagedSpace(ctx),
});

/** Validate, then activate the staged space atomically. Refused when validation fails. */
// authz: admin-only; assertAdmin runs first, activateStagedSpace checks again
export const activateStaged = authedAction({
	args: {},
	handler: async (ctx): Promise<RebuildValidation> => {
		// One model budget for this action, from its start (ADR-0073).
		anchorActionDeadline(ctx);
		const validation = await validateStagedSpace(ctx);
		if (!validation.isPassing) {
			throwInvalidState(
				`The staged embedding space failed validation: ${validation.passed} of ${validation.sampled} sampled items found themselves.`,
				{ ...validation }
			);
		}
		await ctx.runMutation(internal.aiRouting.embeddingRebuildState.activateStagedSpace, {
			spaceId: validation.spaceId,
			sampled: validation.sampled,
			passed: validation.passed,
		});
		return validation;
	},
});
