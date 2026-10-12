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
import { requireOrgPermission } from '../lib/sessionOrganization';
import { ensureConfiguredSpace } from '../lib/aiRouting/embeddingActivation';
import {
	identityOf,
	isIdentityOfTarget,
	ownsColumn,
	readActiveSpace,
	readConfiguredTarget,
	readSearchableSpace,
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
 * The admin floor of this lane's admin actions (`organization:manage`). Each
 * action calls it FIRST, before it resolves a credential, asks for admission or
 * calls a provider, so a member who is not an admin causes no provider call.
 */
export const assertAdmin = internalQuery({
	args: {},
	handler: async (ctx): Promise<null> => {
		await requireOrgPermission(ctx, 'organization:manage');
		return null;
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

/**
 * The active and staged spaces, whether the active one is the configured one
 * (searchable), the stored embedding kind (null: env configuration), and
 * whether the configured embedder is local. Read before any credential.
 */
export const getSpaces = internalQuery({
	args: {},
	handler: async (
		ctx
	): Promise<{
		active: SpaceDoc | null;
		staged: SpaceDoc | null;
		isActiveConfigured: boolean;
		storedEmbeddingKind: Doc<'aiProviderConfig'>['embeddingProviderKind'] | null;
		/** Whether the configured embedder is local (free); null when none is configured. */
		isConfiguredLocal: boolean | null;
	}> => {
		const active = await readActiveSpace(ctx.db);
		const staged = await readStagedSpace(ctx.db);
		const target = await readConfiguredTarget(ctx.db);
		const isActiveConfigured =
			active !== null && target !== null && isIdentityOfTarget(identityOf(active), target);
		const row = await ctx.db.query('aiProviderConfig').first(); // bounded: org singleton
		return {
			active,
			staged,
			isActiveConfigured,
			storedEmbeddingKind: row?.embeddingProviderKind ?? null,
			isConfiguredLocal: target?.isLocal ?? null,
		};
	},
});

/**
 * The space a rollback restores: the one the active space replaced, as recorded
 * when it was activated (`predecessorSpaceId`), and only while it still owns
 * its column, so its vectors there are its own and current. Null otherwise:
 * no predecessor, it is no longer retired, or another space has taken its
 * column since (a staged rebuild, even a cancelled one).
 */
export async function readRollbackSpace(ctx: Pick<QueryCtx, 'db'>): Promise<SpaceDoc | null> {
	const active = await readActiveSpace(ctx.db);
	if (!active?.predecessorSpaceId) return null;
	const predecessor = await ctx.db.get(active.predecessorSpaceId);
	if (predecessor?.state !== 'retired') return null;
	return (await ownsColumn(ctx.db, predecessor)) ? predecessor : null;
}

/** A space without its internal identity key. */
function spaceView(space: SpaceDoc | null) {
	if (!space) return null;
	const { identityKey: _key, ...view } = space;
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
		const rollbackTo = await readRollbackSpace(ctx);
		const coverage = await ctx.db.query('embeddingCoverage').first(); // bounded: singleton
		const searchable = await readSearchableSpace(ctx.db);
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
			/**
			 * The last completed count, against `searchableSpaceId` (absent: no
			 * space was searchable). `isCurrent` false: the searchable space has
			 * changed since, and a new count is on its way.
			 */
			coverage: coverage
				? { ...coverage, isCurrent: coverage.searchableSpaceId === searchable?._id }
				: null,
			jobs: jobs.map(jobView),
			attestations,
			/** A hosted re-embed or rebuild needs spend admission (D8); absent until it lands. */
			isPaidEmbeddingAvailable: isPaidEmbeddingAdmissionAvailable(),
			/** A staged rebuild and its activation rewrite the stored configuration. */
			canStageRebuild: hasStoredConfig && staged === null && searchable !== null,
		};
	},
});
