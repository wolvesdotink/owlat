/**
 * accountManagement.exportUserData — access + redaction.
 *
 * requireSelf rejects a foreign userId; the export omits webhook secrets and
 * api-key hashes and carries template/attachment content only through the
 * fail-closed staged projections; GDPR-erased contacts are excluded; and the
 * api-key + webhook metadata sections are populated ONLY for an org
 * admin/owner (empty for a plain 'editor').
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { storeSealedBlob } from '../lib/sealedBlob';
import { sessionMock, resetSessionMock } from './gdprSessionMock';
import {
	EXPORT_TEST_SECRET,
	EXPORT_TEST_SITE,
	newHarness,
	seedProfile,
	seedOrg,
	seedMember,
	exportAllUserData,
} from './gdprAccountFixtures';

vi.mock('../lib/sessionOrganization', async () => {
	const { gdprSessionOrganizationMock } = await import('./gdprSessionMock');
	return await gdprSessionOrganizationMock();
});

beforeEach(resetSessionMock);
afterEach(() => {
	vi.unstubAllEnvs();
});

describe('accountManagement.exportUserData — requireSelf', () => {
	it('rejects a foreign userId (session is auth-user-1, asks for someone else)', async () => {
		const t = newHarness();
		await seedProfile(t, 'auth-user-1');

		await expect(
			t.action(api.auth.accountExport.exportUserData, { userId: 'someone-else' })
		).rejects.toThrow();
	});

	it('returns the caller-owned profile + org for their own userId', async () => {
		const t = newHarness();
		await seedProfile(t, 'auth-user-1', 'owner@example.com');
		const orgId = await seedOrg(t, 'Acme', 'private organization metadata');
		await seedMember(t, orgId, 'auth-user-1', 'owner');

		const res = await exportAllUserData(t, 'auth-user-1');

		expect(res.userProfile.email).toBe('owner@example.com');
		expect(res.organizations).toHaveLength(1);
		expect(res.organizations[0]!.organization.name).toBe('Acme');
		expect(res.organizations[0]!.organization).toEqual({
			_id: orgId,
			name: 'Acme',
			slug: 'acme',
		});
		expect(res.organizations[0]!.role).toBe('owner');
		expect(typeof res.exportedAt).toBe('number');
		expect(JSON.stringify(res)).not.toContain('private organization metadata');
	});
});

describe('accountManagement.exportUserData — secret redaction', () => {
	it('omits webhook secrets and api-key hashes from the export', async () => {
		const t = newHarness();
		sessionMock.role = 'owner';
		await seedProfile(t, 'auth-user-1');
		const orgId = await seedOrg(t);
		await seedMember(t, orgId, 'auth-user-1', 'owner');

		await t.run(async (ctx) => {
			await ctx.db.insert('contacts', {
				email: 'customer@example.com',
				source: 'api',
				doiStatus: 'pending',
				doiConfirmationToken: 'doi-confirmation-capability-canary',
				doiTokenExpiresAt: Date.now() + 60_000,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.insert('campaigns', {
				name: 'Campaign with public archive',
				status: 'sent',
				archiveEnabled: true,
				archiveToken: 'campaign-archive-capability-canary',
				archiveSubject: 'Archive subject',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.insert('webhooks', {
				name: 'hook',
				url: 'https://example.com/hook',
				events: ['contact.created'],
				secret: 'super-secret-signing-key',
				isActive: true,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.insert('apiKeys', {
				name: 'key',
				keyHash: 'deadbeef-hash-value',
				keyPrefix: 'lm_live_',
				scopes: ['contacts:read'],
				isActive: true,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		const res = await exportAllUserData(t, 'auth-user-1');

		const orgExport = res.organizations[0]!;
		expect(orgExport.data.webhooks).toHaveLength(1);
		expect(orgExport.data.apiKeys).toHaveLength(1);
		expect(orgExport.data.contacts).toHaveLength(1);
		expect(orgExport.data.campaigns).toHaveLength(1);

		// No `secret` on any exported webhook.
		const serialized = JSON.stringify(res);
		expect(serialized).not.toContain('super-secret-signing-key');
		expect(serialized).not.toContain('deadbeef-hash-value');
		expect(serialized).not.toContain('doi-confirmation-capability-canary');
		expect(serialized).not.toContain('campaign-archive-capability-canary');

		expect(orgExport.data.webhooks[0]).not.toHaveProperty('secret');
		expect(orgExport.data.contacts[0]).not.toHaveProperty('doiConfirmationToken');
		expect(orgExport.data.contacts[0]).not.toHaveProperty('doiTokenExpiresAt');
		expect(orgExport.data.campaigns[0]).not.toHaveProperty('archiveToken');
		expect(orgExport.data.campaigns[0]).toMatchObject({
			archiveEnabled: true,
			archiveSubject: 'Archive subject',
		});
		// api-key export carries only safe metadata (name/prefix/timestamps).
		expect(orgExport.data.apiKeys[0]).not.toHaveProperty('keyHash');
		expect(orgExport.data.apiKeys[0]).toMatchObject({
			name: 'key',
			keyPrefix: 'lm_live_',
		});
	});

	it('exports template content and attachment bytes through fail-closed staged projections', async () => {
		vi.stubEnv('INSTANCE_SECRET', EXPORT_TEST_SECRET);
		vi.stubEnv('CONVEX_SITE_URL', EXPORT_TEST_SITE);
		const t = newHarness();
		await seedProfile(t, 'auth-user-1');
		const orgId = await seedOrg(t);
		await seedMember(t, orgId, 'auth-user-1', 'owner');

		const { validStorageId, missingStorageId, corruptStorageId } = await t.run(async (ctx) => {
			const now = Date.now();
			const validBytes = new TextEncoder().encode('template attachment bytes');
			const validStorageId = await storeSealedBlob(
				ctx.storage,
				validBytes,
				'application/octet-stream'
			);
			const missingStorageId = await storeSealedBlob(
				ctx.storage,
				new TextEncoder().encode('delete me'),
				'application/octet-stream'
			);
			await ctx.storage.delete(missingStorageId);
			const sealedCorruptSource = await storeSealedBlob(
				ctx.storage,
				new TextEncoder().encode('corrupt me'),
				'application/octet-stream'
			);
			const sealedBlob = await ctx.storage.get(sealedCorruptSource);
			const corruptBytes = new Uint8Array(await sealedBlob!.arrayBuffer());
			corruptBytes[corruptBytes.length - 1] = corruptBytes[corruptBytes.length - 1]! ^ 1;
			const corruptStorageId = await ctx.storage.store(
				new Blob([corruptBytes as unknown as BlobPart])
			);
			await ctx.storage.delete(sealedCorruptSource);
			const personalMailStorageId = await storeSealedBlob(
				ctx.storage,
				new TextEncoder().encode('cross-resource-personal-mail-secret'),
				'text/plain'
			);
			const insertAsset = (storageId: Id<'_storage'>, filename: string) =>
				ctx.db.insert('mediaAssets', {
					storageId,
					filename,
					mimeType: 'application/octet-stream',
					fileSize: validBytes.byteLength,
					url: 'https://capability.invalid/asset',
					uploadedBy: 'auth-user-1',
					createdAt: now,
					updatedAt: now,
				});
			const validAssetId = await insertAsset(validStorageId, 'valid.bin');
			const missingAssetId = await insertAsset(missingStorageId, 'missing.bin');
			const corruptAssetId = await insertAsset(corruptStorageId, 'corrupt.bin');

			await ctx.db.insert('emailTemplates', {
				name: 'Account export template',
				subject: 'Template subject',
				content: JSON.stringify([
					{
						id: 'image-1',
						type: 'image',
						content: {
							alt: 'customer-authored-template-body',
							src: 'https://capability.invalid/image?token=image-url-canary',
							storageId: validStorageId,
							mediaAssetId: validAssetId,
						},
					},
					{
						id: 'cross-resource-image',
						type: 'image',
						content: {
							src: 'https://capability.invalid/personal-mail',
							storageId: personalMailStorageId,
							mediaAssetId: validAssetId,
						},
					},
				]),
				htmlContent: '<img src="https://capability.invalid/html-token-canary">',
				type: 'marketing',
				status: 'draft',
				searchableText: 'future-field-secret-canary',
				seedTag: 'future-seed-secret-canary',
				createdAt: now,
				updatedAt: now,
			});
			await ctx.db.insert('transactionalEmails', {
				name: 'Transactional export template',
				slug: 'transactional-export-template',
				subject: 'Transactional subject',
				content: JSON.stringify([{ id: 'text-1', type: 'text', content: { html: 'exact body' } }]),
				htmlContent: '<img src="https://capability.invalid/transactional-html-canary">',
				attachments: JSON.stringify([
					{
						id: 'valid',
						filename: 'valid.bin',
						storageId: validStorageId,
						url: 'https://capability.invalid/attachment-token-canary',
						contentType: 'application/octet-stream',
						fileSize: validBytes.byteLength,
						mediaAssetId: validAssetId,
					},
					{
						id: 'missing',
						filename: 'missing.bin',
						storageId: missingStorageId,
						mediaAssetId: missingAssetId,
						url: 'https://capability.invalid/missing-token-canary',
					},
					{
						id: 'corrupt',
						filename: 'corrupt.bin',
						storageId: corruptStorageId,
						mediaAssetId: corruptAssetId,
						url: 'https://capability.invalid/corrupt-token-canary',
					},
				]),
				status: 'draft',
				searchableText: 'future-transactional-secret-canary',
				seedTag: 'future-transactional-seed-canary',
				createdAt: now,
				updatedAt: now,
			});
			return { validStorageId, missingStorageId, corruptStorageId };
		});

		const exported = await exportAllUserData(t, 'auth-user-1');
		const organizationData = exported.organizations[0]!.data;
		const emailTemplate = organizationData.emailTemplates[0]!;
		const transactionalTemplate = organizationData.transactionalEmails[0]!;

		expect(emailTemplate).toMatchObject({
			name: 'Account export template',
			editorContent: {
				availability: 'available',
				value: [
					{
						content: {
							alt: 'customer-authored-template-body',
							storedContent: {
								contentBase64: btoa('template attachment bytes'),
								contentEncoding: 'base64',
								availability: 'available',
							},
						},
					},
					{
						content: {
							storedContent: {
								contentBase64: '',
								contentEncoding: 'base64',
								availability: 'missing',
							},
						},
					},
				],
			},
		});
		expect(transactionalTemplate).toMatchObject({
			editorContent: {
				availability: 'available',
				value: [{ content: { html: 'exact body' } }],
			},
			attachments: {
				availability: 'available',
				items: [
					{
						id: 'valid',
						filename: 'valid.bin',
						contentBase64: btoa('template attachment bytes'),
						contentEncoding: 'base64',
						availability: 'available',
					},
					{
						id: 'missing',
						filename: 'missing.bin',
						contentBase64: '',
						availability: 'missing',
					},
					{
						id: 'corrupt',
						filename: 'corrupt.bin',
						contentBase64: '',
						availability: 'corrupt',
					},
				],
			},
		});

		for (const row of [emailTemplate, transactionalTemplate]) {
			expect(row).not.toHaveProperty('content');
			expect(row).not.toHaveProperty('htmlContent');
			expect(row).not.toHaveProperty('htmlTranslations');
			expect(row).not.toHaveProperty('searchableText');
			expect(row).not.toHaveProperty('seedTag');
		}
		const serialized = JSON.stringify(exported);
		expect(serialized).not.toContain('cross-resource-personal-mail-secret');
		for (const canary of [
			'image-url-canary',
			'html-token-canary',
			'transactional-html-canary',
			'attachment-token-canary',
			'missing-token-canary',
			'corrupt-token-canary',
			'media-ref-canary',
			'future-field-secret-canary',
			'future-seed-secret-canary',
			'future-transactional-secret-canary',
			'future-transactional-seed-canary',
		]) {
			expect(serialized).not.toContain(canary);
		}
		expect(serialized).not.toContain(String(validStorageId));
		expect(serialized).not.toContain(String(missingStorageId));
		expect(serialized).not.toContain(String(corruptStorageId));
	});
});

describe('accountManagement.exportUserData — soft-deleted contacts', () => {
	it('excludes GDPR-erased (soft-deleted) contacts from the export', async () => {
		const t = newHarness();
		await seedProfile(t, 'auth-user-1');
		const orgId = await seedOrg(t);
		await seedMember(t, orgId, 'auth-user-1', 'owner');

		await t.run(async (ctx) => {
			await ctx.db.insert('contacts', {
				email: 'live@example.com',
				source: 'api' as const,
				doiStatus: 'not_required' as const,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.insert('contacts', {
				email: 'erased@example.com',
				source: 'api' as const,
				doiStatus: 'not_required' as const,
				deletedAt: Date.now(), // soft-deleted / GDPR-erased
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		const res = await exportAllUserData(t, 'auth-user-1');

		const emails = res.organizations[0]!.data.contacts.map((contact) => contact['email']);
		expect(emails).toContain('live@example.com');
		expect(emails).not.toContain('erased@example.com');
		expect(res.organizations[0]!.data.contacts).toHaveLength(1);
	});
});

describe('accountManagement.exportUserData — admin-only metadata gating', () => {
	it('populates api-key + webhook metadata for an org admin/owner', async () => {
		const t = newHarness();
		sessionMock.role = 'admin';
		await seedProfile(t, 'auth-user-1');
		const orgId = await seedOrg(t);
		// Membership role drives the in-handler hasPermission gate.
		await seedMember(t, orgId, 'auth-user-1', 'admin');

		await t.run(async (ctx) => {
			await ctx.db.insert('webhooks', {
				name: 'hook',
				url: 'https://example.com/hook',
				events: ['contact.created'],
				secret: 's',
				isActive: true,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.insert('apiKeys', {
				name: 'key',
				keyHash: 'h',
				keyPrefix: 'lm_live_',
				isActive: true,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		const res = await exportAllUserData(t, 'auth-user-1');

		expect(res.organizations[0]!.data.apiKeys).toHaveLength(1);
		expect(res.organizations[0]!.data.webhooks).toHaveLength(1);
	});

	it('leaves api-key + webhook metadata EMPTY for a plain editor', async () => {
		const t = newHarness();
		sessionMock.role = 'editor';
		await seedProfile(t, 'auth-user-1');
		const orgId = await seedOrg(t);
		// The handler reads the *membership* role (not the session) for the gate.
		await seedMember(t, orgId, 'auth-user-1', 'editor');

		await t.run(async (ctx) => {
			await ctx.db.insert('contacts', {
				email: 'customer@example.com',
				source: 'api',
				doiStatus: 'not_required',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.insert('blockedEmails', {
				email: 'blocked-customer@example.com',
				reason: 'manual',
				createdAt: Date.now(),
			});
			await ctx.db.insert('webhooks', {
				name: 'hook',
				url: 'https://example.com/hook',
				events: ['contact.created'],
				secret: 's',
				isActive: true,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.insert('apiKeys', {
				name: 'key',
				keyHash: 'h',
				keyPrefix: 'lm_live_',
				isActive: true,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		const res = await exportAllUserData(t, 'auth-user-1');

		// Editor self-export can't enumerate key prefixes / webhook endpoints.
		expect(res.organizations[0]!.data.apiKeys).toHaveLength(0);
		expect(res.organizations[0]!.data.webhooks).toHaveLength(0);
		expect(res.organizations[0]!.data.contacts).toHaveLength(0);
		expect(Object.values(res.organizations[0]!.data).every((rows) => rows.length === 0)).toBe(true);
		expect(JSON.stringify(res)).not.toContain('customer@example.com');
		expect(JSON.stringify(res)).not.toContain('blocked-customer@example.com');
	});
});

it('does not export private chat bytes through caller-controlled template media IDs', async () => {
	const t = newHarness();
	sessionMock.role = 'owner';
	await seedProfile(t, 'auth-user-1');
	const organizationId = await seedOrg(t);
	await seedMember(t, organizationId, 'auth-user-1', 'owner');
	const assetId = await t.run(async (ctx) => {
		const storageId = await ctx.storage.store(new Blob(['private chat document']));
		return ctx.db.insert('mediaAssets', {
			storageId,
			filename: 'private.txt',
			mimeType: 'text/plain',
			fileSize: 21,
			url: (await ctx.storage.getUrl(storageId))!,
			uploadedBy: 'another-user',
			tags: ['chat-attachment'],
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
	});
	expect(
		await t.query(internal.auth.accountExportQueries.listAuthorizedTemplateMedia, {
			userId: 'auth-user-1',
			organizationId,
			mediaAssetIds: [assetId],
		})
	).toEqual([]);
});
