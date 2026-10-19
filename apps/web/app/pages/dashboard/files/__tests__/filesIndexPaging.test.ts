// @vitest-environment happy-dom
/**
 * The Files page pages on for as long as the read says there is more.
 *
 * The read gate can drop every file on a page the member may not open while
 * later pages hold files they can. The page used to show "No files yet" as
 * soon as no row was visible, and offered "Load more" only next to rows, so
 * such a member hit a dead end. The empty state now waits for the end of the
 * walk (`Exhausted`), and "Load more" shows whenever there is more to load.
 */
import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

Object.assign(globalThis, { useI18n: i18nStubs.useI18n });

type Status = 'LoadingFirstPage' | 'CanLoadMore' | 'LoadingMore' | 'Exhausted';

const card = {
	_id: 'file_1',
	filename: 'contract.pdf',
	mimeType: 'application/pdf',
	fileSize: 2048,
	sourceType: 'upload',
	version: 1,
	createdAt: 1_700_000_000_000,
	updatedAt: 1_700_000_000_000,
	hasBytes: true,
	url: null,
};

async function mountPage(state: { files: unknown[]; status: Status; searchQuery?: string }) {
	const loadMore = vi.fn();
	vi.stubGlobal('useHead', vi.fn());
	vi.stubGlobal('definePageMeta', vi.fn());
	vi.stubGlobal('usePermissions', () => ({ isAdmin: ref(true) }));
	vi.stubGlobal('useSemanticFiles', () => ({
		files: ref(state.files),
		status: ref(state.status),
		isLoading: ref(false),
		error: ref(null),
		refetch: vi.fn(),
		searchQuery: ref(state.searchQuery ?? ''),
		sourceFilter: ref(null),
		viewMode: ref('grid'),
		loadMore,
	}));

	const Page = (await import('../index.vue')).default;
	const wrapper = mount(Page, {
		shallow: true,
		global: {
			plugins: [createTestI18n()],
			renderStubDefaultSlot: true,
			// Nuxt auto-registers these; `shallow` only stubs what it can resolve.
			stubs: {
				UiButton: { template: '<button type="button"><slot /></button>' },
				UiPageHeader: true,
				UiIconBox: true,
				FilesFileCard: true,
				FilesFileUploadModal: true,
			},
		},
	});
	return { wrapper, loadMore };
}

const loadMoreButton = (wrapper: Awaited<ReturnType<typeof mountPage>>['wrapper']) =>
	wrapper.findAll('button').find((b) => b.text() === 'Load more');

describe('Files page — paging past a page with nothing to show', () => {
	for (const searchQuery of ['', 'invoice']) {
		const mode = searchQuery ? 'search' : 'list';

		it(`offers Load more, and no empty state, while a ${mode} has more to load`, async () => {
			const { wrapper, loadMore } = await mountPage({
				files: [],
				status: 'CanLoadMore',
				searchQuery,
			});

			expect(wrapper.text()).not.toContain('No files yet');
			expect(wrapper.text()).not.toContain('No files match your search');
			const button = loadMoreButton(wrapper);
			expect(button).toBeDefined();
			await button!.trigger('click');
			expect(loadMore).toHaveBeenCalledTimes(1);
		});

		it(`shows the empty state once the ${mode} is exhausted`, async () => {
			const { wrapper } = await mountPage({ files: [], status: 'Exhausted', searchQuery });

			expect(wrapper.text()).toContain(searchQuery ? 'No files match your search' : 'No files yet');
			expect(loadMoreButton(wrapper)).toBeUndefined();
		});
	}

	it('keeps Load more beside the files while there are more', async () => {
		const { wrapper } = await mountPage({ files: [card], status: 'CanLoadMore' });

		expect(wrapper.text()).not.toContain('No files yet');
		expect(loadMoreButton(wrapper)).toBeDefined();
	});

	it('shows neither while the first page loads', async () => {
		const { wrapper } = await mountPage({ files: [], status: 'LoadingFirstPage' });

		expect(wrapper.text()).not.toContain('No files yet');
		expect(loadMoreButton(wrapper)).toBeUndefined();
	});
});
