/**
 * The category wait ends early (categoryDefer.ts). A bulk-stranger run that
 * waits for the category refinement used to sleep the full settle time even
 * after the refinement landed. Now a settled category written for the thread
 * (the model's refinement, the owner's override) runs the waiting source at
 * once, and the ceiling job at the settle time is a no-op after that.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import { api, internal } from '../../../_generated/api';
import type { Id } from '../../../_generated/dataModel';
import { CATEGORY_SETTLE_MS } from '../eligibility';
import { captureInterpretSource } from '../sources';
import { modules, seedMailThread } from './interpret.testlib';

const session = vi.hoisted(() => ({
	userId: 'user-A',
	role: 'owner',
	activeOrganizationId: 'org-1',
}));
vi.mock('../../../lib/sessionOrganization', async () => ({
	...(await vi.importActual<object>('../../../lib/sessionOrganization')),
	getMutationContext: vi.fn(async () => session),
	getBetterAuthSessionWithRole: vi.fn(async () => session),
}));

const NOW = Date.UTC(2026, 9, 11, 9, 0);
const UNTIL = NOW + CATEGORY_SETTLE_MS;

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
});
afterEach(() => {
	vi.useRealTimers();
});

type T = ReturnType<typeof convexTest>;

/** A stranger's List-Id mail on a provisional thread, its run waiting for the category. */
async function waitingSource(t: T) {
	const { messageId, threadId } = await seedMailThread(t);
	const source = { kind: 'mail' as const, id: messageId };
	await t.run(async (ctx) => {
		await ctx.db.patch(threadId, {
			category: { label: 'other', source: 'heuristic', classifiedAt: NOW },
		});
		await captureInterpretSource(ctx, { source, isLive: true, listId: '<news.acme.test>' });
	});
	const deferred = await t.mutation(internal.mail.interpret.categoryDefer.deferForCategory, {
		source,
		until: UNTIL,
	});
	expect(deferred).toEqual({ isScheduled: true });
	return { messageId, threadId, source };
}

async function deferredUntil(t: T, messageId: Id<'mailMessages'>) {
	return t.run(async (ctx) => {
		const row = await ctx.db
			.query('interpretSources')
			.withIndex('by_source_key', (q) => q.eq('sourceKey', `mail:${messageId}`))
			.first();
		return row?.categoryDeferredUntil ?? null; // undefined does not survive t.run
	});
}

/** Scheduled interpretation runs, as their scheduled times. */
async function runTimes(t: T): Promise<number[]> {
	return t.run(async (ctx) =>
		(await ctx.db.system.query('_scheduled_functions').collect())
			.filter((job) => job.name.includes('interpretMessage'))
			.map((job) => job.scheduledTime)
	);
}

describe('category wait wake-up', () => {
	it('runs the waiting source as soon as the refinement lands; the ceiling then does nothing', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId, source } = await waitingSource(t);
		expect(await runTimes(t)).toEqual([]);

		vi.setSystemTime(NOW + 30_000);
		await t.mutation(internal.mail.category.applyCategory, {
			threadId,
			label: 'newsletter',
			source: 'llm',
		});
		expect(await deferredUntil(t, messageId)).toBeNull();
		expect(await runTimes(t)).toEqual([NOW + 30_000]);

		vi.setSystemTime(UNTIL);
		const ceiling = await t.mutation(internal.mail.interpret.categoryDefer.settleAtCeiling, {
			source,
			until: UNTIL,
		});
		expect(ceiling).toEqual({ isScheduled: false });
		expect(await runTimes(t)).toHaveLength(1);
	});

	it('runs the waiting source when the owner sets the category', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId } = await waitingSource(t);

		await t.mutation(api.mail.category.recategorize, { threadId, label: 'person' });

		expect(await deferredUntil(t, messageId)).toBeNull();
		expect(await runTimes(t)).toEqual([NOW]);
	});

	it('keeps waiting while the label written is still the provisional baseline', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId } = await waitingSource(t);

		await t.mutation(internal.mail.category.applyCategory, {
			threadId,
			label: 'other',
			source: 'heuristic',
		});

		expect(await deferredUntil(t, messageId)).toBe(UNTIL);
		expect(await runTimes(t)).toEqual([]);
	});

	it('runs the source at the ceiling when nothing woke it, once', async () => {
		const t = convexTest(schema, modules);
		const { messageId, source } = await waitingSource(t);

		vi.setSystemTime(UNTIL);
		const args = { source, until: UNTIL };
		const first = await t.mutation(internal.mail.interpret.categoryDefer.settleAtCeiling, args);
		const again = await t.mutation(internal.mail.interpret.categoryDefer.settleAtCeiling, args);

		expect([first, again]).toEqual([{ isScheduled: true }, { isScheduled: false }]);
		expect(await deferredUntil(t, messageId)).toBeNull();
		expect(await runTimes(t)).toEqual([UNTIL]);
	});

	it('does not wait when the category settled between the run’s read and its deferral', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId } = await seedMailThread(t);
		const source = { kind: 'mail' as const, id: messageId };
		await t.run(async (ctx) => {
			await captureInterpretSource(ctx, { source, isLive: true, listId: '<news.acme.test>' });
			// Written after the run loaded the provisional label; nothing was waiting yet.
			await ctx.db.patch(threadId, {
				category: { label: 'newsletter', source: 'llm', classifiedAt: NOW },
			});
		});

		await t.mutation(internal.mail.interpret.categoryDefer.deferForCategory, {
			source,
			until: UNTIL,
		});

		expect(await deferredUntil(t, messageId)).toBeNull();
		expect(await runTimes(t)).toEqual([NOW]);
	});

	it('replacing a settled label wakes nothing', async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId } = await waitingSource(t);
		await t.run((ctx) =>
			ctx.db.patch(threadId, {
				category: { label: 'newsletter', source: 'llm', classifiedAt: NOW },
			})
		);

		await t.mutation(internal.mail.category.applyCategory, {
			threadId,
			label: 'promotion',
			source: 'llm',
		});

		// Not reachable in practice (the provisional → settled write woke it);
		// the stale deferral is left to its ceiling.
		expect(await deferredUntil(t, messageId)).toBe(UNTIL);
		expect(await runTimes(t)).toEqual([]);
	});
});
