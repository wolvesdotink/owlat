/**
 * The staged embedding rebuild's transactions (ADR-0073, Phase 5).
 *
 * Build into a staged space while retrieval keeps the active one, validate the
 * staged space with a bounded sample of queries (`embeddingRebuild.ts`), then
 * activate it in ONE mutation: the staged space becomes active, the previous
 * active space retires with its vectors intact in its own column, and the
 * stored configuration switches to the staged embedder. Rollback is the same
 * flip back to the recorded predecessor. A staged rebuild needs a stored
 * configuration, because activation rewrites it; an env-only deployment switches
 * through its environment (D8). Activation needs a completed rebuild (every
 * page landed) and no row written during the rebuild still lacking its vector
 * (`catchUpRebuild` walks again): every input change and every added row
 * records `inputChangedAt` on the staged space (`markCorpusChanged`), so a pass
 * that started after the last change covers every eligible row.
 */

import { v } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import { internalQuery, type MutationCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { adminMutation } from '../lib/authedFunctions';
import { recordAuditLog } from '../lib/auditLog';
import { requireOrgPermission } from '../lib/sessionOrganization';
import { throwConflict, throwInvalidState } from '../_utils/errors';
import { isLocalEmbeddingKind, storedEmbeddingTarget } from '../lib/embeddingSpace';
import type { EmbeddingProviderKind } from '../lib/llmProviders/types';
import { isPaidEmbeddingAdmissionAvailable } from '../lib/aiRouting/embeddingAdmission';
import { embeddingSpaceIdentityKey } from '../lib/aiRouting/embeddingKeys';
import {
	activateSpace,
	claimColumn,
	isSpaceLocal,
	retireStagedSpace,
} from '../lib/aiRouting/embeddingActivation';
import {
	assertExpectedSpace,
	identityOf,
	isIdentityOfTarget,
	otherSlot,
	ownsColumn,
	readActiveSpace,
	readSearchableSpace,
	readSpaceByIdentity,
	readStagedSpace,
	type SpaceDoc,
} from '../lib/aiRouting/embeddingRegistry';
import { fileEmbeddingInput, knowledgeEmbeddingInput } from '../lib/aiRouting/embeddingInputs';
import { measuredEmbeddingSpaceValidator } from '../lib/validators/embedding';
import { PAID_EMBEDDING_REFUSAL, readOpenJob, startJob } from './embeddingReembedJobs';
import { readRollbackSpace } from './embeddingSpaces';

/** The minimum share of sampled rows whose own text must find them (top 5). */
export const REBUILD_VALIDATION_PASS_RATE = 0.8;

type ConfigRow = Doc<'aiProviderConfig'>;

async function requireStoredConfig(ctx: MutationCtx): Promise<ConfigRow> {
	const row = await ctx.db.query('aiProviderConfig').first(); // bounded: org singleton
	if (!row) {
		throwInvalidState(
			'A staged rebuild switches the stored AI configuration, and this deployment uses environment settings. Change the embedding model there instead.'
		);
	}
	return row;
}

/**
 * Whether a staged rebuild (and its rollback) may move the stored embedder from
 * `from` to `to` without a new secret: between local kinds, or between models
 * of one provider kind, whose stored key stays valid. Any other move (hosted to
 * local, local to hosted, one hosted provider to another) would drop or need a
 * key, which would leave the rollback without credentials; it goes through the
 * settings instead (the D8 switch path).
 */
export function isStagedTransitionAllowed(
	from: EmbeddingProviderKind,
	to: EmbeddingProviderKind
): boolean {
	return from === to || (isLocalEmbeddingKind(from) && isLocalEmbeddingKind(to));
}

export const STAGED_TRANSITION_REFUSAL =
	'A staged rebuild can move between local embedders, or between models of the stored hosted provider. To change to or from a hosted provider, select it in the settings.';

/**
 * Point the stored configuration at `space`'s embedder. Only a transition
 * `isStagedTransitionAllowed` accepts, so the stored key (if any) stays valid.
 */
async function switchConfigTo(ctx: MutationCtx, row: ConfigRow, space: SpaceDoc): Promise<void> {
	const selection = { embeddingProviderKind: space.provider, embeddingModel: space.model };
	if (
		space.source === 'env' ||
		!isIdentityOfTarget(identityOf(space), storedEmbeddingTarget(selection))
	) {
		throwInvalidState('This embedding space cannot be selected in the stored configuration.');
	}
	if (!isStagedTransitionAllowed(row.embeddingProviderKind, space.provider)) {
		throwInvalidState(STAGED_TRANSITION_REFUSAL);
	}
	await ctx.db.patch(row._id, {
		...selection,
		embeddingModelVersion: row.embeddingModelVersion + 1,
		configRevision: (row.configRevision ?? 0) + 1,
		updatedAt: Date.now(),
	});
}

/** Register the staged space a `startRebuild` measured and start its rebuild job. */
export const stageSpace = internalMutation({
	args: { space: measuredEmbeddingSpaceValidator },
	handler: async (ctx, args): Promise<Id<'embeddingSpaces'>> => {
		const session = await requireOrgPermission(ctx, 'organization:manage');
		const row = await requireStoredConfig(ctx);
		const active = await readSearchableSpace(ctx.db);
		if (!active) {
			throwInvalidState('There is no active embedding space to rebuild from yet.');
		}
		if (!isStagedTransitionAllowed(row.embeddingProviderKind, args.space.provider)) {
			throwInvalidState(STAGED_TRANSITION_REFUSAL);
		}
		if (await readStagedSpace(ctx.db)) throwConflict('A staged rebuild already exists.');
		if (await readOpenJob(ctx)) {
			throwConflict('A re-embed or rebuild is already running. Wait for it, or cancel it first.');
		}
		const { source, ...identity } = args.space;
		if (embeddingSpaceIdentityKey(identity) === active.identityKey) {
			throwInvalidState('This embedding model is already the active one.');
		}
		// The column the active space does not use. A known space that still owns
		// it keeps its vectors there (the rebuild skips them); otherwise it is
		// superseded and rebuilt from scratch (claimColumn). No vector is copied.
		const known = await readSpaceByIdentity(ctx.db, identity);
		const staged = await claimColumn(ctx, known ? { existing: known } : { identity, source }, {
			slot: otherSlot(active.slot),
			state: 'staged',
			extra: { inputChangedAt: undefined },
		});
		const spaceId = staged._id;
		// Paid or not is the staged space's own endpoint, read in this transaction.
		const isPaid = !isSpaceLocal(staged);
		if (isPaid && !isPaidEmbeddingAdmissionAvailable()) throwInvalidState(PAID_EMBEDDING_REFUSAL);
		const jobId = await startJob(ctx, {
			kind: 'rebuild',
			targetSpaceId: spaceId,
			isPaid,
			startedBy: session.userId,
		});
		await recordAuditLog(ctx, {
			userId: session.userId,
			organizationId: session.activeOrganizationId,
			action: 'embedding_space.staged',
			resource: 'embedding_space',
			resourceId: spaceId,
			details: { jobId, provider: identity.provider, model: identity.model, isPaid },
		});
		return spaceId;
	},
});

/** Up to `size` rows per table that hold a vector in the staged space, for validation. */
export const stagedSample = internalQuery({
	args: { spaceId: v.id('embeddingSpaces'), size: v.number() },
	handler: async (ctx, args) => {
		await requireOrgPermission(ctx, 'organization:manage');
		const space = await ctx.db.get(args.spaceId);
		if (!space || space.state !== 'staged') return [];
		const size = Math.max(1, Math.min(10, Math.floor(args.size)));
		const out: { table: 'knowledgeEntries' | 'semanticFiles'; id: string; text: string }[] = [];
		for (const table of ['knowledgeEntries', 'semanticFiles'] as const) {
			const rows =
				space.slot === 'primary'
					? await ctx.db
							.query(table)
							.withIndex('by_embedding_space', (q) => q.eq('embeddingSpaceId', space._id))
							.take(size)
					: await ctx.db
							.query(table)
							.withIndex('by_secondary_embedding_space', (q) =>
								q.eq('secondaryEmbeddingSpaceId', space._id)
							)
							.take(size);
			for (const row of rows) {
				const text =
					table === 'knowledgeEntries'
						? knowledgeEmbeddingInput(row as Doc<'knowledgeEntries'>)
						: fileEmbeddingInput(row as Doc<'semanticFiles'>);
				if (text) out.push({ table, id: row._id, text });
			}
		}
		return out;
	},
});

/**
 * Activate the validated staged space, atomically: states flip and the stored
 * configuration switches in one transaction. The rebuild must have completed.
 */
export const activateStagedSpace = internalMutation({
	args: {
		spaceId: v.id('embeddingSpaces'),
		sampled: v.number(),
		passed: v.number(),
	},
	handler: async (ctx, args) => {
		const session = await requireOrgPermission(ctx, 'organization:manage');
		const row = await requireStoredConfig(ctx);
		const staged = await readStagedSpace(ctx.db);
		assertExpectedSpace(staged, args.spaceId);
		if (!staged) throwInvalidState('There is no staged embedding space.');
		const job = await ctx.db
			.query('embeddingReembedJobs')
			.withIndex('by_target_space', (q) => q.eq('targetSpaceId', staged._id))
			.order('desc')
			.first();
		if (job?.kind !== 'rebuild' || job.status !== 'completed') {
			throwInvalidState('The staged rebuild has not completed yet.');
		}
		// Every embedding input that changed, and every row added, since this pass
		// started may lack its staged vector (the input-change rule cleared it, or
		// the walk had passed it): only a pass that started after the last change
		// covers the corpus.
		if ((staged.inputChangedAt ?? 0) >= job.startedAt) {
			throwInvalidState(
				"Items changed during the rebuild and have no vector in the new model yet. Run the rebuild's catch-up, then activate."
			);
		}
		if (!(await ownsColumn(ctx.db, staged))) {
			throwConflict('The staged space lost its column. Start the rebuild again.');
		}
		const previous = await readActiveSpace(ctx.db);
		await switchConfigTo(ctx, row, staged);
		await activateSpace(ctx, { existing: staged });
		await recordAuditLog(ctx, {
			userId: session.userId,
			organizationId: session.activeOrganizationId,
			action: 'embedding_space.activated',
			resource: 'embedding_space',
			resourceId: staged._id,
			details: {
				previousSpaceId: previous?._id ?? '',
				provider: staged.provider,
				model: staged.model,
				sampled: args.sampled,
				passed: args.passed,
			},
		});
	},
});

/** Walk the corpus again into the staged space (rows changed or added during the rebuild). */
export const catchUpRebuild = adminMutation({
	args: { expectedSpaceId: v.optional(v.id('embeddingSpaces')) },
	handler: async (ctx, args, session) => {
		const staged = await readStagedSpace(ctx.db);
		assertExpectedSpace(staged, args.expectedSpaceId);
		if (!staged) throwInvalidState('There is no staged embedding space.');
		if (await readOpenJob(ctx)) {
			throwConflict('A re-embed or rebuild is already running. Wait for it, or cancel it first.');
		}
		if (!(await ownsColumn(ctx.db, staged))) {
			throwConflict('The staged space lost its column. Start the rebuild again.');
		}
		const isPaid = !isSpaceLocal(staged);
		if (isPaid && !isPaidEmbeddingAdmissionAvailable()) throwInvalidState(PAID_EMBEDDING_REFUSAL);
		const jobId = await startJob(ctx, {
			kind: 'rebuild',
			targetSpaceId: staged._id,
			isPaid,
			startedBy: session.userId,
		});
		await recordAuditLog(ctx, {
			userId: session.userId,
			organizationId: session.activeOrganizationId,
			action: 'embedding_reembed.started',
			resource: 'embedding_space',
			resourceId: staged._id,
			details: { jobId, kind: 'rebuild', isPaid },
		});
	},
});

/**
 * Roll back to the space the active one replaced: its vectors are still in
 * their column, so it is searchable at once (rows written since are re-embedded
 * by the job). A hosted space needs the stored key of its kind.
 */
export const rollback = adminMutation({
	/** `expectedSpaceId`: the space the caller confirmed rolling back to. */
	args: { expectedSpaceId: v.optional(v.id('embeddingSpaces')) },
	handler: async (ctx, args, session) => {
		const row = await requireStoredConfig(ctx);
		const active = await readActiveSpace(ctx.db);
		const previous = active ? await readRollbackSpace(ctx) : null;
		assertExpectedSpace(previous, args.expectedSpaceId);
		if (!active || !previous)
			throwInvalidState('There is no previous embedding space to roll back to.');
		if (!isStagedTransitionAllowed(row.embeddingProviderKind, previous.provider)) {
			throwInvalidState(
				'The previous embedding space uses another provider, whose key is not stored. Select it again in the settings, with its key.'
			);
		}
		await switchConfigTo(ctx, row, previous);
		await activateSpace(ctx, { existing: previous });
		await recordAuditLog(ctx, {
			userId: session.userId,
			organizationId: session.activeOrganizationId,
			action: 'embedding_space.rolled_back',
			resource: 'embedding_space',
			resourceId: previous._id,
			details: { fromSpaceId: active._id, provider: previous.provider, model: previous.model },
		});
	},
});

/** End a staged rebuild without activating it. */
export const cancelRebuild = adminMutation({
	args: { expectedSpaceId: v.optional(v.id('embeddingSpaces')) },
	handler: async (ctx, args, session) => {
		const staged = await readStagedSpace(ctx.db);
		assertExpectedSpace(staged, args.expectedSpaceId);
		if (!staged) return;
		await retireStagedSpace(ctx, staged);
		await recordAuditLog(ctx, {
			userId: session.userId,
			organizationId: session.activeOrganizationId,
			action: 'embedding_space.rebuild_cancelled',
			resource: 'embedding_space',
			resourceId: staged._id,
			details: { provider: staged.provider, model: staged.model },
		});
	},
});
