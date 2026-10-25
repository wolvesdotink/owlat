/**
 * Automation health: the automations list's last-7-days counts and the runs
 * they link to.
 *   - the window is today (UTC) and the six days before it, read off day
 *     buckets, never off runs, so its read cost does not grow with history;
 *   - an entry, a failed step and a stalled run each count once, in the
 *     transaction that ends (or starts) the run, and a duplicate counts nothing;
 *   - a run cancelled because its context went away (the automation paused, a
 *     step removed) is not a failure;
 *   - the affected-runs filter returns exactly the runs a count counted;
 *   - a pause or resume returns the stamp its undo needs, and the undo is
 *     refused once anything (an admin, the failure breaker) changed the status.
 */

import { convexTest } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import type { Doc, Id } from '../../_generated/dataModel';
import type { DatabaseReader } from '../../_generated/server';
import type * as SessionOrganization from '../../lib/sessionOrganization';
import {
	createTestAutomation,
	createTestAutomationStep,
	createTestContact,
	enableFeatures,
} from '../../__tests__/factories';
import {
	healthWindowStart,
	MAX_HEALTH_SUMMARY_IDS,
	recordAutomationHealth,
	summarizeAutomationHealth,
} from '../health';
import { failStepAndCancelRun } from '../stepRunTransitions';
import { recordAutomationRunFailure, AUTOMATION_FAILURE_BREAKER_THRESHOLD } from '../lifecycle';
import { STALLED_RUN_GRACE_MS } from '../stalledRuns';
import { walkerModules, type T } from './walkerHarness';

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof SessionOrganization>('../../lib/sessionOrganization');
	const { realPermissionGate } = await import('../../__tests__/helpers/permissionGateMock');
	const gate = realPermissionGate(actual, () => 'owner');
	const session = async () => ({
		userId: 'user-alice',
		role: 'owner' as const,
		activeOrganizationId: 'org-1',
	});
	return {
		...actual,
		requireOrgMember: vi.fn().mockImplementation(session),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('user-alice'),
		getMutationContext: vi.fn().mockImplementation(session),
		getBetterAuthSessionWithRole: vi.fn().mockImplementation(session),
		requireOrgPermission: vi
			.fn()
			.mockImplementation(async (_ctx: unknown, permission: string, message?: string) => {
				gate(permission, message);
				return session();
			}),
	};
});

const DAY = 24 * 60 * 60 * 1000;
/** Mid-afternoon UTC, so "today" and "now" differ. */
const NOW = Date.parse('2026-10-20T15:30:00Z');
const TODAY = Date.parse('2026-10-20T00:00:00Z');

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
});

afterEach(() => {
	vi.useRealTimers();
});

async function setup(): Promise<T> {
	const t = convexTest(schema, walkerModules);
	rateLimiterTest.register(t);
	await enableFeatures(t, ['automations']);
	return t;
}

async function seedAutomation(
	t: T,
	overrides: Record<string, unknown> = {}
): Promise<{ automationId: Id<'automations'>; stepId: Id<'automationSteps'> }> {
	return await t.run(async (ctx) => {
		const automationId = await ctx.db.insert(
			'automations',
			createTestAutomation({ status: 'active', triggerType: 'contact_created', ...overrides })
		);
		const stepId = await ctx.db.insert(
			'automationSteps',
			createTestAutomationStep({ automationId, stepIndex: 0 })
		);
		return { automationId, stepId };
	});
}

/** A running run with one executing step run, as the walker leaves it mid-step. */
async function seedExecutingRun(
	t: T,
	automationId: Id<'automations'>,
	stepId: Id<'automationSteps'>
): Promise<{ runId: Id<'automationRuns'>; stepRunId: Id<'automationStepRuns'> }> {
	return await t.run(async (ctx) => {
		const contactId = await ctx.db.insert('contacts', createTestContact());
		const runId = await ctx.db.insert('automationRuns', {
			automationId,
			contactId,
			currentStepIndex: 0,
			status: 'running',
			startedAt: Date.now(),
			triggeredBy: 'contact_created',
		});
		const stepRunId = await ctx.db.insert('automationStepRuns', {
			automationRunId: runId,
			automationStepId: stepId,
			stepIndex: 0,
			stepType: 'email',
			status: 'executing',
			scheduledAt: Date.now(),
			startedAt: Date.now(),
			retryCount: 0,
		});
		return { runId, stepRunId };
	});
}

const counts = (t: T, automationId: Id<'automations'>, now = Date.now()) =>
	t.run((ctx) => summarizeAutomationHealth(ctx.db, automationId, now));

describe('the 7-day window', () => {
	it('is today in UTC and the six days before it', async () => {
		expect(healthWindowStart(NOW)).toBe(TODAY - 6 * DAY);
		const t = await setup();
		const { automationId } = await seedAutomation(t);
		await t.run(async (ctx) => {
			await recordAutomationHealth(ctx, automationId, 'entered', TODAY - 6 * DAY); // first instant
			await recordAutomationHealth(ctx, automationId, 'entered', TODAY - 6 * DAY - 1); // just before
			await recordAutomationHealth(ctx, automationId, 'stalled', TODAY - 3 * DAY);
			await recordAutomationHealth(ctx, automationId, 'failed', NOW);
		});
		expect(await counts(t, automationId)).toEqual({ entered: 1, failed: 1, stalled: 1 });
		// A day later the oldest day has left the window.
		expect(await counts(t, automationId, NOW + DAY)).toEqual({
			entered: 0,
			failed: 1,
			stalled: 1,
		});
	});

	it('reads at most one row per shard per day, however long the history', async () => {
		const t = await setup();
		const { automationId } = await seedAutomation(t);
		await t.run(async (ctx) => {
			for (let day = 0; day < 60; day++) {
				for (let i = 0; i < 40; i++) {
					await recordAutomationHealth(ctx, automationId, 'entered', NOW - day * DAY);
				}
			}
		});
		const read = await t.run(async (ctx) => {
			let rows = 0;
			const db = new Proxy(ctx.db, {
				get(target, prop, receiver) {
					if (prop !== 'query') return Reflect.get(target, prop, receiver);
					return (table: 'automationHealthDays') => {
						const query = target.query(table);
						return {
							withIndex: (...args: Parameters<typeof query.withIndex>) => {
								const ranged = query.withIndex(...args);
								return {
									collect: async () => {
										const result = await ranged.collect();
										rows += result.length;
										return result;
									},
								};
							},
						};
					};
				},
			}) as DatabaseReader;
			const sum = await summarizeAutomationHealth(db, automationId, NOW);
			return { sum, rows };
		});
		expect(read.sum.entered).toBe(7 * 40);
		expect(read.rows).toBeLessThanOrEqual(7 * 8);
	});
});

describe('recording', () => {
	it('counts an entry when the trigger fanout starts a run', async () => {
		const t = await setup();
		const { automationId } = await seedAutomation(t);
		const contactId = await t.run((ctx) => ctx.db.insert('contacts', createTestContact()));
		await t.mutation(internal.automations.triggers.fireContactCreatedTrigger, { contactId });
		// The contact is already running: the second firing starts nothing.
		await t.mutation(internal.automations.triggers.fireContactCreatedTrigger, { contactId });
		expect(await counts(t, automationId)).toEqual({ entered: 1, failed: 0, stalled: 0 });
	});

	it('counts a failed step once and marks its run', async () => {
		const t = await setup();
		const { automationId, stepId } = await seedAutomation(t);
		const { runId, stepRunId } = await seedExecutingRun(t, automationId, stepId);
		const fail = () =>
			t.run(async (ctx) => {
				const stepRun = (await ctx.db.get(stepRunId)) as Doc<'automationStepRuns'>;
				await failStepAndCancelRun(ctx, stepRun, 'SMTP down', {
					countRunFailure: true,
					stepFault: true,
				});
			});
		await fail();
		await fail(); // a late duplicate of the same finalization
		const run = await t.run((ctx) => ctx.db.get(runId));
		expect(run).toMatchObject({ status: 'cancelled', endReason: 'step_failed' });
		expect(await counts(t, automationId)).toEqual({ entered: 0, failed: 1, stalled: 0 });
	});

	it('does not count a run cancelled because its automation was paused', async () => {
		const t = await setup();
		const { automationId, stepId } = await seedAutomation(t);
		const { runId, stepRunId } = await seedExecutingRun(t, automationId, stepId);
		await t.run(async (ctx) => {
			const stepRun = (await ctx.db.get(stepRunId)) as Doc<'automationStepRuns'>;
			await failStepAndCancelRun(ctx, stepRun, 'Automation is no longer active', {
				countRunFailure: false,
				stepFault: false,
			});
		});
		const run = await t.run((ctx) => ctx.db.get(runId));
		expect(run?.status).toBe('cancelled');
		expect(run?.endReason).toBeUndefined();
		expect(await counts(t, automationId)).toEqual({ entered: 0, failed: 0, stalled: 0 });
	});

	it('counts a stalled run once, when the sweep ends it', async () => {
		const t = await setup();
		const { automationId, stepId } = await seedAutomation(t);
		const { runId, stepRunId } = await seedExecutingRun(t, automationId, stepId);
		// The step finished but nothing entered the next one: the run is stuck.
		await t.run((ctx) => ctx.db.patch(stepRunId, { status: 'completed', completedAt: Date.now() }));
		// Inside the grace period the run is left alone.
		await t.mutation(internal.automations.stalledRuns.sweepStalledRuns, {});
		expect((await counts(t, automationId)).stalled).toBe(0);

		vi.setSystemTime(NOW + STALLED_RUN_GRACE_MS);
		await t.mutation(internal.automations.stalledRuns.sweepStalledRuns, {});
		await t.mutation(internal.automations.stalledRuns.sweepStalledRuns, {});
		const run = await t.run((ctx) => ctx.db.get(runId));
		expect(run).toMatchObject({ status: 'cancelled', endReason: 'stalled' });
		expect(await counts(t, automationId)).toEqual({ entered: 0, failed: 0, stalled: 1 });
	});
});

describe('summaries', () => {
	it('answers for each live automation and leaves out a deleted one', async () => {
		const t = await setup();
		const live = await seedAutomation(t);
		const deleted = await seedAutomation(t, { status: 'paused' });
		await t.run(async (ctx) => {
			await recordAutomationHealth(ctx, live.automationId, 'entered');
			await recordAutomationHealth(ctx, deleted.automationId, 'failed');
		});
		await t.mutation(api.automations.automations.remove, { automationId: deleted.automationId });

		const rows = await t.query(api.automations.health.summaries, {
			automationIds: [live.automationId, deleted.automationId, live.automationId],
		});
		expect(rows).toEqual([{ automationId: live.automationId, entered: 1, failed: 0, stalled: 0 }]);
	});

	it('refuses more ids than one list page holds', async () => {
		const t = await setup();
		const { automationId } = await seedAutomation(t);
		await expect(
			t.query(api.automations.health.summaries, {
				automationIds: Array.from({ length: MAX_HEALTH_SUMMARY_IDS + 1 }, () => automationId),
			})
		).rejects.toThrow(/at most/i);
	});
});

describe('affected runs', () => {
	it('lists the runs a count counted, inside the same window', async () => {
		const t = await setup();
		const { automationId } = await seedAutomation(t);
		const ids = await t.run(async (ctx) => {
			const contactId = await ctx.db.insert('contacts', createTestContact());
			const run = (status: 'cancelled' | 'completed', fields: Partial<Doc<'automationRuns'>>) =>
				ctx.db.insert('automationRuns', {
					automationId,
					contactId,
					currentStepIndex: 0,
					status,
					startedAt: NOW - 10 * DAY,
					triggeredBy: 'contact_created',
					...fields,
				});
			return {
				failedToday: await run('cancelled', { completedAt: NOW, endReason: 'step_failed' }),
				failedLastWeek: await run('cancelled', {
					completedAt: TODAY - 6 * DAY,
					endReason: 'step_failed',
				}),
				failedTooLongAgo: await run('cancelled', {
					completedAt: TODAY - 6 * DAY - 1,
					endReason: 'step_failed',
				}),
				stalled: await run('cancelled', { completedAt: NOW, endReason: 'stalled' }),
				cancelled: await run('cancelled', { completedAt: NOW }),
				completed: await run('completed', { completedAt: NOW }),
			};
		});

		const failed = await t.query(api.automations.analytics.getAutomationRuns, {
			automationId,
			endReason: 'step_failed',
		});
		expect(failed.runs.map((run) => run._id)).toEqual([ids.failedToday, ids.failedLastWeek]);
		const stalled = await t.query(api.automations.analytics.getAutomationRuns, {
			automationId,
			endReason: 'stalled',
		});
		expect(stalled.runs.map((run) => run._id)).toEqual([ids.stalled]);
	});
});

describe('pause and resume undo', () => {
	it('returns the stamp an undo needs, and the undo applies while nothing changed', async () => {
		const t = await setup();
		const { automationId } = await seedAutomation(t);
		const paused = await t.mutation(api.automations.automations.pause, { automationId });
		expect(paused).toEqual({ statusChangedAt: NOW });
		// Pausing a paused automation changes nothing, so there is nothing to undo.
		expect(await t.mutation(api.automations.automations.pause, { automationId })).toEqual({
			statusChangedAt: null,
		});

		vi.setSystemTime(NOW + 1000);
		await t.mutation(api.automations.automations.resume, {
			automationId,
			ifStatusChangedAt: NOW,
		});
		expect((await t.run((ctx) => ctx.db.get(automationId)))?.status).toBe('active');
	});

	it('refuses an undo once the status changed again', async () => {
		const t = await setup();
		const { automationId } = await seedAutomation(t);
		await t.mutation(api.automations.automations.pause, { automationId });
		vi.setSystemTime(NOW + 1000);
		await t.mutation(api.automations.automations.resume, { automationId });
		vi.setSystemTime(NOW + 2000);
		await t.mutation(api.automations.automations.pause, { automationId });

		// The undo of the first pause would resume over the latest one.
		await expect(
			t.mutation(api.automations.automations.resume, { automationId, ifStatusChangedAt: NOW })
		).rejects.toThrow(/nothing was undone/);
		expect((await t.run((ctx) => ctx.db.get(automationId)))?.status).toBe('paused');
	});

	it('refuses to undo a resume after the failure breaker paused the automation', async () => {
		const t = await setup();
		const { automationId } = await seedAutomation(t, { status: 'paused' });
		const resumed = await t.mutation(api.automations.automations.resume, { automationId });
		vi.setSystemTime(NOW + 1000);
		await t.run(async (ctx) => {
			for (let i = 0; i < AUTOMATION_FAILURE_BREAKER_THRESHOLD; i++) {
				await recordAutomationRunFailure(ctx, automationId);
			}
		});
		const breakerPaused = await t.run((ctx) => ctx.db.get(automationId));
		expect(breakerPaused).toMatchObject({ status: 'paused', statusChangedAt: NOW + 1000 });

		await expect(
			t.mutation(api.automations.automations.pause, {
				automationId,
				ifStatusChangedAt: resumed.statusChangedAt!,
			})
		).rejects.toThrow(/nothing was undone/);
	});
});
