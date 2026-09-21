import { convexTest, type TestConvex } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import { recordUploadedBlob } from './uploadFixtures.testlib';
import { seedMailbox } from '../mail/__tests__/helpers.testlib';
import { enableFeatures } from './factories';
import type { Id } from '../_generated/dataModel';

// Exercise real immutable storage metadata with small byte fixtures. Production
// limits remain single-sourced in the shared attachment policy.
vi.mock('@owlat/shared/attachments', async () => ({
	...(await vi.importActual('@owlat/shared/attachments')),
	MAX_ATTACHMENT_BYTES: 16,
	MAX_LIBRARY_FILE_BYTES: 32,
	ATTACHMENT_COMPOSE_LIMITS: { maxCount: 2, maxTotalBytes: 12 },
}));
vi.mock('../lib/sessionOrganization', async () => {
	const session = { userId: 'user-A', activeOrganizationId: 'org-1', role: 'owner' };
	return {
		...(await vi.importActual('../lib/sessionOrganization')),
		getMutationContext: vi.fn(async () => session),
		requireOrgMember: vi.fn(async () => session),
		requireOrgPermission: vi.fn(async () => session),
		requireAdminContext: vi.fn(async () => session),
		getBetterAuthSessionWithRole: vi.fn(async () => session),
		isActiveOrgMember: vi.fn(async () => true),
	};
});
const modules = import.meta.glob('../**/*.*s');
type Harness = TestConvex<typeof schema>;
async function upload(t: Harness, size: number) {
	return t.run(async (ctx) => {
		const storageId = await ctx.storage.store(
			new Blob([new Uint8Array(size)], { type: 'text/plain' })
		);
		await recordUploadedBlob(ctx, storageId, 'user-A');
		return storageId;
	});
}

describe('authoritative upload size admission', () => {
	for (const kind of ['chat', 'media', 'semantic'] as const) {
		it(`${kind} rejects underreported oversize/empty blobs and persists actual allowed sizes`, async () => {
			const t = convexTest(schema, modules);
			await enableFeatures(t, ['chat']);
			const bind = (storageId: Id<'_storage'>, fileSize = 1) => {
				const args = { storageId, filename: 'file.txt', mimeType: 'text/plain', fileSize };
				if (kind === 'chat') return t.mutation(api.chat.attachments.registerAttachment, args);
				if (kind === 'media') return t.mutation(api.mediaAssets.create, args);
				return t.mutation(api.semanticFiles.create, { ...args, sourceType: 'upload' });
			};
			await expect(bind(await upload(t, kind === 'chat' ? 17 : 33))).rejects.toThrow(/limit/);
			await expect(bind(await upload(t, 0))).rejects.toThrow(/positive/);
			const id = await bind(await upload(t, 8), 999_999_999);
			expect((await t.run((ctx) => ctx.db.get(id)))?.fileSize).toBe(8);
			const missing = await upload(t, 4);
			await t.run((ctx) => ctx.storage.delete(missing));
			await expect(bind(missing)).rejects.toThrow(/missing/);
		});
	}

	it('counts real inline and legacy attachment bytes, preserves the receipt after rejection, and caps count', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		const { draftId } = await t.mutation(api.mail.drafts.create, { mailboxId });
		const attach = (storageId: Id<'_storage'>, isInline = false) =>
			t.mutation(api.mail.drafts.addAttachment, {
				draftId,
				storageId,
				filename: 'file.txt',
				contentType: 'text/plain',
				size: 0,
				isInline,
			});
		const first = await upload(t, 8);
		await attach(first);
		expect((await t.run((ctx) => ctx.db.get(draftId)))?.attachments[0]?.size).toBe(8);
		// An existing misreported row cannot make room for additional bytes.
		await t.run(async (ctx) => {
			const draft = (await ctx.db.get(draftId))!;
			await ctx.db.patch(draftId, {
				attachments: draft.attachments.map((a) => ({ ...a, size: 0 })),
			});
		});
		const second = await upload(t, 8);
		await expect(attach(second, true)).rejects.toThrow(/total size/);
		await t.mutation(api.mail.drafts.removeAttachment, { draftId, storageId: first });
		await attach(second, true); // failed bind did not burn the upload receipt
		await attach(await upload(t, 1));
		await expect(attach(await upload(t, 1), true)).rejects.toThrow(/Too many/);
	});
});
