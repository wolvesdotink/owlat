/**
 * Extraction progress markers outlive a long budget refusal (Sol r3 F2):
 * retention ages out `complete` markers only; an unfinished one stays until it
 * completes or its source is deleted.
 */
import { describe, expect, it } from 'vitest';
import { internal } from '../../_generated/api';
import { newHarness } from '../../__tests__/testModules';
import { dropExtractionProgress } from '../extractionProgress';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('extraction progress retention', () => {
	it('keeps an unfinished marker however old, and ages out a complete one', async () => {
		const t = newHarness();
		const longAgo = Date.now() - 90 * DAY_MS;
		await t.run(async (ctx) => {
			for (const [sourceId, status] of [
				['unfinished', 'in_progress'],
				['finished', 'complete'],
			] as const) {
				await ctx.db.insert('knowledgeExtractionProgress', {
					sourceType: 'email',
					sourceId,
					status,
					entries: status === 'in_progress' ? [] : undefined,
					updatedAt: longAgo,
				});
			}
		});

		await t.mutation(internal.maintenance.retention.sweepAiRoutingRecords, {});

		const left = await t.run((ctx) => ctx.db.query('knowledgeExtractionProgress').collect());
		expect(left.map((row) => [row.sourceId, row.status])).toEqual([['unfinished', 'in_progress']]);
		expect(
			await t.query(internal.knowledge.extractionProgress.extractionProgressOf, {
				sourceType: 'email',
				sourceId: 'unfinished',
			})
		).toMatchObject({ isDone: false, isPartial: true });
	});

	it('drops a marker, unfinished or not, when its source is deleted', async () => {
		const t = newHarness();
		await t.run(async (ctx) => {
			await ctx.db.insert('knowledgeExtractionProgress', {
				sourceType: 'file',
				sourceId: 'file-1',
				status: 'in_progress',
				updatedAt: Date.now(),
			});
			await ctx.db.insert('knowledgeExtractionProgress', {
				sourceType: 'email',
				sourceId: 'file-1',
				status: 'in_progress',
				updatedAt: Date.now(),
			});
			await dropExtractionProgress(ctx, 'file', 'file-1');
		});
		const left = await t.run((ctx) => ctx.db.query('knowledgeExtractionProgress').collect());
		// Only the marker of the deleted source, matched by type and id.
		expect(left.map((row) => row.sourceType)).toEqual(['email']);
	});
});
