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
import { addMessageToThread, modules, seedMailThread, type Test } from './interpret.testlib';

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

type T = Test;

/** A stranger's List-Id mail on a provisional thread, its run waiting for the category. */
async function waitingSource(t: T) {
	const { mailboxId, messageId, threadId } = await seedMailThread(t);
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
	expect(deferred).toEqual({ kind: 'waiting', until: UNTIL });
	return { mailboxId, messageId, threadId, source };
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

/** One more message in the thread and its source row, waiting for the category or not. */
async function insertSource(
	t: T,
	at: { mailboxId: Id<'mailboxes'>; threadId: Id<'mailThreads'> },
	waiting: boolean,
	n: number
): Promise<Id<'mailMessages'>> {
	const id = await addMessageToThread(t, at, {
		text: `Update ${n}`,
		receivedAt: NOW - 100_000 + n,
	});
	await t.run((ctx) =>
		ctx.db.insert('interpretSources', {
			threadKind: 'mail',
			mailThreadId: at.threadId,
			source: { kind: 'mail', id },
			sourceKey: `mail:${id}`,
			eligibility: {
				isLive: true,
				folder: 'inbox',
				isThreadMuted: false,
				isBulkHeaderPresent: true,
				isSenderKnown: false,
			},
			...(waiting ? { categoryDeferredUntil: UNTIL } : {}),
			createdAt: NOW,
			updatedAt: NOW,
		})
	);
	return id;
}

/** Run the wake's scheduled continuations, page by page. Returns how many ran. */
async function driveWake(t: T): Promise<number> {
	const continued = new Set<string>();
	for (let page = 0; page < 20; page++) {
		const next = await t.run(async (ctx) =>
			(await ctx.db.system.query('_scheduled_functions').collect()).filter(
				(job) => job.name.includes('continueCategoryWake') && !continued.has(job._id)
			)
		);
		if (next.length === 0) break;
		for (const job of next) {
			continued.add(job._id);
			await t.mutation(
				internal.mail.interpret.categoryDefer.continueCategoryWake,
				job.args[0] as never
			);
		}
	}
	return continued.size;
}

/** Scheduled interpretation runs, as the message ids they read. */
async function runIds(t: T): Promise<string[]> {
	return t.run(async (ctx) =>
		(await ctx.db.system.query('_scheduled_functions').collect())
			.filter((job) => job.name.includes('interpretMessage'))
			.map((job) => (job.args[0] as { source: { id: string } }).source.id)
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

	it('sends the run back to read when the category settled between its read and its deferral', async () => {
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

		const args = { source, until: UNTIL };
		const answers = [
			await t.mutation(internal.mail.interpret.categoryDefer.deferForCategory, args),
			await t.mutation(internal.mail.interpret.categoryDefer.deferForCategory, args),
		];

		// The run reads again itself, under its lease: nothing is recorded or
		// scheduled, however often the stale deferral is repeated (Sol r1 F1).
		expect(answers).toEqual([{ kind: 'settled' }, { kind: 'settled' }]);
		expect(await deferredUntil(t, messageId)).toBeNull();
		expect(await runTimes(t)).toEqual([]);
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

	it('wakes every waiting source of a long thread, past newer sources that are not waiting', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, messageId, threadId } = await waitingSource(t);
		const at = { mailboxId, threadId };
		// 64 more waiting sources, then 20 newer ones that are not waiting, so the
		// waiting ones sit far below the first page.
		const waiting = [messageId];
		for (let n = 0; n < 64; n++) waiting.push(await insertSource(t, at, true, n));
		for (let n = 64; n < 84; n++) await insertSource(t, at, false, n);

		await t.mutation(internal.mail.category.applyCategory, {
			threadId,
			label: 'newsletter',
			source: 'llm',
		});
		const continued = await driveWake(t);

		expect(continued).toBeGreaterThan(0);
		for (const id of waiting) expect(await deferredUntil(t, id)).toBeNull();
		const runs = await runIds(t);
		// Each waiting source runs exactly once; no source that was not waiting runs.
		expect(runs.sort()).toEqual([...waiting].sort());
	});

	it('keeps paging when sources a cursor already read are deleted meanwhile', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, messageId, threadId } = await waitingSource(t);
		const at = { mailboxId, threadId };
		const waiting = [messageId];
		for (let n = 0; n < 110; n++) waiting.push(await insertSource(t, at, true, n));
		// The 50 newest were one page, all at one creation time, and a purge
		// deleted them before the next page ran (Sol fixes-r2 F2): the cursor
		// names 50 ids the read can no longer return.
		const rows = await t.run((ctx) =>
			ctx.db
				.query('interpretSources')
				.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
				.order('desc')
				.collect()
		);
		const visited = rows.slice(0, 50);
		await t.run(async (ctx) => {
			for (const row of visited) await ctx.db.delete(row._id);
		});
		const cursor = { at: visited[49]!._creationTime, seen: visited.map((row) => row._id) };

		await t.mutation(internal.mail.interpret.categoryDefer.continueCategoryWake, {
			threadId,
			cursor,
		});
		await driveWake(t);

		const left = waiting.filter((id) => !visited.some((row) => row.source.id === id));
		expect(left).toHaveLength(61);
		for (const id of left) expect(await deferredUntil(t, id)).toBeNull();
		expect((await runIds(t)).sort()).toEqual([...left].sort());
	});
});
