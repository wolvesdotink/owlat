/**
 * The staged embedding rebuild (ADR-0073, Phase 5): build into a staged space
 * while retrieval keeps the active one, validate it with a bounded sample of
 * queries, activate it atomically (states and the stored configuration in one
 * transaction), and roll back to the previous space with its vectors intact.
 *
 * `embed` is mocked to a deterministic vector per (model, text), so the two
 * models disagree; the local server answers no revision probe.
 */
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Ai from 'ai';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import {
	configureLocalEmbedder,
	seedEmbeddingSpace,
	stampedIn,
	TEST_LOCAL_SPACE,
} from './helpers/embeddingSpaces';

const DIMS = 64;

/** A one-hot per (model, text), padded to the index width like `toIndexVector`. */
function vectorFor(modelId: string, text: string, width = DIMS): number[] {
	let hash = 0;
	for (const char of `${modelId}|${text}`) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
	return Array.from({ length: width }, (_, i) => (i === hash % DIMS ? 1 : 0));
}

vi.mock('ai', async () => {
	const actual = await vi.importActual<typeof Ai>('ai');
	return {
		...actual,
		embed: vi.fn(async ({ model, value }: { model: { modelId: string }; value: string }) => ({
			embedding: vectorFor(model.modelId, value),
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
const TITLES = ['Invoices go out in EUR', 'Support hours are 9 to 5', 'Refunds take a week'];

/** A configured local nomic deployment whose entries are in the active nomic space. */
async function nomicDeployment(t: T): Promise<Id<'embeddingSpaces'>> {
	await configureLocalEmbedder(t);
	const nomic = await seedEmbeddingSpace(t, {
		identity: { ...TEST_LOCAL_SPACE, dimensions: DIMS },
	});
	const now = Date.now();
	for (const title of TITLES) {
		await t.run((ctx) =>
			ctx.db.insert('knowledgeEntries', {
				entryType: 'fact',
				title,
				content: title,
				sourceType: 'manual',
				embedding: vectorFor('nomic-embed-text', `${title}: ${title}`, 1536),
				...stampedIn(nomic, 'fact'),
				confidence: 0.9,
				lastValidatedAt: now,
				searchableText: title,
				createdAt: now,
				updatedAt: now,
			})
		);
	}
	return nomic;
}

/** A vector-only search with the query embedded by the configured model. */
async function findByMeaning(t: T, text: string): Promise<string[]> {
	const results = await t.action(internal.knowledge.retrieval.semanticSearch, {
		queryText: text,
		scopeToContact: 'org-wide',
		includeInboxDerived: true,
		limit: 1,
	});
	return results.filter((r) => r._score > 0).map((r) => r.title);
}

const states = (t: T) =>
	t.run(async (ctx) => {
		const spaces = await ctx.db.query('embeddingSpaces').collect();
		const config = await ctx.db.query('aiProviderConfig').first();
		return {
			spaces: Object.fromEntries(spaces.map((s) => [s.model, `${s.state}/${s.slot}`])),
			configModel: config?.embeddingModel,
		};
	});

describe('staged rebuild', () => {
	it('builds beside the active space, validates, activates atomically and rolls back', async () => {
		const t = convexTest(schema, modules);
		const nomic = await nomicDeployment(t);
		const title = TITLES[0]!;
		expect(await findByMeaning(t, `${title}: ${title}`)).toEqual([title]);

		const staged = await t.action(api.aiRouting.embeddingRebuild.startRebuild, {
			embeddingProviderKind: 'local',
			embeddingModel: 'mxbai-embed-large',
		});
		await flush(t);
		expect(await states(t)).toEqual({
			spaces: { 'nomic-embed-text': 'active/primary', 'mxbai-embed-large': 'staged/secondary' },
			configModel: undefined,
		});
		const rebuilt = await t.run((ctx) => ctx.db.query('knowledgeEntries').collect());
		for (const row of rebuilt) {
			expect(row.secondaryEmbeddingSpaceId).toBe(staged);
			expect(row.secondaryEmbeddingSpaceEntryKey).toBe(`${staged}:fact`);
			// The active vectors are untouched.
			expect(row.embeddingSpaceId).toBe(nomic);
		}
		// Retrieval still uses the active space throughout the rebuild.
		expect(await findByMeaning(t, `${title}: ${title}`)).toEqual([title]);

		const validation = await t.action(api.aiRouting.embeddingRebuild.validateStaged, {});
		expect(validation).toMatchObject({ sampled: 3, passed: 3, isPassing: true });

		await t.action(api.aiRouting.embeddingRebuild.activateStaged, {});
		// One transaction: the states and the stored selection moved together.
		expect(await states(t)).toEqual({
			spaces: { 'nomic-embed-text': 'retired/primary', 'mxbai-embed-large': 'active/secondary' },
			configModel: 'mxbai-embed-large',
		});
		expect(await findByMeaning(t, `${title}: ${title}`)).toEqual([title]);

		await t.mutation(api.aiRouting.embeddingRebuildState.rollback, {});
		expect(await states(t)).toEqual({
			spaces: { 'nomic-embed-text': 'active/primary', 'mxbai-embed-large': 'retired/secondary' },
			configModel: 'nomic-embed-text',
		});
		// The previous space's vectors were never overwritten: searchable at once.
		expect(await findByMeaning(t, `${title}: ${title}`)).toEqual([title]);

		const audit = await t.run((ctx) => ctx.db.query('auditLogs').collect());
		expect(audit.map((row) => row.action)).toEqual([
			'embedding_space.staged',
			'embedding_space.activated',
			'embedding_space.rolled_back',
		]);
	});

	it('refuses to activate before the rebuild has filled the staged space', async () => {
		const t = convexTest(schema, modules);
		await nomicDeployment(t);
		await t.action(api.aiRouting.embeddingRebuild.startRebuild, {
			embeddingProviderKind: 'local',
			embeddingModel: 'mxbai-embed-large',
		});
		// The rebuild job is still queued: no row is in the staged space yet.
		await expect(t.action(api.aiRouting.embeddingRebuild.activateStaged, {})).rejects.toThrow(
			/failed validation/
		);
		expect((await states(t)).spaces['nomic-embed-text']).toBe('active/primary');
	});

	it('refuses a staged rebuild into the active model, or a second one', async () => {
		const t = convexTest(schema, modules);
		await nomicDeployment(t);
		await expect(
			t.action(api.aiRouting.embeddingRebuild.startRebuild, { embeddingProviderKind: 'local' })
		).rejects.toThrow(/already the active one/);
		await t.action(api.aiRouting.embeddingRebuild.startRebuild, {
			embeddingProviderKind: 'local',
			embeddingModel: 'mxbai-embed-large',
		});
		await expect(
			t.action(api.aiRouting.embeddingRebuild.startRebuild, {
				embeddingProviderKind: 'local',
				embeddingModel: 'all-minilm',
			})
		).rejects.toThrow(/already exists/);
	});

	it('refuses a hosted target whose key Owlat does not hold', async () => {
		const t = convexTest(schema, modules);
		await nomicDeployment(t);
		await expect(
			t.action(api.aiRouting.embeddingRebuild.startRebuild, { embeddingProviderKind: 'openai' })
		).rejects.toThrow(/select it in the settings/);
	});

	it('cancels a staged rebuild without touching the active space', async () => {
		const t = convexTest(schema, modules);
		await nomicDeployment(t);
		await t.action(api.aiRouting.embeddingRebuild.startRebuild, {
			embeddingProviderKind: 'local',
			embeddingModel: 'mxbai-embed-large',
		});
		await t.mutation(api.aiRouting.embeddingRebuildState.cancelRebuild, {});
		await flush(t);
		expect((await states(t)).spaces).toEqual({
			'nomic-embed-text': 'active/primary',
			'mxbai-embed-large': 'retired/secondary',
		});
		const [job] = await t.run((ctx) => ctx.db.query('embeddingReembedJobs').collect());
		expect(job?.status).toBe('cancelled');
	});
});
