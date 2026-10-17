/**
 * PR review PR-4: the bulk rule (D2) reads the thread's FINAL category. A
 * stranger's List-Id mail captured while the category is still the
 * provisional baseline (`other`, model refinement pending) waits for the
 * refinement, bounded, and a refinement to `newsletter` keeps it out.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import { internal } from '../../../_generated/api';
import { CATEGORY_SETTLE_MS, isInterpretationEligible, settleCategory } from '../eligibility';
import { captureInterpretSource } from '../sources';
import { modules, seedMailThread } from './interpret.testlib';

const NOW = Date.UTC(2026, 9, 11, 9, 0);

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
});
afterEach(() => {
	vi.useRealTimers();
});

const stranger = {
	isLive: true,
	folder: 'inbox',
	isThreadMuted: false,
	isBulkHeaderPresent: true,
	isSenderKnown: false,
	category: 'other',
};

describe('settleCategory', () => {
	it('waits while a bulk-stranger candidate’s category is provisional', () => {
		expect(
			settleCategory(stranger, {
				threadCategory: { label: 'other', source: 'heuristic' },
				capturedAt: NOW,
				now: NOW + 1000,
			})
		).toEqual({ pendingUntil: NOW + CATEGORY_SETTLE_MS });
	});

	it('takes the refined label once it landed, and the provisional one after the wait', () => {
		expect(
			settleCategory(stranger, {
				threadCategory: { label: 'newsletter', source: 'llm' },
				capturedAt: NOW,
				now: NOW + 1000,
			})
		).toEqual({ signals: { ...stranger, category: 'newsletter' } });
		expect(
			settleCategory(stranger, {
				threadCategory: { label: 'other', source: 'heuristic' },
				capturedAt: NOW,
				now: NOW + CATEGORY_SETTLE_MS,
			})
		).toEqual({ signals: stranger });
	});

	it('never waits for a known sender, mail without bulk headers, or our own mail', () => {
		const pending = {
			threadCategory: { label: 'other', source: 'heuristic' },
			capturedAt: NOW,
			now: NOW,
		};
		expect(settleCategory({ ...stranger, isSenderKnown: true }, pending)).toHaveProperty('signals');
		expect(settleCategory({ ...stranger, isBulkHeaderPresent: false }, pending)).toHaveProperty(
			'signals'
		);
		expect(settleCategory(stranger, { ...pending, direction: 'outbound' })).toHaveProperty(
			'signals'
		);
	});
});

describe('owner’s repro: provisional category, List-Id capture, newsletter refinement', () => {
	it('keeps a stranger’s newsletter out once the refinement lands', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId } = await seedMailThread(t);
		const source = { kind: 'mail' as const, id: messageId };
		// enqueueCategoryCheck's baseline while the model refinement is scheduled.
		await t.run(async (ctx) => {
			await ctx.db.patch(threadId, {
				category: { label: 'other', source: 'heuristic', classifiedAt: NOW },
			});
			await captureInterpretSource(ctx, { source, isLive: true, listId: '<news.acme.test>' });
		});

		const early = await t.query(internal.mail.interpret.load.loadForInterpretation, { source });
		expect(early?.categoryPendingUntil).toBe(NOW + CATEGORY_SETTLE_MS);

		// The refinement persists `newsletter` after the capture.
		await t.run((ctx) =>
			ctx.db.patch(threadId, {
				category: { label: 'newsletter', source: 'llm', classifiedAt: NOW + 2000 },
			})
		);
		const late = await t.query(internal.mail.interpret.load.loadForInterpretation, { source });
		expect(late?.categoryPendingUntil).toBeUndefined();
		expect(late?.eligibility?.category).toBe('newsletter');
		expect(isInterpretationEligible(late!.eligibility!, { direction: 'inbound' })).toMatchObject({
			isEligible: false,
			skipReason: 'bulk',
		});
	});

	it('the run waits instead of reading the provisional label, with one deferred job however often it is called', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId } = await seedMailThread(t);
		const source = { kind: 'mail' as const, id: messageId };
		await t.run(async (ctx) => {
			await ctx.db.patch(threadId, {
				category: { label: 'other', source: 'heuristic', classifiedAt: NOW },
			});
			await captureInterpretSource(ctx, { source, isLive: true, listId: '<news.acme.test>' });
		});
		// Repeated and concurrent calls (a re-run, the stale sweep, two jobs).
		const results = await Promise.all([
			t.action(internal.mail.interpret.run.interpretMessage, { source }),
			t.action(internal.mail.interpret.run.interpretMessage, { source }),
		]);
		results.push(await t.action(internal.mail.interpret.run.interpretMessage, { source }));
		for (const result of results) {
			expect(result).toMatchObject({ status: 'skipped', errorCode: 'category_pending' });
		}
		const scheduled = await t.run(async (ctx) =>
			(await ctx.db.system.query('_scheduled_functions').collect()).filter(
				(f) => f.name.includes('interpretMessage') || f.name.includes('settleAtCeiling')
			)
		);
		// One deferred job for the source, its ceiling at the settle time; recorded on its snapshot.
		expect(scheduled.map((f) => [f.name, f.scheduledTime])).toEqual([
			[expect.stringContaining('settleAtCeiling'), NOW + CATEGORY_SETTLE_MS],
		]);
		const row = await t.run(async (ctx) =>
			ctx.db
				.query('interpretSources')
				.withIndex('by_source_key', (q) => q.eq('sourceKey', `mail:${messageId}`))
				.first()
		);
		expect(row?.categoryDeferredUntil).toBe(NOW + CATEGORY_SETTLE_MS);
	});
});
