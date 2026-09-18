import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { batchGet } from '../batchLoader';

const modules = import.meta.glob('../../**/*.*s');

/**
 * `batchGet` is the read primitive twenty query paths now fan out through, so
 * the two properties they rely on are pinned here: every id resolves (a missing
 * row is `null`, never a dropped entry, because callers index the map by id),
 * and a repeated id costs one read — the dedupe is the reason a page of rows
 * pointing at the same thread or folder is cheap.
 */
describe('batchGet', () => {
	it('maps every id to its document and a deleted id to null', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			const now = Date.now();
			const first = await ctx.db.insert('topics', { name: 'First', createdAt: now });
			const second = await ctx.db.insert('topics', { name: 'Second', createdAt: now });
			await ctx.db.delete(second);

			const byId = await batchGet(ctx, [first, second]);

			expect(byId.get(first)?.name).toBe('First');
			expect(byId.get(second)).toBeNull();
		});
	});

	it('reads a repeated id once', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			const now = Date.now();
			const topicId = await ctx.db.insert('topics', { name: 'Repeated', createdAt: now });
			const reads: string[] = [];
			const countingCtx = {
				db: {
					get: (id: Id<'topics'>) => {
						reads.push(id);
						return ctx.db.get(id);
					},
				},
			};

			const byId = await batchGet(countingCtx, [topicId, topicId, topicId]);

			expect(reads).toEqual([topicId]);
			expect(byId.get(topicId)?.name).toBe('Repeated');
		});
	});
});
