import { PLUGIN_WORKER_MAX_PENDING_JOBS } from '@owlat/plugin-kit';
import { convexTest } from 'convex-test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Doc, Id } from '../../_generated/dataModel';
import schema from '../../schema';
import {
	claim,
	complete,
	enqueue,
	fail,
	getNextQueued,
	heartbeat,
	listRecent,
	reclaimStale,
	requestCancel,
} from '../workerTasks';

const modules = import.meta.glob('../../**/*.*s');

/** Controls what the (mocked) system authorizer returns for enqueue. */
const authz = vi.hoisted(() => ({
	scope: null as null | { organizationId: string; userId: string; pluginId: string },
}));
vi.mock('../authorization', () => ({
	authorizeSystemBundledPlugin: vi.fn(async () => authz.scope),
}));

const session = vi.hoisted(() => ({ organizationId: 'org-1', canManage: true }));
vi.mock('../../lib/sessionOrganization', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../lib/sessionOrganization')>()),
	getSingletonOrganizationId: vi.fn(async () => session.organizationId),
	// Satisfy the authed floor without a live BetterAuth session component.
	requireOrgMember: vi.fn(async () => ({
		userId: 'operator',
		activeOrganizationId: session.organizationId,
		role: 'owner',
	})),
	getMutationContext: vi.fn(async () => ({
		session: { userId: 'operator', activeOrganizationId: session.organizationId, role: 'owner' },
	})),
	requireOrgPermission: vi.fn(async () => {
		if (!session.canManage) throw new Error('forbidden');
	}),
}));

type Ctx = Parameters<Parameters<ReturnType<typeof convexTest>['run']>[0]>[0];

// Unwrap the registered functions to their raw handlers so a real convex-test db
// ctx can drive them without going through the auth floor / component calls.
const enqueueH = (enqueue as unknown as { _handler: (c: Ctx, a: unknown) => Promise<unknown> })
	._handler;
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
const requestCancelH = (
	requestCancel as unknown as { _handler: (c: Ctx, a: unknown) => Promise<unknown> }
)._handler;
const listRecentH = (
	listRecent as unknown as { _handler: (c: Ctx, a: unknown) => Promise<unknown> }
)._handler;

const OWNED_KIND = 'plugin.lab.seed-test';

function grant(pluginId = 'lab', organizationId = 'org-1') {
	authz.scope = { organizationId, userId: 'system:bundled_plugin', pluginId };
}

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

beforeEach(() => {
	authz.scope = null;
	session.organizationId = 'org-1';
	session.canManage = true;
});

describe('enqueue authorization + validation (fail closed)', () => {
	it('inserts a queued job attributed to the plugin and audits the enqueue', async () => {
		const t = convexTest(schema, modules);
		grant();
		await t.run(async (ctx) => {
			const id = (await enqueueH(ctx, {
				pluginId: 'lab',
				jobKind: OWNED_KIND,
				payload: '{"n":1}',
			})) as Id<'pluginTasks'>;
			const task = (await ctx.db.get(id))!;
			expect(task.status).toBe('queued');
			expect(task.attempts).toBe(0);
			expect(task.pluginId).toBe('lab');
			expect(task.organizationId).toBe('org-1');

			const audit = await auditRows(ctx);
			expect(audit).toHaveLength(1);
			expect(audit[0]!.pluginId).toBe('lab');
			expect(audit[0]!.details?.['operation']).toBe('worker.enqueue');
			expect(audit[0]!.details?.['outcome']).toBe('completed');
		});
	});

	it('enqueues nothing when the plugin is unauthorized (disabled/ungranted)', async () => {
		const t = convexTest(schema, modules);
		authz.scope = null;
		await t.run(async (ctx) => {
			const id = await enqueueH(ctx, { pluginId: 'lab', jobKind: OWNED_KIND, payload: '{}' });
			expect(id).toBeNull();
			expect(await ctx.db.query('pluginTasks').take(1)).toHaveLength(0);
			expect(await auditRows(ctx)).toHaveLength(0);
		});
	});

	it('rejects a cross-plugin job kind and audits the denial', async () => {
		const t = convexTest(schema, modules);
		grant('lab');
		await t.run(async (ctx) => {
			const id = await enqueueH(ctx, {
				pluginId: 'lab',
				jobKind: 'plugin.other.seed-test',
				payload: '{}',
			});
			expect(id).toBeNull();
			expect(await ctx.db.query('pluginTasks').take(1)).toHaveLength(0);
			const audit = await auditRows(ctx);
			expect(audit).toHaveLength(1);
			expect(audit[0]!.details?.['outcome']).toBe('denied');
		});
	});

	it('rejects an oversized payload (untrusted input bound)', async () => {
		const t = convexTest(schema, modules);
		grant();
		await t.run(async (ctx) => {
			const id = await enqueueH(ctx, {
				pluginId: 'lab',
				jobKind: OWNED_KIND,
				payload: 'x'.repeat(64 * 1024 + 1),
			});
			expect(id).toBeNull();
			expect(await ctx.db.query('pluginTasks').take(1)).toHaveLength(0);
			expect((await auditRows(ctx))[0]!.details?.['outcome']).toBe('denied');
		});
	});

	it('clamps an over-large retry budget to the host ceiling', async () => {
		const t = convexTest(schema, modules);
		grant();
		await t.run(async (ctx) => {
			const id = (await enqueueH(ctx, {
				pluginId: 'lab',
				jobKind: OWNED_KIND,
				payload: '{}',
				maxAttempts: 9999,
				timeoutMs: 10,
			})) as Id<'pluginTasks'>;
			const task = (await ctx.db.get(id))!;
			expect(task.maxAttempts).toBe(5);
			expect(task.timeoutMs).toBe(1_000); // clamped up to the minimum budget
		});
	});

	it('caps a plugin at PLUGIN_WORKER_MAX_PENDING_JOBS in-flight jobs (N+1 fails closed)', async () => {
		const t = convexTest(schema, modules);
		grant();
		await t.run(async (ctx) => {
			// Fill the queue to the cap with a mix of queued + running (both count).
			for (let i = 0; i < PLUGIN_WORKER_MAX_PENDING_JOBS; i += 1) {
				await seedTask(ctx, { status: i % 2 === 0 ? 'queued' : 'running' });
			}
			const before = (await ctx.db.query('pluginTasks').collect()).length;
			expect(before).toBe(PLUGIN_WORKER_MAX_PENDING_JOBS);

			// The N+1th enqueue is rejected and inserts nothing.
			const id = await enqueueH(ctx, { pluginId: 'lab', jobKind: OWNED_KIND, payload: '{}' });
			expect(id).toBeNull();
			expect((await ctx.db.query('pluginTasks').collect()).length).toBe(before);

			// The denial is audited against the (authorized) plugin as a budget denial.
			const denials = (await auditRows(ctx)).filter((row) => row.details?.['outcome'] === 'denied');
			expect(denials).toHaveLength(1);
			expect(denials[0]!.pluginId).toBe('lab');
			expect(denials[0]!.details?.['operation']).toBe('worker.enqueue');
			expect(denials[0]!.details?.['reasonCode']).toBe('access_or_budget_denied');
		});
	});

	it('does not count terminal jobs toward the in-flight cap', async () => {
		const t = convexTest(schema, modules);
		grant();
		await t.run(async (ctx) => {
			// A plugin's completed history — far beyond the cap — must not block it.
			for (let i = 0; i < PLUGIN_WORKER_MAX_PENDING_JOBS + 5; i += 1) {
				await seedTask(ctx, {
					status: i % 3 === 0 ? 'succeeded' : i % 3 === 1 ? 'failed' : 'cancelled',
				});
			}
			const id = await enqueueH(ctx, { pluginId: 'lab', jobKind: OWNED_KIND, payload: '{}' });
			expect(id).not.toBeNull();
			const task = (await ctx.db.get(id as Id<'pluginTasks'>))!;
			expect(task.status).toBe('queued');
		});
	});

	it('scopes the in-flight cap per plugin (a busy plugin does not block another)', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			// Fill plugin "busy" to the cap.
			for (let i = 0; i < PLUGIN_WORKER_MAX_PENDING_JOBS; i += 1) {
				await seedTask(ctx, { pluginId: 'busy', jobKind: 'plugin.busy.seed-test' });
			}
			// A different plugin at zero in-flight jobs still enqueues.
			grant('lab');
			const ok = await enqueueH(ctx, { pluginId: 'lab', jobKind: OWNED_KIND, payload: '{}' });
			expect(ok).not.toBeNull();
			// The busy plugin itself is now capped.
			grant('busy');
			const blocked = await enqueueH(ctx, {
				pluginId: 'busy',
				jobKind: 'plugin.busy.seed-test',
				payload: '{}',
			});
			expect(blocked).toBeNull();
		});
	});
});

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

describe('requestCancel (operator)', () => {
	it('flags a queued job for cancellation without terminating it inline', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			const id = await seedTask(ctx, { status: 'queued' });
			await requestCancelH(ctx, { taskId: id });
			const task = (await ctx.db.get(id))!;
			expect(task.isCancelRequested).toBe(true);
			expect(task.status).toBe('queued'); // worker converts it at claim
		});
	});

	it('refuses to cancel a job that has already finished', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			const id = await seedTask(ctx, { status: 'succeeded' });
			await expect(requestCancelH(ctx, { taskId: id })).rejects.toThrow();
		});
	});

	it('refuses to cancel a job owned by another organization', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			const id = await seedTask(ctx, { organizationId: 'org-2' });
			await expect(requestCancelH(ctx, { taskId: id })).rejects.toThrow();
		});
	});

	it('refuses cancellation without the manage permission', async () => {
		const t = convexTest(schema, modules);
		session.canManage = false;
		await t.run(async (ctx) => {
			const id = await seedTask(ctx, { status: 'running' });
			await expect(requestCancelH(ctx, { taskId: id })).rejects.toThrow('forbidden');
		});
	});
});

describe('listRecent', () => {
	it('returns only this organization’s jobs, newest first', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await seedTask(ctx, { organizationId: 'org-1', createdAt: 1 });
			await seedTask(ctx, { organizationId: 'org-1', createdAt: 2 });
			await seedTask(ctx, { organizationId: 'org-2', createdAt: 3 });
			const rows = (await listRecentH(ctx, {})) as Doc<'pluginTasks'>[];
			expect(rows).toHaveLength(2);
			expect(rows.every((r) => r.organizationId === 'org-1')).toBe(true);
		});
	});
});
