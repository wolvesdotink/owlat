/**
 * The re-embed job (ADR-0073, Phase 1a and D8; #1334): a local embedder brings
 * unknown, inactive and unembedded rows back into the active space on its own;
 * the job is bounded and resumes from its cursor; a switch ends it; a hosted
 * (paid) re-embed is refused while spend admission is absent.
 *
 * `embed` is mocked to a deterministic vector per (model, text); the local
 * server answers no revision probe. Scheduled work runs only when a test
 * flushes it.
 */
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Ai from 'ai';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import {
	configureLocalEmbedder,
	measuredLocalSpace,
	seedEmbeddingSpace,
	stampedIn,
	TEST_LOCAL_SPACE,
} from './helpers/embeddingSpaces';

const DIMS = 64;
const embedCalls = vi.hoisted(() => ({ texts: [] as string[] }));

vi.mock('ai', async () => {
	const actual = await vi.importActual<typeof Ai>('ai');
	return {
		...actual,
		embed: vi.fn(async ({ model, value }: { model: { modelId: string }; value: string }) => {
			embedCalls.texts.push(value);
			const vector = Array.from({ length: 64 }, () => 0);
			let hash = 0;
			for (const char of `${model.modelId}|${value}`) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
			vector[hash % 64] = 1;
			return { embedding: vector, usage: { tokens: 1 } };
		}),
	};
});

const session = vi.hoisted(() => ({ role: 'owner' as 'owner' | 'editor' }));
vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<object>('../lib/sessionOrganization');
	const current = async () => {
		if (session.role !== 'owner') throw new Error('forbidden');
		return { userId: 'admin-1', role: session.role, activeOrganizationId: 'org-1' };
	};
	return { ...actual, requireOrgPermission: vi.fn(current), requireAdminContext: vi.fn(current) };
});

const modules = import.meta.glob('../**/*.*s');
type T = ReturnType<typeof convexTest>;

/** The active space a local nomic job measures (64-wide vectors, no digest). */
const NOMIC = { ...TEST_LOCAL_SPACE, dimensions: DIMS };

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
	embedCalls.texts = [];
	session.role = 'owner';
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
const padded = (at: number) => Array.from({ length: 1536 }, (_, i) => (i === at ? 1 : 0));

async function insertEntry(
	t: T,
	title: string,
	fields: Partial<Doc<'knowledgeEntries'>> = {}
): Promise<Id<'knowledgeEntries'>> {
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

const jobs = (t: T) => t.run((ctx) => ctx.db.query('embeddingReembedJobs').collect());

describe('local re-embed', () => {
	it('brings unknown, inactive and unembedded rows into the active space, once each', async () => {
		const t = convexTest(schema, modules);
		await configureLocalEmbedder(t);
		const active = await seedEmbeddingSpace(t, { identity: NOMIC });
		const retired = await seedEmbeddingSpace(t, {
			state: 'retired',
			identity: { ...NOMIC, model: 'all-minilm' },
		});
		const legacy = await insertEntry(t, 'legacy', {
			embedding: padded(3),
			embeddingGeneratedAt: 1,
		});
		const inactive = await insertEntry(t, 'inactive', {
			embedding: padded(4),
			...stampedIn(retired, 'fact'),
		});
		const manual = await insertEntry(t, 'manual');
		const current = await insertEntry(t, 'current', {
			embedding: padded(5),
			...stampedIn(active, 'fact'),
		});
		const expired = await insertEntry(t, 'expired', { expiresAt: Date.now() - 1 });
		const file = await insertFile(t, 'notes.txt', {
			title: 'Notes',
			extractedText: 'The quarterly plan, in full.',
			embedding: padded(6),
			embeddingGeneratedAt: 1,
		});
		const pending = await insertFile(t, 'pending.txt');

		await t.action(internal.aiRouting.embeddingReembed.kickoff, { isForced: true });
		await flush(t);

		const [job] = await jobs(t);
		expect(job).toMatchObject({
			kind: 'reembed',
			status: 'completed',
			isPaid: false,
			targetSpaceId: active,
			embeddedCount: 4,
		});
		const rows = await t.run(async (ctx) => ({
			legacy: await ctx.db.get(legacy),
			inactive: await ctx.db.get(inactive),
			manual: await ctx.db.get(manual),
			current: await ctx.db.get(current),
			expired: await ctx.db.get(expired),
			file: await ctx.db.get(file),
			pending: await ctx.db.get(pending),
		}));
		for (const row of [rows.legacy, rows.inactive, rows.manual, rows.file]) {
			expect(row).toMatchObject({
				embeddingSpaceId: active,
				embeddingProvenance: 'measured',
				embeddingModel: 'nomic-embed-text',
			});
			expect(row!.embedding).toHaveLength(1536);
		}
		expect(rows.legacy!.embeddingSpaceEntryKey).toBe(`${active}:fact`);
		// The row already in the active space, an expired entry and an unprocessed
		// file are left alone.
		expect(rows.current!.embedding).toEqual(padded(5));
		expect(rows.expired!.embeddingSpaceId).toBeUndefined();
		expect(rows.pending!.embeddingSpaceId).toBeUndefined();
		// One probe, then each candidate exactly once.
		expect(embedCalls.texts).toHaveLength(5);

		// The finished job leaves a coverage count on the space.
		const space = await t.run((ctx) => ctx.db.get(active));
		expect(space?.coverage?.knowledgeEntries).toMatchObject({ active: 4, unembedded: 1 });
		expect(space?.coverage?.semanticFiles).toMatchObject({ active: 1, unembedded: 1 });
	});

	it('registers and activates the configured space when none is active', async () => {
		const t = convexTest(schema, modules);
		await configureLocalEmbedder(t);
		await insertEntry(t, 'legacy', { embedding: padded(3), embeddingGeneratedAt: 1 });

		await t.action(internal.aiRouting.embeddingReembed.kickoff, { isForced: true });
		await flush(t);

		const spaces = await t.run((ctx) => ctx.db.query('embeddingSpaces').collect());
		expect(spaces).toHaveLength(1);
		expect(spaces[0]).toMatchObject({ ...NOMIC, state: 'active', slot: 'primary' });
		expect(spaces[0]!.revision).toBeUndefined();
	});

	it('resumes a stalled job from its cursor, embedding no row twice', async () => {
		const t = convexTest(schema, modules);
		await configureLocalEmbedder(t);
		const active = await seedEmbeddingSpace(t, { identity: NOMIC });
		for (let i = 0; i < 40; i++) {
			await insertEntry(t, `legacy ${i}`, { embedding: padded(i), embeddingGeneratedAt: 1 });
		}
		const outcome = await t.mutation(internal.aiRouting.embeddingReembedJobs.startLocalReembed, {
			spaceId: active,
			isForced: true,
		});
		expect(outcome).toBe('started');
		const [started] = await jobs(t);

		// One batch runs, then the worker dies: nothing advances the job.
		await t.action(internal.aiRouting.embeddingReembed.runBatch, {
			jobId: started!._id,
			generation: 1,
		});
		const midway = (await jobs(t))[0]!;
		expect(midway.embeddedCount).toBe(32);
		expect(midway.cursor).toBeDefined();
		await t.run((ctx) => ctx.db.patch(midway._id, { updatedAt: Date.now() - 60 * 60_000 }));

		// The kickoff sweep resumes it under a new generation; the old chain stops.
		expect(
			await t.mutation(internal.aiRouting.embeddingReembedJobs.startLocalReembed, {
				spaceId: active,
				isForced: false,
			})
		).toBe('resumed');
		await flush(t);

		const done = (await jobs(t))[0]!;
		expect(done).toMatchObject({ status: 'completed', generation: 2, embeddedCount: 40 });
		expect(new Set(embedCalls.texts).size).toBe(40);
		expect(embedCalls.texts).toHaveLength(40);
	});

	it('ends when the configuration switches to another space', async () => {
		const t = convexTest(schema, modules);
		await configureLocalEmbedder(t);
		const active = await seedEmbeddingSpace(t, { identity: NOMIC });
		await insertEntry(t, 'legacy', { embedding: padded(3), embeddingGeneratedAt: 1 });
		await t.mutation(internal.aiRouting.embeddingReembedJobs.startLocalReembed, {
			spaceId: active,
			isForced: true,
		});

		await configureLocalEmbedder(t, 'mxbai-embed-large');
		await t.mutation(internal.knowledge.graph.saveEntry, {
			entryType: 'fact',
			title: 'new',
			content: 'new',
			sourceType: 'manual',
			embedding: padded(9),
			embeddingSpace: { ...measuredLocalSpace(DIMS), model: 'mxbai-embed-large' },
			confidence: 0.9,
		});

		const [job] = await jobs(t);
		expect(job).toMatchObject({ status: 'cancelled', pausedReason: 'space_changed' });
		expect((await t.run((ctx) => ctx.db.get(active)))?.state).toBe('retired');
	});

	it('runs nothing by default without an AI configuration', async () => {
		const t = convexTest(schema, modules);
		await insertEntry(t, 'legacy', { embedding: padded(3), embeddingGeneratedAt: 1 });
		await t.action(internal.aiRouting.embeddingReembed.kickoff, { isForced: true });
		await flush(t);
		expect(await jobs(t)).toEqual([]);
		expect(embedCalls.texts).toEqual([]);
	});
});

describe('paid re-embed (hosted embedder)', () => {
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

	it('is refused while spend admission is absent', async () => {
		const t = convexTest(schema, modules);
		await configureOpenAi(t);
		await seedEmbeddingSpace(t, { identity: OPENAI });
		await expect(t.mutation(api.aiRouting.embeddingReembedJobs.startReembed, {})).rejects.toThrow(
			/spend admission/
		);
		expect(await jobs(t)).toEqual([]);
	});

	it('is never started by the kickoff', async () => {
		const t = convexTest(schema, modules);
		await configureOpenAi(t);
		await seedEmbeddingSpace(t, { identity: OPENAI });
		await insertEntry(t, 'legacy', { embedding: padded(3), embeddingGeneratedAt: 1 });
		await t.action(internal.aiRouting.embeddingReembed.kickoff, { isForced: true });
		await flush(t);
		expect(await jobs(t)).toEqual([]);
		expect(embedCalls.texts).toEqual([]);
	});

	it('pauses a running paid job for budget before any call', async () => {
		const t = convexTest(schema, modules);
		await configureOpenAi(t);
		const active = await seedEmbeddingSpace(t, { identity: OPENAI });
		await insertEntry(t, 'legacy', { embedding: padded(3), embeddingGeneratedAt: 1 });
		const jobId = await t.run((ctx) =>
			ctx.db.insert('embeddingReembedJobs', {
				kind: 'reembed',
				targetSpaceId: active,
				status: 'running',
				isPaid: true,
				generation: 1,
				phase: 'knowledgeEntries',
				scannedCount: 0,
				embeddedCount: 0,
				skippedCount: 0,
				failedCount: 0,
				startedAt: Date.now(),
				updatedAt: Date.now(),
			})
		);
		await t.action(internal.aiRouting.embeddingReembed.runBatch, { jobId, generation: 1 });
		expect(await t.run((ctx) => ctx.db.get(jobId))).toMatchObject({
			status: 'paused',
			pausedReason: 'budget',
		});
		expect(embedCalls.texts).toEqual([]);
	});

	it('refuses a non-admin', async () => {
		const t = convexTest(schema, modules);
		session.role = 'editor';
		await expect(t.mutation(api.aiRouting.embeddingReembedJobs.startReembed, {})).rejects.toThrow(
			/forbidden/
		);
	});
});
