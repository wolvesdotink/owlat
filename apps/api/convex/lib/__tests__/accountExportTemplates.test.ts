import { describe, expect, it, vi } from 'vitest';
import type { Doc, Id } from '../../_generated/dataModel';
import { accountExportBytesToBase64 } from '../accountExportEncoding';
import {
	ACCOUNT_EXPORT_TEMPLATE_MEDIA_MAX_BYTES,
	openEmailTemplateContent,
} from '../accountExportTemplates';

describe('account export template media projection', () => {
	it('exports exact UI-stored image bytes and strips every capability-bearing source', async () => {
		const primaryBytes = new Uint8Array([0, 1, 2, 127, 128, 255]);
		const darkBytes = new TextEncoder().encode('exact dark image bytes');
		const blobs = new Map<string, Blob>([
			['storage-primary', new Blob([primaryBytes])],
			['storage-dark', new Blob([darkBytes])],
		]);
		const storage = {
			get: vi.fn(async (storageId: Id<'_storage'>) => {
				if (storageId === ('storage-corrupt' as Id<'_storage'>)) {
					throw new Error('damaged storage object');
				}
				return blobs.get(storageId) ?? null;
			}),
		};
		const template = {
			content: JSON.stringify([
				{
					id: 'normal-ui-image',
					type: 'image',
					content: {
						src: 'https://capability.example/primary',
						storageId: 'storage-primary',
						mediaAssetId: 'asset-primary',
						darkSrc: 'https://capability.example/dark',
						darkStorageId: 'storage-dark',
						darkMediaAssetId: 'asset-dark',
						srcset: 'https://capability.example/primary 2x',
						alt: 'Customer-authored alt text',
					},
				},
				{
					id: 'legacy-ui-image',
					type: 'image',
					content: {
						src: 'https://capability.example/legacy-without-storage-id',
						darkSrc: 'https://capability.example/legacy-dark-without-storage-id',
						alt: 'Legacy image',
					},
				},
				{
					id: 'damaged-ui-image',
					type: 'image',
					content: {
						src: 'https://capability.example/corrupt',
						storageId: 'storage-corrupt',
						mediaAssetId: 'asset-corrupt',
						alt: 'Damaged image',
					},
				},
			]),
		} as unknown as Doc<'emailTemplates'>;

		const result = await openEmailTemplateContent(storage, template, [
			{ mediaAssetId: 'asset-primary', storageId: 'storage-primary' },
			{ mediaAssetId: 'asset-dark', storageId: 'storage-dark' },
			{ mediaAssetId: 'asset-corrupt', storageId: 'storage-corrupt' },
		]);

		expect(result.editorContent).toEqual({
			availability: 'available',
			value: [
				{
					id: 'normal-ui-image',
					type: 'image',
					content: {
						alt: 'Customer-authored alt text',
						storedContent: {
							contentBase64: accountExportBytesToBase64(primaryBytes),
							contentEncoding: 'base64',
							availability: 'available',
						},
						darkStoredContent: {
							contentBase64: accountExportBytesToBase64(darkBytes),
							contentEncoding: 'base64',
							availability: 'available',
						},
					},
				},
				{
					id: 'legacy-ui-image',
					type: 'image',
					content: {
						alt: 'Legacy image',
						storedContent: {
							contentBase64: '',
							contentEncoding: 'base64',
							availability: 'missing',
						},
						darkStoredContent: {
							contentBase64: '',
							contentEncoding: 'base64',
							availability: 'missing',
						},
					},
				},
				{
					id: 'damaged-ui-image',
					type: 'image',
					content: {
						alt: 'Damaged image',
						storedContent: {
							contentBase64: '',
							contentEncoding: 'base64',
							availability: 'corrupt',
						},
					},
				},
			],
		});

		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain('capability.example');
		expect(serialized).not.toContain('storage-primary');
		expect(serialized).not.toContain('storage-dark');
		expect(serialized).not.toContain('storage-corrupt');
		expect(serialized).not.toContain('srcset');
	});

	it('does not read an arbitrary storage ID under missing or mismatched media provenance', async () => {
		const storage = {
			get: vi.fn(async () => new Blob(['cross-resource secret'])),
		};
		const template = {
			content: JSON.stringify([
				{
					type: 'image',
					content: {
						src: 'https://capability.example/cross-resource',
						storageId: 'foreign-storage',
						mediaAssetId: 'owned-asset',
					},
				},
				{
					type: 'image',
					content: {
						src: 'https://capability.example/no-asset',
						storageId: 'unbacked-storage',
					},
				},
			]),
		} as unknown as Doc<'emailTemplates'>;

		const result = await openEmailTemplateContent(storage, template, [
			{ mediaAssetId: 'owned-asset', storageId: 'owned-storage' },
		]);

		expect(storage.get).not.toHaveBeenCalled();
		expect(result.editorContent).toMatchObject({
			value: [
				{ content: { storedContent: { availability: 'missing' } } },
				{ content: { storedContent: { availability: 'missing' } } },
			],
		});
		expect(JSON.stringify(result)).not.toContain('cross-resource secret');
	});

	it('opens image-heavy templates sequentially and stops at the decoded aggregate cap', async () => {
		const assetBytes = new Uint8Array(6 * 1024 * 1024);
		let activeReads = 0;
		let peakReads = 0;
		const storage = {
			get: vi.fn(async () => {
				activeReads += 1;
				peakReads = Math.max(peakReads, activeReads);
				await Promise.resolve();
				activeReads -= 1;
				return new Blob([assetBytes]);
			}),
		};
		const images = Array.from({ length: 3 }, (_, index) => ({
			type: 'image',
			content: {
				src: `https://capability.example/${index}`,
				storageId: `storage-${index}`,
				mediaAssetId: `asset-${index}`,
			},
		}));
		const template = {
			content: JSON.stringify(images),
		} as unknown as Doc<'emailTemplates'>;

		expect(assetBytes.byteLength * 2).toBeLessThan(ACCOUNT_EXPORT_TEMPLATE_MEDIA_MAX_BYTES);
		expect(assetBytes.byteLength * 3).toBeGreaterThan(ACCOUNT_EXPORT_TEMPLATE_MEDIA_MAX_BYTES);
		await expect(
			openEmailTemplateContent(
				storage,
				template,
				images.map((_, index) => ({
					mediaAssetId: `asset-${index}`,
					storageId: `storage-${index}`,
				}))
			)
		).rejects.toThrow('aggregate limit');
		expect(peakReads).toBe(1);
	});
});
