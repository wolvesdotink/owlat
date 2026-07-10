/**
 * Coverage for auth/invitationResend.throttleResend:
 *   - first resend for an invitation is allowed and records the send time
 *   - a second resend within the cooldown window is rejected (rate limited)
 *   - a resend after the cooldown window elapses is allowed again
 *   - non-admin callers are rejected
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../../schema';
import { api } from '../../_generated/api';

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
			!path.includes('llmProvider')
	)
);

describe('invitationResend.throttleResend', () => {
	it('allows the first resend and records the send time', async () => {
		setAdminSession();
		const t = convexTest(schema, modules);

		const result = await t.mutation(api.auth.invitationResend.throttleResend, {
			invitationId: 'inv-1',
		});
		expect(result.ok).toBe(true);

		await t.run(async (ctx) => {
			const row = await ctx.db
				.query('invitationResends')
				.withIndex('by_invitation', (q) => q.eq('invitationId', 'inv-1'))
				.first();
			expect(row).toBeTruthy();
			expect(row?.organizationId).toBe('test-org');
		});
	});

	it('rejects a second resend within the cooldown window', async () => {
		setAdminSession();
		const t = convexTest(schema, modules);

		await t.mutation(api.auth.invitationResend.throttleResend, {
			invitationId: 'inv-1',
		});

		await expect(
			t.mutation(api.auth.invitationResend.throttleResend, {
				invitationId: 'inv-1',
			})
		).rejects.toThrow(/wait/i);
	});

	it('allows a resend again once the cooldown window has elapsed', async () => {
		setAdminSession();
		const t = convexTest(schema, modules);

		// Seed a stale resend row (last sent well over the cooldown ago).
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

		await t.run(async (ctx) => {
			const rows = await ctx.db
				.query('invitationResends')
				.withIndex('by_invitation', (q) => q.eq('invitationId', 'inv-1'))
				.collect();
			// The single row is reused (patched), not duplicated.
			expect(rows).toHaveLength(1);
			expect(rows[0]?.lastSentAt).toBeGreaterThan(Date.now() - 60_000);
		});
	});

	it('throttles each invitation independently', async () => {
		setAdminSession();
		const t = convexTest(schema, modules);

		const a = await t.mutation(api.auth.invitationResend.throttleResend, {
			invitationId: 'inv-a',
		});
		const b = await t.mutation(api.auth.invitationResend.throttleResend, {
			invitationId: 'inv-b',
		});
		expect(a.ok).toBe(true);
		expect(b.ok).toBe(true);
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
