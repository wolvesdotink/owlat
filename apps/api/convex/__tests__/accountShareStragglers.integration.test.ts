/**
 * Integration tests for the remaining straggler endpoints:
 *
 *   - auth/accountManagement.ts  cancelAccountDeletion (token-gated publicMutation)
 *                                + getPendingDeletionRequest (authedQuery, requireSelf)
 *   - shareLinks.ts              createShareLink / revokeShareLink / listShareLinks
 *                                (admin/permission gate + polymorphic-target xor invariant)
 *   - shareLinkHttp.ts           GET /share/{token} (public token endpoint)
 *   - shareLinkQueries.ts        getShareLinkByToken (internal: revoked/expired/live)
 *   - systemUpdates.ts           checkForUpdates (bespoke platform-admin gate)
 *
 * Auth model under test (single-org deployment):
 *   - The authedQuery/authedMutation floor (`requireOrgMember` / `getMutationContext`)
 *     is mocked to pass with a configurable role so the *in-handler* role gate
 *     (`hasPermission(role, 'shareLinks:manage')` — the REAL implementation) is the
 *     thing exercised.
 *   - `getPendingDeletionRequest`/the session path of `cancelAccountDeletion` use the
 *     REAL `requireSelf`, which reads `getUserIdFromSession` (mocked) — so a foreign
 *     userId is genuinely rejected.
 *   - `checkForUpdates` is an `authedAction`; its floor calls `auth.membership.assertOrgMember`
 *     → `requireOrgMember` (mocked). On top of the floor it resolves the caller via
 *     `requireAuthenticatedIdentity` (mocked) and looks the subject up in the REAL
 *     `platformAdmins` table via `isPlatformAdminByUserId`.
 */

import { convexTest, type TestConvex } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';

// Mutable session: requireSelf passes for `sessionMock.userId`; role drives the
// in-handler shareLinks:manage permission gate; subject is what
// requireAuthenticatedIdentity resolves to (the platform-admin lookup key).
const sessionMock = vi.hoisted(() => ({
	userId: 'auth-user-1',
	role: 'owner' as 'owner' | 'admin' | 'editor' | 'viewer',
	subject: 'auth-user-1',
}));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		// authedQuery/authedMutation + authedAction (assertOrgMember) floor.
		requireOrgMember: vi.fn().mockImplementation(async () => ({
			userId: sessionMock.userId,
			role: sessionMock.role,
		})),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockImplementation(async () => sessionMock.userId),
		getMutationContext: vi.fn().mockImplementation(async () => ({
			userId: sessionMock.userId,
			role: sessionMock.role,
		})),
		requireOrgPermission: vi.fn().mockImplementation(async () => ({
			userId: sessionMock.userId,
			role: sessionMock.role,
		})),
		// requirePlatformAdmin / checkForUpdates resolve the caller through this.
		requireAuthenticatedIdentity: vi.fn().mockImplementation(async () => ({
			subject: sessionMock.subject,
			issuer: 'test',
			tokenIdentifier: `test|${sessionMock.subject}`,
		})),
		// requireSelf is called through a local reference inside accountManagement,
		// so mock it directly (NOT only getUserIdFromSession).
		requireSelf: vi.fn().mockImplementation(async (_ctx: unknown, claimed: string) => {
			if (claimed !== sessionMock.userId) {
				throw new Error('unauthenticated');
			}
			return sessionMock.userId;
		}),
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

function newHarness(): TestConvex<typeof schema> {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	return t;
}

const SAVED_ENV = { ...process.env };

beforeEach(() => {
	sessionMock.userId = 'auth-user-1';
	sessionMock.role = 'owner';
	sessionMock.subject = 'auth-user-1';
});

afterEach(() => {
	process.env = { ...SAVED_ENV };
});

// ─── Seed helpers ───────────────────────────────────────────────────────────

async function seedProfile(
	t: TestConvex<typeof schema>,
	authUserId: string,
	email = 'me@example.com',
): Promise<Id<'userProfiles'>> {
	return await t.run(async (ctx) => {
		const now = Date.now();
		return await ctx.db.insert('userProfiles', {
			authUserId,
			email,
			name: 'Me',
			createdAt: now,
			updatedAt: now,
		});
	});
}

async function seedDeletionRequest(
	t: TestConvex<typeof schema>,
	userProfileId: Id<'userProfiles'>,
	overrides: Partial<{ cancellationToken: string; status: 'pending' | 'cancelled' | 'completed'; email: string }> = {},
): Promise<Id<'accountDeletionRequests'>> {
	return await t.run(async (ctx) => {
		const now = Date.now();
		return await ctx.db.insert('accountDeletionRequests', {
			userProfileId,
			email: overrides.email ?? 'me@example.com',
			requestedAt: now,
			scheduledForDeletion: now + 30 * 24 * 60 * 60 * 1000,
			cancellationToken: overrides.cancellationToken ?? 'cancel-tok',
			status: overrides.status ?? 'pending',
			createdAt: now,
		});
	});
}

async function seedTemplate(
	t: TestConvex<typeof schema>,
	overrides: Record<string, unknown> = {},
): Promise<Id<'emailTemplates'>> {
	return await t.run(async (ctx) => {
		const now = Date.now();
		return await ctx.db.insert('emailTemplates', {
			name: 'Welcome',
			subject: 'Hello there',
			previewText: 'Preview line',
			content: '{"blocks":[]}',
			htmlContent: '<p>rendered html</p>',
			type: 'marketing' as const,
			status: 'published' as const,
			createdAt: now,
			updatedAt: now,
			...overrides,
		});
	});
}

async function seedTransactional(
	t: TestConvex<typeof schema>,
	overrides: Record<string, unknown> = {},
): Promise<Id<'transactionalEmails'>> {
	return await t.run(async (ctx) => {
		const now = Date.now();
		return await ctx.db.insert('transactionalEmails', {
			name: 'Receipt',
			slug: 'receipt',
			subject: 'Your receipt',
			content: '{"blocks":[]}',
			htmlContent: '<p>txn html</p>',
			status: 'published' as const,
			createdAt: now,
			updatedAt: now,
			...overrides,
		});
	});
}

async function seedPlatformAdmin(
	t: TestConvex<typeof schema>,
	authUserId: string,
): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert('platformAdmins', {
			authUserId,
			email: `${authUserId}@example.com`,
			role: 'superadmin' as const,
			createdAt: Date.now(),
		});
	});
}

// ============================================================
// cancelAccountDeletion (token-gated publicMutation)
// ============================================================

describe('accountManagement.cancelAccountDeletion — token path', () => {
	it('cancels a pending request when given the matching cancellation token', async () => {
		const t = newHarness();
		const profileId = await seedProfile(t, 'auth-user-1');
		const requestId = await seedDeletionRequest(t, profileId, { cancellationToken: 'secret-token-abc' });

		const res = await t.mutation(api.auth.accountManagement.cancelAccountDeletion, {
			userId: 'auth-user-1',
			cancellationToken: 'secret-token-abc',
		});
		expect(res).toEqual({ success: true });

		await t.run(async (ctx) => {
			const req = await ctx.db.get(requestId);
			expect(req?.status).toBe('cancelled');
			expect(typeof req?.statusChangedAt).toBe('number');
		});
	});

	it('rejects a bogus cancellation token (no matching pending request)', async () => {
		const t = newHarness();
		const profileId = await seedProfile(t, 'auth-user-1');
		await seedDeletionRequest(t, profileId, { cancellationToken: 'the-real-token' });

		await expect(
			t.mutation(api.auth.accountManagement.cancelAccountDeletion, {
				userId: 'auth-user-1',
				cancellationToken: 'this-is-wrong',
			}),
		).rejects.toThrow();

		// The real pending request is untouched.
		await t.run(async (ctx) => {
			const reqs = await ctx.db
				.query('accountDeletionRequests')
				.withIndex('by_user_profile', (q) => q.eq('userProfileId', profileId))
				.collect();
			expect(reqs).toHaveLength(1);
			expect(reqs[0]!.status).toBe('pending');
		});
	});

	it('does not match an already-cancelled request via its token (filtered to pending)', async () => {
		const t = newHarness();
		const profileId = await seedProfile(t, 'auth-user-1');
		await seedDeletionRequest(t, profileId, {
			cancellationToken: 'used-token',
			status: 'cancelled',
		});

		await expect(
			t.mutation(api.auth.accountManagement.cancelAccountDeletion, {
				userId: 'auth-user-1',
				cancellationToken: 'used-token',
			}),
		).rejects.toThrow();
	});

	it('session path (no token) cancels the caller-owned pending request', async () => {
		const t = newHarness();
		const profileId = await seedProfile(t, 'auth-user-1');
		const requestId = await seedDeletionRequest(t, profileId);

		const res = await t.mutation(api.auth.accountManagement.cancelAccountDeletion, {
			userId: 'auth-user-1',
		});
		expect(res).toEqual({ success: true });

		await t.run(async (ctx) => {
			const req = await ctx.db.get(requestId);
			expect(req?.status).toBe('cancelled');
		});
	});

	it('session path (no token) rejects a foreign userId via requireSelf', async () => {
		const t = newHarness();
		const profileId = await seedProfile(t, 'auth-user-1');
		await seedDeletionRequest(t, profileId);

		// Session is auth-user-1; asking to cancel for someone else.
		await expect(
			t.mutation(api.auth.accountManagement.cancelAccountDeletion, {
				userId: 'someone-else',
			}),
		).rejects.toThrow();
	});
});

// ============================================================
// getPendingDeletionRequest (authedQuery, requireSelf)
// ============================================================

describe('accountManagement.getPendingDeletionRequest', () => {
	it('returns the pending request for the caller', async () => {
		const t = newHarness();
		const profileId = await seedProfile(t, 'auth-user-1');
		const requestId = await seedDeletionRequest(t, profileId);

		const req = await t.query(api.auth.accountManagement.getPendingDeletionRequest, {
			userId: 'auth-user-1',
		});
		expect(req?._id).toBe(requestId);
		expect(req?.status).toBe('pending');
	});

	it('returns null when there is no pending request', async () => {
		const t = newHarness();
		await seedProfile(t, 'auth-user-1');

		const req = await t.query(api.auth.accountManagement.getPendingDeletionRequest, {
			userId: 'auth-user-1',
		});
		expect(req).toBeNull();
	});

	it('rejects a foreign userId via requireSelf', async () => {
		const t = newHarness();
		await seedProfile(t, 'auth-user-1');

		await expect(
			t.query(api.auth.accountManagement.getPendingDeletionRequest, {
				userId: 'someone-else',
			}),
		).rejects.toThrow();
	});
});

// ============================================================
// shareLinks.createShareLink
// ============================================================

describe('shareLinks.createShareLink', () => {
	it('creates a share link for an email template (snapshots html/subject, sets xor target)', async () => {
		const t = newHarness();
		const templateId = await seedTemplate(t);

		const res = await t.mutation(api.shareLinks.createShareLink, {
			emailTemplateId: templateId,
		});
		expect(res.token).toHaveLength(24);
		expect(res.url).toContain(`token=${encodeURIComponent(res.token)}`);

		await t.run(async (ctx) => {
			const link = await ctx.db.get(res.shareLinkId);
			expect(link).not.toBeNull();
			expect(link!.targetType).toBe('emailTemplate');
			expect(link!.emailTemplateId).toBe(templateId);
			expect(link!.transactionalEmailId).toBeUndefined();
			expect(link!.htmlContent).toBe('<p>rendered html</p>');
			expect(link!.subject).toBe('Hello there');
			expect(link!.previewText).toBe('Preview line');
			expect(link!.createdBy).toBe('auth-user-1');
			expect(link!.expiresAt).toBeGreaterThan(Date.now());
			expect(link!.revokedAt).toBeUndefined();
		});
	});

	it('creates a share link for a transactional email', async () => {
		const t = newHarness();
		const txnId = await seedTransactional(t);

		const res = await t.mutation(api.shareLinks.createShareLink, {
			transactionalEmailId: txnId,
		});

		await t.run(async (ctx) => {
			const link = await ctx.db.get(res.shareLinkId);
			expect(link!.targetType).toBe('transactionalEmail');
			expect(link!.transactionalEmailId).toBe(txnId);
			expect(link!.emailTemplateId).toBeUndefined();
			expect(link!.htmlContent).toBe('<p>txn html</p>');
		});
	});

	it('rejects when neither target id is set (xor: at least one)', async () => {
		const t = newHarness();
		await expect(
			t.mutation(api.shareLinks.createShareLink, {}),
		).rejects.toThrow();
	});

	it('rejects when BOTH target ids are set (xor: at most one)', async () => {
		const t = newHarness();
		const templateId = await seedTemplate(t);
		const txnId = await seedTransactional(t);

		await expect(
			t.mutation(api.shareLinks.createShareLink, {
				emailTemplateId: templateId,
				transactionalEmailId: txnId,
			}),
		).rejects.toThrow();

		// Nothing was inserted.
		await t.run(async (ctx) => {
			const links = await ctx.db.query('shareLinks').collect();
			expect(links).toHaveLength(0);
		});
	});

	it('rejects an unsaved (no htmlContent) template — must be saved before sharing', async () => {
		const t = newHarness();
		const templateId = await seedTemplate(t, { htmlContent: undefined });

		await expect(
			t.mutation(api.shareLinks.createShareLink, { emailTemplateId: templateId }),
		).rejects.toThrow();
	});

	it('rejects a non-privileged caller (viewer lacks shareLinks:manage)', async () => {
		const t = newHarness();
		sessionMock.role = 'viewer';
		const templateId = await seedTemplate(t);

		await expect(
			t.mutation(api.shareLinks.createShareLink, { emailTemplateId: templateId }),
		).rejects.toThrow();
	});
});

// ============================================================
// shareLinks.revokeShareLink
// ============================================================

describe('shareLinks.revokeShareLink', () => {
	it('marks the link revoked (sets revokedAt)', async () => {
		const t = newHarness();
		const templateId = await seedTemplate(t);
		const { shareLinkId } = await t.mutation(api.shareLinks.createShareLink, {
			emailTemplateId: templateId,
		});

		await t.mutation(api.shareLinks.revokeShareLink, { shareLinkId });

		await t.run(async (ctx) => {
			const link = await ctx.db.get(shareLinkId);
			expect(typeof link!.revokedAt).toBe('number');
		});
	});

	it('rejects a non-privileged caller (viewer)', async () => {
		const t = newHarness();
		const templateId = await seedTemplate(t);
		const { shareLinkId } = await t.mutation(api.shareLinks.createShareLink, {
			emailTemplateId: templateId,
		});

		sessionMock.role = 'viewer';
		await expect(
			t.mutation(api.shareLinks.revokeShareLink, { shareLinkId }),
		).rejects.toThrow();
	});
});

// ============================================================
// shareLinks.listShareLinks
// ============================================================

describe('shareLinks.listShareLinks', () => {
	it('lists links for an email template, newest first', async () => {
		const t = newHarness();
		const templateId = await seedTemplate(t);

		const first = await t.mutation(api.shareLinks.createShareLink, { emailTemplateId: templateId });
		const second = await t.mutation(api.shareLinks.createShareLink, { emailTemplateId: templateId });

		const links = await t.query(api.shareLinks.listShareLinks, { emailTemplateId: templateId });
		expect(links).toHaveLength(2);
		// Sorted createdAt desc — most recent createdAt first.
		expect(links[0]!.createdAt).toBeGreaterThanOrEqual(links[1]!.createdAt);
		const ids = links.map((l) => l._id);
		expect(ids).toContain(first.shareLinkId);
		expect(ids).toContain(second.shareLinkId);
	});

	it('returns [] for an unknown template id', async () => {
		const t = newHarness();
		// A real-but-unused template id (no share links point at it).
		const templateId = await seedTemplate(t);
		const links = await t.query(api.shareLinks.listShareLinks, { emailTemplateId: templateId });
		expect(links).toEqual([]);
	});

	it('returns [] when neither target id is provided', async () => {
		const t = newHarness();
		const links = await t.query(api.shareLinks.listShareLinks, {});
		expect(links).toEqual([]);
	});

	it('lists links scoped to a transactional email only', async () => {
		const t = newHarness();
		const templateId = await seedTemplate(t);
		const txnId = await seedTransactional(t);
		await t.mutation(api.shareLinks.createShareLink, { emailTemplateId: templateId });
		const txnLink = await t.mutation(api.shareLinks.createShareLink, { transactionalEmailId: txnId });

		const links = await t.query(api.shareLinks.listShareLinks, { transactionalEmailId: txnId });
		expect(links).toHaveLength(1);
		expect(links[0]!._id).toBe(txnLink.shareLinkId);
	});
});

// ============================================================
// shareLinkQueries.getShareLinkByToken (internal)
// ============================================================

describe('shareLinkQueries.getShareLinkByToken', () => {
	it('returns live link data for a valid token', async () => {
		const t = newHarness();
		const templateId = await seedTemplate(t);
		const { token } = await t.mutation(api.shareLinks.createShareLink, { emailTemplateId: templateId });

		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				defaultFromName: 'Acme Co',
				createdAt: Date.now(),
			});
		});

		const result = await t.query(internal.shareLinkQueries.getShareLinkByToken, { token });
		expect(result).not.toBeNull();
		expect(result).not.toHaveProperty('expired');
		const data = result as { html: string; subject: string; organizationName: string };
		expect(data.html).toBe('<p>rendered html</p>');
		expect(data.subject).toBe('Hello there');
		expect(data.organizationName).toBe('Acme Co');
	});

	it('returns null for a bogus token', async () => {
		const t = newHarness();
		const result = await t.query(internal.shareLinkQueries.getShareLinkByToken, {
			token: 'no-such-token',
		});
		expect(result).toBeNull();
	});

	it('returns null for a revoked token', async () => {
		const t = newHarness();
		const templateId = await seedTemplate(t);
		const { token, shareLinkId } = await t.mutation(api.shareLinks.createShareLink, {
			emailTemplateId: templateId,
		});
		await t.mutation(api.shareLinks.revokeShareLink, { shareLinkId });

		const result = await t.query(internal.shareLinkQueries.getShareLinkByToken, { token });
		expect(result).toBeNull();
	});

	it('returns { expired: true } for an expired (but not revoked) token', async () => {
		const t = newHarness();
		const token = await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert('shareLinks', {
				targetType: 'emailTemplate' as const,
				token: 'expired-token',
				htmlContent: '<p>old</p>',
				subject: 'Old',
				expiresAt: now - 1000, // already expired
				createdBy: 'auth-user-1',
				createdAt: now - 2000,
			});
			return 'expired-token';
		});

		const result = await t.query(internal.shareLinkQueries.getShareLinkByToken, { token });
		expect(result).toEqual({ expired: true });
	});
});

// ============================================================
// shareLinkHttp — GET /share/{token}
// ============================================================

describe('GET /share/{token}', () => {
	it('returns 200 + snapshotted html for a live link', async () => {
		const t = newHarness();
		const templateId = await seedTemplate(t);
		const { token } = await t.mutation(api.shareLinks.createShareLink, { emailTemplateId: templateId });
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				defaultFromName: 'Acme Co',
				createdAt: Date.now(),
			});
		});

		const res = await t.fetch(`/share/${token}`, { method: 'GET' });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; data: { html: string; subject: string; organizationName: string } };
		expect(body.ok).toBe(true);
		expect(body.data.html).toBe('<p>rendered html</p>');
		expect(body.data.subject).toBe('Hello there');
		expect(body.data.organizationName).toBe('Acme Co');
		// no-store cache header from the handler.
		expect(res.headers.get('Cache-Control')).toBe('no-store');
	});

	it('returns 404 for a bogus token', async () => {
		const t = newHarness();
		const res = await t.fetch('/share/does-not-exist', { method: 'GET' });
		expect(res.status).toBe(404);
	});

	it('returns 404 for a revoked link', async () => {
		const t = newHarness();
		const templateId = await seedTemplate(t);
		const { token, shareLinkId } = await t.mutation(api.shareLinks.createShareLink, {
			emailTemplateId: templateId,
		});
		await t.mutation(api.shareLinks.revokeShareLink, { shareLinkId });

		const res = await t.fetch(`/share/${token}`, { method: 'GET' });
		expect(res.status).toBe(404);
	});

	it('returns 404 not_found for an expired link (reason rides in data)', async () => {
		const t = newHarness();
		await t.run(async (ctx) => {
			const now = Date.now();
			await ctx.db.insert('shareLinks', {
				targetType: 'emailTemplate' as const,
				token: 'expired-http-token',
				htmlContent: '<p>old</p>',
				subject: 'Old',
				expiresAt: now - 1000,
				createdBy: 'auth-user-1',
				createdAt: now - 2000,
			});
		});

		const res = await t.fetch('/share/expired-http-token', { method: 'GET' });
		// An expired link is gone → 404 (the taxonomy-supported status). Previously
		// the handler emitted an unsupported 410 that fell through to 400; fixed.
		// The `expired` reason still rides in the error envelope's data.
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: { category: string; data?: { reason?: string } } };
		expect(body.error.category).toBe('not_found');
		expect(body.error.data?.reason).toBe('expired');
	});

	it('returns 404 for a non-GET method (no POST route registered on the /share/ prefix)', async () => {
		const t = newHarness();
		// http.ts only registers GET + OPTIONS for the /share/ prefix, so a POST
		// matches no route and the Convex router answers 404 (the shell's 405
		// method gate is never reached).
		const res = await t.fetch('/share/whatever', { method: 'POST' });
		expect(res.status).toBe(404);
	});
});

// ============================================================
// systemUpdates.checkForUpdates — platform-admin gate
// ============================================================

describe('systemUpdates.checkForUpdates — platform-admin gate', () => {
	it('rejects a caller with no platformAdmins row', async () => {
		const t = newHarness();
		sessionMock.subject = 'not-an-admin';
		// No platformAdmins seeded → isPlatformAdminByUserId returns false.

		await expect(
			t.action(api.systemUpdates.checkForUpdates, {}),
		).rejects.toThrow();
	});

	it('rejects an org member whose subject is not in platformAdmins (admin tier is higher)', async () => {
		const t = newHarness();
		// Seed an admin for a DIFFERENT subject; the caller is still not an admin.
		await seedPlatformAdmin(t, 'some-other-admin');
		sessionMock.subject = 'auth-user-1';

		await expect(
			t.action(api.systemUpdates.checkForUpdates, {}),
		).rejects.toThrow();
	});

	it('passes the gate for a platform admin and returns the cached (fresh) result without a network call', async () => {
		const t = newHarness();
		await seedPlatformAdmin(t, 'auth-user-1');
		sessionMock.subject = 'auth-user-1';
		process.env['OWLAT_VERSION'] = '1.2.0';

		// Seed a FRESH latestCheck cache doc so the action returns from cache
		// (force=false + checkedAt within TTL) and never hits GitHub.
		await t.run(async (ctx) => {
			await ctx.db.insert('systemUpdates', {
				kind: 'latestCheck' as const,
				latestVersion: '1.3.0',
				releaseNotes: 'New stuff',
				publishedAt: Date.now(),
				checkedAt: Date.now(),
			});
		});

		const res = await t.action(api.systemUpdates.checkForUpdates, {});
		expect(res.latestVersion).toBe('1.3.0');
		expect(res.currentVersion).toBe('1.2.0');
		expect(res.updateAvailable).toBe(true); // 1.3.0 > 1.2.0
		expect(res.releaseNotes).toBe('New stuff');
		expect(res.error).toBeNull();
	});

	it('reports no update available when the cached version is not newer', async () => {
		const t = newHarness();
		await seedPlatformAdmin(t, 'auth-user-1');
		sessionMock.subject = 'auth-user-1';
		process.env['OWLAT_VERSION'] = '2.0.0';

		await t.run(async (ctx) => {
			await ctx.db.insert('systemUpdates', {
				kind: 'latestCheck' as const,
				latestVersion: '1.9.9',
				releaseNotes: 'older',
				publishedAt: Date.now(),
				checkedAt: Date.now(),
			});
		});

		const res = await t.action(api.systemUpdates.checkForUpdates, {});
		expect(res.updateAvailable).toBe(false);
	});
});
