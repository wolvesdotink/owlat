import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';

const modules = import.meta.glob('../**/*.*s');

/**
 * Guards the storage-quota integrity fix in mediaAssets.ts: the persisted
 * `fileSize` (which the quota in getStats sums) is reconciled against the real
 * blob size by `reconcileAssetSize`, so a client can't under-report its upload
 * to evade the quota.
 */
describe('mediaAssets.reconcileAssetSize', () => {
	async function seedAsset(
		t: ReturnType<typeof convexTest>,
		claimedFileSize: number,
		bytes: Uint8Array,
	) {
		return t.run(async (ctx) => {
			const storageId = await ctx.storage.store(
				new Blob([bytes.buffer as ArrayBuffer], { type: 'image/png' }),
			);
			const assetId = await ctx.db.insert('mediaAssets', {
				storageId,
				filename: 'pic.png',
				mimeType: 'image/png',
				fileSize: claimedFileSize, // client-supplied (possibly a lie)
				url: 'https://example.com/pic.png',
				uploadedBy: 'user-1',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			return { assetId, storageId, actualSize: (await ctx.storage.get(storageId))!.size };
		});
	}

	it('corrects a stored fileSize that drifts from the real blob size', async () => {
		const t = convexTest(schema, modules);
		const bytes = new Uint8Array(1000); // real size 1000 bytes
		// Honest-ish client that reported a slightly stale/rounded value.
		const { assetId, storageId, actualSize } = await seedAsset(t, 980, bytes);

		await t.run(async (ctx) => {
			await ctx.runMutation(internal.mediaAssets.reconcileAssetSize, {
				assetId,
				storageId,
				actualSize,
			});
		});

		await t.run(async (ctx) => {
			const asset = await ctx.db.get(assetId);
			expect(asset).not.toBeNull();
			expect(asset?.fileSize).toBe(actualSize); // corrected to real bytes
		});
	});

	it('quotas off the reconciled (server-measured) size, not the client lie', async () => {
		const t = convexTest(schema, modules);
		const bytes = new Uint8Array(1200);
		// Slight under-report (within the quarantine factor) → corrected in place.
		const { assetId, storageId, actualSize } = await seedAsset(t, 1000, bytes);

		await t.run(async (ctx) => {
			await ctx.runMutation(internal.mediaAssets.reconcileAssetSize, {
				assetId,
				storageId,
				actualSize,
			});
		});

		const stats = await t.run(async (ctx) => {
			const assets = await ctx.db.query('mediaAssets').collect();
			return assets.reduce((sum, a) => sum + a.fileSize, 0);
		});
		expect(stats).toBe(actualSize); // quota reflects the real bytes
	});

	it('quarantines an asset whose fileSize is grossly under-reported', async () => {
		const t = convexTest(schema, modules);
		const bytes = new Uint8Array(10_000); // really 10KB
		// Client claimed 1KB — a > 1.5x under-report → quota-evasion → quarantine.
		const { assetId, storageId, actualSize } = await seedAsset(t, 1000, bytes);

		await t.run(async (ctx) => {
			await ctx.runMutation(internal.mediaAssets.reconcileAssetSize, {
				assetId,
				storageId,
				actualSize,
			});
		});

		await t.run(async (ctx) => {
			expect(await ctx.db.get(assetId)).toBeNull(); // row deleted
			expect(await ctx.storage.getUrl(storageId as Id<'_storage'>)).toBeNull(); // blob gone
		});
	});

	it('no-ops when the stored size already matches', async () => {
		const t = convexTest(schema, modules);
		const bytes = new Uint8Array(500);
		const { assetId, storageId, actualSize } = await seedAsset(t, 500, bytes);
		const before = await t.run(async (ctx) => (await ctx.db.get(assetId))?.updatedAt);

		await t.run(async (ctx) => {
			await ctx.runMutation(internal.mediaAssets.reconcileAssetSize, {
				assetId,
				storageId,
				actualSize,
			});
		});

		await t.run(async (ctx) => {
			const asset = await ctx.db.get(assetId);
			expect(asset?.fileSize).toBe(500);
			expect(asset?.updatedAt).toBe(before); // untouched
		});
	});
});
