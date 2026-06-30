import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import { createTestEmailTemplate, createTestTransactionalEmail } from './factories';
import type { Id } from '../_generated/dataModel';

/**
 * mediaAssets.countUsage — the per-asset "used in N emails" figure the library
 * detail panel shows. A library image carries the asset's `_storage` id in the
 * editor `content` JSON (the media picker sets ImageBlockContent.storageId), so
 * the count is an exact substring match on that opaque id.
 */

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		requireOrgPermission: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
	};
});

const modules = import.meta.glob('../**/*.*s');

/** Serialize an editor-state blob that references a media asset by storageId,
 *  exactly as the builder persists a library image block. */
function contentReferencing(storageId: string): string {
	return JSON.stringify({
		blocks: [
			{ type: 'image', content: { src: `https://cdn/${storageId}`, storageId } },
		],
	});
}

async function seedAsset(t: ReturnType<typeof convexTest>): Promise<{ assetId: Id<'mediaAssets'>; storageId: string }> {
	return await t.run(async (ctx) => {
		const storageId = await ctx.storage.store(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }));
		const assetId = await ctx.db.insert('mediaAssets', {
			storageId,
			filename: 'logo.png',
			mimeType: 'image/png',
			fileSize: 3,
			url: `https://cdn/${storageId}`,
			uploadedBy: 'test-user',
			searchableText: 'logo',
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		return { assetId, storageId: String(storageId) };
	});
}

/** Insert a saved block whose serialized `content` references a media asset,
 *  exactly as the saved-block editor persists a library image. */
async function insertBlock(t: ReturnType<typeof convexTest>, content: string): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert('emailBlocks', {
			name: 'hero block',
			content,
			usageCount: 0,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
	});
}

describe('mediaAssets.countUsage', () => {
	it('counts templates, transactional emails and saved blocks that reference the asset', async () => {
		const t = convexTest(schema, modules);
		const { assetId, storageId } = await seedAsset(t);

		await t.run(async (ctx) => {
			// 2 templates reference it, 1 does not.
			await ctx.db.insert('emailTemplates', createTestEmailTemplate({ content: contentReferencing(storageId) }));
			await ctx.db.insert('emailTemplates', createTestEmailTemplate({ content: contentReferencing(storageId) }));
			await ctx.db.insert('emailTemplates', createTestEmailTemplate({ content: JSON.stringify({ blocks: [] }) }));
			// 1 transactional email references it.
			await ctx.db.insert('transactionalEmails', createTestTransactionalEmail({ content: contentReferencing(storageId) }));
			await ctx.db.insert('transactionalEmails', createTestTransactionalEmail({ content: JSON.stringify({ blocks: [] }) }));
		});
		// 1 saved block references it, 1 does not.
		await insertBlock(t, contentReferencing(storageId));
		await insertBlock(t, JSON.stringify({ blocks: [] }));

		const { count } = await t.query(api.mediaAssets.countUsage, { assetId });
		expect(count).toBe(4);
	});

	it('counts an asset embedded only in a saved block (not in any template)', async () => {
		const t = convexTest(schema, modules);
		const { assetId, storageId } = await seedAsset(t);

		await insertBlock(t, contentReferencing(storageId));

		const { count } = await t.query(api.mediaAssets.countUsage, { assetId });
		expect(count).toBe(1);
	});

	it('returns 0 when the asset is referenced nowhere', async () => {
		const t = convexTest(schema, modules);
		const { assetId } = await seedAsset(t);

		await t.run(async (ctx) => {
			await ctx.db.insert('emailTemplates', createTestEmailTemplate({ content: JSON.stringify({ blocks: [] }) }));
			// A DIFFERENT asset's id must not be mistaken for ours (real _storage
			// ids are fixed-length, so one is never a substring of another).
			const otherStorageId = await ctx.storage.store(new Blob([new Uint8Array([7, 7, 7])]));
			await ctx.db.insert('emailTemplates', createTestEmailTemplate({ content: contentReferencing(String(otherStorageId)) }));
		});

		const { count } = await t.query(api.mediaAssets.countUsage, { assetId });
		expect(count).toBe(0);
	});

	it('returns 0 for a missing asset', async () => {
		const t = convexTest(schema, modules);
		const fakeId = await t.run(async (ctx) => {
			const id = await ctx.db.insert('mediaAssets', {
				storageId: await ctx.storage.store(new Blob([new Uint8Array([9])])),
				filename: 'x.png',
				mimeType: 'image/png',
				fileSize: 1,
				url: 'https://cdn/x',
				uploadedBy: 'test-user',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.delete(id);
			return id;
		});

		const { count } = await t.query(api.mediaAssets.countUsage, { assetId: fakeId });
		expect(count).toBe(0);
	});
});
