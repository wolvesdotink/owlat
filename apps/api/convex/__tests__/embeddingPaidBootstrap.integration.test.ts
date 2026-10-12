/**
 * The paid re-embed bootstrap (ADR-0073, D8, F3): a hosted deployment's first
 * upgrade has only unknown vectors and no searchable space, and no new content
 * may ever arrive. An admin start measures the configured space with one
 * admitted call, activates it and runs the admitted re-embed. Admission is
 * mocked here (the admission lane fills the seam); no provider is called.
 */
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Ai from 'ai';
import schema from '../schema';
import { api } from '../_generated/api';
import type { PaidEmbeddingBatch } from '../lib/aiRouting/embeddingAdmission';

const admission = vi.hoisted(() => ({
	isAdmitting: true,
	batches: [] as PaidEmbeddingBatch[],
	settled: 0,
	dispatched: [] as number[],
}));

// Only the admission decision is mocked; `runAdmittedEmbedding` (the
// classify / admit / settle-once wrapper) is the real one.
vi.mock('../lib/aiRouting/embeddingAdmission', async (importOriginal) => {
	const actual = await importOriginal<object>();
	const admitPaidEmbeddingBatch = vi.fn(async (_ctx: unknown, batch: PaidEmbeddingBatch) => {
		admission.batches.push(batch);
		if (!admission.isAdmitting) return { isAdmitted: false, reason: 'over the daily ceiling' };
		return {
			isAdmitted: true,
			settle: async (usage: { dispatchedCalls: number }) => {
				admission.settled += 1;
				admission.dispatched.push(usage.dispatchedCalls);
			},
		};
	});
	return {
		...actual,
		isPaidEmbeddingAdmissionAvailable: () => true,
		admitPaidEmbeddingBatch,
	};
});

const embedCalls = vi.hoisted(() => ({ count: 0, isFailing: false }));
vi.mock('ai', async () => {
	const actual = await vi.importActual<typeof Ai>('ai');
	return {
		...actual,
		embed: vi.fn(async () => {
			embedCalls.count += 1;
			if (embedCalls.isFailing) throw new Error('provider error');
			return { embedding: Array.from({ length: 1536 }, (_, i) => (i === 7 ? 1 : 0)) };
		}),
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
	// The env plane: hosted OpenAI embeddings, no stored row.
	vi.stubEnv('LLM_API_KEY', 'sk-test-env');
	admission.isAdmitting = true;
	admission.batches = [];
	admission.settled = 0;
	admission.dispatched = [];
	embedCalls.count = 0;
	embedCalls.isFailing = false;
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

const flush = (t: T) => t.finishAllScheduledFunctions(vi.runAllTimers);

async function legacyEntries(t: T, count: number) {
	const now = Date.now();
	await t.run(async (ctx) => {
		for (let i = 0; i < count; i++) {
			await ctx.db.insert('knowledgeEntries', {
				entryType: 'fact',
				title: `legacy ${i}`,
				content: `legacy ${i}`,
				sourceType: 'manual',
				embedding: Array.from({ length: 1536 }, (_, j) => (j === i ? 1 : 0)),
				embeddingModel: 'text-embedding-3-small',
				embeddingGeneratedAt: 1,
				confidence: 0.9,
				lastValidatedAt: now,
				createdAt: now,
				updatedAt: now,
			});
		}
	});
}

describe('paid re-embed bootstrap', () => {
	it('measures and activates the configured space, then re-embeds, every call admitted', async () => {
		const t = convexTest(schema, modules);
		await legacyEntries(t, 3);

		await t.action(api.aiRouting.embeddingReembed.startReembed, {});
		await flush(t);

		const spaces = await t.run((ctx) => ctx.db.query('embeddingSpaces').collect());
		expect(spaces).toHaveLength(1);
		expect(spaces[0]).toMatchObject({
			provider: 'openai',
			endpoint: 'native',
			model: 'text-embedding-3-small',
			dimensions: 1536,
			source: 'env',
			state: 'active',
		});
		const [job] = await t.run((ctx) => ctx.db.query('embeddingReembedJobs').collect());
		expect(job).toMatchObject({ status: 'completed', isPaid: true, embeddedCount: 3 });
		const rows = await t.run((ctx) => ctx.db.query('knowledgeEntries').collect());
		expect(rows.every((r) => r.embeddingSpaceId === spaces[0]!._id)).toBe(true);
		// The probe, then one batch: both admitted, both settled.
		expect(admission.batches.map((b) => [b.jobKind, b.items])).toEqual([
			['probe', 1],
			['reembed', 3],
		]);
		expect(admission.settled).toBe(2);
		expect(admission.dispatched).toEqual([1, 3]);
		expect(embedCalls.count).toBe(4);
	});

	it('settles the admitted probe exactly once when the call fails (F15)', async () => {
		const t = convexTest(schema, modules);
		await legacyEntries(t, 1);
		embedCalls.isFailing = true;
		await expect(t.action(api.aiRouting.embeddingReembed.startReembed, {})).rejects.toThrow();
		// The failed call may still be billed: it counts as dispatched.
		expect(admission.settled).toBe(1);
		expect(admission.dispatched).toEqual([1]);
	});

	it('makes no provider call when admission refuses the probe', async () => {
		const t = convexTest(schema, modules);
		await legacyEntries(t, 1);
		admission.isAdmitting = false;
		await expect(t.action(api.aiRouting.embeddingReembed.startReembed, {})).rejects.toThrow(
			/daily ceiling/
		);
		expect(embedCalls.count).toBe(0);
		expect(await t.run((ctx) => ctx.db.query('embeddingSpaces').collect())).toEqual([]);
	});
});
