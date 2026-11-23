import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import * as onboarding from '../auth/onboarding';
import {
	createTestApiKey,
	createTestContact,
	createTestDomain,
	createTestEmailTemplate,
} from './factories';

/**
 * Onboarding consolidation contract (audit item p3-onboarding).
 *
 * Two things are locked in here:
 *
 *  1. **Instance-scoped dismissal.** Owlat is single-org-per-deployment and
 *     onboarding *progress* is derived live from instance data, so dismissal
 *     must be instance-wide too: dismissing as one admin has to hide the
 *     surface for every other admin/browser. A per-user localStorage dismissal
 *     would disagree with the shared progress, so the server ORs the dismissal
 *     across all records.
 *
 *  2. **Dead code is gone.** `get`, `initialize`, and `markStepComplete` (and
 *     the inert per-step boolean columns they wrote) were never read and have
 *     been deleted per the prefer-deletion convention. Importing the module
 *     must not break, and only the live functions remain exported.
 */

// Only the auth FLOOR is mocked (the `authedQuery`/`authedMutation` wrapper's
// `requireOrgMember` / `getMutationContext`). `requireSelf` / `getUserIdFromSession`
// stay REAL so each `withIdentity(...)` call resolves to its own user — that's
// exactly what the instance-scoped assertion needs (two distinct admins).
vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'admin-a', role: 'owner' }),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'admin-a', role: 'owner' }),
	};
});

// Delivery readiness reads provider routes and the environment; the checklist
// tests below only need "this instance can send" to be true.
vi.mock('../lib/sendProviders/capability', async () => {
	const actual = await vi.importActual('../lib/sendProviders/capability');
	return { ...actual, isDeliveryConfigured: vi.fn().mockResolvedValue(true) };
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
			!path.includes('agent/steps/') &&
			!path.includes('knowledgeExtraction') &&
			!path.includes('files/processing') &&
			!path.includes('visualizationAgent') &&
			!path.includes('llmProvider')
	)
);

function adminIdentity(subject: string) {
	return { subject, issuer: 'test', tokenIdentifier: `test|${subject}` };
}

describe('auth/onboarding — instance-scoped dismissal', () => {
	it('is not dismissed for a fresh instance', async () => {
		const t = convexTest(schema, modules).withIdentity(adminIdentity('admin-a'));
		const progress = await t.query(api.auth.onboarding.getWithActualProgress, {
			userId: 'admin-a',
		});
		expect(progress.dismissed).toBe(false);
		expect(progress.dismissedAt).toBeUndefined();
	});

	it('reflects one admin dismissing onto every other admin (instance-wide)', async () => {
		const base = convexTest(schema, modules);

		// Admin A dismisses onboarding.
		await base
			.withIdentity(adminIdentity('admin-a'))
			.mutation(api.auth.onboarding.dismiss, { userId: 'admin-a' });

		// A different admin, in a different browser/session, sees it dismissed —
		// even though they never wrote a record of their own.
		const asAdminB = await base
			.withIdentity(adminIdentity('admin-b'))
			.query(api.auth.onboarding.getWithActualProgress, { userId: 'admin-b' });
		expect(asAdminB.dismissed).toBe(true);
		expect(asAdminB.dismissedAt).toEqual(expect.any(Number));

		// And the dismissing admin still sees it dismissed (idempotent, no per-user split).
		const asAdminA = await base
			.withIdentity(adminIdentity('admin-a'))
			.query(api.auth.onboarding.getWithActualProgress, { userId: 'admin-a' });
		expect(asAdminA.dismissed).toBe(true);
	});

	it('keeps exactly one dismissal record when the same admin dismisses twice', async () => {
		const base = convexTest(schema, modules);
		const asA = () => base.withIdentity(adminIdentity('admin-a'));

		await asA().mutation(api.auth.onboarding.dismiss, { userId: 'admin-a' });
		await asA().mutation(api.auth.onboarding.dismiss, { userId: 'admin-a' });

		const rows = await base.run(async (ctx) => ctx.db.query('onboardingProgress').collect());
		expect(rows).toHaveLength(1);
		expect(rows[0]?.dismissed).toBe(true);
	});
});

describe('auth/onboarding — dead code is deleted', () => {
	it('no longer exports get / initialize / markStepComplete', () => {
		const surface = onboarding as Record<string, unknown>;
		expect(surface['get']).toBeUndefined();
		expect(surface['initialize']).toBeUndefined();
		expect(surface['markStepComplete']).toBeUndefined();
	});

	it('still exports the live functions', () => {
		const surface = onboarding as Record<string, unknown>;
		expect(surface['getWithActualProgress']).toBeDefined();
		expect(surface['dismiss']).toBeDefined();
		expect(surface['restore']).toBeDefined();
	});
});

describe('auth/onboarding — steps follow the workspace features', () => {
	/** Every instance step done except the campaign one. */
	async function seedAllButACampaign(t: ReturnType<typeof convexTest>, campaigns: boolean) {
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				featureFlags: { campaigns },
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.insert('contacts', createTestContact() as never);
			await ctx.db.insert('emailTemplates', createTestEmailTemplate() as never);
			await ctx.db.insert('apiKeys', createTestApiKey() as never);
			await ctx.db.insert('domains', createTestDomain({ status: 'verified' }) as never);
		});
	}

	it('leaves out "Send a campaign" while campaigns are off, so the rest completes it', async () => {
		const t = convexTest(schema, modules);
		await seedAllButACampaign(t, false);
		const progress = await t
			.withIdentity(adminIdentity('admin-a'))
			.query(api.auth.onboarding.getWithActualProgress, { userId: 'admin-a' });
		expect(progress.totalSteps).toBe(5);
		expect(progress.completedSteps).toBe(5);
		expect(progress.isComplete).toBe(true);
	});

	it('counts "Send a campaign" while campaigns are on', async () => {
		const t = convexTest(schema, modules);
		await seedAllButACampaign(t, true);
		const progress = await t
			.withIdentity(adminIdentity('admin-a'))
			.query(api.auth.onboarding.getWithActualProgress, { userId: 'admin-a' });
		expect(progress.totalSteps).toBe(6);
		expect(progress.completedSteps).toBe(5);
		expect(progress.isComplete).toBe(false);
	});
});
