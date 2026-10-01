/**
 * Integration import page continuation and recovery (#999): a committed page
 * always has its successor (or the run's end) committed with it, a lost hop is
 * re-issued by the recovery sweep without counting anything twice, and a run
 * that cannot continue ends visibly instead of blocking every later import.
 *
 * Faults are injected into the real page commit (`commitIntegrationPage`) at
 * each point a page's work used to be split across calls: after the provider
 * fetch, after the contact and suppression stages, while scheduling the next
 * page, and after the progress write. Each one must leave the run exactly as it
 * was before the page, and the sweep must then finish the import with exact
 * counts. The scheduler runs on fake timers, so every hop is driven
 * explicitly. `global.fetch` is the only other fake.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { modules } from '../../__tests__/testModules';
import { enableFeatures } from '../../__tests__/factories';
import { api, internal } from '../../_generated/api';
import type { Doc, Id } from '../../_generated/dataModel';
import { expectScheduledFailure } from '../../__tests__/helpers/scheduledFailures';
import {
	abortWorkspaceDeletion,
	openWorkspaceDeletionFence,
} from '../../__tests__/helpers/workspaceDeletionFence';
import { isSealedImportCredential, sealImportCredential } from '../credentialSeal';
import { MAX_PAGE_RECOVERIES, UNLEASED_RUN_GRACE_MS } from '../recovery';
import { fakeMailchimpAudience } from './fakeMailchimpAudience';

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		requireOrgPermission: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
	};
});

const API_KEY = 'abc123-us21';
const CONFIG = {
	provider: 'mailchimp' as const,
	apiKey: API_KEY,
	listId: 'list_a',
	importSuppressions: true,
};

function subscribers(prefix: string, count: number) {
	return Array.from({ length: count }, (_, i) => ({
		email: `${prefix}-${i}@example.com`,
		status: 'subscribed',
	}));
}

/**
 * A three-page audience: 99 subscribers and one bounce, then 100 subscribers,
 * then 49 subscribers and one departure who is not a contact here.
 */
const AUDIENCE: { email: string; status: string }[] = [
	...subscribers('p1', 99),
	{ email: 'bounced@example.com', status: 'cleaned' },
	...subscribers('p2', 100),
	...subscribers('p3', 49),
	{ email: 'stranger@example.com', status: 'unsubscribed' },
];
const TOTAL_IMPORTED = 99 + 100 + 49;
/** Three audience pages, then the closing pass over members changed during the run. */
const PROVIDER_CALLS = 4;

function audienceFetch() {
	return fakeMailchimpAudience(AUDIENCE).fetch;
}

// ─── Fault injection into the real page commit ──────────────────────────────

type Fault = 'afterFetch' | 'afterStages' | 'duringScheduling' | 'afterProgress';
type Handler = (ctx: Record<string, unknown>, args: Record<string, unknown>) => Promise<unknown>;

/** Which commit (1-based) fails, and how; `times` consecutive commits from there. */
let fault: { kind: Fault; atCommit: number; times: number } | null = null;
let commits = 0;

function injected(kind: Fault): Error {
	return new Error(`injected fault: ${kind}`);
}

const faultyModules = {
	...modules,
	'../integrationImports/pageCommit.ts': async () => {
		const mod = (await modules['../integrationImports/pageCommit.ts']!()) as Record<
			string,
			unknown
		>;
		const real = mod['commitIntegrationPage'] as { _handler: Handler };
		const _handler: Handler = async (ctx, args) => {
			commits++;
			const active =
				fault !== null && commits >= fault.atCommit && commits < fault.atCommit + fault.times
					? fault.kind
					: null;
			if (active === 'afterFetch') throw injected(active);
			let handlerCtx = ctx;
			if (active === 'afterStages') {
				// The commit's own first patch is its progress write, after both
				// nested stages have written.
				const db = ctx['db'] as Record<string, unknown>;
				handlerCtx = {
					...ctx,
					db: new Proxy(db, {
						get(target, prop) {
							if (prop === 'patch') {
								return async () => {
									throw injected(active);
								};
							}
							const value = Reflect.get(target, prop, target);
							return typeof value === 'function' ? value.bind(target) : value;
						},
					}),
				};
			}
			if (active === 'duringScheduling') {
				const scheduler = ctx['scheduler'] as Record<string, unknown>;
				handlerCtx = {
					...ctx,
					scheduler: {
						...scheduler,
						runAfter: async () => {
							throw injected(active);
						},
					},
				};
			}
			const outcome = await real._handler(handlerCtx, args);
			if (active === 'afterProgress') throw injected(active);
			return outcome;
		};
		return { ...mod, commitIntegrationPage: Object.assign(() => undefined, real, { _handler }) };
	},
};

// ─── Harness ────────────────────────────────────────────────────────────────

type Harness = ReturnType<typeof convexTest>;

async function newRun(): Promise<{ t: Harness; importId: Id<'integrationImports'> }> {
	const t = convexTest(schema, faultyModules);
	await enableFeatures(t, ['imports.mailchimp']);
	const importId = await t.mutation(api.integrationImports.walker.startIntegrationImport, {
		config: CONFIG,
		handleDuplicates: 'skip',
	});
	return { t, importId };
}

async function drain(t: Harness): Promise<void> {
	await t.finishAllScheduledFunctions(vi.runAllTimers);
}

async function sweep(t: Harness) {
	return await t.mutation(internal.integrationImports.recovery.recoverStalledImports, {});
}

async function readRun(t: Harness, id: Id<'integrationImports'>) {
	return (await t.run(async (ctx) => ctx.db.get(id))) as Doc<'integrationImports'>;
}

async function pendingHops(t: Harness) {
	const jobs = await t.run(async (ctx) => ctx.db.system.query('_scheduled_functions').collect());
	return jobs.filter(
		(job) =>
			job.name === 'integrationImports/walker:processIntegrationPage' &&
			job.state.kind === 'pending'
	);
}

async function counts(t: Harness) {
	return await t.run(async (ctx) => ({
		contacts: (await ctx.db.query('contacts').collect()).length,
		blocked: (await ctx.db.query('blockedEmails').collect()).length,
	}));
}

function providerCalls(fetch: ReturnType<typeof audienceFetch>): number {
	return fetch.mock.calls.filter((call) => String(call[0]).includes('api.mailchimp.com')).length;
}

/** The finished run, every page counted exactly once. */
function expectExactTotals(run: Doc<'integrationImports'>) {
	expect(run.status).toBe('completed');
	expect(run.imported).toBe(TOTAL_IMPORTED);
	expect(run.suppressionCounts).toMatchObject({ bouncedHard: 1, noContact: 1 });
	expect(run.errors).toEqual([]);
	expect(run.resumeConfig).toBeUndefined();
}

const originalFetch = global.fetch;

beforeEach(() => {
	fault = null;
	commits = 0;
	vi.useFakeTimers();
	vi.stubEnv('INSTANCE_SECRET', 'page-recovery-test-secret');
	// Hops that fail on purpose below.
	expectScheduledFailure('integrationImports/walker:processIntegrationPage');
});

afterEach(() => {
	global.fetch = originalFetch;
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('integration import page continuation (#999)', () => {
	it('keeps the sealed config on the run for recovery, never the key, and drops it at the end', async () => {
		global.fetch = audienceFetch();
		const { t, importId } = await newRun();

		const started = await readRun(t, importId);
		expect(started.resumeConfig).toMatchObject({ provider: 'mailchimp', listId: 'list_a' });
		const stored = (started.resumeConfig as { apiKey: string }).apiKey;
		expect(stored).not.toBe(API_KEY);
		expect(isSealedImportCredential(stored)).toBe(true);
		expect(started.pageJobId).toBeDefined();

		const progress = await t.query(api.integrationImports.walker.getImportProgress, {});
		expect(progress).not.toHaveProperty('resumeConfig');

		await drain(t);
		expectExactTotals(await readRun(t, importId));
	});

	it.each<Fault>(['afterFetch', 'afterStages', 'duringScheduling', 'afterProgress'])(
		'a fault %s on a page rolls the page back whole, and the sweep finishes the run exactly',
		async (kind) => {
			const fetch = audienceFetch();
			global.fetch = fetch;
			const { t, importId } = await newRun();
			// Page one commits; page two's commit fails (it is not the last page,
			// so it has a successor to schedule).
			fault = { kind, atCommit: 2, times: 1 };
			await drain(t);

			const stalled = await readRun(t, importId);
			expect(stalled.status).toBe('running');
			expect(JSON.parse(stalled.cursor)).toMatchObject({ pass: 'audience', offset: 100 });
			expect(stalled.pagesCommitted).toBe(1);
			expect(stalled.imported).toBe(99);
			expect(stalled.suppressionCounts).toMatchObject({ bouncedHard: 1, noContact: 0 });
			// Nothing of page two persisted, and nothing is queued behind it.
			expect(await counts(t)).toEqual({ contacts: 99, blocked: 1 });
			expect(await pendingHops(t)).toHaveLength(0);

			expect(await sweep(t)).toEqual({ live: 0, resumed: 1, failed: 0 });
			expect((await readRun(t, importId)).pageRecoveries).toBe(1);
			await drain(t);

			const finished = await readRun(t, importId);
			expectExactTotals(finished);
			expect(finished.pageRecoveries).toBeUndefined();
			expect(await counts(t)).toEqual({ contacts: TOTAL_IMPORTED, blocked: 1 });
			// Every page once, page two twice (the lost hop and its re-issue).
			expect(providerCalls(fetch)).toBe(PROVIDER_CALLS + 1);
		}
	);

	it('a fault on the first page leaves a run the sweep can still start', async () => {
		global.fetch = audienceFetch();
		const { t, importId } = await newRun();
		fault = { kind: 'duringScheduling', atCommit: 1, times: 1 };
		await drain(t);

		const stalled = await readRun(t, importId);
		expect(stalled).toMatchObject({
			status: 'running',
			cursor: '',
			pagesCommitted: 0,
			imported: 0,
		});
		expect(await counts(t)).toEqual({ contacts: 0, blocked: 0 });

		await sweep(t);
		await drain(t);
		expectExactTotals(await readRun(t, importId));
	});

	it('leaves a run whose hop is queued or running alone', async () => {
		global.fetch = audienceFetch();
		const { t, importId } = await newRun();

		expect(await sweep(t)).toEqual({ live: 1, resumed: 0, failed: 0 });
		expect(await pendingHops(t)).toHaveLength(1);

		await drain(t);
		expectExactTotals(await readRun(t, importId));
	});

	it('ends a run whose page keeps failing, with a reason, and frees the start gate', async () => {
		global.fetch = audienceFetch();
		const { t, importId } = await newRun();
		fault = { kind: 'afterStages', atCommit: 1, times: 100 };
		await drain(t);

		for (let attempt = 1; attempt <= MAX_PAGE_RECOVERIES; attempt++) {
			expect(await sweep(t)).toEqual({ live: 0, resumed: 1, failed: 0 });
			await drain(t);
		}
		expect(await sweep(t)).toEqual({ live: 0, resumed: 0, failed: 1 });

		const ended = await readRun(t, importId);
		expect(ended.status).toBe('failed');
		expect(ended.errors.join(' ')).toMatch(/did not complete after 3 retries/);
		expect(ended.resumeConfig).toBeUndefined();
		expect(ended.imported).toBe(0);
		expect(await counts(t)).toEqual({ contacts: 0, blocked: 0 });

		fault = null;
		await expect(
			t.mutation(api.integrationImports.walker.startIntegrationImport, {
				config: CONFIG,
				handleDuplicates: 'skip',
			})
		).resolves.toBeDefined();
	});

	it('ends a run it cannot resume (no sealed config) instead of leaving it running', async () => {
		vi.unstubAllEnvs();
		vi.stubEnv('INSTANCE_SECRET', '');
		global.fetch = audienceFetch();
		const { t, importId } = await newRun();
		// Without an instance secret the key would be stored in plaintext, so it is
		// not stored at all.
		expect((await readRun(t, importId)).resumeConfig).toBeUndefined();
		fault = { kind: 'afterFetch', atCommit: 1, times: 1 };
		await drain(t);

		expect(await sweep(t)).toEqual({ live: 0, resumed: 0, failed: 1 });
		const ended = await readRun(t, importId);
		expect(ended.status).toBe('failed');
		expect(ended.errors.join(' ')).toMatch(/cannot be resumed/);
	});

	it('a duplicate hop for a page that is already committed counts and writes nothing', async () => {
		const fetch = audienceFetch();
		global.fetch = fetch;
		const { t, importId } = await newRun();
		const hop = {
			importId,
			config: (await readRun(t, importId)).resumeConfig!,
			cursor: '',
			page: 0,
		};

		// Two hops for page one fetch at the same time; only one may commit.
		await Promise.all([
			t.action(internal.integrationImports.walker.processIntegrationPage, hop),
			t.action(internal.integrationImports.walker.processIntegrationPage, hop),
		]);
		const afterRace = await readRun(t, importId);
		expect(afterRace.imported).toBe(99);
		expect(afterRace.pagesCommitted).toBe(1);
		expect(await pendingHops(t)).toHaveLength(2); // the start's queued hop + ONE successor

		// A re-delivery after the commit does not even fetch.
		const before = providerCalls(fetch);
		await t.action(internal.integrationImports.walker.processIntegrationPage, hop);
		expect(providerCalls(fetch)).toBe(before);

		await drain(t);
		expectExactTotals(await readRun(t, importId));
		expect(await counts(t)).toEqual({ contacts: TOTAL_IMPORTED, blocked: 1 });
	});

	it('a credential that no longer opens fails the run visibly instead of stranding it', async () => {
		global.fetch = audienceFetch();
		const { t, importId } = await newRun();
		// The instance secret changed between the start and the hop.
		vi.stubEnv('INSTANCE_SECRET', 'a-different-secret');
		await drain(t);

		const run = await readRun(t, importId);
		expect(run.status).toBe('failed');
		expect(run.errors.join(' ')).toMatch(/Could not open the stored provider credential/);
		expect(run.errors.join(' ')).not.toContain(API_KEY);
		expect(await sweep(t)).toEqual({ live: 0, resumed: 0, failed: 0 });
	});

	it('stands down while a workspace deletion runs, then recovers the run once it ends', async () => {
		global.fetch = audienceFetch();
		const { t, importId } = await newRun();
		// The deletion's quiesce phase cancels the queued hop and opens the fence;
		// the sweep reaches `integrationImports` only near the end of its walk.
		const jobId = await t.run(async (ctx) => {
			await ctx.scheduler.cancel((await ctx.db.get(importId))!.pageJobId!);
			return await openWorkspaceDeletionFence(ctx);
		});
		const before = await readRun(t, importId);

		expect(await sweep(t)).toEqual({ live: 0, resumed: 0, failed: 0 });
		expect(await readRun(t, importId)).toEqual(before);
		expect(await pendingHops(t)).toHaveLength(0);

		// An aborted deletion lifts the fence and leaves the run in place: the
		// next sweep picks it up as usual.
		await t.run(async (ctx) => abortWorkspaceDeletion(ctx, jobId));
		expect(await sweep(t)).toEqual({ live: 0, resumed: 1, failed: 0 });
		await drain(t);
		expectExactTotals(await readRun(t, importId));
	});

	it('a failing hop cannot append to or reopen a cancelled run', async () => {
		global.fetch = audienceFetch();
		const { t, importId } = await newRun();
		await t.mutation(api.integrationImports.walker.cancelImport, { importId });

		await t.mutation(internal.integrationImports.walker.completeImport, {
			importId,
			status: 'failed',
			errorMessage: 'Could not open the stored provider credential: x',
			cursor: '',
			page: 0,
		});
		await drain(t);
		expect(await sweep(t)).toEqual({ live: 0, resumed: 0, failed: 0 });

		const run = await readRun(t, importId);
		expect(run.status).toBe('failed');
		expect(run.errors).toEqual(['Cancelled by user']);
		expect(run.resumeConfig).toBeUndefined();
		expect(await counts(t)).toEqual({ contacts: 0, blocked: 0 });
	});
});

// ─── Runs the previous release started ──────────────────────────────────────

describe('integration import runs from the previous release', () => {
	async function seedLegacyRun(t: Harness, overrides: Partial<Doc<'integrationImports'>> = {}) {
		return await t.run(async (ctx) =>
			ctx.db.insert('integrationImports', {
				provider: 'mailchimp',
				status: 'running',
				cursor: '100',
				imported: 99,
				updated: 0,
				skipped: 0,
				failed: 0,
				errors: [],
				handleDuplicates: 'skip',
				startedAt: Date.now(),
				...overrides,
			})
		);
	}

	it('continues from a hop that release queued, and becomes resumable', async () => {
		global.fetch = audienceFetch();
		const t = convexTest(schema, faultyModules);
		const importId = await seedLegacyRun(t, { cursor: '', imported: 0 });
		const sealed = { ...CONFIG, apiKey: await sealImportCredential(API_KEY) };

		// The previous release's hop carries no page number.
		await t.action(internal.integrationImports.walker.processIntegrationPage, {
			importId,
			config: sealed,
			cursor: '',
		});

		const continued = await readRun(t, importId);
		expect(continued).toMatchObject({ status: 'running', pagesCommitted: 1 });
		expect(JSON.parse(continued.cursor)).toMatchObject({ pass: 'audience', offset: 100 });
		expect(continued.resumeConfig).toEqual(sealed);
		expect(continued.pageJobId).toBeDefined();

		await drain(t);
		expectExactTotals(await readRun(t, importId));
	});

	it('still accepts that release’s progress writes on its own rows only', async () => {
		const t = convexTest(schema, faultyModules);
		const legacy = await seedLegacyRun(t);
		const current = await seedLegacyRun(t, { pagesCommitted: 1 });
		const progress = {
			imported: 10,
			updated: 0,
			skipped: 0,
			failed: 0,
			errors: [],
			newCursor: '200',
		};

		await t.mutation(internal.integrationImports.walker.updateImportProgress, {
			importId: legacy,
			...progress,
		});
		await t.mutation(internal.integrationImports.walker.updateImportProgress, {
			importId: current,
			...progress,
		});

		expect(await readRun(t, legacy)).toMatchObject({ imported: 109, cursor: '200' });
		expect((await readRun(t, legacy)).lastPageAt).toBeDefined();
		expect(await readRun(t, current)).toMatchObject({ imported: 99, cursor: '100' });
	});

	it('waits out the grace on a run without a lease, then ends it if it cannot resume', async () => {
		const t = convexTest(schema, faultyModules);
		const importId = await seedLegacyRun(t);

		expect(await sweep(t)).toEqual({ live: 1, resumed: 0, failed: 0 });
		vi.setSystemTime(Date.now() + UNLEASED_RUN_GRACE_MS + 1);
		expect(await sweep(t)).toEqual({ live: 0, resumed: 0, failed: 1 });

		const run = await readRun(t, importId);
		expect(run.status).toBe('failed');
		expect(run.errors.join(' ')).toMatch(/cannot be resumed/);
	});
});
