/**
 * Embedding spaces (ADR-0073, Phase 1a provenance, D8 and the Phase 5 rebuild):
 * the reads the searches and jobs share, and the settings page's overview.
 *
 * The rules live in `lib/aiRouting/embeddingRegistry.ts`. This module exposes
 * them to actions (`searchTarget`, `ensureConfigured`, `getSpaces`) and to the
 * settings page (`status`, U1): the active space and how much of the corpus it
 * covers, a staged rebuild, the space a rollback would restore, the running
 * job, and the recorded attestations.
 */

import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';
import { internalQuery, type QueryCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { adminQuery } from '../lib/authedFunctions';
import {
	ensureConfiguredSpace,
	identityOf,
	isIdentityOfTarget,
	readActiveSpace,
	readConfiguredTarget,
	readStagedSpace,
	resolveSearchTarget,
	type SpaceDoc,
	type SpaceRef,
} from '../lib/aiRouting/embeddingRegistry';
import {
	embeddingSpaceIdentityFields,
	measuredEmbeddingSpaceValidator,
} from '../lib/validators/embedding';
import { isPaidEmbeddingAdmissionAvailable } from '../lib/aiRouting/embeddingAdmission';

/**
 * The space and column a vector search filters on (`searchSpaceVectors`): the
 * space named by id, or the one registered for a measured identity. Only the
 * active space, unless `allowStaged`. Null ⇒ nothing comparable to search.
 */
export const searchTarget = internalQuery({
	args: {
		spaceId: v.optional(v.id('embeddingSpaces')),
		identity: v.optional(
			v.object({ ...embeddingSpaceIdentityFields, source: v.optional(v.string()) })
		),
		allowStaged: v.optional(v.boolean()),
	},
	handler: async (ctx, args): Promise<SpaceRef | null> => {
		const identity = args.identity
			? {
					provider: args.identity.provider,
					endpoint: args.identity.endpoint,
					model: args.identity.model,
					dimensions: args.identity.dimensions,
					revision: args.identity.revision,
					quantization: args.identity.quantization,
				}
			: undefined;
		return resolveSearchTarget(ctx.db, {
			spaceId: args.spaceId,
			identity,
			allowStaged: args.allowStaged,
		});
	},
});

/**
 * Register and activate the configured space a job measured (the D8 switch
 * path), or null when the configuration no longer names it.
 */
export const ensureConfigured = internalMutation({
	args: { space: measuredEmbeddingSpaceValidator },
	handler: async (ctx, args): Promise<SpaceDoc | null> => ensureConfiguredSpace(ctx, args.space),
});

/** The active and staged spaces, and whether the active one is the configured one. */
export const getSpaces = internalQuery({
	args: {},
	handler: async (
		ctx
	): Promise<{ active: SpaceDoc | null; staged: SpaceDoc | null; isActiveConfigured: boolean }> => {
		const active = await readActiveSpace(ctx.db);
		const staged = await readStagedSpace(ctx.db);
		const target = await readConfiguredTarget(ctx.db);
		const isActiveConfigured =
			active !== null && target !== null && isIdentityOfTarget(identityOf(active), target);
		return { active, staged, isActiveConfigured };
	},
});

/** The space a rollback restores: the one the active space replaced. */
export async function readRollbackSpace(ctx: Pick<QueryCtx, 'db'>): Promise<SpaceDoc | null> {
	const retired = await ctx.db
		.query('embeddingSpaces')
		.withIndex('by_state', (q) => q.eq('state', 'retired'))
		.take(50);
	let latest: SpaceDoc | null = null;
	for (const space of retired) {
		if (space.activatedAt === undefined || space.retiredAt === undefined) continue;
		if (!latest || space.retiredAt > (latest.retiredAt ?? 0)) latest = space;
	}
	return latest;
}

/** A space without its coverage snapshot (the overview returns that once). */
function spaceView(space: SpaceDoc | null) {
	if (!space) return null;
	const { coverage: _coverage, identityKey: _key, ...view } = space;
	return view;
}

function jobView(job: Doc<'embeddingReembedJobs'>) {
	const { generation: _generation, rootRequestId: _root, ...view } = job;
	return view;
}

/**
 * The settings page's embedding section (U1): which space vector search uses,
 * how much of the corpus it covers (`coverage`, the last completed count), a
 * staged rebuild and the space a rollback would restore, the jobs, and the
 * recorded attestations. `configured.isActive` false means the configuration
 * names another space whose first vector has not landed: vector search has
 * nothing to compare until it does (D8).
 */
export const status = adminQuery({
	args: {},
	handler: async (ctx) => {
		const active = await readActiveSpace(ctx.db);
		const staged = await readStagedSpace(ctx.db);
		const rollbackTo = active ? await readRollbackSpace(ctx) : null;
		const target = await readConfiguredTarget(ctx.db);
		const hasStoredConfig = (await ctx.db.query('aiProviderConfig').first()) !== null; // bounded: org singleton

		const jobs: Doc<'embeddingReembedJobs'>[] = [];
		for (const jobStatus of ['running', 'paused'] as const) {
			jobs.push(
				...(await ctx.db
					.query('embeddingReembedJobs')
					.withIndex('by_status', (q) => q.eq('status', jobStatus))
					.take(5))
			);
		}
		const recentJobs = await ctx.db.query('embeddingReembedJobs').order('desc').take(5);
		for (const job of recentJobs) {
			if (!jobs.some((known) => known._id === job._id)) jobs.push(job);
		}

		const attestations = await ctx.db.query('embeddingAttestations').order('desc').take(20);

		return {
			active: spaceView(active),
			staged: spaceView(staged),
			rollbackTo: spaceView(rollbackTo),
			configured: target
				? {
						provider: target.provider,
						endpoint: target.endpoint,
						model: target.model,
						source: target.source,
						isLocal: target.isLocal,
						isActive: active !== null && isIdentityOfTarget(identityOf(active), target),
					}
				: null,
			coverage: active?.coverage ?? null,
			jobs: jobs.map(jobView),
			attestations,
			/** A hosted re-embed or rebuild needs spend admission (D8); absent until it lands. */
			isPaidEmbeddingAvailable: isPaidEmbeddingAdmissionAvailable(),
			/** A staged rebuild and its activation rewrite the stored configuration. */
			canStageRebuild: hasStoredConfig && staged === null && active !== null,
		};
	},
});
