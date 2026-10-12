/**
 * Legacy embedding cohorts (ADR-0073, Phase 1a; #1334).
 *
 * Vectors written before provenance carry only the static `embeddingModel`
 * stamp, which proves nothing: env overrides changed the model without touching
 * the row, and removing and re-saving the config reset its counter. Such rows
 * are unknown: vector search skips them until a cohort is established or the
 * re-embed job replaces them.
 *
 * A cohort is established in exactly two ways, both recorded as what they are:
 *
 *   - `record`: retained deployment or configuration records establish the
 *     provider, endpoint, model, native width and revision for the whole period
 *     the vectors were written. Owlat itself kept no such record (the audit log
 *     never held env overrides or digests), so an operator cites them here.
 *   - `attestation`: an operator attests to those facts.
 *
 * A sample re-embed (`embeddingSampleCheck.ts`) may corroborate a cohort but
 * never establishes one: a deployment that switched A → B → A passes a sample of
 * A rows. Applying a cohort stamps its unknown rows with the space and the
 * evidence row (`embeddingProvenance` = the source, `embeddingAttestationId`);
 * revoking it clears exactly those stamps again. Both walks are bounded pages.
 *
 * Only primary-column vectors exist from before provenance, so the attested
 * space must keep its vectors in the primary column.
 */

import { v } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import type { MutationCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { adminMutation } from '../lib/authedFunctions';
import { recordAuditLog } from '../lib/auditLog';
import { getOrThrow, throwInvalidInput, throwInvalidState } from '../_utils/errors';
import { embeddingSpaceEntryKey, embeddingSpaceIdentityKey } from '../lib/aiRouting/embeddingKeys';
import { readSpaceByIdentity } from '../lib/aiRouting/embeddingRegistry';
import { EMBEDDING_DIMENSIONS } from '../lib/constants';
import {
	embeddingCohortValidator,
	embeddingSpaceIdentityFields,
} from '../lib/validators/embedding';

type Attestation = Doc<'embeddingAttestations'>;
type EmbeddingTable = Attestation['cohort']['tables'][number];

const ATTESTATION_PAGE_SIZE = 64;
const STATEMENT_MAX_CHARS = 2000;

/**
 * Whether a stored (index-padded) vector can be `dimensions` wide: nothing
 * non-zero past that width. A wider vector contradicts the attested model and
 * is left unknown; this only refuses, it never confirms.
 */
export function fitsAttestedWidth(vector: readonly number[], dimensions: number): boolean {
	if (dimensions > vector.length) return false;
	for (let i = dimensions; i < vector.length; i++) if (vector[i] !== 0) return false;
	return true;
}

/** The index range of one cohort table: unknown rows (or the attested space's) in the period. */
function cohortPage(
	ctx: MutationCtx,
	table: EmbeddingTable,
	spaceId: Id<'embeddingSpaces'> | undefined,
	attestation: Attestation
) {
	const { writtenFrom, writtenUntil } = attestation.cohort;
	return ctx.db
		.query(table)
		.withIndex('by_embedding_space', (q) =>
			q
				.eq('embeddingSpaceId', spaceId)
				.gte('embeddingGeneratedAt', writtenFrom ?? 0)
				.lt('embeddingGeneratedAt', writtenUntil)
		)
		.paginate({ cursor: attestation.cursor ?? null, numItems: ATTESTATION_PAGE_SIZE });
}

/** Move a walk to its next table, or end it. */
function nextPhase(attestation: Attestation): EmbeddingTable | undefined {
	const tables = attestation.cohort.tables;
	const index = attestation.phase ? tables.indexOf(attestation.phase) : -1;
	return tables[index + 1];
}

/**
 * Record a cohort and start assigning it. The space is an existing one
 * (`spaceId`) or an identity the evidence names, registered as a retired
 * space; rows of a space that is not active stay out of vector search until
 * re-embedded, but their provenance is known.
 */
export const attest = adminMutation({
	args: {
		spaceId: v.optional(v.id('embeddingSpaces')),
		identity: v.optional(v.object(embeddingSpaceIdentityFields)),
		source: v.union(v.literal('record'), v.literal('attestation')),
		cohort: embeddingCohortValidator,
		statement: v.string(),
	},
	handler: async (ctx, args, session): Promise<Id<'embeddingAttestations'>> => {
		const now = Date.now();
		const statement = args.statement.trim();
		if (!statement || statement.length > STATEMENT_MAX_CHARS) {
			throwInvalidInput(`Describe the evidence in 1 to ${STATEMENT_MAX_CHARS} characters.`);
		}
		const { tables, writtenFrom, writtenUntil } = args.cohort;
		if (tables.length === 0 || new Set(tables).size !== tables.length) {
			throwInvalidInput('Name each table of the cohort once.');
		}
		if (writtenUntil > now || (writtenFrom !== undefined && writtenFrom >= writtenUntil)) {
			throwInvalidInput('The cohort period must end in the past and after it starts.');
		}
		if ((args.spaceId === undefined) === (args.identity === undefined)) {
			throwInvalidInput('Name the space either by id or by its identity.');
		}

		let space: Doc<'embeddingSpaces'>;
		if (args.spaceId) {
			space = await getOrThrow(ctx, args.spaceId, 'Embedding space');
		} else {
			const identity = args.identity!;
			if (identity.dimensions < 1 || identity.dimensions > EMBEDDING_DIMENSIONS) {
				throwInvalidInput(`The width must be between 1 and ${EMBEDDING_DIMENSIONS}.`);
			}
			const known = await readSpaceByIdentity(ctx.db, identity);
			space =
				known ??
				(await ctx.db.get(
					await ctx.db.insert('embeddingSpaces', {
						...identity,
						identityKey: embeddingSpaceIdentityKey(identity),
						source: args.source,
						state: 'retired',
						slot: 'primary',
						createdAt: now,
						updatedAt: now,
					})
				))!;
		}
		if (space.slot !== 'primary') {
			throwInvalidState(
				'Vectors from before provenance are in the primary column, but this space keeps its vectors in the other one. Re-embed instead.'
			);
		}

		const attestationId = await ctx.db.insert('embeddingAttestations', {
			spaceId: space._id,
			source: args.source,
			cohort: args.cohort,
			statement,
			attestedBy: session.userId,
			attestedAt: now,
			status: 'applying',
			phase: tables[0],
			rowsAssigned: 0,
			updatedAt: now,
		});
		await recordAuditLog(ctx, {
			userId: session.userId,
			organizationId: session.activeOrganizationId,
			action: 'embedding_cohort.attested',
			resource: 'embedding_space',
			resourceId: space._id,
			details: {
				attestationId,
				source: args.source,
				tables: tables.join(','),
				writtenFrom: writtenFrom ?? 0,
				writtenUntil,
			},
			detailsBlob: JSON.stringify({ statement, cohort: args.cohort }),
		});
		await ctx.scheduler.runAfter(0, internal.aiRouting.embeddingAttestations.applyPage, {
			attestationId,
		});
		return attestationId;
	},
});

/** Assign one page of a cohort's unknown rows to its space. */
export const applyPage = internalMutation({
	args: { attestationId: v.id('embeddingAttestations') },
	handler: async (ctx, args) => {
		const attestation = await ctx.db.get(args.attestationId);
		if (!attestation || attestation.status !== 'applying' || !attestation.phase) return;
		const space = await ctx.db.get(attestation.spaceId);
		if (!space) return;
		const table = attestation.phase;
		const page = await cohortPage(ctx, table, undefined, attestation);
		const stamp = attestation.cohort.legacyModelStamp;
		let assigned = 0;
		for (const row of page.page) {
			if (row.embedding.length === 0) continue;
			if (stamp !== undefined && row.embeddingModel !== stamp) continue;
			if (!fitsAttestedWidth(row.embedding, space.dimensions)) continue;
			const entryType =
				table === 'knowledgeEntries' ? (row as Doc<'knowledgeEntries'>).entryType : undefined;
			await ctx.db.patch(row._id, {
				embeddingSpaceId: space._id,
				embeddingProvenance: attestation.source,
				embeddingAttestationId: attestation._id,
				...(entryType
					? { embeddingSpaceEntryKey: embeddingSpaceEntryKey(space._id, entryType) }
					: {}),
			});
			assigned += 1;
		}
		const now = Date.now();
		const rowsAssigned = attestation.rowsAssigned + assigned;
		if (!page.isDone) {
			await ctx.db.patch(attestation._id, {
				rowsAssigned,
				cursor: page.continueCursor,
				updatedAt: now,
			});
		} else {
			const phase = nextPhase(attestation);
			await ctx.db.patch(attestation._id, {
				rowsAssigned,
				cursor: undefined,
				phase,
				...(phase ? {} : { status: 'applied' as const }),
				updatedAt: now,
			});
			if (!phase) {
				// Rows assigned to an inactive space wait for the re-embed; recount coverage.
				await ctx.scheduler.runAfter(0, internal.aiRouting.embeddingReembed.kickoff, {
					isForced: true,
				});
				return;
			}
		}
		await ctx.scheduler.runAfter(0, internal.aiRouting.embeddingAttestations.applyPage, args);
	},
});

/**
 * Revoke a cohort: its rows return to unknown (out of vector search) and the
 * re-embed job brings them back with measured provenance.
 */
export const revoke = adminMutation({
	args: { attestationId: v.id('embeddingAttestations') },
	handler: async (ctx, args, session) => {
		const attestation = await getOrThrow(ctx, args.attestationId, 'Attestation');
		if (attestation.status === 'revoked') return;
		const now = Date.now();
		await ctx.db.patch(attestation._id, {
			status: 'revoked',
			revokedAt: now,
			revokedBy: session.userId,
			phase: attestation.cohort.tables[0],
			cursor: undefined,
			updatedAt: now,
		});
		await recordAuditLog(ctx, {
			userId: session.userId,
			organizationId: session.activeOrganizationId,
			action: 'embedding_cohort.revoked',
			resource: 'embedding_space',
			resourceId: attestation.spaceId,
			details: { attestationId: attestation._id, rowsAssigned: attestation.rowsAssigned },
		});
		await ctx.scheduler.runAfter(0, internal.aiRouting.embeddingAttestations.revokePage, args);
	},
});

/** Clear one page of a revoked cohort's stamps (only rows this attestation assigned). */
export const revokePage = internalMutation({
	args: { attestationId: v.id('embeddingAttestations') },
	handler: async (ctx, args) => {
		const attestation = await ctx.db.get(args.attestationId);
		if (!attestation || attestation.status !== 'revoked' || !attestation.phase) return;
		const table = attestation.phase;
		const page = await cohortPage(ctx, table, attestation.spaceId, attestation);
		for (const row of page.page) {
			if (row.embeddingAttestationId !== attestation._id) continue;
			await ctx.db.patch(row._id, {
				embeddingSpaceId: undefined,
				embeddingProvenance: undefined,
				embeddingAttestationId: undefined,
				...(table === 'knowledgeEntries' ? { embeddingSpaceEntryKey: undefined } : {}),
			});
		}
		const now = Date.now();
		if (!page.isDone) {
			await ctx.db.patch(attestation._id, { cursor: page.continueCursor, updatedAt: now });
		} else {
			const phase = nextPhase(attestation);
			await ctx.db.patch(attestation._id, { cursor: undefined, phase, updatedAt: now });
			if (!phase) {
				await ctx.scheduler.runAfter(0, internal.aiRouting.embeddingReembed.kickoff, {
					isForced: true,
				});
				return;
			}
		}
		await ctx.scheduler.runAfter(0, internal.aiRouting.embeddingAttestations.revokePage, args);
	},
});
