/**
 * The re-embed job (#1334): a local embedder brings
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
/** Texts whose embedding call fails (a provider error); `count` per text. */
const embedFailures = vi.hoisted(() => ({
	texts: [] as string[],
	remaining: new Map<string, number>(),
}));

vi.mock('ai', async () => {
	const actual = await vi.importActual<typeof Ai>('ai');
	return {
		...actual,
		embed: vi.fn(async ({ model, value }: { model: { modelId: string }; value: string }) => {
			const left = embedFailures.remaining.get(value) ?? 0;
			if (left > 0) {
				embedFailures.remaining.set(value, left - 1);
				embedFailures.texts.push(value);
				throw Object.assign(new Error('provider error'), { statusCode: 400 }); // not retried by the ledger's policy
			}
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
	const member = async () => ({
		userId: 'admin-1',
		role: session.role,
		activeOrganizationId: 'org-1',
	});
	return {
		...actual,
		requireOrgPermission: vi.fn(current),
		requireAdminContext: vi.fn(current),
		// Any member passes the action floor; the admin floor is checked inside.
		requireOrgMember: vi.fn(member),
	};
});

const modules = import.meta.glob('../**/*.*s');
type T = ReturnType<typeof convexTest>;

/** The active space a local nomic job measures (64-wide vectors, no digest). */
const NOMIC = { ...TEST_LOCAL_SPACE, dimensions: DIMS };

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
	embedCalls.texts = [];
	embedFailures.texts = [];
	embedFailures.remaining.clear();
	session.role = 'owner';
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
			slot: 'secondary',
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
		expect(embedFailures.texts).toEqual([]);

		// The finished job leaves a coverage count against the searchable space.
		const coverage = await t.run((ctx) => ctx.db.query('embeddingCoverage').first());
		expect(coverage?.searchableSpaceId).toBe(active);
		expect(coverage?.knowledgeEntries).toMatchObject({ active: 4, unembedded: 1 });
		expect(coverage?.semanticFiles).toMatchObject({ active: 1, unembedded: 1 });
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

	it('retries a page whose calls failed, and completes only when every row landed (F6)', async () => {
		const t = convexTest(schema, modules);
		await configureLocalEmbedder(t);
		const active = await seedEmbeddingSpace(t, { identity: NOMIC });
		await insertEntry(t, 'steady', { embedding: padded(3), embeddingGeneratedAt: 1 });
		const flaky = await insertEntry(t, 'flaky', { embedding: padded(4), embeddingGeneratedAt: 1 });
		embedFailures.remaining.set('flaky: flaky content', 1);
		await t.mutation(internal.aiRouting.embeddingReembedJobs.startLocalReembed, {
			spaceId: active,
			isForced: true,
		});
		await flush(t);
		const [job] = await jobs(t);
		expect(job).toMatchObject({ status: 'completed', embeddedCount: 2, failedCount: 1 });
		expect((await t.run((ctx) => ctx.db.get(flaky)))?.embeddingSpaceId).toBe(active);
	});

	it('pauses when a page keeps failing, keeping its cursor for a resume (F6)', async () => {
		const t = convexTest(schema, modules);
		await configureLocalEmbedder(t);
		const active = await seedEmbeddingSpace(t, { identity: NOMIC });
		const broken = await insertEntry(t, 'broken', {
			embedding: padded(4),
			embeddingGeneratedAt: 1,
		});
		embedFailures.remaining.set('broken: broken content', 99);
		await t.mutation(internal.aiRouting.embeddingReembedJobs.startLocalReembed, {
			spaceId: active,
			isForced: true,
		});
		await flush(t);
		const [job] = await jobs(t);
		expect(job).toMatchObject({
			status: 'paused',
			pausedReason: 'provider_unavailable',
			phase: 'knowledgeEntries',
		});
		expect(job!.cursor).toBeUndefined();
		expect(embedFailures.texts).toHaveLength(3);
		expect((await t.run((ctx) => ctx.db.get(broken)))?.embeddingSpaceId).toBeUndefined();

		// The provider recovers: the kickoff's resume finishes the job.
		embedFailures.remaining.clear();
		expect(
			await t.mutation(internal.aiRouting.embeddingReembedJobs.startLocalReembed, {
				spaceId: active,
				isForced: false,
			})
		).toBe('resumed');
		await flush(t);
		expect((await jobs(t))[0]).toMatchObject({ status: 'completed' });
		expect((await t.run((ctx) => ctx.db.get(broken)))?.embeddingSpaceId).toBe(active);
	});

	it('a settings save ends the jobs of the old space at once (F5)', async () => {
		const t = convexTest(schema, modules);
		await configureLocalEmbedder(t);
		const active = await seedEmbeddingSpace(t, { identity: NOMIC });
		await insertEntry(t, 'legacy', { embedding: padded(3), embeddingGeneratedAt: 1 });
		await t.mutation(internal.aiRouting.embeddingReembedJobs.startLocalReembed, {
			spaceId: active,
			isForced: true,
		});
		const row = await t.run((ctx) => ctx.db.query('aiProviderConfig').first());
		await t.mutation(internal.aiProviderConfig._persistConfig, {
			languageProviderKind: row!.languageProviderKind,
			languageBaseUrl: row!.languageBaseUrl,
			modelFast: row!.modelFast,
			modelCapable: row!.modelCapable,
			isLanguageLocal: true,
			embeddingProviderKind: 'local',
			embeddingModel: 'mxbai-embed-large',
		});
		const [job] = await jobs(t);
		expect(job).toMatchObject({ status: 'cancelled', pausedReason: 'space_changed' });
		// A batch the old generation scheduled writes nothing.
		await t.action(internal.aiRouting.embeddingReembed.runBatch, {
			jobId: job!._id,
			generation: 1,
		});
		const rows = await t.run((ctx) => ctx.db.query('knowledgeEntries').collect());
		expect(rows.every((r) => r.embeddingSpaceId === undefined)).toBe(true);
	});

	it('reactivating a space that still owns its column reuses its vectors (F4)', async () => {
		const t = convexTest(schema, modules);
		await configureLocalEmbedder(t); // names nomic: A
		const a = await seedEmbeddingSpace(t, { identity: NOMIC, state: 'retired', slot: 'primary' });
		const c = await seedEmbeddingSpace(t, {
			identity: { ...NOMIC, model: 'all-minilm' },
			state: 'active',
			slot: 'secondary',
		});
		const aRow = await insertEntry(t, 'a row', { embedding: padded(3), ...stampedIn(a, 'fact') });

		await t.mutation(internal.aiRouting.embeddingSpaces.ensureConfigured, {
			space: measuredLocalSpace(DIMS),
		});
		await flush(t);

		const spaces = await t.run(async (ctx) => ({ a: await ctx.db.get(a), c: await ctx.db.get(c) }));
		expect(spaces.a).toMatchObject({ state: 'active', slot: 'primary', predecessorSpaceId: c });
		expect((await t.run((ctx) => ctx.db.get(aRow)))?.embedding).toEqual(padded(3));
		expect(embedCalls.texts).not.toContain('a row: a row content');
	});

	it('a space that lost its column is superseded and re-embedded, never copied (F4)', async () => {
		const t = convexTest(schema, modules);
		await configureLocalEmbedder(t); // names nomic: A
		const a = await seedEmbeddingSpace(t, { identity: NOMIC, state: 'retired', slot: 'primary' });
		const aRow = await insertEntry(t, 'a row', { embedding: padded(3), ...stampedIn(a, 'fact') });
		// C took the primary column after A (a higher claim), and is active there.
		const c = await seedEmbeddingSpace(t, {
			identity: { ...NOMIC, model: 'all-minilm' },
			state: 'active',
			slot: 'primary',
		});
		const cRow = await insertEntry(t, 'c row', { embedding: padded(4), ...stampedIn(c, 'fact') });

		await t.mutation(internal.aiRouting.embeddingSpaces.ensureConfigured, {
			space: measuredLocalSpace(DIMS),
		});
		await flush(t);

		const spaces = await t.run((ctx) => ctx.db.query('embeddingSpaces').collect());
		const fresh = spaces.find((space) => space.model === NOMIC.model && space.state === 'active')!;
		expect(fresh._id).not.toBe(a);
		expect(fresh.slot).toBe('secondary');
		expect(spaces.find((space) => space._id === a)?.identityKey).toContain('#superseded:');
		const rows = await t.run(async (ctx) => ({
			a: await ctx.db.get(aRow),
			c: await ctx.db.get(cRow),
		}));
		// C's column is untouched; A's row was re-embedded into the fresh space.
		expect(rows.c).toMatchObject({ embeddingSpaceId: c, embedding: padded(4) });
		expect(rows.a?.secondaryEmbeddingSpaceId).toBe(fresh._id);
		expect(embedCalls.texts).toContain('a row: a row content');
	});

	it('a space that lost its column to a third one is superseded, not reused (F4)', async () => {
		const t = convexTest(schema, modules);
		await configureLocalEmbedder(t); // names nomic: A
		const a = await seedEmbeddingSpace(t, { identity: NOMIC, state: 'retired', slot: 'primary' });
		const aRow = await insertEntry(t, 'a row', { embedding: padded(3), ...stampedIn(a, 'fact') });
		// B wrote the primary column after A, then retired; C is active in the other one.
		await seedEmbeddingSpace(t, {
			identity: { ...NOMIC, model: 'mxbai-embed-large' },
			state: 'retired',
			slot: 'primary',
		});
		await seedEmbeddingSpace(t, {
			identity: { ...NOMIC, model: 'all-minilm' },
			state: 'active',
			slot: 'secondary',
		});

		await t.mutation(internal.aiRouting.embeddingSpaces.ensureConfigured, {
			space: measuredLocalSpace(DIMS),
		});
		await flush(t);

		const fresh = (await t.run((ctx) => ctx.db.query('embeddingSpaces').collect())).find(
			(space) => space.model === NOMIC.model && space.state === 'active'
		)!;
		expect(fresh._id).not.toBe(a);
		expect(fresh.slot).toBe('primary');
		// A's leftover vector was not trusted: the row was re-embedded.
		expect((await t.run((ctx) => ctx.db.get(aRow)))?.embeddingSpaceId).toBe(fresh._id);
		expect(embedCalls.texts).toContain('a row: a row content');
	});

	it('recovers an env Ollama deployment on its own, and re-embeds an edit (F16)', async () => {
		const t = convexTest(schema, modules);
		// No stored row: the env plane, pointed at the compose Ollama service.
		vi.stubEnv('LLM_PROVIDER', 'ollama');
		const legacy = await insertEntry(t, 'legacy', {
			embedding: padded(3),
			embeddingGeneratedAt: 1,
		});

		await t.action(internal.aiRouting.embeddingReembed.kickoff, { isForced: true });
		await flush(t);

		const [space] = await t.run((ctx) => ctx.db.query('embeddingSpaces').collect());
		expect(space).toMatchObject({ provider: 'openai', source: 'env', state: 'active' });
		expect(space!.endpoint.startsWith('http://ollama:11434/~')).toBe(true);
		const [job] = await jobs(t);
		expect(job).toMatchObject({ status: 'completed', isPaid: false, embeddedCount: 1 });
		expect((await t.run((ctx) => ctx.db.get(legacy)))?.embeddingSpaceId).toBe(space!._id);

		// An edit clears the row's vectors; the local re-embed restores it at once.
		const edited = await insertEntry(t, 'edited');
		await t.action(internal.aiRouting.embeddingReembed.reembedRow, {
			table: 'knowledgeEntries',
			id: edited,
		});
		expect((await t.run((ctx) => ctx.db.get(edited)))?.embeddingSpaceId).toBe(space!._id);
	});

	/**
	 * The OpenAI adapter pointed at a local Ollama (`LLM_PROVIDER=openai`): local
	 * by its URL, so probed for its revision whatever LLM_PROVIDER says. The
	 * served digest is whatever `served.digest` holds when a probe arrives.
	 */
	function serveEnvOllamaBehindOpenAi() {
		vi.stubEnv('LLM_PROVIDER', 'openai');
		vi.stubEnv('LLM_API_KEY', 'unused-by-ollama');
		vi.stubEnv('LLM_BASE_URL', 'http://localhost:11434/v1');
		vi.stubEnv('LLM_EMBEDDING_MODEL', 'nomic-embed-text');
		const served = { digest: 'a'.repeat(64) };
		const probes: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) => {
				probes.push(String(url));
				const models = [{ name: 'nomic-embed-text:latest', digest: served.digest, details: {} }];
				return new Response(JSON.stringify({ models }), { status: 200 });
			})
		);
		return { served, probes };
	}

	it('splits an env Ollama behind LLM_PROVIDER=openai by its served digest (F20)', async () => {
		const t = convexTest(schema, modules);
		const { served, probes } = serveEnvOllamaBehindOpenAi();
		const legacy = await insertEntry(t, 'legacy');

		await t.action(internal.aiRouting.embeddingReembed.kickoff, { isForced: true });
		await flush(t);
		expect(probes.length).toBeGreaterThan(0);
		expect(probes.every((url) => url === 'http://localhost:11434/api/tags')).toBe(true);
		const [first] = await t.run((ctx) => ctx.db.query('embeddingSpaces').collect());
		expect(first).toMatchObject({ source: 'env', state: 'active', revision: served.digest });
		expect((await t.run((ctx) => ctx.db.get(legacy)))?.embeddingSpaceId).toBe(first!._id);

		// `ollama pull` swaps the weights under the same name.
		served.digest = 'b'.repeat(64);
		const edited = await insertEntry(t, 'edited');
		await t.action(internal.aiRouting.embeddingReembed.reembedRow, {
			table: 'knowledgeEntries',
			id: edited,
		});
		const spaces = await t.run((ctx) => ctx.db.query('embeddingSpaces').collect());
		const second = spaces.find((space) => space.revision === served.digest)!;
		expect(second._id).not.toBe(first!._id);
		expect(second.identityKey).not.toBe(first!.identityKey);
		expect(second.state).toBe('active');
		expect(spaces.find((space) => space._id === first!._id)?.state).toBe('retired');
		// The new space takes the other column; the old digest's vector is not
		// its own, so the row is out of its search until the re-embed the
		// activation scheduled embeds it there.
		expect(second.slot).not.toBe(first!.slot);
		const spacesOf = async (id: Id<'knowledgeEntries'>) => {
			const row = (await t.run((ctx) => ctx.db.get(id)))!;
			return [row.embeddingSpaceId, row.secondaryEmbeddingSpaceId];
		};
		expect(await spacesOf(legacy)).toEqual([first!._id, undefined]);
		expect(await spacesOf(edited)).toContain(second._id);
		await flush(t);
		expect(await spacesOf(legacy)).toContain(second._id);
		expect(embedCalls.texts.filter((text) => text === 'legacy: legacy content')).toHaveLength(2);
	});

	it('moves the local re-embed to the new digest once a job measures it (F20)', async () => {
		const t = convexTest(schema, modules);
		const { served } = serveEnvOllamaBehindOpenAi();
		const legacy = await insertEntry(t, 'legacy');
		await t.action(internal.aiRouting.embeddingReembed.kickoff, { isForced: true });
		await flush(t);
		const [first] = await t.run((ctx) => ctx.db.query('embeddingSpaces').collect());

		// Only the job notices the new digest: an unembedded row, then a forced pass.
		served.digest = 'b'.repeat(64);
		const added = await insertEntry(t, 'added');
		await t.action(internal.aiRouting.embeddingReembed.kickoff, { isForced: true });
		await flush(t);

		const spaces = await t.run((ctx) => ctx.db.query('embeddingSpaces').collect());
		const second = spaces.find((space) => space.revision === served.digest)!;
		expect(second).toMatchObject({ state: 'active' });
		expect(second._id).not.toBe(first!._id);
		for (const id of [legacy, added]) {
			const row = (await t.run((ctx) => ctx.db.get(id)))!;
			expect([row.embeddingSpaceId, row.secondaryEmbeddingSpaceId]).toContain(second._id);
		}
		// The old space's job ended once (its page measured the new digest), and the
		// kickoff it scheduled measured and activated the new space: no job loops.
		const ended = (await jobs(t)).filter((job) => job.targetSpaceId === first!._id);
		expect(ended.filter((job) => job.status === 'cancelled').length).toBeLessThanOrEqual(1);
		expect(
			embedCalls.texts.filter((text) => text === 'added: added content').length
		).toBeLessThanOrEqual(2);
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

	it('starts a paid job once spend admission exists; its batches are admitted one by one', async () => {
		const t = convexTest(schema, modules);
		await configureOpenAi(t);
		await seedEmbeddingSpace(t, { identity: OPENAI });
		await t.action(api.aiRouting.embeddingReembed.startReembed, {});
		// The batches' own admission is pinned by the two runBatch tests below.
		expect(await jobs(t)).toEqual([expect.objectContaining({ isPaid: true })]);
		expect(embedCalls.texts).toEqual([]);
	});

	it('counts unknown vectors on a first upgrade with nothing searchable (F9)', async () => {
		const t = convexTest(schema, modules);
		await configureOpenAi(t);
		await insertEntry(t, 'legacy', { embedding: padded(3), embeddingGeneratedAt: 1 });
		await t.action(internal.aiRouting.embeddingReembed.kickoff, { isForced: true });
		await flush(t);
		const coverage = await t.run((ctx) => ctx.db.query('embeddingCoverage').first());
		expect(coverage?.searchableSpaceId).toBeUndefined();
		expect(coverage?.knowledgeEntries).toMatchObject({ active: 0, unknown: 1 });
	});

	it('counts a pending switch against nothing, as retrieval does (F9)', async () => {
		const t = convexTest(schema, modules);
		await configureOpenAi(t);
		const old = await seedEmbeddingSpace(t, {
			identity: { ...OPENAI, model: 'text-embedding-ada-002' },
		});
		await insertEntry(t, 'ada row', { embedding: padded(3), ...stampedIn(old, 'fact') });
		await t.mutation(internal.aiRouting.embeddingCoverage.requestScan, { isForced: true });
		await flush(t);
		const coverage = await t.run((ctx) => ctx.db.query('embeddingCoverage').first());
		expect(coverage?.searchableSpaceId).toBeUndefined();
		expect(coverage?.knowledgeEntries).toMatchObject({ active: 0, inactive: 1 });
	});

	it('derives a job as paid from its target space, in the starting transaction (F12)', async () => {
		const t = convexTest(schema, modules);
		await configureOpenAi(t);
		await seedEmbeddingSpace(t, { identity: OPENAI });
		// Called directly: no earlier read of the configuration can vouch for it,
		// so the job is paid because its target is, and each batch is admitted.
		await t.mutation(internal.aiRouting.embeddingReembedJobs.startReembedJob, {});
		expect(await jobs(t)).toEqual([expect.objectContaining({ isPaid: true })]);
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
		// The env plane: hosted OpenAI embeddings with a key, so only admission
		// refuses: a ceiling over a spend state nobody has reconciled yet.
		vi.stubEnv('LLM_API_KEY', 'sk-test-env');
		vi.stubEnv('AI_SPEND_DAILY_BUDGET_USD', '10');
		const active = await seedEmbeddingSpace(t, { identity: OPENAI });
		await t.run((ctx) => ctx.db.patch(active, { source: 'env' }));
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

	it('admits a batch by the embedder it resolves, not by the job flag (F12)', async () => {
		const t = convexTest(schema, modules);
		// The env plane: hosted OpenAI embeddings, under a ceiling admission cannot verify.
		vi.stubEnv('LLM_API_KEY', 'sk-test-env');
		vi.stubEnv('AI_SPEND_DAILY_BUDGET_USD', '10');
		const active = await seedEmbeddingSpace(t, {
			identity: OPENAI,
			isConfigured: false,
		});
		await t.run((ctx) => ctx.db.patch(active, { source: 'env' }));
		await insertEntry(t, 'legacy', { embedding: padded(3), embeddingGeneratedAt: 1 });
		const jobId = await t.run((ctx) =>
			ctx.db.insert('embeddingReembedJobs', {
				kind: 'reembed',
				targetSpaceId: active,
				status: 'running',
				// A job recorded as free (a stale flag): the dispatch must not trust it.
				isPaid: false,
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
		vi.unstubAllEnvs();
	});

	it('refuses a non-admin', async () => {
		const t = convexTest(schema, modules);
		session.role = 'editor';
		await expect(t.action(api.aiRouting.embeddingReembed.startReembed, {})).rejects.toThrow(
			/forbidden/
		);
		expect(embedCalls.texts).toEqual([]);
	});
});
