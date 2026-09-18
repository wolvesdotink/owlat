/**
 * Integration tests for how the `platformAdmins` roster is BOOTSTRAPPED
 * (apps/api/convex/platformAdmin/bootstrap.ts).
 *
 * Two entry points, one shared precondition — the table must be empty:
 *
 *   - `seedInitialPlatformAdmin` (internal) runs inside `/seed/admin` and grants
 *     the freshly-created setup user `superadmin`.
 *   - `claimInitialPlatformAdmin` (`ownerMutation`) lets the org OWNER take the
 *     empty roster from the admin hub on an instance seeded before that existed.
 *
 * The empty-table precondition is the only thing standing between "the owner of
 * a single-org self-host can operate their own box" and "any org admin can
 * silently promote themselves", so each refusal path below is a security
 * assertion, not a nicety.
 *
 * The org floors are mocked (`getMutationContext` / `requireOrgMember` /
 * `requireOwnerContext`) with a switchable role, but the OWNER gate itself runs
 * the real `hasPermission(role, 'organization:delete')` so a role regression in
 * the permission table still fails here.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';

const sessionMock = vi.hoisted(() => ({
	subject: 'owner-user',
	role: 'owner' as 'owner' | 'admin' | 'editor',
}));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof import('../lib/sessionOrganization')>(
		'../lib/sessionOrganization'
	);
	// `requirePermission` is an assertion function, which TypeScript refuses to
	// call through a namespace binding — raise the same forbidden error directly.
	const errors = await vi.importActual<typeof import('../_utils/errors')>('../_utils/errors');
	const session = () => ({
		userId: sessionMock.subject,
		role: sessionMock.role,
		activeOrganizationId: 'org-1',
	});
	return {
		...actual,
		getMutationContext: vi.fn(async () => session()),
		requireOrgMember: vi.fn(async () => session()),
		isActiveOrgMember: vi.fn(async () => true),
		getUserIdFromSession: vi.fn(async () => sessionMock.subject),
		// Keep the REAL permission check — only the session resolution is faked.
		// `requireOwnerContext` in the actual module calls its own internal
		// `getMutationContext`, which the spread above does not rewire, so the
		// gate has to be reassembled here from the genuine helpers.
		requireOwnerContext: vi.fn(async (_ctx: unknown, message?: string) => {
			if (!actual.hasPermission(session().role, 'organization:delete')) {
				errors.throwForbidden(message ?? 'Only owners can perform this action');
			}
			return session();
		}),
		requireOrgPermission: vi.fn(async (_ctx: unknown, permission: never) => {
			if (!actual.hasPermission(session().role, permission)) {
				errors.throwForbidden("You don't have permission to perform this action");
			}
			return session();
		}),
		requireAuthenticatedIdentity: vi.fn(async () => ({
			subject: sessionMock.subject,
			issuer: 'test',
			tokenIdentifier: `test|${sessionMock.subject}`,
		})),
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
			!path.includes('llmProvider')
	)
);

function setCaller(subject: string, role: 'owner' | 'admin' | 'editor' = 'owner') {
	sessionMock.subject = subject;
	sessionMock.role = role;
}

async function seedProfile(
	t: ReturnType<typeof convexTest>,
	authUserId: string,
	overrides: { email?: string; deletedAt?: number } = {}
): Promise<Id<'userProfiles'>> {
	return await t.run(async (ctx) => {
		const now = Date.now();
		return ctx.db.insert('userProfiles', {
			authUserId,
			email: overrides.email ?? `${authUserId}@example.com`,
			name: authUserId,
			...(overrides.deletedAt !== undefined ? { deletedAt: overrides.deletedAt } : {}),
			createdAt: now,
			updatedAt: now,
		});
	});
}

async function seedAdmin(
	t: ReturnType<typeof convexTest>,
	authUserId: string,
	role: 'admin' | 'superadmin' = 'superadmin'
): Promise<Id<'platformAdmins'>> {
	return await t.run(async (ctx) =>
		ctx.db.insert('platformAdmins', {
			authUserId,
			email: `${authUserId}@example.com`,
			role,
			createdAt: Date.now(),
		})
	);
}

const roster = (t: ReturnType<typeof convexTest>) =>
	t.run(async (ctx) => ctx.db.query('platformAdmins').collect());

beforeEach(() => {
	setCaller('owner-user', 'owner');
});

// ============ seedInitialPlatformAdmin (the /seed/admin path) ============

describe('seedInitialPlatformAdmin', () => {
	it('grants the freshly-seeded setup user superadmin', async () => {
		const t = convexTest(schema, modules);
		await seedProfile(t, 'setup-user', { email: 'setup@example.com' });

		const result = await t.mutation(internal.platformAdmin.bootstrap.seedInitialPlatformAdmin, {});

		expect(result).toEqual({ granted: true });
		const rows = await roster(t);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			authUserId: 'setup-user',
			email: 'setup@example.com',
			role: 'superadmin',
		});
	});

	it('writes an audit row attributing the grant to setup', async () => {
		const t = convexTest(schema, modules);
		await seedProfile(t, 'setup-user');

		await t.mutation(internal.platformAdmin.bootstrap.seedInitialPlatformAdmin, {});

		const logs = await t.run(async (ctx) => ctx.db.query('auditLogs').collect());
		expect(logs).toHaveLength(1);
		expect(logs[0]).toMatchObject({
			action: 'platform_admin.bootstrap_granted',
			resource: 'platform_admin',
			userId: 'setup-user',
		});
		expect(logs[0]?.details).toMatchObject({ via: 'setup', role: 'superadmin' });
	});

	it('is a no-op when a platform admin already exists', async () => {
		const t = convexTest(schema, modules);
		await seedAdmin(t, 'existing-admin');
		await seedProfile(t, 'setup-user');

		const result = await t.mutation(internal.platformAdmin.bootstrap.seedInitialPlatformAdmin, {});

		expect(result).toEqual({ granted: false });
		expect(await roster(t)).toHaveLength(1);
	});

	it('is a no-op when no user profile exists yet', async () => {
		const t = convexTest(schema, modules);

		const result = await t.mutation(internal.platformAdmin.bootstrap.seedInitialPlatformAdmin, {});

		expect(result).toEqual({ granted: false });
		expect(await roster(t)).toHaveLength(0);
	});

	it('refuses to guess when the instance already holds several users', async () => {
		// Not a fresh seed — picking "a" profile here would hand the deployment to
		// an arbitrary member.
		const t = convexTest(schema, modules);
		await seedProfile(t, 'user-a');
		await seedProfile(t, 'user-b');

		const result = await t.mutation(internal.platformAdmin.bootstrap.seedInitialPlatformAdmin, {});

		expect(result).toEqual({ granted: false });
		expect(await roster(t)).toHaveLength(0);
	});
});

// ============ claimInitialPlatformAdmin (the owner path) ============

describe('claimInitialPlatformAdmin', () => {
	it('lets the org owner claim an empty roster', async () => {
		const t = convexTest(schema, modules);
		await seedProfile(t, 'owner-user', { email: 'owner@example.com' });

		await t.mutation(api.platformAdmin.bootstrap.claimInitialPlatformAdmin, {});

		const rows = await roster(t);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			authUserId: 'owner-user',
			email: 'owner@example.com',
			role: 'superadmin',
		});
	});

	it('makes the claimer a platform admin for real', async () => {
		const t = convexTest(schema, modules);
		await seedProfile(t, 'owner-user');
		// `isPlatformAdmin` reads the raw Convex identity rather than the mocked
		// session helpers, so this arm needs a real one attached.
		const asOwner = t.withIdentity({ subject: 'owner-user' });
		expect(await asOwner.query(api.platformAdmin.platformAdmin.isPlatformAdmin, {})).toBe(false);

		await t.mutation(api.platformAdmin.bootstrap.claimInitialPlatformAdmin, {});

		expect(await asOwner.query(api.platformAdmin.platformAdmin.isPlatformAdmin, {})).toBe(true);
	});

	it('rejects an org ADMIN — this is an owner-only decision', async () => {
		const t = convexTest(schema, modules);
		setCaller('admin-user', 'admin');
		await seedProfile(t, 'admin-user');

		await expect(
			t.mutation(api.platformAdmin.bootstrap.claimInitialPlatformAdmin, {})
		).rejects.toThrow();
		expect(await roster(t)).toHaveLength(0);
	});

	it('rejects an editor', async () => {
		const t = convexTest(schema, modules);
		setCaller('editor-user', 'editor');
		await seedProfile(t, 'editor-user');

		await expect(
			t.mutation(api.platformAdmin.bootstrap.claimInitialPlatformAdmin, {})
		).rejects.toThrow();
		expect(await roster(t)).toHaveLength(0);
	});

	it('refuses once anybody holds platform admin', async () => {
		// The escalation case: an owner must not be able to add themselves behind
		// an existing operator's back — that goes through addPlatformAdmin.
		const t = convexTest(schema, modules);
		await seedAdmin(t, 'someone-else');
		await seedProfile(t, 'owner-user');

		await expect(
			t.mutation(api.platformAdmin.bootstrap.claimInitialPlatformAdmin, {})
		).rejects.toThrow(/already has a platform admin/i);
		expect(await roster(t)).toHaveLength(1);
	});

	it('is not repeatable by the same owner', async () => {
		const t = convexTest(schema, modules);
		await seedProfile(t, 'owner-user');

		await t.mutation(api.platformAdmin.bootstrap.claimInitialPlatformAdmin, {});
		await expect(
			t.mutation(api.platformAdmin.bootstrap.claimInitialPlatformAdmin, {})
		).rejects.toThrow();

		expect(await roster(t)).toHaveLength(1);
	});

	it('rejects an owner with no user profile', async () => {
		const t = convexTest(schema, modules);

		await expect(
			t.mutation(api.platformAdmin.bootstrap.claimInitialPlatformAdmin, {})
		).rejects.toThrow();
		expect(await roster(t)).toHaveLength(0);
	});
});

// ============ getBootstrapStatus (drives the admin-hub card) ============

describe('getBootstrapStatus', () => {
	it('offers the claim to an owner while the roster is empty', async () => {
		const t = convexTest(schema, modules);

		expect(await t.query(api.platformAdmin.bootstrap.getBootstrapStatus, {})).toEqual({
			rosterEmpty: true,
			canClaim: true,
		});
	});

	it('does not offer it to a non-owner', async () => {
		const t = convexTest(schema, modules);
		setCaller('admin-user', 'admin');

		expect(await t.query(api.platformAdmin.bootstrap.getBootstrapStatus, {})).toEqual({
			rosterEmpty: true,
			canClaim: false,
		});
	});

	it('stops offering it once the roster is populated', async () => {
		const t = convexTest(schema, modules);
		await seedAdmin(t, 'someone-else');

		expect(await t.query(api.platformAdmin.bootstrap.getBootstrapStatus, {})).toEqual({
			rosterEmpty: false,
			canClaim: false,
		});
	});
});

// ============ promotion candidates ============

describe('listAllUsers', () => {
	it('omits soft-deleted accounts from the promotion picker', async () => {
		const t = convexTest(schema, modules);
		await seedAdmin(t, 'owner-user');
		await seedProfile(t, 'owner-user');
		await seedProfile(t, 'live-user');
		await seedProfile(t, 'gone-user', { deletedAt: Date.now() });

		const users = await t.query(api.platformAdmin.queries.listAllUsers, {});

		expect(users.map((u) => u.authUserId).sort()).toEqual(['live-user', 'owner-user']);
	});
});
