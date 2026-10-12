/**
 * Column ownership holds however many embedding spaces were ever configured
 * (ADR-0073; Sol r4 F19). A column's owner is the space there with the highest
 * claim, read through the `by_slot_claim` index: a fixed window of the oldest
 * spaces missed the newest one, so space 501 lost its own column, its re-embed
 * batches stopped, and a new claim could repeat an existing one.
 */
import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import { claimColumn } from '../lib/aiRouting/embeddingActivation';
import { embeddingSpaceIdentityKey } from '../lib/aiRouting/embeddingKeys';
import { ownsColumn, readColumnOwner } from '../lib/aiRouting/embeddingRegistry';
import { seedEmbeddingSpace, TEST_LOCAL_SPACE } from './helpers/embeddingSpaces';

const modules = import.meta.glob('../**/*.*s');
type T = TestConvex<typeof schema>;

/** More spaces than any fixed read window this module ever used. */
const OLD_SPACES = 520;

/** Retired spaces in the primary column, claims 1..count, oldest first. */
async function seedRetiredSpaces(t: T, count: number): Promise<void> {
	const now = Date.now();
	await t.run(async (ctx) => {
		for (let claim = 1; claim <= count; claim += 1) {
			const identity = { ...TEST_LOCAL_SPACE, model: `old-model-${claim}` };
			await ctx.db.insert('embeddingSpaces', {
				...identity,
				identityKey: embeddingSpaceIdentityKey(identity),
				source: 'stored_config',
				state: 'retired',
				slot: 'primary',
				columnClaim: claim,
				retiredAt: now,
				createdAt: now,
				updatedAt: now,
			});
		}
	});
}

beforeEach(() => {
	// The re-embed batch a job schedules stays queued: the page is read directly.
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
	vi.useRealTimers();
});

describe('column ownership past any fixed window (F19)', () => {
	it('the newest space owns its column, and a new claim lands above the real maximum', async () => {
		const t = convexTest(schema, modules);
		await seedRetiredSpaces(t, OLD_SPACES);
		const newestId = await seedEmbeddingSpace(t);

		await t.run(async (ctx) => {
			const newest = (await ctx.db.get(newestId))!;
			expect(newest.columnClaim).toBe(OLD_SPACES + 1);
			expect(await ownsColumn(ctx.db, newest)).toBe(true);
			expect((await readColumnOwner(ctx.db, 'primary'))?._id).toBe(newestId);
			expect(await readColumnOwner(ctx.db, 'secondary')).toBeNull();
			const oldest = (await ctx.db.query('embeddingSpaces').first())!;
			expect(await ownsColumn(ctx.db, oldest)).toBe(false);

			const staged = await claimColumn(
				ctx,
				{ identity: { ...TEST_LOCAL_SPACE, model: 'next-model' }, source: 'stored_config' },
				{ slot: 'secondary', state: 'staged' }
			);
			expect(staged.columnClaim).toBe(OLD_SPACES + 2);
			// The secondary column's new owner; the primary one keeps its owner.
			expect(await ownsColumn(ctx.db, staged)).toBe(true);
			expect(await ownsColumn(ctx.db, newest)).toBe(true);
		});
	});

	it('a re-embed of the newest space reads its page instead of stopping', async () => {
		const t = convexTest(schema, modules);
		await seedRetiredSpaces(t, OLD_SPACES);
		const newestId = await seedEmbeddingSpace(t);
		const now = Date.now();
		await t.run((ctx) =>
			ctx.db.insert('knowledgeEntries', {
				entryType: 'fact',
				title: 'Office hours',
				content: 'The office opens at nine.',
				sourceType: 'manual',
				embedding: [],
				confidence: 0.9,
				lastValidatedAt: now,
				searchableText: 'Office hours',
				createdAt: now,
				updatedAt: now,
			})
		);

		const outcome = await t.mutation(internal.aiRouting.embeddingReembedJobs.startLocalReembed, {
			spaceId: newestId,
			isForced: true,
		});
		expect(outcome).toBe('started');
		const job = (await t.run((ctx) => ctx.db.query('embeddingReembedJobs').first()))!;
		const page = await t.query(internal.aiRouting.embeddingReembedJobs.reembedPage, {
			jobId: job._id,
			generation: job.generation,
		});
		expect(page.kind).toBe('page');
		expect(page.kind === 'page' && page.target._id).toBe(newestId);
		expect(page.kind === 'page' && page.items.map((item) => item.text)).toHaveLength(1);
	});
});
