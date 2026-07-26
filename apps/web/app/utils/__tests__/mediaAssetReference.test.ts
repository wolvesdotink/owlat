import { describe, expect, it, vi } from 'vitest';
import type { Id } from '@owlat/api/dataModel';
import { registerUploadedMediaReference } from '../mediaAssetReference';

const metadata = {
	storageId: 'storage-1' as Id<'_storage'>,
	filename: 'photo.png',
	mimeType: 'image/png',
	fileSize: 128,
	width: 20,
	height: 10,
};

describe('registerUploadedMediaReference', () => {
	it('registers the blob before resolving and returns all durable identities', async () => {
		const createMediaAsset = vi.fn().mockResolvedValue('media-1');
		const getUrl = vi.fn().mockResolvedValue('https://files.example/photo');

		await expect(
			registerUploadedMediaReference({ createMediaAsset, getUrl }, metadata)
		).resolves.toEqual({
			ok: true,
			reference: {
				url: 'https://files.example/photo',
				storageId: 'storage-1',
				mediaAssetId: 'media-1',
			},
		});
		expect(createMediaAsset).toHaveBeenCalledWith(metadata);
		expect(getUrl).toHaveBeenCalledWith('storage-1');
		expect(createMediaAsset.mock.invocationCallOrder[0]).toBeLessThan(
			getUrl.mock.invocationCallOrder[0]!
		);
	});

	it('reports media registration failure without attempting URL resolution', async () => {
		const createMediaAsset = vi.fn().mockResolvedValue(undefined);
		const getUrl = vi.fn();

		await expect(
			registerUploadedMediaReference({ createMediaAsset, getUrl }, metadata)
		).resolves.toEqual({
			ok: false,
			reason: 'media-registration-failed',
		});
		expect(getUrl).not.toHaveBeenCalled();
	});

	it('distinguishes a missing guarded URL after successful registration', async () => {
		await expect(
			registerUploadedMediaReference(
				{
					createMediaAsset: vi.fn().mockResolvedValue('media-1'),
					getUrl: vi.fn().mockResolvedValue(null),
				},
				metadata
			)
		).resolves.toEqual({ ok: false, reason: 'url-unavailable' });
	});
});
