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
import { ConvexError, type Value } from 'convex/values';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Ai from 'ai';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { enableFeatures } from './factories';
import { EMBEDDING_TARGET_CHANGED } from '../lib/aiRouting/embeddingRegistry';
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
		embed: vi.fn(async ({ model, value }: { model: { modelId: string }; value: string }) => {
			embedCalls.count += 1;
			return { embedding: vectorFor(model.modelId, value), usage: { tokens: 1 } };
		}),
	};
});

const session = vi.hoisted(() => ({ role: 'owner' as 'owner' | 'editor' }));
vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<object>('../lib/sessionOrganization');
	const member = async () => ({
		userId: 'admin-1',
		role: session.role,
		activeOrganizationId: 'org-1',
	});
	const admin = async () => {
		if (session.role !== 'owner') throw new Error('forbidden');
		return member();
	};
	return {
		...actual,
		requireOrgPermission: vi.fn(admin),
		requireAdminContext: vi.fn(admin),
		requireOrgMember: vi.fn(member),
		// The knowledge edit paths (authedMutation's floor).
		getMutationContext: vi.fn(member),
		getBetterAuthSessionWithRole: vi.fn(member),
		isActiveOrgMember: vi.fn(async () => true),
	};
});

const embedCalls = vi.hoisted(() => ({ count: 0 }));

const modules = import.meta.glob('../**/*.*s');
type T = ReturnType<typeof convexTest>;

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
	session.role = 'owner';
	embedCalls.count = 0;
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

	it('refuses a non-admin before any provider call (F2)', async () => {
		const t = convexTest(schema, modules);
		await nomicDeployment(t);
		session.role = 'editor';
		await expect(
			t.action(api.aiRouting.embeddingRebuild.startRebuild, {
				embeddingProviderKind: 'local',
				embeddingModel: 'mxbai-embed-large',
			})
		).rejects.toThrow(/forbidden/);
		await expect(t.action(api.aiRouting.embeddingRebuild.validateStaged, {})).rejects.toThrow(
			/forbidden/
		);
		await expect(t.action(api.aiRouting.embeddingRebuild.activateStaged, {})).rejects.toThrow(
			/forbidden/
		);
		expect(embedCalls.count).toBe(0);
	});

	it('refuses a staged move between a hosted and a local embedder (F8)', async () => {
		const t = convexTest(schema, modules);
		await nomicDeployment(t);
		await t.run(async (ctx) => {
			const row = await ctx.db.query('aiProviderConfig').first();
			await ctx.db.patch(row!._id, { embeddingProviderKind: 'openai', embeddingModel: undefined });
		});
		await expect(
			t.action(api.aiRouting.embeddingRebuild.startRebuild, { embeddingProviderKind: 'local' })
		).rejects.toThrow(/to or from a hosted provider/);
		expect(embedCalls.count).toBe(0);
	});

	it('rolls back to the recorded predecessor, not the newest retired space (F7)', async () => {
		const t = convexTest(schema, modules);
		await nomicDeployment(t);
		const stageAndActivate = async (model: string) => {
			await t.action(api.aiRouting.embeddingRebuild.startRebuild, {
				embeddingProviderKind: 'local',
				embeddingModel: model,
			});
			await flush(t);
			await t.action(api.aiRouting.embeddingRebuild.activateStaged, {});
			await flush(t);
		};
		await stageAndActivate('mxbai-embed-large');
		await stageAndActivate('all-minilm');
		const byModel = async () =>
			Object.fromEntries(
				(await t.run((ctx) => ctx.db.query('embeddingSpaces').collect())).map((space) => [
					space.model,
					space,
				])
			);
		const spaces = await byModel();
		expect(spaces['all-minilm']!.predecessorSpaceId).toBe(spaces['mxbai-embed-large']!._id);

		// Stage and cancel a rebuild of the previously activated nomic space: it
		// is now the most recently retired space that was ever active.
		await t.action(api.aiRouting.embeddingRebuild.startRebuild, {
			embeddingProviderKind: 'local',
			embeddingModel: 'nomic-embed-text',
		});
		await t.mutation(api.aiRouting.embeddingRebuildState.cancelRebuild, {});
		await flush(t);

		// The predecessor is mxbai, not the most recently retired nomic. But that
		// staged nomic took mxbai's column, so mxbai's vectors there are no longer
		// all its own: no rollback is offered, and none runs.
		const status = await t.query(api.aiRouting.embeddingSpaces.status, {});
		expect(status.rollbackTo).toBeNull();
		await expect(t.mutation(api.aiRouting.embeddingRebuildState.rollback, {})).rejects.toThrow(
			/no previous embedding space/
		);
		expect((await byModel())['all-minilm']!.state).toBe('active');
	});

	it('rolls back to the predecessor while it still owns its column (F7)', async () => {
		const t = convexTest(schema, modules);
		await nomicDeployment(t);
		await t.action(api.aiRouting.embeddingRebuild.startRebuild, {
			embeddingProviderKind: 'local',
			embeddingModel: 'mxbai-embed-large',
		});
		await flush(t);
		await t.action(api.aiRouting.embeddingRebuild.activateStaged, {});
		await flush(t);
		const status = await t.query(api.aiRouting.embeddingSpaces.status, {});
		expect(status.rollbackTo?.model).toBe('nomic-embed-text');
		await t.mutation(api.aiRouting.embeddingRebuildState.rollback, {});
		expect((await states(t)).spaces['nomic-embed-text']).toBe('active/primary');
	});

	it('refuses activation while an entry added during the rebuild lacks the new vector (F6)', async () => {
		const t = convexTest(schema, modules);
		await nomicDeployment(t);
		await t.action(api.aiRouting.embeddingRebuild.startRebuild, {
			embeddingProviderKind: 'local',
			embeddingModel: 'mxbai-embed-large',
		});
		await flush(t);
		// A fact extracted after the walk passed: its commit marks the change.
		await t.mutation(internal.knowledge.graph.saveEntry, {
			entryType: 'fact',
			title: 'Late fact',
			content: 'Late fact',
			sourceType: 'manual',
			embedding: [],
			confidence: 0.9,
		});
		await expect(t.action(api.aiRouting.embeddingRebuild.activateStaged, {})).rejects.toThrow(
			/changed during the rebuild/
		);
		await t.mutation(api.aiRouting.embeddingRebuildState.catchUpRebuild, {});
		await flush(t);
		await t.action(api.aiRouting.embeddingRebuild.activateStaged, {});
		expect((await states(t)).spaces['mxbai-embed-large']).toBe('active/secondary');
		const late = (await t.run((ctx) => ctx.db.query('knowledgeEntries').collect())).find(
			(row) => row.title === 'Late fact'
		);
		expect(late?.secondaryEmbedding).toBeDefined();
	});

	it('a pending file that finishes processing after its page blocks activation (F6)', async () => {
		const t = convexTest(schema, modules);
		await nomicDeployment(t);
		const now = Date.now();
		// Pending (not yet processed) when the rebuild walks past it.
		const fileId = await t.run((ctx) =>
			ctx.db.insert('semanticFiles', {
				filename: 'plan.txt',
				mimeType: 'text/plain',
				fileSize: 5,
				sourceType: 'upload',
				version: 1,
				embedding: [],
				createdAt: now,
				updatedAt: now,
			})
		);
		await t.action(api.aiRouting.embeddingRebuild.startRebuild, {
			embeddingProviderKind: 'local',
			embeddingModel: 'mxbai-embed-large',
		});
		await flush(t);
		// Processing finishes now, with a vector in the active (nomic) space only.
		await t.mutation(internal.semanticFiles.updateProcessedMetadata, {
			fileId,
			title: 'Plan',
			extractedText: 'The quarterly plan, in full.',
			embedding: vectorFor('nomic-embed-text', 'x', 1536),
			embeddingSpace: { ...TEST_LOCAL_SPACE, dimensions: DIMS, source: 'stored_config' },
		});
		await expect(t.action(api.aiRouting.embeddingRebuild.activateStaged, {})).rejects.toThrow(
			/changed during the rebuild/
		);
		await t.mutation(api.aiRouting.embeddingRebuildState.catchUpRebuild, {});
		await flush(t);
		await t.action(api.aiRouting.embeddingRebuild.activateStaged, {});
		const file = await t.run((ctx) => ctx.db.get(fileId));
		expect(file?.secondaryEmbedding).toBeDefined();
	});

	it('a content change clears the other column, so no stale vector is reused (F14)', async () => {
		const t = convexTest(schema, modules);
		await nomicDeployment(t);
		const now = Date.now();
		const fileId = await t.run((ctx) =>
			ctx.db.insert('semanticFiles', {
				filename: 'plan.txt',
				mimeType: 'text/plain',
				fileSize: 5,
				sourceType: 'upload',
				version: 1,
				title: 'Plan',
				extractedText: 'Version one of the plan.',
				embedding: [],
				createdAt: now,
				updatedAt: now,
			})
		);
		await t.action(api.aiRouting.embeddingRebuild.startRebuild, {
			embeddingProviderKind: 'local',
			embeddingModel: 'mxbai-embed-large',
		});
		await flush(t);
		expect((await t.run((ctx) => ctx.db.get(fileId)))?.secondaryEmbedding).toBeDefined();
		// Reprocessed with new content: the active column gets the new vector, and
		// the staged column's vector of the old content is cleared.
		await t.mutation(internal.semanticFiles.updateProcessedMetadata, {
			fileId,
			extractedText: 'Version two, rewritten.',
			embedding: vectorFor('nomic-embed-text', 'v2', 1536),
			embeddingSpace: { ...TEST_LOCAL_SPACE, dimensions: DIMS, source: 'stored_config' },
		});
		const file = await t.run((ctx) => ctx.db.get(fileId));
		expect(file?.embeddingSpaceId).toBeDefined();
		expect(file?.secondaryEmbedding).toBeUndefined();
		expect(file?.secondaryEmbeddingSpaceId).toBeUndefined();
	});

	it.each(['updateEntry', 'createPolicyEntry'] as const)(
		'an expired entry revived through %s after the walk blocks activation (F6)',
		async (path) => {
			const t = convexTest(schema, modules);
			await enableFeatures(t, ['ai.knowledge']);
			await nomicDeployment(t);
			const now = Date.now();
			// Expired while the rebuild walks: not eligible, so not embedded.
			const entryId = await t.run((ctx) =>
				ctx.db.insert('knowledgeEntries', {
					entryType: 'faq',
					title: 'Opening hours',
					content: 'We open at nine.',
					sourceType: 'curated',
					isAuthoritative: true,
					embedding: [],
					confidence: 1,
					expiresAt: now - 1_000,
					lastValidatedAt: now,
					searchableText: 'Opening hours We open at nine.',
					createdAt: now,
					updatedAt: now,
				})
			);
			await t.action(api.aiRouting.embeddingRebuild.startRebuild, {
				embeddingProviderKind: 'local',
				embeddingModel: 'mxbai-embed-large',
			});
			await flush(t);
			expect((await t.run((ctx) => ctx.db.get(entryId)))?.secondaryEmbedding).toBeUndefined();

			// An expiry-only edit makes it live again.
			const later = Date.now() + 86_400_000;
			if (path === 'updateEntry') {
				await t.mutation(api.knowledge.graph.updateEntry, { entryId, expiresAt: later });
			} else {
				await t.mutation(api.knowledge.graph.createPolicyEntry, {
					entryId,
					entryType: 'faq',
					title: 'Opening hours',
					content: 'We open at nine.',
					expiresAt: later,
				});
			}
			await expect(t.action(api.aiRouting.embeddingRebuild.activateStaged, {})).rejects.toThrow(
				/changed during the rebuild/
			);
			await t.mutation(api.aiRouting.embeddingRebuildState.catchUpRebuild, {});
			await flush(t);
			await t.action(api.aiRouting.embeddingRebuild.activateStaged, {});
			expect((await t.run((ctx) => ctx.db.get(entryId)))?.secondaryEmbedding).toBeDefined();
		}
	);
});

describe('a confirmation names its space (expectedSpaceId)', () => {
	/** The rejection's payload: `conflict` with the stable reason, or a failure. */
	async function targetChanged(call: Promise<unknown>) {
		const error = await call.then(
			() => null,
			(caught: unknown) => caught
		);
		expect(error).toBeInstanceOf(ConvexError);
		expect((error as ConvexError<Value>).data).toMatchObject({
			category: 'conflict',
			data: { reason: EMBEDDING_TARGET_CHANGED },
		});
	}

	/** Admin 1 confirms staged A; admin 2 cancels it and stages B meanwhile. */
	async function replacedStaging(t: T) {
		await nomicDeployment(t);
		const stage = async (model: string) => {
			const id = await t.action(api.aiRouting.embeddingRebuild.startRebuild, {
				embeddingProviderKind: 'local',
				embeddingModel: model,
			});
			await flush(t);
			return id;
		};
		const confirmed = await stage('mxbai-embed-large');
		await t.mutation(api.aiRouting.embeddingRebuildState.cancelRebuild, {});
		const current = await stage('all-minilm');
		return { confirmed, current };
	}

	it('refuses validate, activate, catch-up and cancel on a replaced staged space', async () => {
		const t = convexTest(schema, modules);
		const { confirmed, current } = await replacedStaging(t);
		const before = await states(t);
		const calls = embedCalls.count;
		const expected = { expectedSpaceId: confirmed };

		await targetChanged(t.action(api.aiRouting.embeddingRebuild.validateStaged, expected));
		await targetChanged(t.action(api.aiRouting.embeddingRebuild.activateStaged, expected));
		await targetChanged(t.mutation(api.aiRouting.embeddingRebuildState.catchUpRebuild, expected));
		await targetChanged(t.mutation(api.aiRouting.embeddingRebuildState.cancelRebuild, expected));
		// Nothing embedded, staged, activated or cancelled.
		expect(embedCalls.count).toBe(calls);
		expect(await states(t)).toEqual(before);

		// The space actually staged is accepted.
		const validation = await t.action(api.aiRouting.embeddingRebuild.validateStaged, {
			expectedSpaceId: current,
		});
		expect(validation.spaceId).toBe(current);
		await t.mutation(api.aiRouting.embeddingRebuildState.cancelRebuild, {
			expectedSpaceId: current,
		});
		expect((await states(t)).spaces['all-minilm']).toBe('retired/secondary');
	});

	it('refuses a cancel whose staged space is already gone', async () => {
		const t = convexTest(schema, modules);
		const { current } = await replacedStaging(t);
		await t.mutation(api.aiRouting.embeddingRebuildState.cancelRebuild, {});
		await targetChanged(
			t.mutation(api.aiRouting.embeddingRebuildState.cancelRebuild, { expectedSpaceId: current })
		);
	});

	it('refuses a rollback to another space than the one confirmed', async () => {
		const t = convexTest(schema, modules);
		const nomic = await nomicDeployment(t);
		const mxbai = await t.action(api.aiRouting.embeddingRebuild.startRebuild, {
			embeddingProviderKind: 'local',
			embeddingModel: 'mxbai-embed-large',
		});
		await flush(t);
		await t.action(api.aiRouting.embeddingRebuild.activateStaged, { expectedSpaceId: mxbai });
		await flush(t);
		const before = await states(t);
		await targetChanged(
			t.mutation(api.aiRouting.embeddingRebuildState.rollback, { expectedSpaceId: mxbai })
		);
		expect(await states(t)).toEqual(before);
		await t.mutation(api.aiRouting.embeddingRebuildState.rollback, { expectedSpaceId: nomic });
		expect((await states(t)).spaces['nomic-embed-text']).toBe('active/primary');
	});

	it('refuses an activation whose staged space changed after its validation', async () => {
		const t = convexTest(schema, modules);
		const { confirmed } = await replacedStaging(t);
		// The race inside activateStaged: validated A, but B is staged when it commits.
		await targetChanged(
			t.mutation(internal.aiRouting.embeddingRebuildState.activateStagedSpace, {
				spaceId: confirmed,
				sampled: 3,
				passed: 3,
			})
		);
		expect((await states(t)).spaces['all-minilm']).toBe('staged/secondary');
	});

	it('refuses a re-embed before its bootstrap call when nothing confirmed is searchable', async () => {
		const t = convexTest(schema, modules);
		await configureLocalEmbedder(t);
		const confirmed = await seedEmbeddingSpace(t, {
			identity: { ...TEST_LOCAL_SPACE, model: 'all-minilm', dimensions: DIMS },
			state: 'retired',
		});
		const calls = embedCalls.count;
		await targetChanged(
			t.action(api.aiRouting.embeddingReembed.startReembed, { expectedSpaceId: confirmed })
		);
		// No provider call measured and activated the configured space.
		expect(embedCalls.count).toBe(calls);
		expect((await states(t)).spaces).toEqual({ 'all-minilm': 'retired/primary' });
	});

	it('refuses a re-embed into another space than the searchable one', async () => {
		const t = convexTest(schema, modules);
		const nomic = await nomicDeployment(t);
		const other = await seedEmbeddingSpace(t, {
			identity: { ...TEST_LOCAL_SPACE, model: 'all-minilm', dimensions: DIMS },
			state: 'retired',
			slot: 'secondary',
		});
		await targetChanged(
			t.action(api.aiRouting.embeddingReembed.startReembed, { expectedSpaceId: other })
		);
		expect(await t.run((ctx) => ctx.db.query('embeddingReembedJobs').collect())).toEqual([]);
		const jobId = await t.action(api.aiRouting.embeddingReembed.startReembed, {
			expectedSpaceId: nomic,
		});
		expect((await t.run((ctx) => ctx.db.get(jobId)))?.targetSpaceId).toBe(nomic);
	});
});
