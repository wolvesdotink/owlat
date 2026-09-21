import { convexTest, type TestConvex } from 'convex-test';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { consumeUpload, mintUploadUrl } from '../storage/uploads';
import { recordUploadedBlob } from './uploadFixtures.testlib';
import { seedMailbox } from '../mail/__tests__/helpers.testlib';

const session = vi.hoisted(() => ({
	userId: 'user-A',
	activeOrganizationId: 'org-1',
	role: 'owner',
}));
vi.mock('../lib/sessionOrganization', async () => ({
	...(await vi.importActual('../lib/sessionOrganization')),
	getMutationContext: vi.fn(async () => ({ ...session })),
	requireOrgMember: vi.fn(async () => ({ ...session })),
	getBetterAuthSessionWithRole: vi.fn(async () => ({ ...session })),
	isActiveOrgMember: vi.fn(async () => true),
}));

const modules = import.meta.glob('../**/*.*s');
type Harness = TestConvex<typeof schema>;

beforeEach(() => {
	session.userId = 'user-A';
	session.activeOrganizationId = 'org-1';
	vi.stubEnv('SITE_URL', 'https://app.owlat.test');
	vi.stubEnv('INSTANCE_SECRET', 'test-upload-service-secret');
});
afterEach(() => vi.unstubAllEnvs());

async function uploaded(t: Harness, owner = 'user-A') {
	return t.run(async (ctx) => {
		const storageId = await ctx.storage.store(new Blob(['private content']));
		await recordUploadedBlob(ctx, storageId, owner);
		return storageId;
	});
}

async function draft(t: Harness) {
	const mailboxId = await seedMailbox(t);
	const { draftId } = await t.mutation(api.mail.drafts.create, { mailboxId });
	return { mailboxId, draftId };
}

function attach(t: Harness, draftId: Id<'mailDrafts'>, storageId: Id<'_storage'>) {
	return t.mutation(api.mail.drafts.addAttachment, {
		draftId,
		storageId,
		filename: 'document.txt',
		contentType: 'text/plain',
		size: 15,
	});
}

describe('server-recorded upload ownership', () => {
	it('mints the browser proxy URL and records only service-attested native uploads', async () => {
		const t = convexTest(schema, modules);
		const url = new URL(await t.run((ctx) => mintUploadUrl(ctx, session)));
		expect(url.origin + url.pathname).toBe('https://app.owlat.test/api/storage/upload');
		const token = url.searchParams.get('token')!;
		const headers = {
			'Content-Type': 'application/json',
			Authorization: 'Bearer test-upload-service-secret',
		};
		const unauthenticated = await t.fetch('/storage/upload/begin', {
			method: 'POST',
			body: JSON.stringify({ token }),
		});
		expect(unauthenticated.status).toBe(401);
		const response = await t.fetch('/storage/upload/begin', {
			method: 'POST',
			headers,
			body: JSON.stringify({ token }),
		});
		expect(response.status).toBe(200);
		const { uploadId, uploadUrl } = (await response.json()) as {
			uploadId: Id<'storageUploads'>;
			uploadUrl: string;
		};
		expect(uploadUrl).toMatch(/^https?:\/\//);
		// Stand in for the native upload response seen only by the trusted proxy.
		const storageId = await t.run((ctx) => ctx.storage.store(new Blob(['new bytes'])));
		const forged = await t.fetch('/storage/upload/finish', {
			method: 'POST',
			body: JSON.stringify({ uploadId, storageId }),
		});
		expect(forged.status).toBe(401);
		const finished = await t.fetch('/storage/upload/finish', {
			method: 'POST',
			headers,
			body: JSON.stringify({ uploadId, storageId }),
		});
		expect(finished.status).toBe(200);
		expect(await finished.json()).toEqual({ storageId });
		const receipt = await t.run((ctx) =>
			ctx.db
				.query('storageUploads')
				.withIndex('by_storage', (q) => q.eq('storageId', storageId))
				.unique()
		);
		expect(receipt).toMatchObject({
			userId: 'user-A',
			organizationId: 'org-1',
			status: 'uploaded',
		});
		expect(
			(
				await t.fetch('/storage/upload/begin', {
					method: 'POST',
					headers,
					body: JSON.stringify({ token }),
				})
			).status
		).toBe(401);
		await t.fetch('/storage/upload/abort', {
			method: 'POST',
			headers,
			body: JSON.stringify({ uploadId, storageId }),
		});
		expect(await t.run(async (ctx) => (await ctx.storage.get(storageId)) !== null)).toBe(true);
	});

	it('refuses expired and concurrently claimed capabilities, accepts key rotation, and bounds control bodies', async () => {
		const t = convexTest(schema, modules);
		const url = new URL(await t.run((ctx) => mintUploadUrl(ctx, session)));
		const token = url.searchParams.get('token')!;
		const claims = await Promise.all([
			t.mutation(internal.storage.uploads.begin, { token }),
			t.mutation(internal.storage.uploads.begin, { token }),
		]);
		expect(claims.filter(Boolean)).toHaveLength(1);
		const expired = new URL(await t.run((ctx) => mintUploadUrl(ctx, session)));
		await t.run(async (ctx) => {
			const ticket = await ctx.db
				.query('storageUploads')
				.withIndex('by_token', (q) => q.eq('token', expired.searchParams.get('token')!))
				.unique();
			await ctx.db.patch(ticket!._id, { expiresAt: Date.now() - 1 });
		});
		const headers = { Authorization: 'Bearer old-upload-service-secret' };
		vi.stubEnv('INSTANCE_SECRET_PREVIOUS', 'old-upload-service-secret');
		const body = JSON.stringify({ token: expired.searchParams.get('token') });
		expect((await t.fetch('/storage/upload/begin', { method: 'POST', headers, body })).status).toBe(
			401
		);
		const fresh = new URL(await t.run((ctx) => mintUploadUrl(ctx, session)));
		expect(
			(
				await t.fetch('/storage/upload/begin', {
					method: 'POST',
					headers,
					body: JSON.stringify({ token: fresh.searchParams.get('token') }),
				})
			).status
		).toBe(200);
		const tooLarge = await t.fetch('/storage/upload/begin', {
			method: 'POST',
			headers,
			body: 'x'.repeat(10 * 1024 + 1),
		});
		expect(tooLarge.status).not.toBe(200);
		vi.stubEnv('INSTANCE_SECRET', '');
		expect((await t.fetch('/storage/upload/begin', { method: 'POST', headers, body })).status).toBe(
			401
		);
	});

	it('rejects another uploader and untracked private blobs without linking or deleting them', async () => {
		const t = convexTest(schema, modules);
		const { draftId, mailboxId } = await draft(t);
		const foreign = await uploaded(t, 'user-B');
		const untracked = await t.run((ctx) => ctx.storage.store(new Blob(['existing private mail'])));
		for (const storageId of [foreign, untracked]) {
			await expect(attach(t, draftId, storageId)).rejects.toThrow(/not an unclaimed upload/);
			await expect(
				t.mutation(api.mail.archiveImport.start, {
					mailboxId,
					storageId,
					filename: 'private.eml',
					format: 'eml',
					totalBytes: 0,
				})
			).rejects.toThrow(/not an unclaimed upload/);
			expect(await t.run(async (ctx) => (await ctx.storage.get(storageId)) !== null)).toBe(true);
		}
		expect((await t.run((ctx) => ctx.db.get(draftId)))?.attachments).toEqual([]);
	});

	it('allows one owner binding, rejects cross-resource rebinding, and deletes its own attachment', async () => {
		const t = convexTest(schema, modules);
		const first = await draft(t);
		const second = await draft(t);
		const storageId = await uploaded(t);
		await attach(t, first.draftId, storageId);
		await expect(attach(t, second.draftId, storageId)).rejects.toThrow(/not an unclaimed upload/);
		await expect(
			t.mutation(api.mail.archiveImport.start, {
				mailboxId: first.mailboxId,
				storageId,
				filename: 'archive.eml',
				format: 'eml',
				totalBytes: 0,
			})
		).rejects.toThrow(/not an unclaimed upload/);
		expect(await t.run(async (ctx) => (await ctx.storage.get(storageId)) !== null)).toBe(true);
		await t.mutation(api.mail.drafts.removeAttachment, { draftId: first.draftId, storageId });
		expect(await t.run(async (ctx) => (await ctx.storage.get(storageId)) !== null)).toBe(false);
	});

	it('does not delete legacy or inherited blobs on draft removal or discard', async () => {
		const t = convexTest(schema, modules);
		const storageId = await t.run((ctx) => ctx.storage.store(new Blob(['shared original'])));
		for (const operation of ['remove', 'discard']) {
			const { draftId } = await draft(t);
			await t.run((ctx) =>
				ctx.db.patch(draftId, {
					attachments: [
						{
							storageId,
							filename: 'legacy.txt',
							contentType: 'text/plain',
							size: 15,
							isInline: false,
						},
					],
				})
			);
			if (operation === 'remove')
				await t.mutation(api.mail.drafts.removeAttachment, { draftId, storageId });
			else await t.mutation(api.mail.drafts.discard, { draftId });
			expect(await t.run(async (ctx) => (await ctx.storage.get(storageId)) !== null)).toBe(true);
		}
	});

	it('enforces organization scope and expires only unclaimed uploads', async () => {
		const t = convexTest(schema, modules);
		const abandoned = await uploaded(t);
		const bound = await uploaded(t);
		await expect(
			t.run((ctx) =>
				consumeUpload(ctx, bound, { ...session, activeOrganizationId: 'org-other' }, 'test:bound')
			)
		).rejects.toThrow(/not an unclaimed upload/);
		await t.run((ctx) => consumeUpload(ctx, bound, session, 'test:bound'));
		await t.run(async (ctx) => {
			const receipt = await ctx.db
				.query('storageUploads')
				.withIndex('by_storage', (q) => q.eq('storageId', abandoned))
				.unique();
			await ctx.db.patch(receipt!._id, { expiresAt: Date.now() - 1 });
		});
		await t.mutation(internal.storage.uploads.cleanup, {});
		expect(await t.run(async (ctx) => (await ctx.storage.get(abandoned)) !== null)).toBe(false);
		expect(await t.run(async (ctx) => (await ctx.storage.get(bound)) !== null)).toBe(true);
	});
});
