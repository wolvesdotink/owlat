/**
 * Legacy embedding cohorts (ADR-0073, Phase 1a; #1334).
 *
 * A cohort is established only by records or an operator attestation, both
 * recorded as such. A sample re-embed check corroborates and never establishes:
 * even a perfect sample leaves every row unknown and out of vector search.
 */
import { createHash } from 'node:crypto';
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Ai from 'ai';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { normalizeForHash } from '../lib/knowledgeEdges';
import { fitsAttestedWidth } from '../aiRouting/embeddingAttestations';
import {
	configureLocalEmbedder,
	seedEmbeddingSpace,
	TEST_LOCAL_SPACE,
} from './helpers/embeddingSpaces';

const DIM = 1536;
const unit = (at: number) => Array.from({ length: DIM }, (_, i) => (i === at ? 1 : 0));

/** The vector the mocked local model returns for a text: a one-hot by hash. */
function vectorFor(text: string): number[] {
	let hash = 0;
	for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
	return unit(hash % 700);
}

vi.mock('ai', async () => {
	const actual = await vi.importActual<typeof Ai>('ai');
	return {
		...actual,
		embed: vi.fn(async ({ value }: { value: string }) => ({
			embedding: vectorFor(value),
			usage: { tokens: 1 },
		})),
	};
});

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<object>('../lib/sessionOrganization');
	const admin = async () => ({ userId: 'admin-1', role: 'owner', activeOrganizationId: 'org-1' });
	return {
		...actual,
		requireOrgPermission: vi.fn(admin),
		requireAdminContext: vi.fn(admin),
		requireOrgMember: vi.fn(admin),
	};
});

const modules = import.meta.glob('../**/*.*s');
type T = ReturnType<typeof convexTest>;

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => new Response('not found', { status: 404 }))
	);
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

const flush = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers);

/** A row written before provenance: a vector, the static model stamp, no space. */
async function legacyEntry(
	t: T,
	title: string,
	writtenAt: number,
	fields: Partial<Doc<'knowledgeEntries'>> = {}
): Promise<Id<'knowledgeEntries'>> {
	const content = `${title} content`;
	return t.run((ctx) =>
		ctx.db.insert('knowledgeEntries', {
			entryType: 'fact',
			title,
			content,
			sourceType: 'agent_extracted',
			embedding: vectorFor(`${title}: ${content}`),
			embeddingModel: 'text-embedding-3-small',
			embeddingGeneratedAt: writtenAt,
			contentHash: createHash('sha256').update(normalizeForHash(title, content)).digest('hex'),
			confidence: 0.9,
			lastValidatedAt: writtenAt,
			searchableText: title,
			createdAt: writtenAt,
			updatedAt: writtenAt,
			...fields,
		})
	);
}

const vectorHits = (t: T, spaceId: Id<'embeddingSpaces'>, at: number[]) =>
	t.action(internal.knowledge.retrieval.semanticSearch, {
		embedding: at,
		embeddingSpaceId: spaceId,
		scopeToContact: 'org-wide',
		includeInboxDerived: true,
	});

describe('attestation', () => {
	it('assigns the attested cohort, and only it, recorded as an attestation', async () => {
		const t = convexTest(schema, modules);
		const space = await seedEmbeddingSpace(t);
		const inCohort = await legacyEntry(t, 'in cohort', 1_000);
		const tooLate = await legacyEntry(t, 'too late', 9_000);
		const otherStamp = await legacyEntry(t, 'other stamp', 2_000, { embeddingModel: 'ada-002' });

		const attestationId = await t.mutation(api.aiRouting.embeddingAttestations.attest, {
			spaceId: space,
			source: 'attestation',
			cohort: {
				tables: ['knowledgeEntries'],
				writtenUntil: 5_000,
				legacyModelStamp: 'text-embedding-3-small',
			},
			statement: 'We ran the local nomic model since install, never anything else.',
		});
		await flush(t);

		const rows = await t.run(async (ctx) => ({
			inCohort: await ctx.db.get(inCohort),
			tooLate: await ctx.db.get(tooLate),
			otherStamp: await ctx.db.get(otherStamp),
			attestation: await ctx.db.get(attestationId),
		}));
		expect(rows.inCohort).toMatchObject({
			embeddingSpaceId: space,
			embeddingProvenance: 'attestation',
			embeddingAttestationId: attestationId,
			embeddingSpaceEntryKey: `${space}:fact`,
		});
		expect(rows.tooLate!.embeddingSpaceId).toBeUndefined();
		expect(rows.otherStamp!.embeddingSpaceId).toBeUndefined();
		expect(rows.attestation).toMatchObject({
			status: 'applied',
			rowsAssigned: 1,
			attestedBy: 'admin-1',
			source: 'attestation',
		});

		// The cohort is searchable by vector in its (active) space.
		const hits = await vectorHits(t, space, rows.inCohort!.embedding);
		expect(hits.map((h) => h.title)).toEqual(['in cohort']);

		const audit = await t.run((ctx) => ctx.db.query('auditLogs').collect());
		expect(audit.map((row) => row.action)).toContain('embedding_cohort.attested');
	});

	it('records retained records as `record`, and registers the space they name', async () => {
		const t = convexTest(schema, modules);
		const entry = await legacyEntry(t, 'from records', 1_000);
		await t.mutation(api.aiRouting.embeddingAttestations.attest, {
			identity: {
				provider: 'openai',
				endpoint: 'native',
				model: 'text-embedding-3-small',
				dimensions: 1536,
			},
			source: 'record',
			cohort: { tables: ['knowledgeEntries'], writtenUntil: 5_000 },
			statement: 'Deployment manifest v3 pins OpenAI text-embedding-3-small from install on.',
		});
		await flush(t);
		const row = await t.run((ctx) => ctx.db.get(entry));
		expect(row?.embeddingProvenance).toBe('record');
		const space = await t.run((ctx) => ctx.db.get(row!.embeddingSpaceId!));
		// Known, but not the active space: out of vector search until re-embedded.
		expect(space).toMatchObject({ source: 'record', state: 'retired', slot: 'primary' });
	});

	it('leaves a row whose vector is wider than the attested model unknown', async () => {
		const t = convexTest(schema, modules);
		const space = await seedEmbeddingSpace(t, {
			identity: { ...TEST_LOCAL_SPACE, dimensions: 768 },
		});
		const wide = await legacyEntry(t, 'wide', 1_000, { embedding: unit(900) });
		const fits = await legacyEntry(t, 'fits', 1_000, { embedding: unit(10) });
		await t.mutation(api.aiRouting.embeddingAttestations.attest, {
			spaceId: space,
			source: 'attestation',
			cohort: { tables: ['knowledgeEntries'], writtenUntil: 5_000 },
			statement: 'nomic, 768 wide.',
		});
		await flush(t);
		expect((await t.run((ctx) => ctx.db.get(wide)))?.embeddingSpaceId).toBeUndefined();
		expect((await t.run((ctx) => ctx.db.get(fits)))?.embeddingSpaceId).toBe(space);
	});

	it('revocation returns exactly the assigned rows to unknown', async () => {
		const t = convexTest(schema, modules);
		const space = await seedEmbeddingSpace(t);
		const entry = await legacyEntry(t, 'revoked', 1_000);
		const attestationId = await t.mutation(api.aiRouting.embeddingAttestations.attest, {
			spaceId: space,
			source: 'attestation',
			cohort: { tables: ['knowledgeEntries'], writtenUntil: 5_000 },
			statement: 'Mistaken attestation.',
		});
		await flush(t);
		await t.mutation(api.aiRouting.embeddingAttestations.revoke, { attestationId });
		await flush(t);
		const row = await t.run((ctx) => ctx.db.get(entry));
		expect(row?.embeddingSpaceId).toBeUndefined();
		expect(row?.embeddingProvenance).toBeUndefined();
		expect(row?.embeddingAttestationId).toBeUndefined();
		expect(await vectorHits(t, space, row!.embedding)).toEqual([]);
		expect(await t.run((ctx) => ctx.db.get(attestationId))).toMatchObject({
			status: 'revoked',
			revokedBy: 'admin-1',
		});
	});

	it('refuses an open-ended or future cohort', async () => {
		const t = convexTest(schema, modules);
		const space = await seedEmbeddingSpace(t);
		await expect(
			t.mutation(api.aiRouting.embeddingAttestations.attest, {
				spaceId: space,
				source: 'attestation',
				cohort: { tables: ['knowledgeEntries'], writtenUntil: Date.now() + 60_000 },
				statement: 'Future.',
			})
		).rejects.toThrow(/period/);
	});
});

describe('sample check', () => {
	it('corroborates a matching sample but establishes nothing', async () => {
		const t = convexTest(schema, modules);
		await configureLocalEmbedder(t);
		const space = await seedEmbeddingSpace(t);
		const ids: Id<'knowledgeEntries'>[] = [];
		for (let i = 0; i < 6; i++) ids.push(await legacyEntry(t, `sampled ${i}`, 1_000 + i * 100));

		const report = await t.action(api.aiRouting.embeddingSampleCheck.run, {
			cohort: { tables: ['knowledgeEntries'], writtenUntil: 5_000 },
			size: 6,
		});
		expect(report.sampled).toBeGreaterThan(0);
		expect(report.matched).toBe(report.sampled);
		expect(report.isProvenanceEstablished).toBe(false);

		// Every row is still unknown, and still out of vector search.
		for (const id of ids) {
			const row = await t.run((ctx) => ctx.db.get(id));
			expect(row?.embeddingSpaceId).toBeUndefined();
			expect(await vectorHits(t, space, row!.embedding)).toEqual([]);
		}
		const audit = await t.run((ctx) => ctx.db.query('auditLogs').collect());
		expect(audit.map((row) => row.action)).toEqual(['embedding_cohort.sample_checked']);
	});

	it('counts an edited entry as a missing input, never as a match or a mismatch', async () => {
		const t = convexTest(schema, modules);
		await configureLocalEmbedder(t);
		const id = await legacyEntry(t, 'edited', 1_000);
		await t.run((ctx) => ctx.db.patch(id, { content: 'rewritten by a person' }));
		const report = await t.action(api.aiRouting.embeddingSampleCheck.run, {
			cohort: { tables: ['knowledgeEntries'], writtenUntil: 5_000 },
			size: 1,
		});
		expect(report).toMatchObject({ sampled: 1, matched: 0, mismatched: 0, inputMissing: 1 });
	});
});

describe('fitsAttestedWidth', () => {
	it('refuses only vectors with non-zero components past the width', () => {
		expect(fitsAttestedWidth([1, 0, 0, 0], 2)).toBe(true);
		expect(fitsAttestedWidth([0, 0, 1, 0], 2)).toBe(false);
		expect(fitsAttestedWidth([1, 1], 4)).toBe(false);
	});
});
