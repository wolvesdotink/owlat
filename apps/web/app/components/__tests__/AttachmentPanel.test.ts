import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, nextTick, ref } from 'vue';
import AttachmentPanel from '../AttachmentPanel.vue';

const generateUploadUrl = vi.fn();
const createMediaAsset = vi.fn();
const getStorageUrl = vi.fn();
const uploadFileToStorage = vi.fn();

const MediaPickerModalStub = defineComponent({
	name: 'MediaPickerModal',
	emits: ['select', 'update:open'],
	template: '<div data-testid="media-picker" />',
});

function mountPanel() {
	return mount(AttachmentPanel, {
		props: { attachments: [] },
		global: {
			stubs: {
				Icon: true,
				UiProgressBar: true,
				MediaPickerModal: MediaPickerModalStub,
			},
		},
	});
}

beforeEach(() => {
	generateUploadUrl.mockReset().mockResolvedValue('https://upload.example');
	createMediaAsset.mockReset().mockResolvedValue('media-asset-uploaded');
	getStorageUrl.mockReset().mockResolvedValue('https://files.example/uploaded');
	uploadFileToStorage.mockReset().mockResolvedValue({
		ok: true,
		storageId: 'storage-uploaded',
	});

	vi.stubGlobal('useBackendOperation', (_operation: unknown, options: { label: string }) => ({
		run: options.label === 'Save attachment' ? createMediaAsset : generateUploadUrl,
	}));
	vi.stubGlobal('useToast', () => ({ showToast: vi.fn() }));
	vi.stubGlobal('useDropZone', () => ({
		isDragOver: ref(false),
		handleDragOver: vi.fn(),
		handleDragLeave: vi.fn(),
		handleDrop: vi.fn(),
	}));
	vi.stubGlobal('uploadFileToStorage', uploadFileToStorage);
	vi.stubGlobal('requireConvex', () => ({ query: getStorageUrl }));
	vi.stubGlobal('formatCompactFileSize', (bytes: number) => `${bytes} B`);
});

describe('AttachmentPanel storage provenance', () => {
	it('emits the registered media asset ID for a direct upload', async () => {
		const wrapper = mountPanel();
		const file = new File(['attachment'], 'invoice.pdf', {
			type: 'application/pdf',
		});
		const input = wrapper.get('input[type="file"]');
		Object.defineProperty(input.element, 'files', {
			configurable: true,
			value: [file],
		});

		await input.trigger('change');
		await flushPromises();
		await nextTick();

		expect(createMediaAsset).toHaveBeenCalledWith(
			expect.objectContaining({ storageId: 'storage-uploaded', filename: 'invoice.pdf' })
		);
		expect(wrapper.emitted('update:attachments')?.at(-1)?.[0]).toEqual([
			expect.objectContaining({
				filename: 'invoice.pdf',
				storageId: 'storage-uploaded',
				mediaAssetId: 'media-asset-uploaded',
				url: 'https://files.example/uploaded',
			}),
		]);
	});

	it('preserves the selected media asset ID from the media picker', async () => {
		const wrapper = mountPanel();
		wrapper.findComponent(MediaPickerModalStub).vm.$emit('select', {
			url: 'https://files.example/library',
			storageId: 'storage-library',
			mediaAssetId: 'media-asset-library',
			filename: 'terms.pdf',
			contentType: 'application/pdf',
			fileSize: 1_024,
		});
		await nextTick();

		expect(wrapper.emitted('update:attachments')?.at(-1)?.[0]).toEqual([
			expect.objectContaining({
				filename: 'terms.pdf',
				storageId: 'storage-library',
				mediaAssetId: 'media-asset-library',
				url: 'https://files.example/library',
			}),
		]);
	});
});
