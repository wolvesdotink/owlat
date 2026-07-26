import { describe, expect, it, vi } from 'vitest';
import type { Doc, Id } from '../../_generated/dataModel';
import { accountExportBytesToBase64 } from '../accountExportEncoding';
import { openEmailTemplateContent } from '../accountExportTemplates';

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
						darkSrc: 'https://capability.example/dark',
						darkStorageId: 'storage-dark',
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
						alt: 'Damaged image',
					},
				},
			]),
		} as unknown as Doc<'emailTemplates'>;

		const result = await openEmailTemplateContent(storage, template);

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
});
