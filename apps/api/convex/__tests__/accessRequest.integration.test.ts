/**
 * Coverage for auth/accessRequest.ts — the door out of the invite-only
 * dead-end:
 *   - request: authed-identity self, idempotent reuse of the open row, "already
 *     a member" refusal, note length cap, and — the security property — that it
 *     only ever writes the accessRequests table (it can NEVER grant membership).
 *   - listPending / resolve: admin gating, org isolation, and resolving as a
 *     plain status flip that likewise never confers membership.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';

const sessionMocks = vi.hoisted(() => ({
	requireAuthenticatedIdentity: vi.fn(),
	getBetterAuthSession: vi.fn(),
	getBetterAuthSessionWithRole: vi.fn(),
	getSingletonOrganizationId: vi.fn(),
	// adminQuery gates listPending via requireOrgPermission; adminMutation gates
	// resolve via requireAdminContext. Both are called inside the wrappers.
	requireOrgPermission: vi.fn(),
	requireAdminContext: vi.fn(),
}));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireAuthenticatedIdentity: sessionMocks.requireAuthenticatedIdentity,
		getBetterAuthSession: sessionMocks.getBetterAuthSession,
		getBetterAuthSessionWithRole: sessionMocks.getBetterAuthSessionWithRole,
		getSingletonOrganizationId: sessionMocks.getSingletonOrganizationId,
		requireOrgPermission: sessionMocks.requireOrgPermission,
		requireAdminContext: sessionMocks.requireAdminContext,
	};
});

/**
 * A signed-in but orgless requester: an authenticated identity, no active org,
 * and the singleton org resolves for addressing the request. The admin gates
 * fail closed for this caller.
 */
function setRequesterSession(userId: string, email = `${userId}@example.com`, orgId = 'test-org') {
	sessionMocks.requireAuthenticatedIdentity.mockResolvedValue({ subject: userId, email });
	sessionMocks.getBetterAuthSession.mockResolvedValue({ userId, activeOrganizationId: null });
	sessionMocks.getSingletonOrganizationId.mockResolvedValue(orgId);
	sessionMocks.requireOrgPermission.mockImplementation(async () => {
		throw new Error("You don't have permission to perform this action");
	});
	sessionMocks.requireAdminContext.mockImplementation(async () => {
		throw new Error('Only owners and admins can perform this action');
	});
}

function setAdminSession(userId = 'admin-user', orgId = 'test-org') {
	sessionMocks.requireAuthenticatedIdentity.mockResolvedValue({
		subject: userId,
		email: `${userId}@example.com`,
	});
	sessionMocks.getBetterAuthSessionWithRole.mockResolvedValue({
		userId,
		role: 'owner',
		activeOrganizationId: orgId,
	});
	sessionMocks.getSingletonOrganizationId.mockResolvedValue(orgId);
	sessionMocks.requireOrgPermission.mockResolvedValue({ userId, role: 'owner' });
	sessionMocks.requireAdminContext.mockResolvedValue({ userId, role: 'owner' });
}

async function seedUserProfile(
	t: ReturnType<typeof convexTest>,
	userId: string,
	email: string,
	name?: string
) {
	await t.run(async (ctx) => {
		await ctx.db.insert('userProfiles', {
			authUserId: userId,
			email,
			name,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
	});
}

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
			!path.includes('llmProvider')
	)
);

beforeEach(() => {
	vi.clearAllMocks();
});

describe('accessRequest.request', () => {
	it('inserts an open request naming the requester, addressed to the singleton org', async () => {
		setRequesterSession('newcomer');
		const t = convexTest(schema, modules);
		await seedUserProfile(t, 'newcomer', 'newcomer@example.com', 'New Comer');

		const result = await t.mutation(api.auth.accessRequest.request, { note: 'I need in' });
		expect(result.requested).toBe(true);

		await t.run(async (ctx) => {
			const rows = await ctx.db
				.query('accessRequests')
				.withIndex('by_auth_user_id', (q) => q.eq('authUserId', 'newcomer'))
				.collect();
			expect(rows).toHaveLength(1);
			expect(rows[0]?.status).toBe('open');
			expect(rows[0]?.requesterEmail).toBe('newcomer@example.com');
			expect(rows[0]?.requesterName).toBe('New Comer');
			expect(rows[0]?.note).toBe('I need in');
			expect(rows[0]?.organizationId).toBe('test-org');
		});
	});

	it('falls back to the identity email when no profile exists yet', async () => {
		setRequesterSession('newcomer', 'from-identity@example.com');
		const t = convexTest(schema, modules);

		await t.mutation(api.auth.accessRequest.request, {});

		await t.run(async (ctx) => {
			const rows = await ctx.db
				.query('accessRequests')
				.withIndex('by_auth_user_id', (q) => q.eq('authUserId', 'newcomer'))
				.collect();
			expect(rows).toHaveLength(1);
			expect(rows[0]?.requesterEmail).toBe('from-identity@example.com');
		});
	});

	it('is idempotent: a second request reuses the open row and refreshes the note', async () => {
		setRequesterSession('newcomer');
		const t = convexTest(schema, modules);
		await seedUserProfile(t, 'newcomer', 'newcomer@example.com');

		const first = await t.mutation(api.auth.accessRequest.request, { note: 'first' });
		const second = await t.mutation(api.auth.accessRequest.request, { note: 'second' });
		expect(second.requestId).toBe(first.requestId);

		await t.run(async (ctx) => {
			const rows = await ctx.db
				.query('accessRequests')
				.withIndex('by_auth_user_id', (q) => q.eq('authUserId', 'newcomer'))
				.collect();
			expect(rows).toHaveLength(1);
			expect(rows[0]?.note).toBe('second');
		});
	});

	it('refuses when the caller already belongs to the organization', async () => {
		setRequesterSession('member-a');
		// The caller is actually a member: their session carries an active org.
		sessionMocks.getBetterAuthSession.mockResolvedValue({
			userId: 'member-a',
			activeOrganizationId: 'test-org',
		});
		const t = convexTest(schema, modules);

		await expect(t.mutation(api.auth.accessRequest.request, {})).rejects.toThrow(
			/already have access/i
		);

		await t.run(async (ctx) => {
			const rows = await ctx.db.query('accessRequests').collect();
			expect(rows).toHaveLength(0);
		});
	});

	it('rejects a note longer than the length cap', async () => {
		setRequesterSession('newcomer');
		const t = convexTest(schema, modules);
		await seedUserProfile(t, 'newcomer', 'newcomer@example.com');

		await expect(
			t.mutation(api.auth.accessRequest.request, { note: 'x'.repeat(501) })
		).rejects.toThrow(/characters or fewer/i);
	});

	it('SECURITY: requesting only writes the accessRequests table — it cannot grant membership', async () => {
		setRequesterSession('newcomer');
		const t = convexTest(schema, modules);
		await seedUserProfile(t, 'newcomer', 'newcomer@example.com');

		await t.mutation(api.auth.accessRequest.request, {});

		await t.run(async (ctx) => {
			// The ONLY effect is one open request row. There is no mailbox, no
			// membership, no org-scoped grant of any kind — the requester is still
			// exactly as orgless as before.
			const requests = await ctx.db.query('accessRequests').collect();
			expect(requests).toHaveLength(1);
			const mailboxes = await ctx.db.query('mailboxes').collect();
			expect(mailboxes).toHaveLength(0);
		});
	});
});

describe('accessRequest.listPending / resolve', () => {
	it('lists open requests for the caller org and resolves them (a status flip, not a grant)', async () => {
		setRequesterSession('newcomer');
		const t = convexTest(schema, modules);
		await seedUserProfile(t, 'newcomer', 'newcomer@example.com');
		await t.mutation(api.auth.accessRequest.request, {});

		setAdminSession();
		const open = await t.query(api.auth.accessRequest.listPending, {});
		expect(open).toHaveLength(1);
		const first = open[0];
		if (!first) throw new Error('expected one open request');
		expect(first.email).toBe('newcomer@example.com');

		const result = await t.mutation(api.auth.accessRequest.resolve, { requestId: first.id });
		expect(result.resolved).toBe(true);

		const afterResolve = await t.query(api.auth.accessRequest.listPending, {});
		expect(afterResolve).toHaveLength(0);

		await t.run(async (ctx) => {
			// Resolving only flipped status; it did not create a mailbox/membership.
			const rows = await ctx.db.query('accessRequests').collect();
			expect(rows).toHaveLength(1);
			expect(rows[0]?.status).toBe('resolved');
			const mailboxes = await ctx.db.query('mailboxes').collect();
			expect(mailboxes).toHaveLength(0);
		});
	});

	it('rejects resolving a request from a different organization', async () => {
		setRequesterSession('newcomer', 'newcomer@example.com', 'org-1');
		const t = convexTest(schema, modules);
		await seedUserProfile(t, 'newcomer', 'newcomer@example.com');
		const created = await t.mutation(api.auth.accessRequest.request, {});

		setAdminSession('admin-user', 'org-2');
		await expect(
			t.mutation(api.auth.accessRequest.resolve, { requestId: created.requestId })
		).rejects.toThrow(/not accessible/i);
	});

	it('a non-admin caller cannot list pending requests (fails closed)', async () => {
		setRequesterSession('newcomer');
		const t = convexTest(schema, modules);
		await seedUserProfile(t, 'newcomer', 'newcomer@example.com');
		await t.mutation(api.auth.accessRequest.request, {});

		// Still not an admin: the admin-gated read must refuse.
		await expect(t.query(api.auth.accessRequest.listPending, {})).rejects.toThrow(/permission/i);
	});
});
