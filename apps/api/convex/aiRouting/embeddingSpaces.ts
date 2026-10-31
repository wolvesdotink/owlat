/**
 * Embedding spaces:
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
import { ensureConfiguredSpace, isSpaceLocal } from '../lib/aiRouting/embeddingActivation';
import {
	embeddingTargetKey,
	storedEmbeddingTarget,
	type EmbeddingTarget,
} from '../lib/embeddingSpace';
import { EMBEDDING_PROVIDER_KINDS } from '../lib/llmProviders/types';
import {
	assertExpectedTarget,
	attestationBlocker,
	identityOf,
	isIdentityOfTarget,
	ownsColumn,
	readActiveSpace,
	readColumnOwner,
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
 * Register and activate the configured space a job measured (the embedding switch
 * path), or null when the configuration no longer names it. With
 * `expectedTargetKey` (the target the caller confirmed and embedded with), a
 * configuration that moved since is refused with `embedding_target_changed`
 * in this transaction, so nothing is activated and no kickoff is scheduled.
 *
 * The previous release's re-embed actions activate through this; this
 * release's commit inside `embeddingReembedCommit.ts`. A space already active
 * is returned as it is. Remove after release N+1.
 */
export const ensureConfigured = internalMutation({
	args: { space: measuredEmbeddingSpaceValidator, expectedTargetKey: v.optional(v.string()) },
	handler: async (ctx, args): Promise<SpaceDoc | null> => {
		if (args.expectedTargetKey !== undefined) {
			const target = await readConfiguredTarget(ctx.db);
			assertExpectedTarget(target ? embeddingTargetKey(target) : null, args.expectedTargetKey);
		}
		return ensureConfiguredSpace(ctx, args.space);
	},
});

/**
 * The active and staged spaces and the stored embedding kind (null: env
 * configuration). Read before any credential.
 */
export const getSpaces = internalQuery({
	args: {},
	handler: async (
		ctx
	): Promise<{
		active: SpaceDoc | null;
		staged: SpaceDoc | null;
		storedEmbeddingKind: Doc<'aiProviderConfig'>['embeddingProviderKind'] | null;
	}> => {
		const active = await readActiveSpace(ctx.db);
		const staged = await readStagedSpace(ctx.db);
		const row = await ctx.db.query('aiProviderConfig').first(); // bounded: org singleton
		return { active, staged, storedEmbeddingKind: row?.embeddingProviderKind ?? null };
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

/**
 * A space without its internal identity key, with whether it is local: free
 * to re-embed or rebuild into, by the rule its jobs are paid by
 * (`isSpaceLocal`, the ledger's locality rule); paid otherwise.
 */
function spaceView(space: SpaceDoc | null) {
	if (!space) return null;
	const { identityKey: _key, ...view } = space;
	return { ...view, isLocal: isSpaceLocal(space) };
}

/**
 * Whether each embedding kind, as a staged rebuild target, is local (free) or
 * hosted (paid): the endpoint `startRebuild` resolves for the kind
 * (`storedEmbeddingTarget`; the model never changes it), judged by the rule the
 * rebuild job is paid by (`isSpaceLocal`).
 */
function rebuildTargetViews() {
	return EMBEDDING_PROVIDER_KINDS.map((kind) => ({
		kind,
		isLocal: isSpaceLocal(storedEmbeddingTarget({ embeddingProviderKind: kind })),
	}));
}

/**
 * Whether a cohort of vectors from before provenance can be attested to the
 * configured target, by the rule `attest` enforces (`attestationBlocker`). The
 * subject is the target's registered space: the active space when it is the
 * configured one, else the primary column's owner when it is; else a new
 * registration. `spaceId` names the subject, to attest by id.
 */
async function configuredAttestation(
	ctx: Pick<QueryCtx, 'db'>,
	target: EmbeddingTarget | null,
	active: SpaceDoc | null
) {
	if (!target) {
		return { canAttest: false, reason: 'not_configured' as const, spaceId: null };
	}
	const owner = await readColumnOwner(ctx.db, 'primary');
	const ofTarget = (space: SpaceDoc | null) =>
		space !== null && isIdentityOfTarget(identityOf(space), target) ? space : null;
	const subject = ofTarget(active) ?? ofTarget(owner);
	const reason = await attestationBlocker(ctx.db, subject);
	return { canAttest: reason === null, reason, spaceId: subject?._id ?? null };
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
 * nothing to compare until it does.
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
						/** Pass back as `startReembed`'s `expectedTargetKey`; no credential in it. */
						targetKey: embeddingTargetKey(target),
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
			/** A hosted re-embed or rebuild needs spend admission; absent until it lands. */
			isPaidEmbeddingAvailable: isPaidEmbeddingAdmissionAvailable(),
			/** A staged rebuild and its activation rewrite the stored configuration. */
			canStageRebuild: hasStoredConfig && staged === null && searchable !== null,
			/** Per embedding kind, whether a rebuild into it is local (free) or paid. */
			rebuildTargets: rebuildTargetViews(),
			/** Whether the configured target can take an attested cohort, and why not. */
			attestation: await configuredAttestation(ctx, target, active),
		};
	},
});
