/**
 * H3 admin recovery for the email-verification gate
 * (auth/emailVerificationAdmin.ts).
 *
 * When REQUIRE_EMAIL_VERIFICATION is on, an unverified account cannot sign in.
 * These owner/admin-gated paths get a stranded member back in:
 *   - markMemberEmailVerified: flips emailVerified true out-of-band, audited,
 *     idempotent, org-scoped, and role-gated (owner/admin only).
 *   - resolveMemberForResend / resendMemberVerificationEmail: re-send the
 *     verification link; same org-scope + admin gate; already-verified is a no-op
 *     that never touches BetterAuth.
 *
 * BetterAuth `member` / `user` rows are real component rows, seeded through the
 * `components.betterAuth.adapter.create` mutation after registering the component
 * with `t.registerComponent` (mirrors gdprAccount.integration.test.ts). The
 * session (caller identity + role + active org) is mocked on
 * `getBetterAuthSessionWithRole`, the single resolver both the admin-mutation and
 * the org-permission gate read.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../../schema';
import betterAuthSchema from '../../betterAuth/schema';
import { api, internal, components } from '../../_generated/api';

const sessionMock = vi.hoisted(() => ({
	userId: 'admin-user',
	role: 'owner' as 'owner' | 'admin' | 'editor',
	activeOrganizationId: 'org-1',
}));

// The gate helpers call each other through module-internal bindings, so the
// low-level `getBetterAuthSessionWithRole` cannot be mocked from the outside —
// mock the exact gate functions the code under test (and its wrappers) invoke
// across a module boundary: `requireOrgMember` (the authedAction floor via
// auth/membership.assertOrgMember), `requireAdminContext` (adminMutation), and
// `requireOrgPermission` (resolveMemberForResend). Mirrors the pattern in
// gdprAccount.integration.test.ts / invitationResend.test.ts.
function currentSession() {
	return {
		userId: sessionMock.userId,
		role: sessionMock.role,
		activeOrganizationId: sessionMock.activeOrganizationId,
	};
}
function requireAdminRole() {
	if (sessionMock.role === 'editor') {
		throw new Error('Only owners and admins can perform this action');
	}
	return currentSession();
}

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		getBetterAuthSessionWithRole: vi.fn().mockImplementation(async () => currentSession()),
		requireOrgMember: vi.fn().mockImplementation(async () => currentSession()),
		requireAdminContext: vi.fn().mockImplementation(async () => requireAdminRole()),
		requireOrgPermission: vi.fn().mockImplementation(async () => requireAdminRole()),
	};
});

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
		.map(([key, val]) =>
			key.startsWith('../') && !key.startsWith('../../')
				? ([`../../auth/${key.slice(3)}`, val] as const)
				: ([key, val] as const)
		)
);

const betterAuthModules = import.meta.glob('../../betterAuth/**/*.*s');

function newHarness(): TestConvex<typeof schema> {
	const t = convexTest(schema, modules);
	t.registerComponent('betterAuth', betterAuthSchema, betterAuthModules);
	return t;
}

/** Create a BetterAuth user; returns its component `_id`. */
async function seedUser(
	t: TestConvex<typeof schema>,
	email: string,
	emailVerified: boolean
): Promise<string> {
	const now = Date.now();
	const user = (await t.mutation(components.betterAuth.adapter.create, {
		input: {
			model: 'user',
			data: { email, name: email, emailVerified, createdAt: now, updatedAt: now },
		},
	} as never)) as { _id: string };
	return user._id;
}

/** Link a user to an org with a role. */
async function seedMember(
	t: TestConvex<typeof schema>,
	organizationId: string,
	userId: string,
	role: 'owner' | 'admin' | 'editor'
): Promise<void> {
	await t.mutation(components.betterAuth.adapter.create, {
		input: {
			model: 'member',
			data: { organizationId, userId, role, createdAt: Date.now() },
		},
	} as never);
}

async function readUser(t: TestConvex<typeof schema>, userId: string) {
	return (await t.query(components.betterAuth.adapter.findOne, {
		model: 'user',
		where: [{ field: '_id', value: userId }],
	})) as { email?: string; emailVerified?: boolean } | null;
}

async function verificationAuditActions(t: TestConvex<typeof schema>): Promise<string[]> {
	return t.run(async (ctx) => {
		const rows = await ctx.db.query('auditLogs').collect();
		return rows.map((r) => r.action);
	});
}

beforeEach(() => {
	sessionMock.userId = 'admin-user';
	sessionMock.role = 'owner';
	sessionMock.activeOrganizationId = 'org-1';
});

describe('markMemberEmailVerified', () => {
	it('flips an unverified org member to verified and writes an audit row', async () => {
		const t = newHarness();
		const memberUserId = await seedUser(t, 'stranded@example.com', false);
		await seedMember(t, 'org-1', memberUserId, 'editor');

		const res = await t.mutation(api.auth.emailVerificationAdmin.markMemberEmailVerified, {
			userId: memberUserId,
		});
		expect(res).toEqual({ alreadyVerified: false, email: 'stranded@example.com' });

		expect((await readUser(t, memberUserId))?.emailVerified).toBe(true);
		expect(await verificationAuditActions(t)).toContain('team_member.email_verified');
	});

	it('is idempotent — an already-verified member is a no-op with no second audit row', async () => {
		const t = newHarness();
		const memberUserId = await seedUser(t, 'already@example.com', true);
		await seedMember(t, 'org-1', memberUserId, 'editor');

		const res = await t.mutation(api.auth.emailVerificationAdmin.markMemberEmailVerified, {
			userId: memberUserId,
		});
		expect(res).toEqual({ alreadyVerified: true, email: 'already@example.com' });
		expect(
			(await verificationAuditActions(t)).filter((a) => a === 'team_member.email_verified')
		).toHaveLength(0);
	});

	it('rejects a non-admin (editor) caller', async () => {
		const t = newHarness();
		const memberUserId = await seedUser(t, 'target@example.com', false);
		await seedMember(t, 'org-1', memberUserId, 'editor');
		sessionMock.role = 'editor';

		await expect(
			t.mutation(api.auth.emailVerificationAdmin.markMemberEmailVerified, { userId: memberUserId })
		).rejects.toThrow();
		expect((await readUser(t, memberUserId))?.emailVerified).toBe(false);
	});

	it('fails closed for a target who is not a member of the caller org (cross-org)', async () => {
		const t = newHarness();
		// Target belongs to a DIFFERENT org; the admin's active org is org-1.
		const foreignUserId = await seedUser(t, 'foreign@example.com', false);
		await seedMember(t, 'org-2', foreignUserId, 'editor');

		await expect(
			t.mutation(api.auth.emailVerificationAdmin.markMemberEmailVerified, { userId: foreignUserId })
		).rejects.toThrow(/not found/i);
		expect((await readUser(t, foreignUserId))?.emailVerified).toBe(false);
	});

	it('fails closed for an unknown target user id', async () => {
		const t = newHarness();
		await expect(
			t.mutation(api.auth.emailVerificationAdmin.markMemberEmailVerified, { userId: 'nope' })
		).rejects.toThrow(/not found/i);
	});
});

describe('resolveMemberForResend (admin gate + org-scoped resolution)', () => {
	it('returns the target email for an admin caller and org member', async () => {
		const t = newHarness();
		const memberUserId = await seedUser(t, 'resend@example.com', false);
		await seedMember(t, 'org-1', memberUserId, 'editor');

		const res = await t.query(internal.auth.emailVerificationAdmin.resolveMemberForResend, {
			userId: memberUserId,
		});
		expect(res.email).toBe('resend@example.com');
		expect(res.alreadyVerified).toBe(false);
		expect(res.organizationId).toBe('org-1');
	});

	it('rejects a non-admin caller before any resolution', async () => {
		const t = newHarness();
		const memberUserId = await seedUser(t, 'resend@example.com', false);
		await seedMember(t, 'org-1', memberUserId, 'editor');
		sessionMock.role = 'editor';

		await expect(
			t.query(internal.auth.emailVerificationAdmin.resolveMemberForResend, { userId: memberUserId })
		).rejects.toThrow();
	});

	it('fails closed for a cross-org target', async () => {
		const t = newHarness();
		const foreignUserId = await seedUser(t, 'foreign@example.com', false);
		await seedMember(t, 'org-2', foreignUserId, 'editor');

		await expect(
			t.query(internal.auth.emailVerificationAdmin.resolveMemberForResend, {
				userId: foreignUserId,
			})
		).rejects.toThrow(/not found/i);
	});
});

describe('resendMemberVerificationEmail', () => {
	it('is a no-op (sent:false) for an already-verified member and never calls BetterAuth', async () => {
		const t = newHarness();
		const memberUserId = await seedUser(t, 'verified@example.com', true);
		await seedMember(t, 'org-1', memberUserId, 'editor');

		const res = await t.action(api.auth.emailVerificationAdmin.resendMemberVerificationEmail, {
			userId: memberUserId,
		});
		expect(res).toEqual({ sent: false, email: 'verified@example.com' });
		// No audit row for a skipped resend.
		expect(await verificationAuditActions(t)).not.toContain('team_member.verification_resent');
	});

	it('rejects a cross-org target before touching BetterAuth', async () => {
		const t = newHarness();
		const foreignUserId = await seedUser(t, 'foreign@example.com', false);
		await seedMember(t, 'org-2', foreignUserId, 'editor');

		await expect(
			t.action(api.auth.emailVerificationAdmin.resendMemberVerificationEmail, {
				userId: foreignUserId,
			})
		).rejects.toThrow(/not found/i);
	});
});
