import { convexTest } from 'convex-test';
import { describe, it, expect, afterEach } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import { createTestAutomation, createTestAutomationStep, createTestContact } from './factories';
import { LEGAL_EDGES, AUTOMATION_FAILURE_BREAKER_THRESHOLD, type AutomationStatus } from '../automations/lifecycle';
import type { Id } from '../_generated/dataModel';

const modules = import.meta.glob('../**/*.*s');

// Lifecycle effects schedule `internal.lib.posthog.capture` — let the
// scheduled functions drain between tests.
afterEach(async () => {
	await new Promise((resolve) => setTimeout(resolve, 25));
});

// ============================================================================
// Edge legality matrix
// ============================================================================

const ALL_STATUSES: AutomationStatus[] = ['draft', 'active', 'paused'];

describe('Automation lifecycle — edge legality matrix', () => {
	for (const from of ALL_STATUSES) {
		for (const to of ALL_STATUSES) {
			const isLegal = LEGAL_EDGES[from].has(to);
			const isSelfLoop = from === to;

			it(`${from} → ${to} ${isSelfLoop ? '(self-loop, recorded)' : isLegal ? '(legal, transitioned)' : '(illegal_edge)'}`, async () => {
				const t = convexTest(schema, modules);
				let automationId: Id<'automations'>;
				await t.run(async (ctx) => {
					automationId = await ctx.db.insert(
						'automations',
						createTestAutomation({
							status: from,
							triggerType: 'contact_created',
							activatedAt: from !== 'draft' ? Date.now() - 10_000 : undefined,
							pausedAt: from === 'paused' ? Date.now() - 5_000 : undefined,
						}),
					);
					if (to === 'active' && !isSelfLoop) {
						// Activate edge requires ≥1 step.
						await ctx.db.insert(
							'automationSteps',
							createTestAutomationStep({
								automationId,
								stepIndex: 0,
								stepType: 'delay',
								config: { duration: 1, unit: 'hours' },
							}),
						);
					}
				});

				const outcome = await t.mutation(internal.automations.lifecycle.transition, {
					automationId: automationId!,
					input: { to, at: Date.now() },
					userId: 'user_test',
				});

				if (isSelfLoop) {
					expect(outcome.ok).toBe(true);
					if (!outcome.ok) return;
					expect(outcome.applied).toBe('recorded');
				} else if (isLegal) {
					expect(outcome.ok).toBe(true);
					if (!outcome.ok) return;
					expect(outcome.applied).toBe('transitioned');
					expect(outcome.from).toBe(from);
					expect(outcome.to).toBe(to);
				} else {
					expect(outcome.ok).toBe(false);
					if (outcome.ok) return;
					expect(outcome.reason).toBe('illegal_edge');
				}
			});
		}
	}
});

// ============================================================================
// Per-transition patch shapes
// ============================================================================

describe('Automation lifecycle — patch shapes', () => {
	it('draft → active sets activatedAt, clears pausedAt, status=active', async () => {
		const t = convexTest(schema, modules);
		const at = Date.now();
		let automationId: Id<'automations'>;
		await t.run(async (ctx) => {
			automationId = await ctx.db.insert(
				'automations',
				createTestAutomation({
					status: 'draft',
					triggerType: 'contact_created',
				}),
			);
			await ctx.db.insert(
				'automationSteps',
				createTestAutomationStep({
					automationId,
					stepIndex: 0,
					stepType: 'delay',
					config: { duration: 1, unit: 'hours' },
				}),
			);
		});

		const outcome = await t.mutation(internal.automations.lifecycle.transition, {
			automationId: automationId!,
			input: { to: 'active', at },
			userId: 'user_1',
		});
		expect(outcome.ok).toBe(true);

		await t.run(async (ctx) => {
			const automation = await ctx.db.get(automationId!);
			expect(automation?.status).toBe('active');
			expect(automation?.activatedAt).toBe(at);
			expect(automation?.pausedAt).toBeUndefined();
			expect(automation?.updatedAt).toBe(at);
		});
	});

	it('paused → active preserves first-activate timestamp, clears pausedAt', async () => {
		const t = convexTest(schema, modules);
		const originalActivatedAt = Date.now() - 100_000;
		let automationId: Id<'automations'>;
		await t.run(async (ctx) => {
			automationId = await ctx.db.insert(
				'automations',
				createTestAutomation({
					status: 'paused',
					triggerType: 'contact_created',
					activatedAt: originalActivatedAt,
					pausedAt: Date.now() - 50_000,
				}),
			);
			await ctx.db.insert(
				'automationSteps',
				createTestAutomationStep({
					automationId,
					stepIndex: 0,
					stepType: 'delay',
					config: { duration: 1, unit: 'hours' },
				}),
			);
		});

		const at = Date.now();
		const outcome = await t.mutation(internal.automations.lifecycle.transition, {
			automationId: automationId!,
			input: { to: 'active', at },
			userId: 'user_1',
		});
		expect(outcome.ok).toBe(true);

		await t.run(async (ctx) => {
			const automation = await ctx.db.get(automationId!);
			expect(automation?.status).toBe('active');
			// First-activate timestamp preserved across resume.
			expect(automation?.activatedAt).toBe(originalActivatedAt);
			expect(automation?.pausedAt).toBeUndefined();
		});
	});

	it('active → paused sets pausedAt, leaves activatedAt intact', async () => {
		const t = convexTest(schema, modules);
		const originalActivatedAt = Date.now() - 50_000;
		let automationId: Id<'automations'>;
		await t.run(async (ctx) => {
			automationId = await ctx.db.insert(
				'automations',
				createTestAutomation({
					status: 'active',
					triggerType: 'contact_created',
					activatedAt: originalActivatedAt,
				}),
			);
		});

		const at = Date.now();
		const outcome = await t.mutation(internal.automations.lifecycle.transition, {
			automationId: automationId!,
			input: { to: 'paused', at },
			userId: 'user_1',
		});
		expect(outcome.ok).toBe(true);

		await t.run(async (ctx) => {
			const automation = await ctx.db.get(automationId!);
			expect(automation?.status).toBe('paused');
			expect(automation?.pausedAt).toBe(at);
			expect(automation?.activatedAt).toBe(originalActivatedAt);
		});
	});

	it('paused → draft clears activatedAt and pausedAt', async () => {
		const t = convexTest(schema, modules);
		let automationId: Id<'automations'>;
		await t.run(async (ctx) => {
			automationId = await ctx.db.insert(
				'automations',
				createTestAutomation({
					status: 'paused',
					triggerType: 'contact_created',
					activatedAt: Date.now() - 100_000,
					pausedAt: Date.now() - 50_000,
				}),
			);
		});

		const at = Date.now();
		const outcome = await t.mutation(internal.automations.lifecycle.transition, {
			automationId: automationId!,
			input: { to: 'draft', at },
			userId: 'user_1',
		});
		expect(outcome.ok).toBe(true);

		await t.run(async (ctx) => {
			const automation = await ctx.db.get(automationId!);
			expect(automation?.status).toBe('draft');
			expect(automation?.activatedAt).toBeUndefined();
			expect(automation?.pausedAt).toBeUndefined();
			expect(automation?.updatedAt).toBe(at);
		});
	});
});

// ============================================================================
// Preconditions for → active
// ============================================================================

describe('Automation lifecycle — → active preconditions', () => {
	it('returns no_steps when activating an automation with zero steps', async () => {
		const t = convexTest(schema, modules);
		let automationId: Id<'automations'>;
		await t.run(async (ctx) => {
			automationId = await ctx.db.insert(
				'automations',
				createTestAutomation({
					status: 'draft',
					triggerType: 'contact_created',
				}),
			);
		});

		const outcome = await t.mutation(internal.automations.lifecycle.transition, {
			automationId: automationId!,
			input: { to: 'active', at: Date.now() },
			userId: 'user_1',
		});

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toBe('no_steps');
	});

	it('returns no_steps when resuming a paused automation that has no steps', async () => {
		const t = convexTest(schema, modules);
		let automationId: Id<'automations'>;
		await t.run(async (ctx) => {
			automationId = await ctx.db.insert(
				'automations',
				createTestAutomation({
					status: 'paused',
					triggerType: 'contact_created',
					activatedAt: Date.now() - 1000,
					pausedAt: Date.now() - 500,
				}),
			);
		});

		const outcome = await t.mutation(internal.automations.lifecycle.transition, {
			automationId: automationId!,
			input: { to: 'active', at: Date.now() },
			userId: 'user_1',
		});

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toBe('no_steps');
	});

	for (const triggerType of [
		'contact_updated',
		'event_received',
		'topic_subscribed',
	] as const) {
		it(`returns invalid_trigger_config for ${triggerType} without config (draft → active)`, async () => {
			const t = convexTest(schema, modules);
			let automationId: Id<'automations'>;
			await t.run(async (ctx) => {
				automationId = await ctx.db.insert(
					'automations',
					createTestAutomation({
						status: 'draft',
						triggerType,
						triggerConfig: undefined,
					}),
				);
				await ctx.db.insert(
					'automationSteps',
					createTestAutomationStep({
						automationId,
						stepIndex: 0,
						stepType: 'delay',
						config: { duration: 1, unit: 'hours' },
					}),
				);
			});

			const outcome = await t.mutation(internal.automations.lifecycle.transition, {
				automationId: automationId!,
				input: { to: 'active', at: Date.now() },
				userId: 'user_1',
			});

			expect(outcome.ok).toBe(false);
			if (outcome.ok) return;
			expect(outcome.reason).toBe('invalid_trigger_config');
		});

		it(`returns invalid_trigger_config for ${triggerType} without config (paused → active, closes drift #3)`, async () => {
			const t = convexTest(schema, modules);
			let automationId: Id<'automations'>;
			await t.run(async (ctx) => {
				automationId = await ctx.db.insert(
					'automations',
					createTestAutomation({
						status: 'paused',
						triggerType,
						triggerConfig: undefined,
						activatedAt: Date.now() - 1000,
						pausedAt: Date.now() - 500,
					}),
				);
				await ctx.db.insert(
					'automationSteps',
					createTestAutomationStep({
						automationId,
						stepIndex: 0,
						stepType: 'delay',
						config: { duration: 1, unit: 'hours' },
					}),
				);
			});

			const outcome = await t.mutation(internal.automations.lifecycle.transition, {
				automationId: automationId!,
				input: { to: 'active', at: Date.now() },
				userId: 'user_1',
			});

			expect(outcome.ok).toBe(false);
			if (outcome.ok) return;
			expect(outcome.reason).toBe('invalid_trigger_config');
		});
	}

	it('contact_created trigger needs no triggerConfig to activate', async () => {
		const t = convexTest(schema, modules);
		let automationId: Id<'automations'>;
		await t.run(async (ctx) => {
			automationId = await ctx.db.insert(
				'automations',
				createTestAutomation({
					status: 'draft',
					triggerType: 'contact_created',
				}),
			);
			await ctx.db.insert(
				'automationSteps',
				createTestAutomationStep({
					automationId,
					stepIndex: 0,
					stepType: 'delay',
					config: { duration: 1, unit: 'hours' },
				}),
			);
		});

		const outcome = await t.mutation(internal.automations.lifecycle.transition, {
			automationId: automationId!,
			input: { to: 'active', at: Date.now() },
			userId: 'user_1',
		});

		expect(outcome.ok).toBe(true);
	});
});

// ============================================================================
// Effects per transition (audit_log + track_event)
// ============================================================================

describe('Automation lifecycle — effects', () => {
	async function setupWithSteps(t: ReturnType<typeof convexTest>, status: AutomationStatus) {
		let automationId: Id<'automations'>;
		await t.run(async (ctx) => {
			automationId = await ctx.db.insert(
				'automations',
				createTestAutomation({
					status,
					triggerType: 'contact_created',
					activatedAt: status !== 'draft' ? Date.now() - 1000 : undefined,
					pausedAt: status === 'paused' ? Date.now() - 500 : undefined,
				}),
			);
			await ctx.db.insert(
				'automationSteps',
				createTestAutomationStep({
					automationId,
					stepIndex: 0,
					stepType: 'delay',
					config: { duration: 1, unit: 'hours' },
				}),
			);
		});
		return automationId!;
	}

	it('draft → active emits automation.activated audit', async () => {
		const t = convexTest(schema, modules);
		const automationId = await setupWithSteps(t, 'draft');

		await t.mutation(internal.automations.lifecycle.transition, {
			automationId,
			input: { to: 'active', at: Date.now() },
			userId: 'user_a',
		});

		await t.run(async (ctx) => {
			const audit = await ctx.db
				.query('auditLogs')
				.collect()
				.then((logs) => logs.find((l) => l.resourceId === automationId));
			expect(audit?.action).toBe('automation.activated');
			expect(audit?.userId).toBe('user_a');
			expect(audit?.resource).toBe('automation');
		});
	});

	it('active → paused emits automation.paused audit', async () => {
		const t = convexTest(schema, modules);
		const automationId = await setupWithSteps(t, 'active');

		await t.mutation(internal.automations.lifecycle.transition, {
			automationId,
			input: { to: 'paused', at: Date.now() },
			userId: 'user_b',
		});

		await t.run(async (ctx) => {
			const audit = await ctx.db
				.query('auditLogs')
				.collect()
				.then((logs) => logs.find((l) => l.resourceId === automationId));
			expect(audit?.action).toBe('automation.paused');
		});
	});

	it('paused → active emits automation.resumed audit (closes drift #2 — distinct from .activated)', async () => {
		const t = convexTest(schema, modules);
		const automationId = await setupWithSteps(t, 'paused');

		await t.mutation(internal.automations.lifecycle.transition, {
			automationId,
			input: { to: 'active', at: Date.now() },
			userId: 'user_c',
		});

		await t.run(async (ctx) => {
			const audit = await ctx.db
				.query('auditLogs')
				.collect()
				.then((logs) => logs.find((l) => l.resourceId === automationId));
			expect(audit?.action).toBe('automation.resumed');
		});
	});

	it('paused → draft emits automation.reverted_to_draft audit (new edge per ADR-0024)', async () => {
		const t = convexTest(schema, modules);
		const automationId = await setupWithSteps(t, 'paused');

		await t.mutation(internal.automations.lifecycle.transition, {
			automationId,
			input: { to: 'draft', at: Date.now() },
			userId: 'user_d',
		});

		await t.run(async (ctx) => {
			const audit = await ctx.db
				.query('auditLogs')
				.collect()
				.then((logs) => logs.find((l) => l.resourceId === automationId));
			expect(audit?.action).toBe('automation.reverted_to_draft');
		});
	});

	it('self-loop records audit with no_op detail but no patch', async () => {
		const t = convexTest(schema, modules);
		const automationId = await setupWithSteps(t, 'active');
		let initialUpdatedAt: number | undefined;
		await t.run(async (ctx) => {
			const a = await ctx.db.get(automationId);
			initialUpdatedAt = a?.updatedAt;
		});

		const outcome = await t.mutation(internal.automations.lifecycle.transition, {
			automationId,
			input: { to: 'active', at: Date.now() + 5000 },
			userId: 'user_e',
		});

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.applied).toBe('recorded');

		await t.run(async (ctx) => {
			const a = await ctx.db.get(automationId);
			// updatedAt not touched by self-loop.
			expect(a?.updatedAt).toBe(initialUpdatedAt);
			const audit = await ctx.db
				.query('auditLogs')
				.collect()
				.then((logs) => logs.find((l) => l.resourceId === automationId));
			expect(audit?.action).toBe('automation.activated');
			expect(audit?.details?.['no_op']).toBe(true);
		});
	});
});

// ============================================================================
// not-found path
// ============================================================================

describe('Automation lifecycle — not found', () => {
	it('returns automation_not_found for a deleted automation', async () => {
		const t = convexTest(schema, modules);
		let automationId: Id<'automations'>;
		await t.run(async (ctx) => {
			automationId = await ctx.db.insert(
				'automations',
				createTestAutomation({ status: 'draft' }),
			);
			await ctx.db.delete(automationId);
		});

		const outcome = await t.mutation(internal.automations.lifecycle.transition, {
			automationId: automationId!,
			input: { to: 'active', at: Date.now() },
			userId: 'user_1',
		});

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.reason).toBe('automation_not_found');
	});
});

// ============================================================================
// Circuit breaker — auto-pause after consecutive run failures
// ============================================================================

describe('Automation lifecycle — circuit breaker', () => {
	async function makeActiveAutomation(t: ReturnType<typeof convexTest>): Promise<Id<'automations'>> {
		return await t.run(async (ctx) => {
			const id = await ctx.db.insert('automations', createTestAutomation({
				status: 'active',
				triggerType: 'contact_created',
				activatedAt: Date.now() - 10_000,
			}));
			await ctx.db.insert('automationSteps', createTestAutomationStep({
				automationId: id,
				stepIndex: 0,
				stepType: 'delay',
				config: { duration: 1, unit: 'hours' },
			}));
			return id;
		});
	}

	it('increments the failure streak below the threshold without pausing', async () => {
		const t = convexTest(schema, modules);
		const id = await makeActiveAutomation(t);
		for (let i = 0; i < AUTOMATION_FAILURE_BREAKER_THRESHOLD - 1; i++) {
			await t.mutation(internal.automations.lifecycle.recordRunFailure, { automationId: id });
		}
		await t.run(async (ctx) => {
			const a = await ctx.db.get(id);
			expect(a!.consecutiveRunFailures).toBe(AUTOMATION_FAILURE_BREAKER_THRESHOLD - 1);
			expect(a!.status).toBe('active');
		});
	});

	it('auto-pauses at the threshold and audit-logs the breaker actor', async () => {
		const t = convexTest(schema, modules);
		const id = await makeActiveAutomation(t);
		for (let i = 0; i < AUTOMATION_FAILURE_BREAKER_THRESHOLD; i++) {
			await t.mutation(internal.automations.lifecycle.recordRunFailure, { automationId: id });
		}
		await t.run(async (ctx) => {
			const a = await ctx.db.get(id);
			expect(a!.status).toBe('paused');
			const logs = await ctx.db.query('auditLogs').collect();
			expect(logs.some((l) => l.userId === 'system:automation-breaker')).toBe(true);
		});
	});

	it('resets the streak when a run completes successfully', async () => {
		const t = convexTest(schema, modules);
		const id = await makeActiveAutomation(t);
		await t.mutation(internal.automations.lifecycle.recordRunFailure, { automationId: id });
		await t.mutation(internal.automations.lifecycle.recordRunFailure, { automationId: id });

		let runId!: Id<'automationRuns'>;
		await t.run(async (ctx) => {
			const contactId = await ctx.db.insert('contacts', createTestContact());
			runId = await ctx.db.insert('automationRuns', {
				automationId: id,
				contactId,
				currentStepIndex: 0,
				status: 'running',
				startedAt: Date.now(),
				triggeredBy: 'contact_created',
			});
		});
		await t.mutation(internal.automations.stepExecutorQueries.completeAutomationRun, { automationRunId: runId });
		await t.run(async (ctx) => {
			const a = await ctx.db.get(id);
			expect(a!.consecutiveRunFailures).toBe(0);
		});
	});
});
