/**
 * Per-user onboarding state (auth/userOnboarding).
 *
 * End-to-end over a real (convex-test) datastore:
 *   - markOnboardingStep flips each step from unset → a completion timestamp,
 *     the way every hook point (mailbox claim/connect, migration start/complete,
 *     indexing complete) drives it, and `get` reads them back.
 *   - idempotency: a second mark for the same step preserves the FIRST timestamp.
 *   - isolation: a caller can only read their OWN row — asking for another
 *     user's id is rejected.
 *   - dismiss round-trips: dismissing sets `dismissedAt`, which `get` reflects.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../../schema';
import { api } from '../../_generated/api';
import { markOnboardingStep, type OnboardingStep } from '../userOnboarding';

const sessionMocks = vi.hoisted(() => ({
	userId: 'user-A',
	role: 'admin' as 'owner' | 'admin' | 'editor',
}));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn(async () => ({
			userId: sessionMocks.userId,
			role: sessionMocks.role,
		})),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn(async () => ({
			userId: sessionMocks.userId,
			role: sessionMocks.role,
		})),
		getBetterAuthSessionWithRole: vi.fn(async () => ({
			userId: sessionMocks.userId,
			role: sessionMocks.role,
			activeOrganizationId: 'org-1',
		})),
		// Self-gate: mirror production's requireSelf — accept the caller's own id,
		// reject anyone else's. Lets the isolation test exercise the real guard.
		requireSelf: vi.fn(async (_ctx: unknown, claimed: string) => {
			if (claimed !== sessionMocks.userId) {
				throw new Error('forbidden: not self');
			}
			return claimed;
		}),
	};
});

const allModules = import.meta.glob('../../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules)
		.filter(
			([path]) =>
				!path.includes('sesActions') &&
				!path.includes('agent/walker') &&
				!path.includes('agent/steps/index') &&
				!path.includes('agent/steps/classify') &&
				!path.includes('agent/steps/draft') &&
				!path.includes('agent/steps/clarify') &&
				!path.includes('knowledgeExtraction') &&
				!path.includes('semanticFileProcessing') &&
				!path.includes('visualizationAgent') &&
				!path.includes('llmProvider')
		)
		.map(([key, val]) =>
			key.startsWith('../') && !key.startsWith('../../')
				? (['../../auth/' + key.slice(3), val] as const)
				: ([key, val] as const)
		)
);

const HOOK_STEPS: OnboardingStep[] = [
	'mailboxReady',
	'importStarted',
	'importDone',
	'knowledgeIndexed',
];

describe('userOnboarding', () => {
	it('flips each hook step from unset to a timestamp and reads it back', async () => {
		const t = convexTest(schema, modules);

		// Nothing done yet → a concrete all-null state (no row required).
		const before = await t.query(api.auth.userOnboarding.get, { userId: 'user-A' });
		for (const step of HOOK_STEPS) {
			expect(before[step]).toBeNull();
		}
		expect(before.dismissedAt).toBeNull();

		for (const step of HOOK_STEPS) {
			await t.run(async (ctx) => {
				await markOnboardingStep(ctx, 'user-A', step);
			});
		}

		const after = await t.query(api.auth.userOnboarding.get, { userId: 'user-A' });
		for (const step of HOOK_STEPS) {
			expect(typeof after[step]).toBe('number');
		}
	});

	it('preserves the first-completion timestamp when a step is marked twice', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await markOnboardingStep(ctx, 'user-A', 'mailboxReady');
		});
		const first = await t.query(api.auth.userOnboarding.get, { userId: 'user-A' });
		const firstTs = first.mailboxReady;
		expect(typeof firstTs).toBe('number');

		// A later replay of the same flow must not move the timestamp.
		await t.run(async (ctx) => {
			await markOnboardingStep(ctx, 'user-A', 'mailboxReady');
		});
		const second = await t.query(api.auth.userOnboarding.get, { userId: 'user-A' });
		expect(second.mailboxReady).toBe(firstTs);
	});

	it("does not leak another user's onboarding state", async () => {
		const t = convexTest(schema, modules);

		// user-B has progress; user-A (the session) must not be able to read it.
		await t.run(async (ctx) => {
			await markOnboardingStep(ctx, 'user-B', 'firstSendDone');
		});

		sessionMocks.userId = 'user-A';
		await expect(t.query(api.auth.userOnboarding.get, { userId: 'user-B' })).rejects.toThrow();
	});

	it('round-trips a dismissal', async () => {
		const t = convexTest(schema, modules);

		sessionMocks.userId = 'user-A';
		const before = await t.query(api.auth.userOnboarding.get, { userId: 'user-A' });
		expect(before.dismissedAt).toBeNull();

		await t.mutation(api.auth.userOnboarding.dismiss, { userId: 'user-A' });

		const after = await t.query(api.auth.userOnboarding.get, { userId: 'user-A' });
		expect(typeof after.dismissedAt).toBe('number');
	});
});
