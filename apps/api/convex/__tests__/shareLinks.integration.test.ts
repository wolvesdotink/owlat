/**
 * `shareLinks.links.listShareLinks` — read-side capability gate.
 *
 * Each share-link row carries the raw `token`, the bearer capability for the
 * unauthenticated `/share` route. Listing therefore must be held to the same
 * `shareLinks:manage` permission that minting (`createShareLink`) and revoking
 * (`revokeShareLink`) already require — an ungated member-readable list would
 * hand every member a live, unauthenticated view of shared email content.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import { createTestEmailTemplate, createTestTransactionalEmail } from './factories';

const permissionState = vi.hoisted(() => ({ allowed: true }));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		// The gated reads now use the THREADED session (handler's 3rd arg) with
		// requirePermission(hasPermission(session.role, …)), so denial is expressed
		// as a non-admin role here rather than by stubbing requireOrgPermission.
		requireOrgMember: vi.fn().mockImplementation(async () => ({
			userId: 'test-user',
			role: permissionState.allowed ? 'owner' : 'editor',
		})),
		getMutationContext: vi.fn().mockImplementation(async () => ({
			userId: 'test-user',
			role: permissionState.allowed ? 'owner' : 'editor',
		})),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		requireAuthenticatedIdentity: vi.fn().mockResolvedValue({
			subject: 'test-user',
			issuer: 'test',
			tokenIdentifier: 'test|test-user',
		}),
		requireOrgPermission: vi.fn().mockImplementation(async () => {
			if (!permissionState.allowed) throw new Error('Missing required permission');
			return { userId: 'test-user', role: 'owner' };
		}),
	};
});

const modules = import.meta.glob('../**/*.*s');

const identity = { subject: 'test-user', issuer: 'test', tokenIdentifier: 'test|test-user' };

beforeEach(() => {
	permissionState.allowed = true;
});
afterEach(() => {
	permissionState.allowed = true;
});

describe('shareLinks.links.listShareLinks — manage gate', () => {
	it('returns the template share links for an admin (shareLinks:manage)', async () => {
		const t = convexTest(schema, modules).withIdentity(identity);
		const templateId = await t.run(async (ctx) => {
			const id = await ctx.db.insert('emailTemplates', createTestEmailTemplate());
			await ctx.db.insert('shareLinks', {
				targetType: 'emailTemplate',
				emailTemplateId: id,
				token: 'share-token-abc',
				htmlContent: '<p>hi</p>',
				subject: 'Subject',
				expiresAt: Date.now() + 1000,
				createdBy: 'test-user',
				createdAt: Date.now(),
			});
			return id;
		});

		const links = await t.query(api.shareLinks.links.listShareLinks, {
			emailTemplateId: templateId,
		});
		expect(links).toHaveLength(1);
	});

	it('rejects a member without shareLinks:manage (the token is a bearer capability)', async () => {
		const t = convexTest(schema, modules).withIdentity(identity);
		const templateId = await t.run(async (ctx) => {
			const id = await ctx.db.insert('emailTemplates', createTestEmailTemplate());
			await ctx.db.insert('shareLinks', {
				targetType: 'emailTemplate',
				emailTemplateId: id,
				token: 'share-token-secret',
				htmlContent: '<p>hi</p>',
				subject: 'Subject',
				expiresAt: Date.now() + 1000,
				createdBy: 'test-user',
				createdAt: Date.now(),
			});
			return id;
		});

		permissionState.allowed = false;
		await expect(
			t.query(api.shareLinks.links.listShareLinks, { emailTemplateId: templateId })
		).rejects.toThrow();
	});
});

describe('shareLinks.queries.getShareLinkByToken — feature flags', () => {
	async function seed(t: ReturnType<typeof convexTest>, transactional: boolean) {
		await t.run(async (ctx) => {
			const templateId = await ctx.db.insert('emailTemplates', createTestEmailTemplate());
			const emailId = await ctx.db.insert('transactionalEmails', createTestTransactionalEmail());
			const base = {
				htmlContent: '<p>hi</p>',
				subject: 'Subject',
				expiresAt: Date.now() + 60_000,
				createdBy: 'test-user',
				createdAt: Date.now(),
			};
			await ctx.db.insert('shareLinks', {
				...base,
				targetType: 'emailTemplate',
				emailTemplateId: templateId,
				token: 'share-token-template',
			});
			await ctx.db.insert('shareLinks', {
				...base,
				targetType: 'transactionalEmail',
				transactionalEmailId: emailId,
				token: 'share-token-transactional',
			});
			await ctx.db.insert('instanceSettings', {
				featureFlags: { transactional },
				createdAt: Date.now(),
			});
		});
	}

	it('serves a transactional email preview only while transactional is on', async () => {
		const on = convexTest(schema, modules);
		await seed(on, true);
		expect(
			await on.query(internal.shareLinks.queries.getShareLinkByToken, {
				token: 'share-token-transactional',
			})
		).toMatchObject({ subject: 'Subject' });

		const off = convexTest(schema, modules);
		await seed(off, false);
		expect(
			await off.query(internal.shareLinks.queries.getShareLinkByToken, {
				token: 'share-token-transactional',
			})
		).toBeNull();
	});

	it('serves an email template preview whatever the transactional flag says', async () => {
		const t = convexTest(schema, modules);
		await seed(t, false);
		expect(
			await t.query(internal.shareLinks.queries.getShareLinkByToken, {
				token: 'share-token-template',
			})
		).toMatchObject({ subject: 'Subject' });
	});
});

// The root `shareLinks.ts` / `shareLinkQueries.ts` shims answer the previous
// release's callers (open tabs, in-flight /share requests) with the moved code.
describe('previous-release share link paths', () => {
	async function seedTemplate(t: ReturnType<typeof convexTest>) {
		return await t.run((ctx) =>
			ctx.db.insert('emailTemplates', {
				...createTestEmailTemplate(),
				htmlContent: '<p>shared</p>',
			})
		);
	}

	it('create, list, read and revoke through the old paths match the moved functions', async () => {
		const harness = convexTest(schema, modules);
		const emailTemplateId = await seedTemplate(harness);
		const t = harness.withIdentity(identity);

		const created = await t.mutation(api.shareLinks.createShareLink, { emailTemplateId });
		expect(created.url).toContain(`token=${encodeURIComponent(created.token)}`);

		const oldList = await t.query(api.shareLinks.listShareLinks, { emailTemplateId });
		const newList = await t.query(api.shareLinks.links.listShareLinks, { emailTemplateId });
		expect(oldList).toEqual(newList);
		expect(oldList.map((link) => link._id)).toEqual([created.shareLinkId]);

		const oldRead = await t.query(internal.shareLinkQueries.getShareLinkByToken, {
			token: created.token,
		});
		const newRead = await t.query(internal.shareLinks.queries.getShareLinkByToken, {
			token: created.token,
		});
		expect(oldRead).toEqual(newRead);
		expect(oldRead).toMatchObject({ html: '<p>shared</p>' });

		await t.mutation(api.shareLinks.revokeShareLink, { shareLinkId: created.shareLinkId });
		expect(
			await t.query(internal.shareLinks.queries.getShareLinkByToken, { token: created.token })
		).toBeNull();
	});

	it('keep the shareLinks:manage floor on every old public path', async () => {
		const harness = convexTest(schema, modules);
		const emailTemplateId = await seedTemplate(harness);
		const t = harness.withIdentity(identity);
		const { shareLinkId } = await t.mutation(api.shareLinks.links.createShareLink, {
			emailTemplateId,
		});

		permissionState.allowed = false;
		await expect(t.mutation(api.shareLinks.createShareLink, { emailTemplateId })).rejects.toThrow(
			'Only owners and admins can create share links'
		);
		await expect(t.query(api.shareLinks.listShareLinks, { emailTemplateId })).rejects.toThrow(
			'Only owners and admins can view share links'
		);
		await expect(t.mutation(api.shareLinks.revokeShareLink, { shareLinkId })).rejects.toThrow(
			'Only owners and admins can revoke share links'
		);
	});
});
