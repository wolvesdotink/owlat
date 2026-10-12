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
 * A sample re-embed is deliberately not offered: it could only corroborate, never
 * establish (a deployment that switched A → B → A passes a sample of A rows),
 * and a legacy row keeps no exact record of the input its vector was made from.
 * Applying a cohort assigns its unknown rows to the space, stamped with the
 * evidence (`embeddingProvenance` = the source, `embeddingAttestationId`):
 *
 *   - Legacy vectors are all in the primary column. When the attested space
 *     keeps its vectors there, they are stamped in place; when it uses the
 *     secondary column, they are copied there with the same stamps
 *     (`secondaryEmbedding*`), and the primary column keeps them unknown.
 *   - A space that is not the active one takes the column the active space does
 *     not use (`reslotSpace` moves an existing one), so attesting never puts it
 *     where re-embedding the active space would overwrite it, or the reverse.
 *   - When the attested space is the configured target and nothing is
 *     searchable yet (a hosted deployment's first upgrade), it is activated: the
 *     cohort becomes searchable as it is applied.
 *
 * Revoking clears exactly the stamps (and copies) that attestation made, in both
 * columns. Every walk is bounded pages.
 */

import { v } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import type { MutationCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { adminMutation } from '../lib/authedFunctions';
import { recordAuditLog } from '../lib/auditLog';
import { getOrThrow, throwInvalidInput, throwInvalidState } from '../_utils/errors';
import {
	embeddingSpaceEntryKey,
	embeddingSpaceIdentityKey,
	type EmbeddingSpaceIdentity,
} from '../lib/aiRouting/embeddingKeys';
import {
	activateSpace,
	identityOf,
	isIdentityOfTarget,
	otherSlot,
	readActiveSpace,
	readConfiguredTarget,
	readSearchableSpace,
	readSpaceByIdentity,
	readStagedSpace,
	reslotSpace,
	slotFields,
	type SpaceDoc,
} from '../lib/aiRouting/embeddingRegistry';
import { EMBEDDING_DIMENSIONS } from '../lib/constants';
import {
	embeddingCohortValidator,
	embeddingSlotValidator,
	embeddingSpaceIdentityFields,
	embeddingTableValidator,
} from '../lib/validators/embedding';

type Attestation = Doc<'embeddingAttestations'>;
type EmbeddingTable = Attestation['cohort']['tables'][number];
type EntryType = Doc<'knowledgeEntries'>['entryType'];

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

/** The unknown primary-column rows of one cohort table, in the cohort's period. */
function cohortPage(ctx: MutationCtx, table: EmbeddingTable, attestation: Attestation) {
	const { writtenFrom, writtenUntil } = attestation.cohort;
	return ctx.db
		.query(table)
		.withIndex('by_embedding_space', (q) =>
			q
				.eq('embeddingSpaceId', undefined)
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
 * The space a cohort is attested to, placed so it shares no column with the
 * active space (unless it is the active space) and never takes a staged
 * rebuild's column.
 */
async function placeAttestedSpace(
	ctx: MutationCtx,
	args: {
		spaceId?: Id<'embeddingSpaces'>;
		identity?: EmbeddingSpaceIdentity;
		source: 'record' | 'attestation';
	}
): Promise<SpaceDoc> {
	const active = await readActiveSpace(ctx.db);
	const staged = await readStagedSpace(ctx.db);
	const known = args.spaceId
		? await getOrThrow(ctx, args.spaceId, 'Embedding space')
		: await readSpaceByIdentity(ctx.db, args.identity!);
	if (known && (known.state === 'active' || known.state === 'staged')) return known;
	if (staged) {
		throwInvalidState(
			'A staged rebuild uses the other vector column. Attest to the active or the staged space, or cancel the rebuild first.'
		);
	}
	const slot = active ? otherSlot(active.slot) : 'primary';
	if (known) {
		await reslotSpace(ctx, known, slot);
		return (await ctx.db.get(known._id))!;
	}
	const identity = args.identity!;
	const now = Date.now();
	const spaceId = await ctx.db.insert('embeddingSpaces', {
		...identity,
		identityKey: embeddingSpaceIdentityKey(identity),
		source: args.source,
		state: 'retired',
		slot,
		createdAt: now,
		updatedAt: now,
	});
	return (await ctx.db.get(spaceId))!;
}

/**
 * Record a cohort and start assigning it. The space is an existing one
 * (`spaceId`) or an identity the evidence names, registered here. When it is
 * the configured target and nothing is searchable yet, it becomes the active
 * space (the first-upgrade path); otherwise rows of a space that is not active
 * stay out of vector search until re-embedded, but their provenance is known.
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
		if (
			args.identity &&
			(args.identity.dimensions < 1 || args.identity.dimensions > EMBEDDING_DIMENSIONS)
		) {
			throwInvalidInput(`The width must be between 1 and ${EMBEDDING_DIMENSIONS}.`);
		}

		let space = await placeAttestedSpace(ctx, args);
		const target = await readConfiguredTarget(ctx.db);
		const isConfigured = target !== null && isIdentityOfTarget(identityOf(space), target);
		if (isConfigured && space.state !== 'active' && !(await readSearchableSpace(ctx.db))) {
			space = await activateSpace(ctx, { existing: space });
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
				isActivated: space.state === 'active',
			},
			detailsBlob: JSON.stringify({ statement, cohort: args.cohort }),
		});
		await ctx.scheduler.runAfter(0, internal.aiRouting.embeddingAttestations.applyPage, {
			attestationId,
		});
		return attestationId;
	},
});

/** The columns that assign a legacy primary vector to `space`, in `space`'s column. */
function assignFields(
	row: { embedding: number[]; embeddingGeneratedAt?: number },
	space: SpaceDoc,
	attestation: Attestation,
	entryType: EntryType | undefined
): Record<string, unknown> {
	if (space.slot === 'primary') {
		return {
			embeddingSpaceId: space._id,
			embeddingProvenance: attestation.source,
			embeddingAttestationId: attestation._id,
			...(entryType
				? { embeddingSpaceEntryKey: embeddingSpaceEntryKey(space._id, entryType) }
				: {}),
		};
	}
	return slotFields(space, row.embedding, {
		now: row.embeddingGeneratedAt ?? attestation.attestedAt,
		entryType,
		provenance: attestation.source,
		attestationId: attestation._id,
	});
}

/** Assign one page of a cohort's unknown rows to its space. */
export const applyPage = internalMutation({
	args: { attestationId: v.id('embeddingAttestations') },
	handler: async (ctx, args) => {
		const attestation = await ctx.db.get(args.attestationId);
		if (!attestation || attestation.status !== 'applying' || !attestation.phase) return;
		const space = await ctx.db.get(attestation.spaceId);
		if (!space) return;
		const table = attestation.phase;
		const page = await cohortPage(ctx, table, attestation);
		const stamp = attestation.cohort.legacyModelStamp;
		let assigned = 0;
		for (const row of page.page) {
			if (row.embedding.length === 0) continue;
			if (stamp !== undefined && row.embeddingModel !== stamp) continue;
			if (!fitsAttestedWidth(row.embedding, space.dimensions)) continue;
			if (row.secondaryEmbeddingAttestationId === attestation._id) continue; // copied already
			const entryType =
				table === 'knowledgeEntries' ? (row as Doc<'knowledgeEntries'>).entryType : undefined;
			await ctx.db.patch(row._id, assignFields(row, space, attestation, entryType));
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
 * Revoke a cohort: its rows return to unknown (out of vector search), in both
 * columns, and the re-embed job brings them back with measured provenance.
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
			phase: undefined,
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
		await ctx.scheduler.runAfter(0, internal.aiRouting.embeddingAttestations.revokePage, {
			attestationId: attestation._id,
			table: 'knowledgeEntries',
			column: 'primary',
			cursor: null,
		});
	},
});

const REVOKE_STEPS = [
	['knowledgeEntries', 'primary'],
	['knowledgeEntries', 'secondary'],
	['semanticFiles', 'primary'],
	['semanticFiles', 'secondary'],
] as const;

/**
 * Clear one page of a revoked cohort's stamps: every row (in either column) that
 * carries this attestation, wherever a slot move copied it.
 */
export const revokePage = internalMutation({
	args: {
		attestationId: v.id('embeddingAttestations'),
		table: embeddingTableValidator,
		column: embeddingSlotValidator,
		cursor: v.union(v.string(), v.null()),
	},
	handler: async (ctx, args) => {
		const attestation = await ctx.db.get(args.attestationId);
		if (!attestation || attestation.status !== 'revoked') return;
		const spaceId = attestation.spaceId;
		const isKnowledge = args.table === 'knowledgeEntries';
		const page =
			args.column === 'primary'
				? await ctx.db
						.query(args.table)
						.withIndex('by_embedding_space', (q) => q.eq('embeddingSpaceId', spaceId))
						.paginate({ cursor: args.cursor, numItems: ATTESTATION_PAGE_SIZE })
				: await ctx.db
						.query(args.table)
						.withIndex('by_secondary_embedding_space', (q) =>
							q.eq('secondaryEmbeddingSpaceId', spaceId)
						)
						.paginate({ cursor: args.cursor, numItems: ATTESTATION_PAGE_SIZE });
		for (const row of page.page) {
			if (args.column === 'primary' && row.embeddingAttestationId === attestation._id) {
				await ctx.db.patch(row._id, {
					embeddingSpaceId: undefined,
					embeddingProvenance: undefined,
					embeddingAttestationId: undefined,
					...(isKnowledge ? { embeddingSpaceEntryKey: undefined } : {}),
				});
			} else if (
				args.column === 'secondary' &&
				row.secondaryEmbeddingAttestationId === attestation._id
			) {
				await ctx.db.patch(row._id, {
					secondaryEmbedding: undefined,
					secondaryEmbeddingSpaceId: undefined,
					secondaryEmbeddingGeneratedAt: undefined,
					secondaryEmbeddingProvenance: undefined,
					secondaryEmbeddingAttestationId: undefined,
					...(isKnowledge ? { secondaryEmbeddingSpaceEntryKey: undefined } : {}),
				});
			}
		}
		const step = REVOKE_STEPS.findIndex(([t, c]) => t === args.table && c === args.column);
		const next = page.isDone ? REVOKE_STEPS[step + 1] : undefined;
		if (!page.isDone) {
			await ctx.scheduler.runAfter(0, internal.aiRouting.embeddingAttestations.revokePage, {
				...args,
				cursor: page.continueCursor,
			});
		} else if (next) {
			await ctx.scheduler.runAfter(0, internal.aiRouting.embeddingAttestations.revokePage, {
				attestationId: args.attestationId,
				table: next[0],
				column: next[1],
				cursor: null,
			});
		} else {
			await ctx.db.patch(attestation._id, { updatedAt: Date.now() });
			await ctx.scheduler.runAfter(0, internal.aiRouting.embeddingReembed.kickoff, {
				isForced: true,
			});
		}
	},
});
