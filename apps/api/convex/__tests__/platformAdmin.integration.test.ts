/**
 * Integration tests for the platform-admin surface
 * (apps/api/convex/platformAdmin/platformAdmin.ts requirePlatformAdmin +
 * platformAdmin/mutations.ts).
 *
 * The management mutations (`setOrganizationStatus`, `addPlatformAdmin`,
 * `removePlatformAdmin`) are `authedMutation`s — their floor is
 * `getMutationContext` (→ `requireOrgMember`), which we mock to pass. On top
 * of that floor `requirePlatformAdmin` resolves the caller via
 * `requireAuthenticatedIdentity(ctx)` (we mock it to return a configurable
 * `subject`) and then looks the subject up in the `platformAdmins` table via
 * the `by_auth_user_id` index. So org membership alone is NOT enough — there
 * must be a `platformAdmins` row for the calling subject.
 *
 * `seedPlatformAdmin` is an `internalMutation` with no auth floor; it is called
 * directly.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';

// Mutable holder for the calling identity. `requireAuthenticatedIdentity`
// (consumed by `requirePlatformAdmin`) reads `subject` off this, so a test can
// switch which user is "logged in".
const sessionMock = vi.hoisted(() => ({
	subject: 'caller-user',
}));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		// authedMutation floor — always a valid org member so the platform-admin
		// gate is the only thing under test.
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'caller-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockImplementation(async () => sessionMock.subject),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'caller-user', role: 'owner' }),
		requireOrgPermission: vi.fn().mockResolvedValue({ userId: 'caller-user', role: 'owner' }),
		// requirePlatformAdmin resolves the caller's identity through this helper.
		requireAuthenticatedIdentity: vi.fn().mockImplementation(async () => ({
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
			!path.includes('llmProvider'),
	),
);

const setCaller = (subject: string) => {
	sessionMock.subject = subject;
};

/** Seed a platformAdmins row for the given auth user. */
async function seedAdmin(
	t: ReturnType<typeof convexTest>,
	authUserId: string,
	role: 'admin' | 'superadmin',
	email = `${authUserId}@example.com`,
): Promise<Id<'platformAdmins'>> {
	return await t.run(async (ctx) =>
		ctx.db.insert('platformAdmins', {
			authUserId,
			email,
			role,
			createdAt: Date.now(),
		}),
	);
}

/** Seed a userProfiles row (addPlatformAdmin resolves the target against it). */
async function seedProfile(
	t: ReturnType<typeof convexTest>,
	authUserId: string,
	email = `${authUserId}@example.com`,
): Promise<Id<'userProfiles'>> {
	return await t.run(async (ctx) => {
		const now = Date.now();
		return ctx.db.insert('userProfiles', {
			authUserId,
			email,
			name: authUserId,
			createdAt: now,
			updatedAt: now,
		});
	});
}

/** Seed the singleton instanceSettings row (required by setOrganizationStatus). */
async function seedInstanceSettings(
	t: ReturnType<typeof convexTest>,
	abuseStatus?: 'clean' | 'warned' | 'suspended' | 'banned',
): Promise<Id<'instanceSettings'>> {
	return await t.run(async (ctx) =>
		ctx.db.insert('instanceSettings', {
			...(abuseStatus ? { abuseStatus } : {}),
			createdAt: Date.now(),
		}),
	);
}

beforeEach(() => {
	setCaller('caller-user');
});

// ============ requirePlatformAdmin (via setOrganizationStatus) ============

describe('requirePlatformAdmin', () => {
	it('rejects a caller with no platformAdmins row (even an org owner)', async () => {
		const t = convexTest(schema, modules);
		await seedInstanceSettings(t);
		// Caller is a valid org owner (the authedMutation floor passes) but has NO
		// platformAdmins row — platform-admin access is a strictly higher tier.
		setCaller('not-a-platform-admin');

		await expect(
			t.mutation(api.platformAdmin.mutations.setOrganizationStatus, {
				abuseStatus: 'suspended',
				reason: 'spam',
			}),
		).rejects.toThrow(/Platform admin access required/);
	});
});

// ============ setOrganizationStatus ============

describe('platformAdmin.setOrganizationStatus', () => {
	it('works for a platform admin (transitions abuseStatus + reports prev/new)', async () => {
		const t = convexTest(schema, modules);
		const settingsId = await seedInstanceSettings(t, 'clean');
		await seedAdmin(t, 'caller-user', 'admin');
		setCaller('caller-user');

		const result = await t.mutation(api.platformAdmin.mutations.setOrganizationStatus, {
			abuseStatus: 'suspended',
			reason: 'abuse detected',
		});

		expect(result.success).toBe(true);
		expect(result.previousStatus).toBe('clean');
		expect(result.newStatus).toBe('suspended');

		await t.run(async (ctx) => {
			const settings = await ctx.db.get(settingsId);
			expect(settings!.abuseStatus).toBe('suspended');
			expect(settings!.abuseStatusReason).toBe('abuse detected');
			expect(settings!.abuseStatusChangedBy).toBe('caller-user');
		});
	});

	it('writes the legacy platform_admin.org_status_changed audit row', async () => {
		const t = convexTest(schema, modules);
		await seedInstanceSettings(t, 'clean');
		await seedAdmin(t, 'caller-user', 'superadmin');
		setCaller('caller-user');

		await t.mutation(api.platformAdmin.mutations.setOrganizationStatus, {
			abuseStatus: 'warned',
			reason: 'first warning',
		});

		const audit = await t.run(async (ctx) =>
			ctx.db
				.query('auditLogs')
				.withIndex('by_action', (q) => q.eq('action', 'platform_admin.org_status_changed'))
				.collect(),
		);
		expect(audit).toHaveLength(1);
		expect(audit[0]!.userId).toBe('caller-user');
		expect(audit[0]!.details).toMatchObject({
			previousStatus: 'clean',
			newStatus: 'warned',
			reason: 'first warning',
		});
	});

	it('throws not_found when there is no instanceSettings row', async () => {
		const t = convexTest(schema, modules);
		await seedAdmin(t, 'caller-user', 'admin');
		setCaller('caller-user');

		await expect(
			t.mutation(api.platformAdmin.mutations.setOrganizationStatus, {
				abuseStatus: 'suspended',
				reason: 'no settings',
			}),
		).rejects.toThrow(/Organization not found/);
	});
});

// ============ addPlatformAdmin ============

describe('platformAdmin.addPlatformAdmin', () => {
	it('lets a superadmin add a new admin and stores the profile email', async () => {
		const t = convexTest(schema, modules);
		await seedAdmin(t, 'super-1', 'superadmin');
		// Target has a canonical profile with a DIFFERENT email than the request,
		// to prove the profile email is stored (not the caller-supplied one).
		await seedProfile(t, 'target-1', 'canonical@example.com');
		setCaller('super-1');

		const newAdminId = await t.mutation(api.platformAdmin.mutations.addPlatformAdmin, {
			authUserId: 'target-1',
			email: 'spoofed@evil.example.com',
			role: 'admin',
		});

		expect(newAdminId).toBeDefined();
		await t.run(async (ctx) => {
			const admin = await ctx.db.get(newAdminId);
			expect(admin!.authUserId).toBe('target-1');
			expect(admin!.email).toBe('canonical@example.com');
			expect(admin!.role).toBe('admin');
		});
	});

	it('writes a platform_admin.admin_added audit row', async () => {
		const t = convexTest(schema, modules);
		await seedAdmin(t, 'super-1', 'superadmin');
		await seedProfile(t, 'target-1', 'canonical@example.com');
		setCaller('super-1');

		const newAdminId = await t.mutation(api.platformAdmin.mutations.addPlatformAdmin, {
			authUserId: 'target-1',
			email: 'ignored@example.com',
			role: 'admin',
		});

		const audit = await t.run(async (ctx) =>
			ctx.db
				.query('auditLogs')
				.withIndex('by_action', (q) => q.eq('action', 'platform_admin.admin_added'))
				.collect(),
		);
		expect(audit).toHaveLength(1);
		expect(audit[0]!.userId).toBe('super-1');
		expect(audit[0]!.resourceId).toBe(newAdminId);
		expect(audit[0]!.details).toMatchObject({
			email: 'canonical@example.com',
			role: 'admin',
			addedBy: 'super-1',
		});
	});

	it('rejects a plain admin (superadmin only)', async () => {
		const t = convexTest(schema, modules);
		await seedAdmin(t, 'admin-1', 'admin');
		await seedProfile(t, 'target-1');
		setCaller('admin-1');

		await expect(
			t.mutation(api.platformAdmin.mutations.addPlatformAdmin, {
				authUserId: 'target-1',
				email: 'target-1@example.com',
				role: 'admin',
			}),
		).rejects.toThrow(/Only superadmins can add/);
	});

	it('rejects an authUserId with no userProfiles row', async () => {
		const t = convexTest(schema, modules);
		await seedAdmin(t, 'super-1', 'superadmin');
		setCaller('super-1');
		// No profile seeded for the target.

		await expect(
			t.mutation(api.platformAdmin.mutations.addPlatformAdmin, {
				authUserId: 'ghost-user',
				email: 'ghost@example.com',
				role: 'admin',
			}),
		).rejects.toThrow(/User not found/);
	});

	it('rejects a duplicate platform admin', async () => {
		const t = convexTest(schema, modules);
		await seedAdmin(t, 'super-1', 'superadmin');
		await seedProfile(t, 'target-1');
		// target-1 is already a platform admin.
		await seedAdmin(t, 'target-1', 'admin');
		setCaller('super-1');

		await expect(
			t.mutation(api.platformAdmin.mutations.addPlatformAdmin, {
				authUserId: 'target-1',
				email: 'target-1@example.com',
				role: 'admin',
			}),
		).rejects.toThrow(/already a platform admin/);
	});
});

// ============ removePlatformAdmin ============

describe('platformAdmin.removePlatformAdmin', () => {
	it('removes another admin for a superadmin and writes an audit row', async () => {
		const t = convexTest(schema, modules);
		await seedAdmin(t, 'super-1', 'superadmin');
		const targetId = await seedAdmin(t, 'target-1', 'admin', 'target-1@example.com');
		setCaller('super-1');

		const result = await t.mutation(api.platformAdmin.mutations.removePlatformAdmin, {
			adminId: targetId,
		});
		expect(result.success).toBe(true);

		await t.run(async (ctx) => {
			expect(await ctx.db.get(targetId)).toBeNull();
		});

		const audit = await t.run(async (ctx) =>
			ctx.db
				.query('auditLogs')
				.withIndex('by_action', (q) => q.eq('action', 'platform_admin.admin_removed'))
				.collect(),
		);
		expect(audit).toHaveLength(1);
		expect(audit[0]!.userId).toBe('super-1');
		expect(audit[0]!.details).toMatchObject({
			email: 'target-1@example.com',
			role: 'admin',
		});
	});

	it('rejects self-removal', async () => {
		const t = convexTest(schema, modules);
		const selfId = await seedAdmin(t, 'super-1', 'superadmin');
		setCaller('super-1');

		await expect(
			t.mutation(api.platformAdmin.mutations.removePlatformAdmin, {
				adminId: selfId,
			}),
		).rejects.toThrow(/Cannot remove yourself/);

		// Still present.
		await t.run(async (ctx) => {
			expect(await ctx.db.get(selfId)).not.toBeNull();
		});
	});

	it('rejects a plain admin (superadmin only)', async () => {
		const t = convexTest(schema, modules);
		await seedAdmin(t, 'admin-1', 'admin');
		const targetId = await seedAdmin(t, 'target-1', 'admin');
		setCaller('admin-1');

		await expect(
			t.mutation(api.platformAdmin.mutations.removePlatformAdmin, {
				adminId: targetId,
			}),
		).rejects.toThrow(/Only superadmins can remove/);

		await t.run(async (ctx) => {
			expect(await ctx.db.get(targetId)).not.toBeNull();
		});
	});

	it('throws not_found for a non-existent admin id', async () => {
		const t = convexTest(schema, modules);
		await seedAdmin(t, 'super-1', 'superadmin');
		// Create then delete a row to obtain a valid-shaped but dangling id.
		const danglingId = await seedAdmin(t, 'gone', 'admin');
		await t.run(async (ctx) => ctx.db.delete(danglingId));
		setCaller('super-1');

		await expect(
			t.mutation(api.platformAdmin.mutations.removePlatformAdmin, {
				adminId: danglingId,
			}),
		).rejects.toThrow(/Platform admin not found/);
	});
});

// ============ seedPlatformAdmin (internal) ============

describe('platformAdmin.seedPlatformAdmin', () => {
	it('succeeds when platformAdmins is empty and seeds a superadmin', async () => {
		const t = convexTest(schema, modules);

		const adminId = await t.mutation(internal.platformAdmin.platformAdmin.seedPlatformAdmin, {
			authUserId: 'first-admin',
			email: 'first@example.com',
		});

		expect(adminId).toBeDefined();
		await t.run(async (ctx) => {
			const admin = await ctx.db.get(adminId);
			expect(admin!.authUserId).toBe('first-admin');
			expect(admin!.email).toBe('first@example.com');
			expect(admin!.role).toBe('superadmin');
		});
	});

	it('rejects seeding once platformAdmins is non-empty', async () => {
		const t = convexTest(schema, modules);
		await seedAdmin(t, 'existing-admin', 'superadmin');

		await expect(
			t.mutation(internal.platformAdmin.platformAdmin.seedPlatformAdmin, {
				authUserId: 'second-admin',
				email: 'second@example.com',
			}),
		).rejects.toThrow(/Platform admins already exist/);
	});
});
