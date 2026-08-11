import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import type { Doc, Id } from '../../_generated/dataModel';
import schema from '../../schema';
import { claim, complete, fail, getNextQueued, heartbeat, reclaimStale } from '../workerTasks';

const modules = import.meta.glob('../../**/*.*s');

type Ctx = Parameters<Parameters<ReturnType<typeof convexTest>['run']>[0]>[0];

// Unwrap the registered functions to their raw handlers so a real convex-test db
// ctx can drive them without going through the auth floor / component calls.
const getNextH = (
	getNextQueued as unknown as { _handler: (c: Ctx, a: unknown) => Promise<unknown> }
)._handler;
const claimH = (claim as unknown as { _handler: (c: Ctx, a: unknown) => Promise<unknown> })
	._handler;
const heartbeatH = (heartbeat as unknown as { _handler: (c: Ctx, a: unknown) => Promise<unknown> })
	._handler;
const completeH = (complete as unknown as { _handler: (c: Ctx, a: unknown) => Promise<unknown> })
	._handler;
const failH = (fail as unknown as { _handler: (c: Ctx, a: unknown) => Promise<unknown> })._handler;
const reclaimH = (reclaimStale as unknown as { _handler: (c: Ctx, a: unknown) => Promise<unknown> })
	._handler;

const OWNED_KIND = 'plugin.lab.seed-test';

async function seedTask(
	ctx: Ctx,
	overrides: Partial<Doc<'pluginTasks'>> = {}
): Promise<Id<'pluginTasks'>> {
	const now = Date.now();
	return await ctx.db.insert('pluginTasks', {
		organizationId: 'org-1',
		pluginId: 'lab',
		jobKind: OWNED_KIND,
		payload: '{}',
		timeoutMs: 60_000,
		status: 'queued',
		attempts: 0,
		maxAttempts: 3,
		isCancelRequested: false,
		createdAt: now,
		updatedAt: now,
		...overrides,
	});
}

async function auditRows(ctx: Ctx): Promise<Doc<'auditLogs'>[]> {
	return await ctx.db.query('auditLogs').take(50);
}

describe('claim / getNextQueued', () => {
	it('returns the oldest queued job and claims it exactly once', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			const first = await seedTask(ctx, { createdAt: 1 });
			await seedTask(ctx, { createdAt: 2 });

			const next = (await getNextH(ctx, {})) as { taskId: Id<'pluginTasks'> } | null;
			expect(next?.taskId).toBe(first);

			const claimed = (await claimH(ctx, { taskId: first })) as {
				claimed: boolean;
				job?: { attempts: number };
			};
			expect(claimed.claimed).toBe(true);
			expect(claimed.job?.attempts).toBe(1);
			expect((await ctx.db.get(first))!.status).toBe('running');

			// A running job cannot be claimed again.
			const second = (await claimH(ctx, { taskId: first })) as { claimed: boolean };
			expect(second.claimed).toBe(false);
		});
	});

	it('marks a job cancelled at claim if cancel was requested while queued (never runs)', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			const id = await seedTask(ctx, { isCancelRequested: true });
			const result = (await claimH(ctx, { taskId: id })) as {
				claimed: boolean;
				cancelled?: boolean;
			};
			expect(result).toEqual({ claimed: false, cancelled: true });
			const task = (await ctx.db.get(id))!;
			expect(task.status).toBe('cancelled');
			expect(task.attempts).toBe(0); // never executed

			const audit = await auditRows(ctx);
			expect(audit[0]!.details?.['operation']).toBe('worker.run');
			expect(audit[0]!.details?.['reasonCode']).toBe('worker_cancelled');
		});
	});
});

describe('heartbeat', () => {
	it('refreshes the lease and surfaces a cancel request on a running job', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			const id = await seedTask(ctx, {
				status: 'running',
				heartbeatAt: 1,
				isCancelRequested: true,
			});
			const beat = (await heartbeatH(ctx, { taskId: id })) as {
				alive: boolean;
				cancelRequested: boolean;
			};
			expect(beat).toEqual({ alive: true, cancelRequested: true });
			expect((await ctx.db.get(id))!.heartbeatAt).toBeGreaterThan(1);
		});
	});

	it('reports not-alive for a job that is no longer running', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			const id = await seedTask(ctx, { status: 'succeeded' });
			expect(await heartbeatH(ctx, { taskId: id })).toEqual({
				alive: false,
				cancelRequested: false,
			});
		});
	});
});

describe('complete', () => {
	it('marks a running job succeeded and stores a clamped result; audits completion', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			const id = await seedTask(ctx, { status: 'running', attempts: 1 });
			const done = (await completeH(ctx, { taskId: id, result: 'ab' })) as { ok: boolean };
			expect(done.ok).toBe(true);
			const task = (await ctx.db.get(id))!;
			expect(task.status).toBe('succeeded');
			expect(task.result).toBe('a b'); // control char stripped
			const audit = await auditRows(ctx);
			expect(audit[0]!.details?.['operation']).toBe('worker.run');
			expect(audit[0]!.details?.['outcome']).toBe('completed');
			// The result text is never copied into the audit row.
			expect(JSON.stringify(audit)).not.toContain('a b');
		});
	});

	it('will not complete a job that is not running (idempotency guard)', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			const id = await seedTask(ctx, { status: 'queued' });
			expect(await completeH(ctx, { taskId: id })).toEqual({ ok: false });
			expect((await ctx.db.get(id))!.status).toBe('queued');
		});
	});
});

describe('fail — retries, terminal failure, and cancellation cannot be escaped', () => {
	it('requeues for retry while attempts remain', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			const id = await seedTask(ctx, {
				status: 'running',
				attempts: 1,
				maxAttempts: 3,
				heartbeatAt: 5,
			});
			const result = (await failH(ctx, { taskId: id, errorMessage: 'boom' })) as {
				status: string;
				retried: boolean;
			};
			expect(result).toEqual({ status: 'queued', retried: true });
			const task = (await ctx.db.get(id))!;
			expect(task.status).toBe('queued');
			expect(task.heartbeatAt).toBeUndefined();
			// A transient retry is not a terminal audit.
			expect(await auditRows(ctx)).toHaveLength(0);
		});
	});

	it('fails terminally once the retry budget is exhausted and audits it', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			const id = await seedTask(ctx, { status: 'running', attempts: 3, maxAttempts: 3 });
			const result = (await failH(ctx, {
				taskId: id,
				errorMessage: 'still broken',
				reasonCode: 'worker_timeout',
			})) as { status: string; retried: boolean };
			expect(result).toEqual({ status: 'failed', retried: false });
			expect((await ctx.db.get(id))!.status).toBe('failed');
			const audit = await auditRows(ctx);
			expect(audit[0]!.details?.['reasonCode']).toBe('worker_timeout');
		});
	});

	it('marks a cancelled running job cancelled — never retried — even with budget left', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			const id = await seedTask(ctx, {
				status: 'running',
				attempts: 1,
				maxAttempts: 5,
				isCancelRequested: true,
			});
			const result = (await failH(ctx, { taskId: id, errorMessage: 'killed' })) as {
				status: string;
				retried: boolean;
			};
			expect(result).toEqual({ status: 'cancelled', retried: false });
			expect((await ctx.db.get(id))!.status).toBe('cancelled');
			expect((await auditRows(ctx))[0]!.details?.['reasonCode']).toBe('worker_cancelled');
		});
	});
});

describe('reclaimStale — crashed worker lease recovery', () => {
	it('requeues a running job whose heartbeat is older than the lease', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			const stale = await seedTask(ctx, {
				status: 'running',
				attempts: 1,
				maxAttempts: 3,
				heartbeatAt: 1_000,
			});
			const fresh = await seedTask(ctx, {
				status: 'running',
				attempts: 1,
				maxAttempts: 3,
				heartbeatAt: 9_000,
			});
			const result = (await reclaimH(ctx, { now: 10_000, leaseMs: 5_000 })) as {
				reclaimed: number;
			};
			expect(result.reclaimed).toBe(1);
			expect((await ctx.db.get(stale))!.status).toBe('queued');
			expect((await ctx.db.get(fresh))!.status).toBe('running');
		});
	});

	it('startup path (leaseMs: 0) reclaims a running job even with a fresh heartbeat', async () => {
		// The realistic crash-then-quick-restart case: the worker was seconds into a
		// job (recent heartbeat) when it crashed; `restart: unless-stopped` restarts
		// it immediately. A fresh single worker holds no running jobs, so startup
		// reclaim with leaseMs:0 must requeue this job — a lease window longer than
		// the job budget would skip it and strand it `running` forever.
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			const now = 10_000_000;
			const recent = await seedTask(ctx, {
				status: 'running',
				attempts: 1,
				maxAttempts: 3,
				claimedAt: now - 120_000, // claimed 2 min ago
				heartbeatAt: now - 2_000, // heartbeat 2s ago — well inside any lease
			});
			const result = (await reclaimH(ctx, { now, leaseMs: 0 })) as { reclaimed: number };
			expect(result.reclaimed).toBe(1);
			expect((await ctx.db.get(recent))!.status).toBe('queued');
		});
	});

	it('terminally fails a reclaimed job with no retries left', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			const id = await seedTask(ctx, {
				status: 'running',
				attempts: 3,
				maxAttempts: 3,
				heartbeatAt: 1,
			});
			await reclaimH(ctx, { now: 10_000, leaseMs: 5_000 });
			expect((await ctx.db.get(id))!.status).toBe('failed');
		});
	});
});
