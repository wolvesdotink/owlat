/**
 * `shareLinks.listShareLinks` — read-side capability gate.
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
import { api } from '../_generated/api';
import { createTestEmailTemplate } from './factories';

const permissionState = vi.hoisted(() => ({ allowed: true }));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
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

describe('shareLinks.listShareLinks — manage gate', () => {
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

		const links = await t.query(api.shareLinks.listShareLinks, { emailTemplateId: templateId });
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
			t.query(api.shareLinks.listShareLinks, { emailTemplateId: templateId })
		).rejects.toThrow();
	});
});
