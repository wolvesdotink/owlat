/**
 * Contact-count reconcile (#917): a recount split across bounded transactions.
 *
 * Covers the issue's acceptance list: a fixed read budget per step whatever the
 * contact book's size, exact convergence while creates, soft deletes and hard
 * deletes land before, at and after each page boundary, a finish that cannot be
 * overwritten by an older generation, joined/resumed overlapping starts, a
 * failed step retried, and dashboards that answer "pending" instead of
 * scanning when no count is cached.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getFunctionName } from 'convex/server';
import schema from '../schema';
import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { api, internal } from '../_generated/api';
import { getStats } from '../analytics/dashboard';
import { getAudienceStats } from '../contacts/analytics';
import { loadCounterScope } from '../lib/counters';
import { getCachedContactCount, incrementContactCount } from '../lib/contactCountHelpers';
import { resolveContact } from '../contacts/resolution';
import { permanentlyDeleteContactWithRelations, softDeleteContact } from '../lib/contactMutations';
import { CONTACT_LIVE_TOTAL_SCOPE } from '../contacts/growthCounters';
import {
	STALLED_AFTER_MS,
	recoverMissingContactCount,
	runContactCountReconcileStep,
	startContactCountReconcile,
	type ReconcileStepOutcome,
} from '../contacts/countReconcile';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	const session = { userId: 'user-alice', role: 'owner', activeOrganizationId: 'org-1' };
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn(async () => session.userId),
		getMutationContext: vi.fn(async () => session),
		getBetterAuthSessionWithRole: vi.fn(async () => session),
		requireOrgPermission: vi.fn(async () => session),
	};
});

const modules = import.meta.glob('../**/*.*s');
type Test = TestConvex<typeof schema>;

// ── helpers ─────────────────────────────────────────────────────────────────

/** Documents a transaction read through `ctx.db` (the budget the limits apply to). */
function metered<C extends { db: object }>(ctx: C): { ctx: C; reads: () => number } {
	let reads = 0;
	const count = (doc: unknown) => {
		if (doc !== null && doc !== undefined) reads += 1;
	};
	const countAll = (docs: readonly unknown[]) => {
		for (const doc of docs) count(doc);
	};
	const wrap = (q: object): object =>
		new Proxy(q, {
			get(target, prop) {
				const value = Reflect.get(target, prop) as unknown;
				if (prop === Symbol.asyncIterator) {
					return () => {
						const it = (target as AsyncIterable<unknown>)[Symbol.asyncIterator]();
						return {
							next: async () => {
								const r = await it.next();
								if (!r.done) count(r.value);
								return r;
							},
						};
					};
				}
				if (typeof value !== 'function') return value;
				return (...args: unknown[]) => {
					const out = (value as (...a: unknown[]) => unknown).apply(target, args);
					if (prop === 'first' || prop === 'unique')
						return (out as Promise<unknown>).then((d) => (count(d), d));
					if (prop === 'take' || prop === 'collect')
						return (out as Promise<unknown[]>).then((ds) => (countAll(ds), ds));
					if (prop === 'paginate')
						return (out as Promise<{ page: unknown[] }>).then((r) => (countAll(r.page), r));
					return out && typeof out === 'object' && !(out instanceof Promise) ? wrap(out) : out;
				};
			},
		});
	const db = new Proxy(ctx.db, {
		get(target, prop) {
			const value = Reflect.get(target, prop) as unknown;
			if (typeof value !== 'function') return value;
			if (prop === 'query')
				return (...a: unknown[]) => wrap((value as (...x: unknown[]) => object).apply(target, a));
			if (prop === 'get')
				return async (...a: unknown[]) => {
					const d = await (value as (...x: unknown[]) => Promise<unknown>).apply(target, a);
					count(d);
					return d;
				};
			return (value as (...x: unknown[]) => unknown).bind(target);
		},
	});
	return { ctx: { ...ctx, db } as C, reads: () => reads };
}

async function seed(t: Test, live: number, deleted = 0): Promise<Id<'contacts'>[]> {
	return t.run(async (ctx) => {
		const ids: Id<'contacts'>[] = [];
		const now = Date.now();
		for (let i = 0; i < live + deleted; i++) {
			ids.push(
				await ctx.db.insert('contacts', {
					email: `s${i}@example.com`,
					source: 'api',
					doiStatus: 'not_required',
					searchableText: `s${i}@example.com`,
					createdAt: now,
					updatedAt: now,
					...(i >= live ? { deletedAt: now, deletedBy: 'test' } : {}),
				})
			);
		}
		return ids;
	});
}

async function createViaResolution(t: Test, identifier: string): Promise<Id<'contacts'>> {
	return t.run(async (ctx) => {
		const result = await resolveContact(ctx, {
			channel: 'email',
			identifier,
			source: 'api',
			mode: 'upsert',
		});
		await incrementContactCount(ctx, 1);
		return result.contactId;
	});
}

async function liveByScan(t: Test): Promise<number> {
	return t.run(
		async (ctx) =>
			(await ctx.db.query('contacts').collect()).filter((c) => c.deletedAt === undefined).length
	);
}

async function generation(t: Test): Promise<Id<'counterScopes'>> {
	const state = await t.run((ctx) => loadCounterScope(ctx.db, CONTACT_LIVE_TOTAL_SCOPE));
	if (!state) throw new Error('no reconcile generation');
	return state._id;
}

async function stepOnce(
	t: Test,
	gen: Id<'counterScopes'>,
	pageRows: number
): Promise<ReconcileStepOutcome> {
	return t.run((ctx) => runContactCountReconcileStep(ctx, gen, pageRows));
}

async function setCached(t: Test, value: number): Promise<void> {
	await t.run(async (ctx: MutationCtx) => {
		const row = await ctx.db
			.query('instanceCounters')
			.withIndex('by_key', (q) => q.eq('key', 'contacts'))
			.first();
		if (row) await ctx.db.patch(row._id, { contactCount: value });
		else
			await ctx.db.insert('instanceCounters', {
				key: 'contacts',
				contactCount: value,
				updatedAt: 0,
			});
	});
}

const cached = (t: Test) => t.run((ctx) => getCachedContactCount(ctx));

beforeEach(() => {
	// Steps reschedule themselves; the tests drive them by hand instead.
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
	vi.setSystemTime(Date.UTC(2026, 8, 30, 9));
});
afterEach(() => {
	vi.useRealTimers();
});

// ── budget ──────────────────────────────────────────────────────────────────

describe('reconcile — fixed per-execution budget', () => {
	it('reads at most one page per step, however many contacts exist', async () => {
		const t = convexTest(schema, modules);
		await seed(t, 950, 50);
		await setCached(t, 3);
		const PAGE = 100;

		expect(await t.run((ctx) => startContactCountReconcile(ctx))).toBe('started');
		const gen = await generation(t);

		const perStep: number[] = [];
		let outcome: ReconcileStepOutcome;
		do {
			outcome = await t.run(async (raw) => {
				const { ctx, reads } = metered(raw);
				const result = await runContactCountReconcileStep(ctx, gen, PAGE);
				perStep.push(reads());
				return result;
			});
		} while (outcome.status === 'continued');

		expect(outcome).toEqual({ status: 'finished', previous: 3, actual: 950, corrected: true });
		expect(await cached(t)).toBe(950);
		// ceil(1000 / 100) pages, the last one empty or partial.
		expect(perStep.length).toBeLessThanOrEqual(11);
		// A page plus the scope row, bucket, counter row and settings fallback: never the table.
		for (const reads of perStep) expect(reads).toBeLessThanOrEqual(PAGE + 8);
		// The generation is gone once it has written its count.
		expect(await t.run((ctx) => loadCounterScope(ctx.db, CONTACT_LIVE_TOTAL_SCOPE))).toBeNull();
	});

	it('runs the whole chain from the daily cron entry point', async () => {
		const t = convexTest(schema, modules);
		await seed(t, 1234, 10);
		// The cron's target keeps its name and (empty) args for old schedules.
		await t.mutation(internal.contacts.contacts.reconcileAllContactCounts, {});
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(await cached(t)).toBe(1234);
	});
});

// ── concurrency ─────────────────────────────────────────────────────────────

describe('reconcile — concurrent writes converge exactly', () => {
	it('counts creates, soft deletes and hard deletes landing around every page boundary', async () => {
		const t = convexTest(schema, modules);
		await seed(t, 40, 5);
		await setCached(t, 999);
		await t.run((ctx) => startContactCountReconcile(ctx));
		const gen = await generation(t);

		let n = 0;
		let outcome: ReconcileStepOutcome;
		let turn = 0;
		do {
			// Before the page: delete the next row the walk will read, one it has
			// already read, and create a new one (it lands after every row).
			const rows = await t.run((ctx) => ctx.db.query('contacts').collect());
			const live = rows.filter((r) => r.deletedAt === undefined);
			const state = await t.run((ctx) => loadCounterScope(ctx.db, CONTACT_LIVE_TOTAL_SCOPE));
			const mark = state?.watermark?.creationTime ?? -1;
			const behind = live.filter((r) => r._creationTime <= mark);
			const ahead = live.filter((r) => r._creationTime > mark);
			if (behind.length > 0) {
				await t.run((ctx) => softDeleteContact(ctx, behind[0]!._id, 'test'));
			}
			if (ahead.length > 0) {
				await t.run((ctx) => softDeleteContact(ctx, ahead[0]!._id, 'test'));
			}
			if (turn % 2 === 0 && behind.length > 1) {
				// Hard delete of a live row the walk has counted (GDPR erase now).
				await t.run((ctx) =>
					permanentlyDeleteContactWithRelations(ctx, behind[1]!._id, { decrementCount: true })
				);
			}
			await createViaResolution(t, `new${n++}@example.com`);
			// The row exactly at the watermark: soft delete it.
			const atMark = live.find((r) => r._creationTime === mark);
			if (atMark && turn % 3 === 1)
				await t.run((ctx) => softDeleteContact(ctx, atMark._id, 'test'));
			turn += 1;
			outcome = await stepOnce(t, gen, 7);
		} while (outcome.status === 'continued');

		const truth = await liveByScan(t);
		expect(outcome).toMatchObject({ status: 'finished', actual: truth });
		expect(await cached(t)).toBe(truth);

		// After the finish, writers keep the count by themselves.
		await createViaResolution(t, 'after@example.com');
		expect(await cached(t)).toBe(truth + 1);
	});

	it('a failed step leaves no partial tally and its retry converges', async () => {
		const t = convexTest(schema, modules);
		await seed(t, 30);
		await t.run((ctx) => startContactCountReconcile(ctx));
		const gen = await generation(t);
		await stepOnce(t, gen, 10);

		// The step commits nothing when its transaction fails.
		await expect(
			t.run(async (ctx) => {
				await runContactCountReconcileStep(ctx, gen, 10);
				throw new Error('transient failure');
			})
		).rejects.toThrow('transient failure');

		let outcome: ReconcileStepOutcome;
		do outcome = await stepOnce(t, gen, 10);
		while (outcome.status === 'continued');
		expect(outcome).toMatchObject({ status: 'finished', actual: 30 });
		expect(await cached(t)).toBe(30);
	});
});

// ── generations ─────────────────────────────────────────────────────────────

describe('reconcile — generations never overwrite a newer count', () => {
	it('joins a run in progress and ignores the steps of a finished one', async () => {
		const t = convexTest(schema, modules);
		await seed(t, 12);
		expect(await t.run((ctx) => startContactCountReconcile(ctx))).toBe('started');
		expect(await t.run((ctx) => startContactCountReconcile(ctx))).toBe('running');
		const oldGen = await generation(t);

		let outcome: ReconcileStepOutcome;
		do outcome = await stepOnce(t, oldGen, 5);
		while (outcome.status === 'continued');
		expect(await cached(t)).toBe(12);

		// A newer run starts and finishes; later writes move the count on.
		await t.run((ctx) => startContactCountReconcile(ctx));
		const newGen = await generation(t);
		expect(newGen).not.toBe(oldGen);
		do outcome = await stepOnce(t, newGen, 50);
		while (outcome.status === 'continued');
		await createViaResolution(t, 'late@example.com');
		expect(await cached(t)).toBe(13);

		// A step of the old generation still queued somewhere changes nothing.
		expect(await stepOnce(t, oldGen, 5)).toEqual({ status: 'stale' });
		expect(await stepOnce(t, newGen, 5)).toEqual({ status: 'stale' });
		expect(await cached(t)).toBe(13);
	});

	it('resumes a stalled run from its cursor instead of starting over', async () => {
		const t = convexTest(schema, modules);
		await seed(t, 25);
		await t.run((ctx) => startContactCountReconcile(ctx));
		const gen = await generation(t);
		await stepOnce(t, gen, 10);

		vi.setSystemTime(Date.now() + STALLED_AFTER_MS + 1);
		expect(await t.run((ctx) => startContactCountReconcile(ctx))).toBe('resumed');
		expect(await generation(t)).toBe(gen);
		const before = await t.run((ctx) => loadCounterScope(ctx.db, CONTACT_LIVE_TOTAL_SCOPE));
		expect(before?.cursor).not.toBeNull();

		let outcome: ReconcileStepOutcome;
		do outcome = await stepOnce(t, gen, 10);
		while (outcome.status === 'continued');
		expect(outcome).toMatchObject({ status: 'finished', actual: 25 });
	});
});

// ── missing cache ───────────────────────────────────────────────────────────

describe('missing contact-count cache', () => {
	type Handler = (ctx: unknown, args: object) => Promise<{ totalContacts: number | null }>;
	const handlerOf = (fn: unknown) => (fn as { _handler: Handler })._handler;

	it('dashboards answer pending (null) without reading the contacts table', async () => {
		const t = convexTest(schema, modules);
		await seed(t, 500);
		for (const fn of [getStats, getAudienceStats]) {
			const { totalContacts, reads } = await t.run(async (raw) => {
				const { ctx, reads } = metered(raw);
				const result = await handlerOf(fn)(ctx, {});
				return { totalContacts: result.totalContacts, reads: reads() };
			});
			expect(totalContacts).toBeNull();
			// Counter row, settings, 30 daily rows or a few config rows — never 500 contacts.
			expect(reads).toBeLessThan(50);
		}
		expect(getFunctionName(api.analytics.dashboard.getStats)).toBe('analytics/dashboard:getStats');
	});

	it('recovery fills the count in the background, keeping zero apart from missing', async () => {
		const empty = convexTest(schema, modules);
		expect(await cached(empty)).toBeNull();
		expect(await empty.run((ctx) => recoverMissingContactCount(ctx))).toBe('started');
		await empty.finishAllScheduledFunctions(vi.runAllTimers);
		expect(await cached(empty)).toBe(0);
		// Zero is a cached count: recovery does not run again.
		expect(await empty.run((ctx) => recoverMissingContactCount(ctx))).toBe('cached');

		const restored = convexTest(schema, modules);
		await seed(restored, 42, 3);
		await restored.run((ctx) => recoverMissingContactCount(ctx));
		await restored.finishAllScheduledFunctions(vi.runAllTimers);
		expect(await cached(restored)).toBe(42);
		const stats = await restored.run((ctx) => handlerOf(getStats)(ctx, {}));
		expect(stats.totalContacts).toBe(42);
	});
});
