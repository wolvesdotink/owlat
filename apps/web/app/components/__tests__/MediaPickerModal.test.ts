import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import MediaPickerModal from '../MediaPickerModal.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import {
	EPISODE_QUIET_MS,
	onSlowEpisodeEnd,
	resetPendingOperations,
	SLOW_OPERATION_MS,
	trackPendingOperation,
	type SlowEpisodeOutcome,
} from '~/lib/pendingOperations';

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

describe('MediaPickerModal and the slow-save episode', () => {
	afterEach(() => {
		resetPendingOperations();
		vi.useRealTimers();
	});

	it('confirms nothing until the picked file is registered and handed over', async () => {
		vi.useFakeTimers();
		const outcomes: SlowEpisodeOutcome[] = [];
		const stop = onSlowEpisodeEnd((outcome) => outcomes.push(outcome));
		let resolveUrl!: (url: string) => void;
		getStorageUrl.mockReset().mockReturnValue(new Promise((resolve) => (resolveUrl = resolve)));
		const wrapper = mount(MediaPickerModal, {
			props: { open: true, allowAllFiles: true },
			global: {
				plugins: [createTestI18n()],
				stubs: {
					UiInput: true,
					UiSpinner: true,
					UiModal: { template: '<div><slot /></div>' },
					UiButton: { template: '<button><slot /></button>' },
				},
			},
		});
		await wrapper
			.findAll('button')
			.find((button) => button.text() === 'Upload')!
			.trigger('click');

		const slowWrite = trackPendingOperation(() => 'Archive');
		vi.advanceTimersByTime(SLOW_OPERATION_MS);
		const input = wrapper.get('input[type="file"]');
		Object.defineProperty(input.element, 'files', {
			configurable: true,
			value: [new File(['document'], 'terms.pdf', { type: 'application/pdf' })],
		});
		await input.trigger('change');
		await vi.advanceTimersByTimeAsync(0);
		expect(getStorageUrl).toHaveBeenCalled();

		slowWrite(true);
		await vi.advanceTimersByTimeAsync(EPISODE_QUIET_MS * 3);
		expect(outcomes).toEqual([]);

		resolveUrl('https://files.example/uploaded');
		await vi.advanceTimersByTimeAsync(0);
		expect(wrapper.emitted('select')).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(EPISODE_QUIET_MS);
		expect(outcomes).toEqual(['saved']);
		stop();
	});
});
