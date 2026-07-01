/**
 * Integration tests for the automation public mutations
 * (apps/api/convex/automations/automations.ts) and the per-step CRUD
 * draft-gate (apps/api/convex/automations/steps.ts).
 *
 * Two axes are covered:
 *
 *  1. The `automations:manage` role gate (owner/admin allowed, editor
 *     rejected) on every lifecycle/edit mutation — driven through the
 *     mutable-role session mock copied from chat.integration.test.ts.
 *
 *  2. The step draft-gate: `addStep` / `updateStep` / `reorderSteps` /
 *     `removeStep` (and `updateTrigger`) are now restricted to DRAFT
 *     automations via `requireDraftAutomation` — editing steps on an
 *     active/paused automation is rejected (`throwInvalidState`), on a
 *     draft is allowed.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import schema from '../schema';
import { api } from '../_generated/api';
import { enableFeatures, createTestAutomation, createTestAutomationStep } from './factories';
import type { Id } from '../_generated/dataModel';

// Mutable mock so a single test can switch the caller's role. The automation
// guards resolve their session via `getMutationContext`, and
// `automations:manage` maps to admin/owner (an `editor` is rejected).
const sessionMock = vi.hoisted(() => ({
	user: { id: 'user-alice', role: 'owner' as 'owner' | 'admin' | 'editor' },
}));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockImplementation(async () => ({
			userId: sessionMock.user.id,
			role: sessionMock.user.role,
		})),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockImplementation(async () => sessionMock.user.id),
		getMutationContext: vi.fn().mockImplementation(async () => ({
			userId: sessionMock.user.id,
			role: sessionMock.user.role,
		})),
		requireOrgPermission: vi.fn().mockImplementation(
			async (_ctx: unknown, permission: string, message?: string) => {
				const mod = actual as typeof import('../lib/sessionOrganization');
				mod.requirePermission(
					mod.hasPermission(
						sessionMock.user.role as Parameters<typeof mod.hasPermission>[0],
						permission as Parameters<typeof mod.hasPermission>[1],
					),
					message,
				);
				return { userId: sessionMock.user.id, role: sessionMock.user.role };
			},
		),
	};
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('agentSecurity') &&
			!path.includes('agentContext') &&
			!path.includes('agentClassifier') &&
			!path.includes('agentDrafter') &&
			!path.includes('agentRouter') &&
			!path.includes('agent/walker') &&
			!path.includes('agent/steps/index') &&
			!path.includes('agent/steps/shared') &&
			!path.includes('agent/steps/classify') &&
			!path.includes('agent/steps/draft') &&
			!path.includes('knowledgeExtraction') &&
			!path.includes('semanticFileProcessing') &&
			!path.includes('visualizationAgent') &&
			!path.includes('llmProvider'),
	),
);

const setUser = (id: string, role: 'owner' | 'admin' | 'editor' = 'editor') => {
	sessionMock.user.id = id;
	sessionMock.user.role = role;
};

/** Fresh harness with the `automations` feature flag on + the rate-limiter
 * component registered (some automation paths share the limiter). */
async function freshT(): Promise<TestConvex<typeof schema>> {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	await enableFeatures(t, ['automations']);
	return t;
}

/** Seed an automation row directly and return its id. */
async function seedAutomation(
	t: TestConvex<typeof schema>,
	overrides: Record<string, unknown> = {},
): Promise<Id<'automations'>> {
	return t.run(async (ctx) =>
		ctx.db.insert('automations', createTestAutomation(overrides)),
	);
}

/** Seed one delay step on an automation and return its id. */
async function seedStep(
	t: TestConvex<typeof schema>,
	automationId: Id<'automations'>,
	overrides: Record<string, unknown> = {},
): Promise<Id<'automationSteps'>> {
	return t.run(async (ctx) =>
		ctx.db.insert(
			'automationSteps',
			createTestAutomationStep({ automationId, stepType: 'delay', ...overrides }),
		),
	);
}

/** Seed a condition step with explicit yes/no branch targets (raw stepIndex
 * positions, the same numeric space the walker resolves against). */
async function seedConditionStep(
	t: TestConvex<typeof schema>,
	automationId: Id<'automations'>,
	stepIndex: number,
	yesBranchStepIndex: number | null,
	noBranchStepIndex: number | null,
): Promise<Id<'automationSteps'>> {
	return t.run(async (ctx) =>
		ctx.db.insert(
			'automationSteps',
			createTestAutomationStep({
				automationId,
				stepType: 'condition',
				stepIndex,
				config: {
					condition: {
						kind: 'contact_property',
						field: 'email',
						operator: 'contains',
						value: '@example.com',
					},
					yesBranchStepIndex,
					noBranchStepIndex,
				},
			}),
		),
	);
}

/** Read a condition step's stored branch targets. */
async function readBranches(
	t: TestConvex<typeof schema>,
	stepId: Id<'automationSteps'>,
): Promise<{ yes: number | null; no: number | null; stepIndex: number | undefined }> {
	const step = await t.run(async (ctx) => ctx.db.get(stepId));
	const config = step?.config as {
		yesBranchStepIndex?: number | null;
		noBranchStepIndex?: number | null;
	};
	return {
		yes: config?.yesBranchStepIndex ?? null,
		no: config?.noBranchStepIndex ?? null,
		stepIndex: step?.stepIndex,
	};
}

beforeEach(() => {
	setUser('user-alice', 'owner');
});

// ============================================================================
// automations:manage role gate on the public mutations
// ============================================================================

describe('automations mutations — automations:manage role gate', () => {
	it('create: owner/admin can create, editor is rejected', async () => {
		const t = await freshT();

		setUser('user-alice', 'admin');
		const id = await t.mutation(api.automations.automations.create, {
			name: 'Welcome Series',
			triggerType: 'contact_created',
		});
		expect(id).toBeDefined();
		const created = await t.run(async (ctx) => ctx.db.get(id));
		expect(created?.status).toBe('draft');

		setUser('user-bob', 'editor');
		await expect(
			t.mutation(api.automations.automations.create, {
				name: 'Nope',
				triggerType: 'contact_created',
			}),
		).rejects.toThrow();
	});

	it('update: editor is rejected, admin can rename', async () => {
		const t = await freshT();
		const id = await seedAutomation(t, { name: 'Original' });

		setUser('user-bob', 'editor');
		await expect(
			t.mutation(api.automations.automations.update, {
				automationId: id,
				name: 'Hacked',
			}),
		).rejects.toThrow();

		setUser('user-alice', 'admin');
		await t.mutation(api.automations.automations.update, {
			automationId: id,
			name: 'Renamed',
		});
		const updated = await t.run(async (ctx) => ctx.db.get(id));
		expect(updated?.name).toBe('Renamed');
	});

	it('updateTrigger: editor is rejected, admin can update (on a draft)', async () => {
		const t = await freshT();
		const id = await seedAutomation(t, { triggerType: 'contact_created' });

		setUser('user-bob', 'editor');
		await expect(
			t.mutation(api.automations.automations.updateTrigger, {
				automationId: id,
				triggerType: 'event_received',
				triggerConfig: { eventName: 'signup' },
			}),
		).rejects.toThrow();

		setUser('user-alice', 'admin');
		await t.mutation(api.automations.automations.updateTrigger, {
			automationId: id,
			triggerType: 'event_received',
			triggerConfig: { eventName: 'signup' },
		});
		const updated = await t.run(async (ctx) => ctx.db.get(id));
		expect(updated?.triggerType).toBe('event_received');
	});

	it('duplicate: editor is rejected, admin gets a draft copy with steps', async () => {
		const t = await freshT();
		const id = await seedAutomation(t, { name: 'Series', status: 'active' });
		await seedStep(t, id, { stepIndex: 0 });

		setUser('user-bob', 'editor');
		await expect(
			t.mutation(api.automations.automations.duplicate, { automationId: id }),
		).rejects.toThrow();

		setUser('user-alice', 'admin');
		const copyId = await t.mutation(api.automations.automations.duplicate, {
			automationId: id,
		});
		const copy = await t.run(async (ctx) => ctx.db.get(copyId));
		expect(copy?.name).toBe('Series (Copy)');
		// A duplicate always starts as a draft, regardless of the source status.
		expect(copy?.status).toBe('draft');
		const copiedSteps = await t.run(async (ctx) =>
			ctx.db
				.query('automationSteps')
				.withIndex('by_automation', (q) => q.eq('automationId', copyId))
				.collect(),
		);
		expect(copiedSteps).toHaveLength(1);
	});

	it('remove: editor is rejected, admin can delete a draft (and its steps)', async () => {
		const t = await freshT();
		const id = await seedAutomation(t, { status: 'draft' });
		const stepId = await seedStep(t, id, { stepIndex: 0 });

		setUser('user-bob', 'editor');
		await expect(
			t.mutation(api.automations.automations.remove, { automationId: id }),
		).rejects.toThrow();

		setUser('user-alice', 'admin');
		await t.mutation(api.automations.automations.remove, { automationId: id });
		const gone = await t.run(async (ctx) => ctx.db.get(id));
		expect(gone).toBeNull();
		const stepGone = await t.run(async (ctx) => ctx.db.get(stepId));
		expect(stepGone).toBeNull();
	});

	it('remove: refuses to delete an active automation (pause first)', async () => {
		const t = await freshT();
		const id = await seedAutomation(t, { status: 'active' });

		setUser('user-alice', 'admin');
		await expect(
			t.mutation(api.automations.automations.remove, { automationId: id }),
		).rejects.toThrow();
		const still = await t.run(async (ctx) => ctx.db.get(id));
		expect(still).not.toBeNull();
	});

	it('activate: editor is rejected, admin can activate a valid draft', async () => {
		const t = await freshT();
		// contact_created needs no triggerConfig; one step satisfies the ≥1 rule.
		const id = await seedAutomation(t, { triggerType: 'contact_created', status: 'draft' });
		await seedStep(t, id, { stepIndex: 0 });

		setUser('user-bob', 'editor');
		await expect(
			t.mutation(api.automations.automations.activate, { automationId: id }),
		).rejects.toThrow();

		setUser('user-alice', 'admin');
		await t.mutation(api.automations.automations.activate, { automationId: id });
		const active = await t.run(async (ctx) => ctx.db.get(id));
		expect(active?.status).toBe('active');
	});

	it('activate: rejects a draft with no steps (no_steps invalid state)', async () => {
		const t = await freshT();
		const id = await seedAutomation(t, { triggerType: 'contact_created', status: 'draft' });

		setUser('user-alice', 'admin');
		await expect(
			t.mutation(api.automations.automations.activate, { automationId: id }),
		).rejects.toThrow();
		const still = await t.run(async (ctx) => ctx.db.get(id));
		expect(still?.status).toBe('draft');
	});

	it('pause: editor is rejected, admin can pause an active automation', async () => {
		const t = await freshT();
		const id = await seedAutomation(t, { status: 'active' });

		setUser('user-bob', 'editor');
		await expect(
			t.mutation(api.automations.automations.pause, { automationId: id }),
		).rejects.toThrow();

		setUser('user-alice', 'admin');
		await t.mutation(api.automations.automations.pause, { automationId: id });
		const paused = await t.run(async (ctx) => ctx.db.get(id));
		expect(paused?.status).toBe('paused');
	});

	it('resume: editor is rejected, admin can resume a paused automation', async () => {
		const t = await freshT();
		const id = await seedAutomation(t, {
			triggerType: 'contact_created',
			status: 'paused',
		});
		await seedStep(t, id, { stepIndex: 0 });

		setUser('user-bob', 'editor');
		await expect(
			t.mutation(api.automations.automations.resume, { automationId: id }),
		).rejects.toThrow();

		setUser('user-alice', 'admin');
		await t.mutation(api.automations.automations.resume, { automationId: id });
		const resumed = await t.run(async (ctx) => ctx.db.get(id));
		expect(resumed?.status).toBe('active');
	});

	it('revertToDraft: editor is rejected, admin can revert a paused automation', async () => {
		const t = await freshT();
		const id = await seedAutomation(t, { status: 'paused' });

		setUser('user-bob', 'editor');
		await expect(
			t.mutation(api.automations.automations.revertToDraft, { automationId: id }),
		).rejects.toThrow();

		setUser('user-alice', 'admin');
		await t.mutation(api.automations.automations.revertToDraft, { automationId: id });
		const reverted = await t.run(async (ctx) => ctx.db.get(id));
		expect(reverted?.status).toBe('draft');
	});
});

// ============================================================================
// Step CRUD draft-gate: structure edits are draft-only.
// ============================================================================

describe('automation steps — draft-gate (requireDraftAutomation)', () => {
	it('addStep: allowed on a draft, rejected on an active automation', async () => {
		const t = await freshT();
		setUser('user-alice', 'admin');

		const draftId = await seedAutomation(t, { status: 'draft' });
		const stepId = await t.mutation(api.automations.steps.addStep, {
			automationId: draftId,
			stepType: 'delay',
			config: { duration: 1, unit: 'days' },
		});
		expect(stepId).toBeDefined();
		const step = await t.run(async (ctx) => ctx.db.get(stepId));
		expect(step?.stepIndex).toBe(0);

		const activeId = await seedAutomation(t, { status: 'active' });
		await expect(
			t.mutation(api.automations.steps.addStep, {
				automationId: activeId,
				stepType: 'delay',
				config: { duration: 1, unit: 'days' },
			}),
		).rejects.toThrow();
	});

	it('addStep: rejected on a paused automation too (not just active)', async () => {
		const t = await freshT();
		setUser('user-alice', 'admin');

		const pausedId = await seedAutomation(t, { status: 'paused' });
		await expect(
			t.mutation(api.automations.steps.addStep, {
				automationId: pausedId,
				stepType: 'delay',
				config: { duration: 1, unit: 'days' },
			}),
		).rejects.toThrow();
	});

	it('addStep: editor is rejected even on a draft (role gate)', async () => {
		const t = await freshT();
		const draftId = await seedAutomation(t, { status: 'draft' });

		setUser('user-bob', 'editor');
		await expect(
			t.mutation(api.automations.steps.addStep, {
				automationId: draftId,
				stepType: 'delay',
				config: { duration: 1, unit: 'days' },
			}),
		).rejects.toThrow();
	});

	it('updateStep: allowed on a draft, rejected once the automation is active', async () => {
		const t = await freshT();
		setUser('user-alice', 'admin');

		const draftId = await seedAutomation(t, { status: 'draft' });
		const stepId = await seedStep(t, draftId, {
			stepIndex: 0,
			config: { duration: 1, unit: 'days' },
		});

		// Draft → allowed.
		await t.mutation(api.automations.steps.updateStep, {
			stepId,
			config: { duration: 3, unit: 'days' },
		});
		const updated = await t.run(async (ctx) => ctx.db.get(stepId));
		expect((updated?.config as { duration: number }).duration).toBe(3);

		// Flip the automation to active; the same edit is now refused.
		await t.run(async (ctx) => ctx.db.patch(draftId, { status: 'active' }));
		await expect(
			t.mutation(api.automations.steps.updateStep, {
				stepId,
				config: { duration: 5, unit: 'days' },
			}),
		).rejects.toThrow();
		const unchanged = await t.run(async (ctx) => ctx.db.get(stepId));
		expect((unchanged?.config as { duration: number }).duration).toBe(3);
	});

	it('reorderSteps: allowed on a draft, rejected on an active automation', async () => {
		const t = await freshT();
		setUser('user-alice', 'admin');

		const draftId = await seedAutomation(t, { status: 'draft' });
		const s0 = await seedStep(t, draftId, { stepIndex: 0 });
		const s1 = await seedStep(t, draftId, { stepIndex: 1 });

		await t.mutation(api.automations.steps.reorderSteps, {
			automationId: draftId,
			stepOrder: [s1, s0],
		});
		const after = await t.run(async (ctx) => ({
			s0: await ctx.db.get(s0),
			s1: await ctx.db.get(s1),
		}));
		expect(after.s1?.stepIndex).toBe(0);
		expect(after.s0?.stepIndex).toBe(1);

		await t.run(async (ctx) => ctx.db.patch(draftId, { status: 'active' }));
		await expect(
			t.mutation(api.automations.steps.reorderSteps, {
				automationId: draftId,
				stepOrder: [s0, s1],
			}),
		).rejects.toThrow();
	});

	it('removeStep: allowed on a draft (reindexes), rejected on an active automation', async () => {
		const t = await freshT();
		setUser('user-alice', 'admin');

		const draftId = await seedAutomation(t, { status: 'draft' });
		const s0 = await seedStep(t, draftId, { stepIndex: 0 });
		const s1 = await seedStep(t, draftId, { stepIndex: 1 });

		await t.mutation(api.automations.steps.removeStep, { stepId: s0 });
		const gone = await t.run(async (ctx) => ctx.db.get(s0));
		expect(gone).toBeNull();
		// Remaining step is reindexed down to 0.
		const remaining = await t.run(async (ctx) => ctx.db.get(s1));
		expect(remaining?.stepIndex).toBe(0);

		// On an active automation, removing a step is refused.
		const activeId = await seedAutomation(t, { status: 'active' });
		const activeStep = await seedStep(t, activeId, { stepIndex: 0 });
		await expect(
			t.mutation(api.automations.steps.removeStep, { stepId: activeStep }),
		).rejects.toThrow();
		const stillThere = await t.run(async (ctx) => ctx.db.get(activeStep));
		expect(stillThere).not.toBeNull();
	});

	it('updateStep / removeStep: throw not-found for a missing step', async () => {
		const t = await freshT();
		setUser('user-alice', 'admin');

		// Insert then delete to obtain a valid-but-dangling id.
		const draftId = await seedAutomation(t, { status: 'draft' });
		const stepId = await seedStep(t, draftId, { stepIndex: 0 });
		await t.run(async (ctx) => ctx.db.delete(stepId));

		await expect(
			t.mutation(api.automations.steps.updateStep, {
				stepId,
				config: { duration: 1, unit: 'days' },
			}),
		).rejects.toThrow();
		await expect(
			t.mutation(api.automations.steps.removeStep, { stepId }),
		).rejects.toThrow();
	});

	it('updateTrigger: rejected on an active automation (trigger is structure)', async () => {
		const t = await freshT();
		setUser('user-alice', 'admin');

		const activeId = await seedAutomation(t, {
			triggerType: 'contact_created',
			status: 'active',
		});
		await expect(
			t.mutation(api.automations.automations.updateTrigger, {
				automationId: activeId,
				triggerType: 'event_received',
				triggerConfig: { eventName: 'signup' },
			}),
		).rejects.toThrow();
	});
});

// ============================================================================
// Condition branch-target remapping on structural edits.
//
// Branch targets are raw stepIndex positions that the walker resolves against,
// so a reorder / remove / insert that rewrites stepIndex must carry the targets
// along — otherwise a branch silently re-points at whichever step now sits in
// the old slot, routing contacts down the wrong path with no error.
// ============================================================================

describe('automation steps — condition branch-target remapping', () => {
	it('reorderSteps: branch targets follow the moved steps', async () => {
		const t = await freshT();
		setUser('user-alice', 'admin');

		// 0: condition (yes→step 1, no→step 2), 1: delay, 2: email
		const draftId = await seedAutomation(t, { status: 'draft' });
		const cond = await seedConditionStep(t, draftId, 0, 1, 2);
		const s1 = await seedStep(t, draftId, { stepIndex: 1 });
		const s2 = await seedStep(t, draftId, { stepIndex: 2, stepType: 'email' });

		// New order: [s2, cond, s1] → s2 is now index 0, cond index 1, s1 index 2.
		await t.mutation(api.automations.steps.reorderSteps, {
			automationId: draftId,
			stepOrder: [s2, cond, s1],
		});

		// cond's yes pointed at old index 1 (s1, now index 2); no pointed at old
		// index 2 (s2, now index 0).
		const branches = await readBranches(t, cond);
		expect(branches.stepIndex).toBe(1);
		expect(branches.yes).toBe(2);
		expect(branches.no).toBe(0);
	});

	it('removeStep: a branch to the deleted step is cleared; later targets shift down', async () => {
		const t = await freshT();
		setUser('user-alice', 'admin');

		// 0: condition (yes→step 1 [will be deleted], no→step 2), 1: delay, 2: email
		const draftId = await seedAutomation(t, { status: 'draft' });
		const cond = await seedConditionStep(t, draftId, 0, 1, 2);
		const s1 = await seedStep(t, draftId, { stepIndex: 1 });
		await seedStep(t, draftId, { stepIndex: 2, stepType: 'email' });

		await t.mutation(api.automations.steps.removeStep, { stepId: s1 });

		// yes pointed at the deleted step → cleared (null). no pointed at old
		// index 2 which shifted down to 1.
		const branches = await readBranches(t, cond);
		expect(branches.yes).toBeNull();
		expect(branches.no).toBe(1);
	});

	it('removeStep: a branch before the deleted slot is unchanged', async () => {
		const t = await freshT();
		setUser('user-alice', 'admin');

		// 0: delay, 1: condition (yes→step 0), 2: delay (deleted)
		const draftId = await seedAutomation(t, { status: 'draft' });
		await seedStep(t, draftId, { stepIndex: 0 });
		const cond = await seedConditionStep(t, draftId, 1, 0, null);
		const s2 = await seedStep(t, draftId, { stepIndex: 2 });

		await t.mutation(api.automations.steps.removeStep, { stepId: s2 });

		const branches = await readBranches(t, cond);
		expect(branches.yes).toBe(0);
		expect(branches.no).toBeNull();
		// The condition step itself was before the deleted slot — index unchanged.
		expect(branches.stepIndex).toBe(1);
	});

	it('addStep with insertAtIndex: branch targets at/after the insert point shift up', async () => {
		const t = await freshT();
		setUser('user-alice', 'admin');

		// 0: condition (yes→step 1, no→step 2), 1: delay, 2: email
		const draftId = await seedAutomation(t, { status: 'draft' });
		const cond = await seedConditionStep(t, draftId, 0, 1, 2);
		await seedStep(t, draftId, { stepIndex: 1 });
		await seedStep(t, draftId, { stepIndex: 2, stepType: 'email' });

		// Insert a new step at index 1 — everything at/after index 1 shifts up.
		await t.mutation(api.automations.steps.addStep, {
			automationId: draftId,
			stepType: 'delay',
			config: { duration: 1, unit: 'days' },
			insertAtIndex: 1,
		});

		// yes (old index 1) → 2, no (old index 2) → 3.
		const branches = await readBranches(t, cond);
		expect(branches.yes).toBe(2);
		expect(branches.no).toBe(3);
		// The condition step was before the insert point — index unchanged.
		expect(branches.stepIndex).toBe(0);
	});

	it('addStep appended at the end leaves existing branch targets untouched', async () => {
		const t = await freshT();
		setUser('user-alice', 'admin');

		const draftId = await seedAutomation(t, { status: 'draft' });
		const cond = await seedConditionStep(t, draftId, 0, 1, null);
		await seedStep(t, draftId, { stepIndex: 1 });

		// No insertAtIndex → append, no shifting.
		await t.mutation(api.automations.steps.addStep, {
			automationId: draftId,
			stepType: 'delay',
			config: { duration: 1, unit: 'days' },
		});

		const branches = await readBranches(t, cond);
		expect(branches.yes).toBe(1);
		expect(branches.no).toBeNull();
	});
});
