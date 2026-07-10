/**
 * Coverage for the invitation-email resend throttle.
 *
 * `enforceResendThrottle` is the real choke point (the `sendInvitationEmail` hook
 * calls it for every send — first invite and every resend, from any client):
 *   - the first send stamps the row (so "1/min" counts the initial send)
 *   - a second send within the cooldown window throws (rate limited)
 *   - a send after the cooldown elapses is allowed again, reusing the row
 *   - each invitation is throttled independently
 *
 * `throttleResend` is the client-facing, READ-ONLY pre-check:
 *   - reports "allowed" when no send is on record or the cooldown elapsed
 *   - throws inside the cooldown (friendly "wait Ns")
 *   - never writes rows (the hook owns the stamp)
 *   - rejects non-admin callers
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';

const sessionMocks = vi.hoisted(() => ({
	getBetterAuthSessionWithRole: vi.fn(),
	requireAdminContext: vi.fn(),
}));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		getBetterAuthSessionWithRole: sessionMocks.getBetterAuthSessionWithRole,
		requireAdminContext: sessionMocks.requireAdminContext,
	};
});

function setAdminSession(userId = 'admin-user', orgId = 'test-org') {
	sessionMocks.getBetterAuthSessionWithRole.mockResolvedValue({
		userId,
		role: 'owner',
		activeOrganizationId: orgId,
	});
	sessionMocks.requireAdminContext.mockResolvedValue({ userId, role: 'owner' });
}

function setEditorSession(userId = 'editor-user', orgId = 'test-org') {
	sessionMocks.getBetterAuthSessionWithRole.mockResolvedValue({
		userId,
		role: 'editor',
		activeOrganizationId: orgId,
	});
	sessionMocks.requireAdminContext.mockImplementation(async () => {
		throw new Error('Only owners and admins can perform this action');
	});
}

const allModules = import.meta.glob('../../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules)
		.filter(
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
				!path.includes('llmProvider')
		)
		// Vite collapses `import.meta.glob` keys for sibling modules to the shortest
		// relative path (e.g. `../invitationResend.ts`), but convex-test derives its
		// module prefix from `../../_generated/api.d.ts` and looks them up under
		// `../../auth/…`. Remap the short keys back so every auth module resolves.
		.map(([key, val]) =>
			key.startsWith('../') && !key.startsWith('../../')
				? (['../../auth/' + key.slice(3), val] as const)
				: ([key, val] as const)
		)
);

describe('invitationResend.enforceResendThrottle (send-path choke point)', () => {
	it('stamps the row on the first send (the initial send counts)', async () => {
		const t = convexTest(schema, modules);

		await t.mutation(internal.auth.invitationResend.enforceResendThrottle, {
			invitationId: 'inv-1',
			organizationId: 'test-org',
		});

		await t.run(async (ctx) => {
			const row = await ctx.db
				.query('invitationResends')
				.withIndex('by_invitation', (q) => q.eq('invitationId', 'inv-1'))
				.first();
			expect(row).toBeTruthy();
			expect(row?.organizationId).toBe('test-org');
		});
	});

	it('throws on a second send within the cooldown window', async () => {
		const t = convexTest(schema, modules);

		await t.mutation(internal.auth.invitationResend.enforceResendThrottle, {
			invitationId: 'inv-1',
			organizationId: 'test-org',
		});

		await expect(
			t.mutation(internal.auth.invitationResend.enforceResendThrottle, {
				invitationId: 'inv-1',
				organizationId: 'test-org',
			})
		).rejects.toThrow(/wait/i);
	});

	it('allows a send again once the cooldown window has elapsed, reusing the row', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert('invitationResends', {
				invitationId: 'inv-1',
				organizationId: 'test-org',
				lastSentAt: Date.now() - 5 * 60_000,
			});
		});

		await t.mutation(internal.auth.invitationResend.enforceResendThrottle, {
			invitationId: 'inv-1',
			organizationId: 'test-org',
		});

		await t.run(async (ctx) => {
			const rows = await ctx.db
				.query('invitationResends')
				.withIndex('by_invitation', (q) => q.eq('invitationId', 'inv-1'))
				.collect();
			// The single row is patched, not duplicated.
			expect(rows).toHaveLength(1);
			expect(rows[0]?.lastSentAt).toBeGreaterThan(Date.now() - 60_000);
		});
	});

	it('throttles each invitation independently', async () => {
		const t = convexTest(schema, modules);

		await t.mutation(internal.auth.invitationResend.enforceResendThrottle, {
			invitationId: 'inv-a',
			organizationId: 'test-org',
		});
		// A different invitation is not affected by inv-a's cooldown.
		await expect(
			t.mutation(internal.auth.invitationResend.enforceResendThrottle, {
				invitationId: 'inv-b',
				organizationId: 'test-org',
			})
		).resolves.not.toThrow();
	});
});

describe('invitationResend.throttleResend (client pre-check)', () => {
	it('reports allowed when nothing is on record', async () => {
		setAdminSession();
		const t = convexTest(schema, modules);

		const result = await t.mutation(api.auth.invitationResend.throttleResend, {
			invitationId: 'inv-1',
		});
		expect(result.ok).toBe(true);
	});

	it('is read-only — it never writes a resend row', async () => {
		setAdminSession();
		const t = convexTest(schema, modules);

		await t.mutation(api.auth.invitationResend.throttleResend, {
			invitationId: 'inv-1',
		});

		await t.run(async (ctx) => {
			const row = await ctx.db
				.query('invitationResends')
				.withIndex('by_invitation', (q) => q.eq('invitationId', 'inv-1'))
				.first();
			expect(row).toBeNull();
		});
	});

	it('throws inside the cooldown once the hook has stamped a send', async () => {
		setAdminSession();
		const t = convexTest(schema, modules);

		// Simulate the enforced send having just stamped the invitation.
		await t.mutation(internal.auth.invitationResend.enforceResendThrottle, {
			invitationId: 'inv-1',
			organizationId: 'test-org',
		});

		await expect(
			t.mutation(api.auth.invitationResend.throttleResend, {
				invitationId: 'inv-1',
			})
		).rejects.toThrow(/wait/i);
	});

	it('reports allowed again once the cooldown has elapsed', async () => {
		setAdminSession();
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert('invitationResends', {
				invitationId: 'inv-1',
				organizationId: 'test-org',
				lastSentAt: Date.now() - 5 * 60_000,
			});
		});

		const result = await t.mutation(api.auth.invitationResend.throttleResend, {
			invitationId: 'inv-1',
		});
		expect(result.ok).toBe(true);
	});

	it('rejects non-admin callers', async () => {
		setEditorSession();
		const t = convexTest(schema, modules);

		await expect(
			t.mutation(api.auth.invitationResend.throttleResend, {
				invitationId: 'inv-1',
			})
		).rejects.toThrow();
	});
});
