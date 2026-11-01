/**
 * Legacy embedding cohorts.
 *
 * A cohort is established only by records or an operator attestation, both
 * recorded as such. An attested space never shares the active space's column,
 * and an attested configured space activates on a first upgrade.
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
		// The configured local default: its seeded space is the searchable one.
		await configureLocalEmbedder(t);
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
		// Outside the cohort: not attested (the local re-embed measures them instead).
		expect(rows.tooLate!.embeddingAttestationId).toBeUndefined();
		expect(rows.tooLate!.embeddingProvenance).not.toBe('attestation');
		expect(rows.otherStamp!.embeddingAttestationId).toBeUndefined();
		expect(rows.otherStamp!.embeddingProvenance).not.toBe('attestation');
		expect(rows.attestation).toMatchObject({
			status: 'applied',
			rowsAssigned: 1,
			attestedBy: 'admin-1',
			source: 'attestation',
		});

		// The cohort is searchable by vector in its (active) space.
		const hits = await vectorHits(t, space, rows.inCohort!.embedding);
		expect(hits[0]).toMatchObject({ title: 'in cohort', _score: 1 });

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
		// No configuration: nothing re-embeds the rows after the revocation.
		const space = await seedEmbeddingSpace(t, { isConfigured: false });
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

describe('first upgrade and column placement', () => {
	const OPENAI = {
		provider: 'openai' as const,
		endpoint: 'native',
		model: 'text-embedding-3-small',
		dimensions: 1536,
	};

	async function configureOpenAi(t: T) {
		await t.run((ctx) =>
			ctx.db.insert('aiProviderConfig', {
				languageProviderKind: 'anthropic',
				modelFast: 'claude-haiku-5-5',
				modelCapable: 'claude-sonnet-5-5',
				embeddingProviderKind: 'openai',
				embeddingModelVersion: 1,
				updatedAt: Date.now(),
			})
		);
	}

	it('activates an attested configured space on a hosted first upgrade (F3)', async () => {
		const t = convexTest(schema, modules);
		await configureOpenAi(t);
		const entry = await legacyEntry(t, 'legacy fact', 1_000);
		await t.mutation(api.aiRouting.embeddingAttestations.attest, {
			identity: OPENAI,
			source: 'attestation',
			cohort: { tables: ['knowledgeEntries'], writtenUntil: 5_000 },
			statement: 'OpenAI text-embedding-3-small since install.',
		});
		await flush(t);
		const space = await t.run(async (ctx) => (await ctx.db.query('embeddingSpaces').collect())[0]);
		expect(space).toMatchObject({ ...OPENAI, state: 'active', slot: 'primary' });
		const row = await t.run((ctx) => ctx.db.get(entry));
		// Searchable at once: no ingestion, no paid call.
		expect((await vectorHits(t, space!._id, row!.embedding)).map((h) => h.title)).toEqual([
			'legacy fact',
		]);
		const status = await t.query(api.aiRouting.embeddingSpaces.status, {});
		expect(status.configured?.isActive).toBe(true);
	});

	it('does not activate an attested space the configuration does not name', async () => {
		const t = convexTest(schema, modules);
		await configureOpenAi(t);
		await legacyEntry(t, 'legacy fact', 1_000);
		await t.mutation(api.aiRouting.embeddingAttestations.attest, {
			identity: { ...OPENAI, model: 'text-embedding-ada-002' },
			source: 'attestation',
			cohort: { tables: ['knowledgeEntries'], writtenUntil: 5_000 },
			statement: 'ada-002 before we upgraded.',
		});
		await flush(t);
		const spaces = await t.run((ctx) => ctx.db.query('embeddingSpaces').collect());
		expect(spaces.map((s) => s.state)).toEqual(['retired']);
	});

	it('refuses a cohort whose column another space owns (F4)', async () => {
		const t = convexTest(schema, modules);
		await configureLocalEmbedder(t);
		// The active local space owns the primary column, where legacy vectors are.
		await seedEmbeddingSpace(t);
		const legacy = await legacyEntry(t, 'legacy', 2_000);
		await expect(
			t.mutation(api.aiRouting.embeddingAttestations.attest, {
				identity: { ...OPENAI, dimensions: 700 },
				source: 'record',
				cohort: { tables: ['knowledgeEntries'], writtenUntil: 5_000 },
				statement: 'Manifest pins OpenAI for 2025.',
			})
		).rejects.toThrow(/another embedding space now uses/);
		const row = await t.run((ctx) => ctx.db.get(legacy));
		expect(row?.embeddingAttestationId).toBeUndefined();
		expect(row?.secondaryEmbedding).toBeUndefined();
	});

	it('stops applying once another space takes the column (F4)', async () => {
		const t = convexTest(schema, modules);
		// Nothing configured: no re-embed interferes.
		for (let i = 0; i < 70; i++) await legacyEntry(t, `legacy ${i}`, 1_000 + i);
		const attestationId = await t.mutation(api.aiRouting.embeddingAttestations.attest, {
			identity: OPENAI,
			source: 'attestation',
			cohort: { tables: ['knowledgeEntries'], writtenUntil: 5_000 },
			statement: 'OpenAI since install.',
		});
		// Before the first page runs, another space claims the primary column.
		await seedEmbeddingSpace(t, {
			identity: { ...OPENAI, model: 'text-embedding-ada-002' },
			state: 'retired',
			slot: 'primary',
			isConfigured: false,
		});
		await flush(t);
		const rows = await t.run((ctx) => ctx.db.query('knowledgeEntries').collect());
		expect(rows.every((row) => row.embeddingAttestationId === undefined)).toBe(true);
		expect(await t.run((ctx) => ctx.db.get(attestationId))).toMatchObject({
			status: 'applied',
			rowsAssigned: 0,
		});
	});

	it('refuses a historical space while another space holds the primary column', async () => {
		const t = convexTest(schema, modules);
		await seedEmbeddingSpace(t);
		await seedEmbeddingSpace(t, {
			state: 'staged',
			slot: 'secondary',
			identity: { ...TEST_LOCAL_SPACE, model: 'mxbai-embed-large' },
		});
		await expect(
			t.mutation(api.aiRouting.embeddingAttestations.attest, {
				identity: OPENAI,
				source: 'attestation',
				cohort: { tables: ['knowledgeEntries'], writtenUntil: 5_000 },
				statement: 'x',
			})
		).rejects.toThrow(/another embedding space now uses/);
	});
});

describe('revocation and a staged rebuild', () => {
	it('revoking a cohort the staged space reuses blocks its activation (F17)', async () => {
		const t = convexTest(schema, modules);
		await configureLocalEmbedder(t);
		// The active nomic space is in the secondary column; a staged mxbai space
		// owns the primary column, where the legacy vectors are.
		await seedEmbeddingSpace(t, { slot: 'secondary' });
		const staged = await seedEmbeddingSpace(t, {
			identity: { ...TEST_LOCAL_SPACE, model: 'mxbai-embed-large' },
			state: 'staged',
			slot: 'primary',
		});
		const entry = await legacyEntry(t, 'legacy', 1_000);
		const attestationId = await t.mutation(api.aiRouting.embeddingAttestations.attest, {
			spaceId: staged,
			source: 'attestation',
			cohort: { tables: ['knowledgeEntries'], writtenUntil: 5_000 },
			statement: 'mxbai since install.',
		});
		await flush(t);
		expect((await t.run((ctx) => ctx.db.get(entry)))?.embeddingSpaceId).toBe(staged);

		// The rebuild completes with the attested rows counted as done.
		await t.run((ctx) =>
			ctx.db.insert('embeddingReembedJobs', {
				kind: 'rebuild',
				targetSpaceId: staged,
				status: 'completed',
				isPaid: false,
				generation: 1,
				phase: 'semanticFiles',
				scannedCount: 1,
				embeddedCount: 0,
				skippedCount: 0,
				failedCount: 0,
				startedAt: Date.now() - 1,
				updatedAt: Date.now(),
				finishedAt: Date.now(),
			})
		);

		await t.mutation(api.aiRouting.embeddingAttestations.revoke, { attestationId });
		await flush(t);
		expect((await t.run((ctx) => ctx.db.get(entry)))?.embeddingSpaceId).toBeUndefined();
		await expect(
			t.mutation(internal.aiRouting.embeddingRebuildState.activateStagedSpace, {
				spaceId: staged,
				sampled: 1,
				passed: 1,
			})
		).rejects.toThrow(/changed during the rebuild/);
	});
});

describe('fitsAttestedWidth', () => {
	it('refuses only vectors with non-zero components past the width', () => {
		expect(fitsAttestedWidth([1, 0, 0, 0], 2)).toBe(true);
		expect(fitsAttestedWidth([0, 0, 1, 0], 2)).toBe(false);
		expect(fitsAttestedWidth([1, 1], 4)).toBe(false);
	});
});
