/**
 * The sample re-embed check (ADR-0073, Phase 1a): corroboration, never proof.
 *
 * It re-embeds a time-spread sample of a cohort's rows with the configured
 * embedder and compares each fresh vector with the stored one. A passing
 * sample cannot establish provenance for the rows it did not sample (a
 * deployment that switched A → B → A passes a sample of A rows), so this check
 * writes no provenance at all: it returns a report and records it in the audit
 * log. Cohorts are established only by records or an attestation
 * (`embeddingAttestations.ts`).
 *
 * Only recoverable, unchanged inputs are compared. A knowledge entry whose
 * stored `contentHash` no longer matches its text was edited (or merged) after
 * its vector was made, and a file edited after processing cannot be rebuilt:
 * both count as `inputMissing`, never as a mismatch. A mismatch on its own
 * cannot tell changed content from a changed model; it needs investigation.
 */

import { v } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { internalMutation } from '../lib/writeFence';
import { internalQuery } from '../_generated/server';
import { authedAction } from '../lib/authedFunctions';
import { recordAuditLog } from '../lib/auditLog';
import { requireOrgPermission } from '../lib/sessionOrganization';
import { throwInvalidState } from '../_utils/errors';
import { normalizeForHash } from '../lib/knowledgeEdges';
import { configuredEmbedderOrNull, embedForIndex } from '../lib/aiRouting/embedderForSpace';
import { embeddingSpaceIdentityKey } from '../lib/aiRouting/embeddingKeys';
import { fileEmbeddingInput, knowledgeEmbeddingInput } from '../lib/aiRouting/embeddingInputs';
import { embeddingCohortValidator } from '../lib/validators/embedding';

/**
 * Cosine similarity a re-embedded unchanged input must reach. The same model
 * build returns the same vector for the same input; the margin covers
 * nondeterministic GPU kernels, not a different model.
 */
export const SAMPLE_COSINE_TOLERANCE = 0.99;
const SAMPLE_MAX = 12;
/** A file processed this long after its vector was made counts as edited since. */
const FILE_EDIT_SLACK_MS = 10 * 60_000;

type SampleRow = {
	id: string;
	text: string | null;
	/** The input may have changed since the vector was made. */
	isInputDoubtful: boolean;
	contentHash?: string;
	title?: string;
	content?: string;
	vector: number[];
};

/**
 * Up to `size` rows of the cohort, spread over its period: the first row at or
 * after each of `size` evenly spaced instants. `attestationId` samples the rows
 * that attestation assigned; without it, the unknown rows in the period.
 */
export const cohortSample = internalQuery({
	args: {
		cohort: embeddingCohortValidator,
		attestationId: v.optional(v.id('embeddingAttestations')),
		size: v.number(),
	},
	handler: async (ctx, args): Promise<{ rows: SampleRow[]; spaceIdentityKey: string | null }> => {
		await requireOrgPermission(ctx, 'organization:manage');
		const attestation = args.attestationId ? await ctx.db.get(args.attestationId) : null;
		const spaceId = attestation?.spaceId;
		const space = spaceId ? await ctx.db.get(spaceId) : null;
		const from = args.cohort.writtenFrom ?? 0;
		const until = args.cohort.writtenUntil;
		const size = Math.max(1, Math.min(SAMPLE_MAX, Math.floor(args.size)));
		const perTable = Math.max(1, Math.ceil(size / args.cohort.tables.length));
		const rows: SampleRow[] = [];
		const seen = new Set<string>();
		for (const table of args.cohort.tables) {
			for (let i = 0; i < perTable && rows.length < size; i++) {
				const at = from + Math.floor(((until - from) * i) / perTable);
				const row = await ctx.db
					.query(table)
					.withIndex('by_embedding_space', (q) =>
						q
							.eq('embeddingSpaceId', spaceId)
							.gte('embeddingGeneratedAt', at)
							.lt('embeddingGeneratedAt', until)
					)
					.first();
				if (!row || seen.has(row._id) || row.embedding.length === 0) continue;
				if (attestation && row.embeddingAttestationId !== attestation._id) continue;
				seen.add(row._id);
				if (table === 'knowledgeEntries') {
					const entry = row as Doc<'knowledgeEntries'>;
					rows.push({
						id: entry._id,
						text: knowledgeEmbeddingInput(entry),
						isInputDoubtful: entry.contentHash === undefined,
						contentHash: entry.contentHash,
						title: entry.title,
						content: entry.content,
						vector: entry.embedding,
					});
				} else {
					const file = row as Doc<'semanticFiles'>;
					const madeAt = file.embeddingGeneratedAt ?? 0;
					rows.push({
						id: file._id,
						text: fileEmbeddingInput(file),
						isInputDoubtful: file.updatedAt - madeAt > FILE_EDIT_SLACK_MS,
						vector: file.embedding,
					});
				}
			}
		}
		return { rows, spaceIdentityKey: space?.identityKey ?? null };
	},
});

async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Cosine over the first `width` components (the stored vector is index-padded). */
function cosine(a: readonly number[], b: readonly number[], width: number): number {
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < width; i++) {
		const x = a[i] ?? 0;
		const y = b[i] ?? 0;
		dot += x * y;
		na += x * x;
		nb += y * y;
	}
	return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

export interface SampleCheckReport {
	sampled: number;
	matched: number;
	mismatched: number;
	inputMissing: number;
	tolerance: number;
	/** Always false: a sample never establishes provenance. */
	isProvenanceEstablished: false;
}

/**
 * Re-embed a sample of a cohort with the configured embedder and compare. A
 * local embedder only: a hosted re-embed is paid work, which waits for spend
 * admission. Writes no provenance.
 */
// authz: admin-only; cohortSample and recordReport require organization:manage
export const run = authedAction({
	args: {
		cohort: embeddingCohortValidator,
		attestationId: v.optional(v.id('embeddingAttestations')),
		size: v.optional(v.number()),
	},
	handler: async (ctx, args): Promise<SampleCheckReport> => {
		const embedder = await configuredEmbedderOrNull(ctx);
		if (!embedder) throwInvalidState('No embedding model is configured.');
		if (!embedder.target.isLocal) {
			throwInvalidState(
				'A sample check with a hosted embedder costs money and needs spend admission, which this build does not have yet.'
			);
		}
		const { rows: sample, spaceIdentityKey } = await ctx.runQuery(
			internal.aiRouting.embeddingSampleCheck.cohortSample,
			{
				cohort: args.cohort,
				attestationId: args.attestationId,
				size: args.size ?? 8,
			}
		);
		const report: SampleCheckReport = {
			sampled: sample.length,
			matched: 0,
			mismatched: 0,
			inputMissing: 0,
			tolerance: SAMPLE_COSINE_TOLERANCE,
			isProvenanceEstablished: false,
		};
		for (const row of sample) {
			let isRecoverable =
				row.text !== null && !(row.isInputDoubtful && row.contentHash === undefined);
			if (isRecoverable && row.contentHash !== undefined) {
				const current = await sha256Hex(normalizeForHash(row.title ?? '', row.content ?? ''));
				isRecoverable = current === row.contentHash;
			}
			if (!isRecoverable || row.text === null) {
				report.inputMissing += 1;
				continue;
			}
			const fresh = await embedForIndex(embedder, row.text);
			// An attested cohort is only comparable with its own space's model.
			if (
				spaceIdentityKey !== null &&
				embeddingSpaceIdentityKey(fresh.space) !== spaceIdentityKey
			) {
				throwInvalidState(
					'The configured embedding model is not the attested one, so it cannot corroborate this cohort.'
				);
			}
			const similarity = cosine(fresh.raw, row.vector, fresh.raw.length);
			if (similarity >= SAMPLE_COSINE_TOLERANCE) report.matched += 1;
			else report.mismatched += 1;
		}
		await ctx.runMutation(internal.aiRouting.embeddingSampleCheck.recordReport, {
			attestationId: args.attestationId,
			report: { ...report },
		});
		return report;
	},
});

/** The audit row of a sample check (admin-gated; no provenance is written). */
export const recordReport = internalMutation({
	args: {
		attestationId: v.optional(v.id('embeddingAttestations')),
		report: v.object({
			sampled: v.number(),
			matched: v.number(),
			mismatched: v.number(),
			inputMissing: v.number(),
			tolerance: v.number(),
			isProvenanceEstablished: v.literal(false),
		}),
	},
	handler: async (ctx, args) => {
		const session = await requireOrgPermission(ctx, 'organization:manage');
		const attestation: Doc<'embeddingAttestations'> | null = args.attestationId
			? await ctx.db.get(args.attestationId)
			: null;
		await recordAuditLog(ctx, {
			userId: session.userId,
			organizationId: session.activeOrganizationId,
			action: 'embedding_cohort.sample_checked',
			resource: 'embedding_space',
			resourceId: attestation?.spaceId as Id<'embeddingSpaces'> | undefined,
			details: { ...args.report, attestationId: args.attestationId ?? '' },
		});
	},
});
