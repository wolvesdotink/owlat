import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import MediaPickerModal from '../MediaPickerModal.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

const generateUploadUrl = vi.fn();
const createMediaAsset = vi.fn();
const getStorageUrl = vi.fn();
const uploadFileToStorage = vi.fn();

beforeEach(() => {
	generateUploadUrl.mockReset().mockResolvedValue({ ok: true, result: 'https://upload.example' });
	createMediaAsset.mockReset().mockResolvedValue({ ok: true, result: 'media-uploaded' });
	getStorageUrl.mockReset().mockResolvedValue('https://files.example/uploaded');
	uploadFileToStorage.mockReset().mockResolvedValue({
		ok: true,
		storageId: 'storage-uploaded',
	});

	vi.stubGlobal('useDebouncedSearch', () => ({
		searchQuery: ref(''),
		debouncedSearch: ref(''),
	}));
	vi.stubGlobal('usePaginatedQuery', () => ({
		results: ref([]),
		status: ref('Exhausted'),
		loadMore: vi.fn(),
		isLoading: ref(false),
	}));
	// `useI18n` is an auto-import in the app; it resolves against the instance
	// `global.plugins` installs.
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	// The operation labels are messages now, so they arrive as getters (a plain
	// `t()` would freeze the label at the locale that was active at setup).
	vi.stubGlobal('useBackendOperation', (_operation: unknown, options: { label: () => string }) => ({
		run: options.label() === 'Upload media' ? createMediaAsset : generateUploadUrl,
	}));
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

describe('MediaPickerModal upload provenance', () => {
	it('emits the registered media and storage identities with the guarded URL', async () => {
		const wrapper = mount(MediaPickerModal, {
			props: { open: true, allowAllFiles: true },
			global: {
				plugins: [createTestI18n()],
				stubs: {
					Icon: true,
					UiInput: true,
					UiSpinner: true,
					UiModal: { template: '<div><slot /></div>' },
					UiButton: { template: '<button><slot /></button>' },
				},
			},
		});
		const uploadTab = wrapper.findAll('button').find((button) => button.text() === 'Upload');
		expect(uploadTab).toBeDefined();
		await uploadTab!.trigger('click');

		const file = new File(['document'], 'terms.pdf', { type: 'application/pdf' });
		const input = wrapper.get('input[type="file"]');
		Object.defineProperty(input.element, 'files', {
			configurable: true,
			value: [file],
		});
		await input.trigger('change');
		await flushPromises();

		expect(wrapper.emitted('select')?.at(-1)?.[0]).toMatchObject({
			url: 'https://files.example/uploaded',
			storageId: 'storage-uploaded',
			mediaAssetId: 'media-uploaded',
			filename: 'terms.pdf',
		});
	});
});
