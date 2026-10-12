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
import { throwInvalidState } from '../_utils/errors';
import {
	embedForIndex,
	resolveEmbedderForSelection,
	resolveEmbedderForSpace,
} from '../lib/aiRouting/embedderForSpace';
import { admitPaidEmbeddingBatch } from '../lib/aiRouting/embeddingAdmission';
import { embeddingSpaceIdentityKey } from '../lib/aiRouting/embeddingKeys';
import { embeddingProviderKindValidator } from '../lib/validators/aiProviderConfig';
import { searchSpaceVectors } from '../knowledge/vectorSearch';
import { SPACE_PROBE_TEXT } from './embeddingReembed';
import { REBUILD_VALIDATION_PASS_RATE } from './embeddingRebuildState';

const VALIDATION_SAMPLE = 5;
/** A sampled row passes when its own text finds it among this many hits. */
const VALIDATION_TOP_K = 5;

/** Start a staged rebuild into the embedder `embeddingProviderKind` / `embeddingModel`. */
// authz: admin-only; stageSpace requires organization:manage before anything is stored
export const startRebuild = authedAction({
	args: {
		embeddingProviderKind: embeddingProviderKindValidator,
		embeddingModel: v.optional(v.string()),
	},
	handler: async (ctx, args): Promise<Id<'embeddingSpaces'>> => {
		const embedder = await resolveEmbedderForSelection(ctx, {
			embeddingProviderKind: args.embeddingProviderKind,
			embeddingModel: args.embeddingModel?.trim() || undefined,
		});
		if (!embedder) {
			throwInvalidState(
				'A staged rebuild can use a local embedder or another model of the stored hosted provider. To move to another hosted provider, select it in the settings with its key.'
			);
		}
		const isPaid = !embedder.target.isLocal;
		let settle: ((usage: { inputTokens: number | undefined }) => Promise<void>) | undefined;
		if (isPaid) {
			const admission = await admitPaidEmbeddingBatch(ctx, {
				rootRequestId: `embedding:stage:${Date.now()}`,
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
		// One call measures the staged space (width, digest) before anything is written.
		const { space } = await embedForIndex(embedder, SPACE_PROBE_TEXT);
		await settle?.({ inputTokens: undefined });
		return await ctx.runMutation(internal.aiRouting.embeddingRebuildState.stageSpace, {
			space,
			isPaid,
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
	const { staged } = await ctx.runQuery(internal.aiRouting.embeddingSpaces.getSpaces, {});
	if (!staged) throwInvalidState('There is no staged embedding space.');
	const embedder = await resolveEmbedderForSpace(ctx, staged);
	if (!embedder) throwInvalidState('No embedder can be built for the staged space.');
	const sample = await ctx.runQuery(internal.aiRouting.embeddingRebuildState.stagedSample, {
		spaceId: staged._id,
		size: VALIDATION_SAMPLE,
	});
	let settle: ((usage: { inputTokens: number | undefined }) => Promise<void>) | undefined;
	if (!embedder.target.isLocal) {
		const admission = await admitPaidEmbeddingBatch(ctx, {
			rootRequestId: `embedding:validate:${staged._id}`,
			task: 'embedding.index',
			jobKind: 'rebuild',
			provider: staged.provider,
			model: staged.model,
			items: sample.length,
			inputChars: sample.reduce((sum, row) => sum + row.text.length, 0),
		});
		if (!admission.isAdmitted) throwInvalidState(admission.reason);
		settle = admission.settle;
	}
	let passed = 0;
	for (const row of sample) {
		const fresh = await embedForIndex(embedder, row.text);
		if (embeddingSpaceIdentityKey(fresh.space) !== staged.identityKey) continue;
		const hits = await searchSpaceVectors(ctx, row.table, {
			vector: fresh.vector,
			embeddingSpaceId: staged._id,
			limit: VALIDATION_TOP_K,
			allowStaged: true,
		});
		if (hits.some((hit) => hit._id === row.id)) passed += 1;
	}
	await settle?.({ inputTokens: undefined });
	const sampled = sample.length;
	return {
		spaceId: staged._id,
		sampled,
		passed,
		isPassing: sampled > 0 && passed / sampled >= REBUILD_VALIDATION_PASS_RATE,
	};
}

/** Validate the staged space without activating it. */
// authz: admin-only; stagedSample requires organization:manage
export const validateStaged = authedAction({
	args: {},
	handler: async (ctx): Promise<RebuildValidation> => validateStagedSpace(ctx),
});

/** Validate, then activate the staged space atomically. Refused when validation fails. */
// authz: admin-only; stagedSample and activateStagedSpace require organization:manage
export const activateStaged = authedAction({
	args: {},
	handler: async (ctx): Promise<RebuildValidation> => {
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
