/**
 * The staged embedding rebuild's transactions (ADR-0073, Phase 5).
 *
 * Build into a staged space while retrieval keeps the active one, validate the
 * staged space with a bounded sample of queries (`embeddingRebuild.ts`), then
 * activate it in ONE mutation: the staged space becomes active, the previous
 * active space retires with its vectors intact in its own column, and the
 * stored configuration switches to the staged embedder. Rollback is the same
 * flip back. A staged rebuild needs a stored configuration, because activation
 * rewrites it; an env-only deployment switches through its environment (D8).
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
import { embeddingSpaceIdentityKey } from '../lib/aiRouting/embeddingKeys';
import {
	activateSpace,
	identityOf,
	isIdentityOfTarget,
	otherSlot,
	readActiveSpace,
	readSpaceByIdentity,
	readStagedSpace,
	retireStagedSpace,
	type SpaceDoc,
} from '../lib/aiRouting/embeddingRegistry';
import { fileEmbeddingInput, knowledgeEmbeddingInput } from '../lib/aiRouting/embeddingInputs';
import { measuredEmbeddingSpaceValidator } from '../lib/validators/embedding';
import { readOpenJob, startJob } from './embeddingReembedJobs';
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
 * Point the stored configuration at `space`'s embedder. A stored hosted key
 * belongs to its kind, so it is cleared when the kind changes.
 */
async function switchConfigTo(ctx: MutationCtx, row: ConfigRow, space: SpaceDoc): Promise<void> {
	const selection = { embeddingProviderKind: space.provider, embeddingModel: space.model };
	if (
		space.source === 'env' ||
		!isIdentityOfTarget(identityOf(space), storedEmbeddingTarget(selection))
	) {
		throwInvalidState('This embedding space cannot be selected in the stored configuration.');
	}
	const isKindChanged = row.embeddingProviderKind !== space.provider;
	await ctx.db.patch(row._id, {
		...selection,
		embeddingModelVersion: row.embeddingModelVersion + 1,
		...(isKindChanged
			? {
					embeddingSecretCiphertext: undefined,
					embeddingSecretIv: undefined,
					embeddingSecretAuthTag: undefined,
					embeddingSecretEnvelopeVersion: undefined,
					embeddingKeyPreview: undefined,
				}
			: {}),
		updatedAt: Date.now(),
	});
}

/** Register the staged space a `startRebuild` measured and start its rebuild job. */
export const stageSpace = internalMutation({
	args: { space: measuredEmbeddingSpaceValidator, isPaid: v.boolean() },
	handler: async (ctx, args): Promise<Id<'embeddingSpaces'>> => {
		const session = await requireOrgPermission(ctx, 'organization:manage');
		await requireStoredConfig(ctx);
		const active = await readActiveSpace(ctx.db);
		if (!active) {
			throwInvalidState('There is no active embedding space to rebuild from yet.');
		}
		if (await readStagedSpace(ctx.db)) throwConflict('A staged rebuild already exists.');
		if (await readOpenJob(ctx)) {
			throwConflict('A re-embed or rebuild is already running. Wait for it, or cancel it first.');
		}
		const { source, ...identity } = args.space;
		if (embeddingSpaceIdentityKey(identity) === active.identityKey) {
			throwInvalidState('This embedding model is already the active one.');
		}
		const now = Date.now();
		const slot = otherSlot(active.slot);
		const known = await readSpaceByIdentity(ctx.db, identity);
		let spaceId: Id<'embeddingSpaces'>;
		if (known) {
			await ctx.db.patch(known._id, {
				state: 'staged',
				slot,
				retiredAt: undefined,
				updatedAt: now,
			});
			spaceId = known._id;
		} else {
			spaceId = await ctx.db.insert('embeddingSpaces', {
				...identity,
				identityKey: embeddingSpaceIdentityKey(identity),
				source,
				state: 'staged',
				slot,
				createdAt: now,
				updatedAt: now,
			});
		}
		const jobId = await startJob(ctx, {
			kind: 'rebuild',
			targetSpaceId: spaceId,
			isPaid: args.isPaid,
			startedBy: session.userId,
		});
		await recordAuditLog(ctx, {
			userId: session.userId,
			organizationId: session.activeOrganizationId,
			action: 'embedding_space.staged',
			resource: 'embedding_space',
			resourceId: spaceId,
			details: { jobId, provider: identity.provider, model: identity.model, isPaid: args.isPaid },
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
		if (!staged || staged._id !== args.spaceId) {
			throwConflict('The staged embedding space changed. Reload and try again.');
		}
		const job = await ctx.db
			.query('embeddingReembedJobs')
			.withIndex('by_target_space', (q) => q.eq('targetSpaceId', staged._id))
			.order('desc')
			.first();
		if (job?.kind !== 'rebuild' || job.status !== 'completed') {
			throwInvalidState('The staged rebuild has not completed yet.');
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

/**
 * Roll back to the space the active one replaced: its vectors are still in
 * their column, so it is searchable at once (rows written since are re-embedded
 * by the job). A hosted space needs the stored key of its kind.
 */
export const rollback = adminMutation({
	args: {},
	handler: async (ctx, _args, session) => {
		const row = await requireStoredConfig(ctx);
		const active = await readActiveSpace(ctx.db);
		const previous = active ? await readRollbackSpace(ctx) : null;
		if (!active || !previous)
			throwInvalidState('There is no previous embedding space to roll back to.');
		if (
			!isLocalEmbeddingKind(previous.provider) &&
			previous.provider !== row.embeddingProviderKind
		) {
			throwInvalidState(
				'The previous embedding space uses a hosted provider whose key is not stored. Select it again in the settings, with its key.'
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
	args: {},
	handler: async (ctx, _args, session) => {
		const staged = await readStagedSpace(ctx.db);
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
