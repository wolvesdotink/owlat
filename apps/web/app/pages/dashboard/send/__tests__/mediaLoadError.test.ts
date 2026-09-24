// @vitest-environment happy-dom
/**
 * A failed media read is not an empty library (#721): the page shows the
 * error with a working Try again, never "No media yet".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { ref } from 'vue';

import MediaPage from '../media.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { installNuxtStubs, queryResult } from '~/__tests__/a11y';
import QueryBoundary from '~/components/ui/QueryBoundary.vue';
import { formatCompactFileSize } from '~/utils/formatters';

let assetsError: Error | null;
let refetchAssets: ReturnType<typeof vi.fn>;

beforeEach(() => {
	assetsError = null;
	refetchAssets = vi.fn();
});

function render(): VueWrapper {
	installNuxtStubs({
		...i18nStubs,
		formatCompactFileSize,
		useCopyToClipboard: () => ({ copy: vi.fn() }),
		useDropZone: () => ({
			isDragOver: ref(false),
			handleDragOver: vi.fn(),
			handleDragLeave: vi.fn(),
			handleDrop: vi.fn(),
		}),
		useConvexQuery: () => queryResult(undefined),
		useMediaLibrary: () => ({
			assets: ref([]),
			stats: ref(undefined),
			tags: ref([]),
			status: ref('Exhausted'),
			isLoading: ref(false),
			error: ref(assetsError),
			refetch: refetchAssets,
			isUploading: ref(false),
			searchQuery: ref(''),
			selectedTag: ref(''),
			selectedTypes: ref([]),
			selectedAssets: ref(new Set()),
			toggleSelect: vi.fn(),
			clearSelection: vi.fn(),
			loadMore: vi.fn(),
			uploadFiles: vi.fn(),
			deleteAssets: vi.fn(),
			updateAsset: vi.fn(),
		}),
	});
	return mount(MediaPage, {
		global: {
			plugins: [createTestI18n()],
			components: { UiQueryBoundary: QueryBoundary },
			stubs: {
				Icon: true,
				UiInput: true,
				UiSelect: true,
				UiCheckbox: true,
				UiModal: true,
				UiConfirmationDialog: true,
				UiSpinner: true,
				UiErrorAlert: { props: ['title'], template: '<p data-stub="error">{{ title }}</p>' },
				UiEmptyState: { props: ['title'], template: '<p data-stub="empty">{{ title }}</p>' },
				UiButton: {
					emits: ['click'],
					template: '<button data-stub="button" @click="$emit(\'click\')"><slot /></button>',
				},
			},
		},
	}) as VueWrapper;
}

describe('media library read state', () => {
	it('shows the empty state when the library really is empty', () => {
		const wrapper = render();

		expect(wrapper.find('[data-stub="empty"]').text()).toBe('No media yet');
		expect(wrapper.find('[data-stub="error"]').exists()).toBe(false);
	});

	it('shows a failed read with Try again instead of the empty state (#721)', async () => {
		assetsError = new Error('[CONVEX Q(mediaAssets:list)] [Request ID: 1] Server Error');
		const wrapper = render();

		expect(wrapper.find('[data-stub="empty"]').exists()).toBe(false);
		expect(wrapper.find('[data-stub="error"]').text()).toBe("Couldn't load media");
		const retry = wrapper.findAll('[data-stub="button"]').find((b) => b.text() === 'Try again');
		expect(retry).toBeDefined();
		await retry!.trigger('click');
		expect(refetchAssets).toHaveBeenCalledTimes(1);
	});
});
