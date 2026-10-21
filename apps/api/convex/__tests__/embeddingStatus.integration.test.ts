/**
 * The settings page's embedding status: what the page needs to
 * gate its actions on the server's own rules instead of guessing.
 *
 *   - `isLocal` on the active, staged and rollback spaces, and per rebuild
 *     target kind: the rule each job is paid by (`isSpaceLocal`), which agrees
 *     with dispatch's (`storedEmbeddingTarget().isLocal`).
 *   - `attestation`: whether the configured target can take an attested
 *     cohort, by the rule `attest` enforces (a retired primary owner included).
 *   - `coverage.*.reembedCandidates` / `reembedSkipped`: exactly the rows a
 *     re-embed embeds, and the ones it skips.
 */
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Ai from 'ai';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { storedEmbeddingTarget } from '../lib/embeddingSpace';
import { EMBEDDING_PROVIDER_KINDS } from '../lib/llmProviders/types';
import {
	configureLocalEmbedder,
	seedEmbeddingSpace,
	stampedIn,
	TEST_LOCAL_SPACE,
} from './helpers/embeddingSpaces';

vi.mock('ai', async () => {
	const actual = await vi.importActual<typeof Ai>('ai');
	return {
		...actual,
		embed: vi.fn(async () => ({
			embedding: Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0)),
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

const OPENAI = {
	provider: 'openai' as const,
	endpoint: 'native',
	model: 'text-embedding-3-small',
	dimensions: 1536,
};

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
	vi.unstubAllEnvs();
});

const flush = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers);
const status = (t: T) => t.query(api.aiRouting.embeddingSpaces.status, {});

describe('locality on the status', () => {
	it('marks the active and staged spaces local or paid', async () => {
		const t = convexTest(schema, modules);
		await seedEmbeddingSpace(t);
		await seedEmbeddingSpace(t, { identity: OPENAI, state: 'staged', slot: 'secondary' });
		const view = await status(t);
		expect(view.active?.isLocal).toBe(true);
		expect(view.staged?.isLocal).toBe(false);
	});

	it('marks the rollback space local or paid', async () => {
		const t = convexTest(schema, modules);
		const predecessor = await seedEmbeddingSpace(t, { state: 'retired', slot: 'secondary' });
		const active = await seedEmbeddingSpace(t, { identity: OPENAI });
		await t.run((ctx) => ctx.db.patch(active, { predecessorSpaceId: predecessor }));
		const view = await status(t);
		expect(view.active?.isLocal).toBe(false);
		expect(view.rollbackTo?._id).toBe(predecessor);
		expect(view.rollbackTo?.isLocal).toBe(true);
	});

	it('names every rebuild target kind local or paid, as dispatch decides it', async () => {
		const t = convexTest(schema, modules);
		for (const baseUrl of [undefined, 'https://embeddings.example.com/v1']) {
			vi.stubEnv('LOCAL_EMBEDDING_BASE_URL', baseUrl);
			const { rebuildTargets } = await status(t);
			expect(rebuildTargets.map((target) => target.kind)).toEqual([...EMBEDDING_PROVIDER_KINDS]);
			for (const { kind, isLocal } of rebuildTargets) {
				expect(isLocal).toBe(storedEmbeddingTarget({ embeddingProviderKind: kind }).isLocal);
			}
		}
		vi.stubEnv('LOCAL_EMBEDDING_BASE_URL', 'https://embeddings.example.com/v1');
		const byKind = Object.fromEntries(
			(await status(t)).rebuildTargets.map((target) => [target.kind, target.isLocal])
		);
		expect(byKind).toEqual({ local: true, openai: false, google: false, openaiCompatible: false });
	});
});

describe('attestation eligibility on the status', () => {
	const attestById = (t: T, spaceId: Id<'embeddingSpaces'>) =>
		t.mutation(api.aiRouting.embeddingAttestations.attest, {
			spaceId,
			source: 'attestation',
			cohort: { tables: ['knowledgeEntries'], writtenUntil: 5_000 },
			statement: 'nomic-embed-text since install.',
		});

	it('is unavailable without a configured embedder', async () => {
		const t = convexTest(schema, modules);
		expect((await status(t)).attestation).toEqual({
			canAttest: false,
			reason: 'not_configured',
			spaceId: null,
		});
	});

	it('allows the configured space that owns the primary column', async () => {
		const t = convexTest(schema, modules);
		const active = await seedEmbeddingSpace(t);
		expect((await status(t)).attestation).toEqual({
			canAttest: true,
			reason: null,
			spaceId: active,
		});
		await expect(attestById(t, active)).resolves.toBeDefined();
	});

	it('allows a new registration while nobody owns the primary column', async () => {
		const t = convexTest(schema, modules);
		await configureLocalEmbedder(t);
		expect((await status(t)).attestation).toEqual({
			canAttest: true,
			reason: null,
			spaceId: null,
		});
	});

	it('refuses while a retired space owns the primary column, as attest does', async () => {
		const t = convexTest(schema, modules);
		await seedEmbeddingSpace(t, { identity: OPENAI, state: 'retired' });
		const active = await seedEmbeddingSpace(t, { slot: 'secondary' });
		expect((await status(t)).attestation).toEqual({
			canAttest: false,
			reason: 'primary_owned_by_other_space',
			spaceId: active,
		});
		await expect(attestById(t, active)).rejects.toThrow(/another embedding space now uses/);
	});

	it('refuses a configured space in the secondary column, as attest does', async () => {
		const t = convexTest(schema, modules);
		const active = await seedEmbeddingSpace(t, { slot: 'secondary' });
		expect((await status(t)).attestation).toEqual({
			canAttest: false,
			reason: 'secondary_column',
			spaceId: active,
		});
		await expect(attestById(t, active)).rejects.toThrow(/keeps its vectors in the other column/);
	});
});

describe('re-embed candidates in the coverage', () => {
	async function insertEntry(t: T, title: string, fields: Partial<Doc<'knowledgeEntries'>> = {}) {
		const now = Date.now();
		return t.run((ctx) =>
			ctx.db.insert('knowledgeEntries', {
				entryType: 'fact',
				title,
				content: `${title} content`,
				sourceType: 'manual',
				embedding: [],
				confidence: 0.9,
				lastValidatedAt: now,
				searchableText: title,
				createdAt: now,
				updatedAt: now,
				...fields,
			})
		);
	}

	async function insertFile(t: T, filename: string, fields: Partial<Doc<'semanticFiles'>> = {}) {
		const now = Date.now();
		return t.run((ctx) =>
			ctx.db.insert('semanticFiles', {
				filename,
				mimeType: 'text/plain',
				fileSize: 5,
				sourceType: 'upload',
				version: 1,
				embedding: [],
				createdAt: now,
				updatedAt: now,
				...fields,
			})
		);
	}

	it('counts exactly the rows a re-embed embeds, apart from the ones it skips', async () => {
		const t = convexTest(schema, modules);
		await configureLocalEmbedder(t);
		const spaceId = await seedEmbeddingSpace(t);
		const vector = Array.from({ length: 1536 }, (_, i) => (i === 1 ? 1 : 0));
		await insertEntry(t, 'searchable', { embedding: vector, ...stampedIn(spaceId, 'fact') });
		await insertEntry(t, 'unknown legacy', { embedding: vector, embeddingGeneratedAt: 1 });
		await insertEntry(t, 'never embedded');
		await insertEntry(t, 'expired', { expiresAt: Date.now() - 1_000 });
		await insertFile(t, 'processed.txt', { extractedText: 'A long enough processed text.' });
		await insertFile(t, 'still processing.txt');
		await insertFile(t, 'x.txt', { extractedText: 'tiny' });

		await t.mutation(api.aiRouting.embeddingCoverage.refresh, {});
		await flush(t);
		const { coverage } = await status(t);
		expect(coverage?.knowledgeEntries).toEqual({
			active: 1,
			unknown: 1,
			inactive: 0,
			unembedded: 2,
			reembedCandidates: 2,
			reembedSkipped: 1,
		});
		expect(coverage?.semanticFiles).toEqual({
			active: 0,
			unknown: 0,
			inactive: 0,
			unembedded: 3,
			reembedCandidates: 1,
			reembedSkipped: 2,
		});

		// The job embeds exactly the counted candidates.
		await t.mutation(internal.aiRouting.embeddingReembedJobs.startLocalReembed, {
			spaceId,
			isForced: true,
		});
		await flush(t);
		const [job] = await t.run((ctx) => ctx.db.query('embeddingReembedJobs').collect());
		expect(job).toMatchObject({ status: 'completed', embeddedCount: 3 });
	});

	it('restarts a walk scheduled before the candidate counts, so no count is partial', async () => {
		const t = convexTest(schema, modules);
		await configureLocalEmbedder(t);
		await seedEmbeddingSpace(t, { identity: { ...TEST_LOCAL_SPACE } });
		await insertEntry(t, 'never embedded');
		const stale = { active: 7, unknown: 7, inactive: 7, unembedded: 7 };
		await t.action(internal.aiRouting.embeddingCoverage.scan, {
			startedAt: Date.now(),
			table: 'semanticFiles',
			cursor: null,
			knowledgeEntries: stale,
			semanticFiles: stale,
		});
		await flush(t);
		const { coverage } = await status(t);
		expect(coverage?.knowledgeEntries).toMatchObject({ unembedded: 1, reembedCandidates: 1 });
		expect(coverage?.semanticFiles).toMatchObject({ unembedded: 0, reembedCandidates: 0 });
	});
});
