/**
 * The list pane's error state follows the renderer on screen (#1099). The
 * grouped views (conversations, categories, sections) each read their own
 * query while the flat feed keeps loading, so a failed grouped read used to
 * render the grouped list's "All clear" under a healthy flat feed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref, type Ref } from 'vue';
import type { PostboxViewMode } from '~/utils/postboxViewMode';
import { usePostboxListSources } from '../usePostboxListSources';

const failure = new Error('[CONVEX Q(mail/mailbox/queries:listThreads)] Server Error');

function read() {
	return { error: ref<Error | null>(null), refetch: vi.fn() };
}

let reads: Record<'conversations' | 'categories' | 'sections' | 'flat', ReturnType<typeof read>>;

beforeEach(() => {
	reads = { conversations: read(), categories: read(), sections: read(), flat: read() };
	vi.stubGlobal('usePostboxThreadGroups', () => reads.conversations);
	vi.stubGlobal('usePostboxThreadCategories', () => reads.categories);
	vi.stubGlobal('usePostboxThreadSections', () => reads.sections);
	vi.stubGlobal('usePostboxThreadBundles', () => ({}));
});

function sources(renderer: Ref<PostboxViewMode>, showingCached = ref(false)) {
	return usePostboxListSources({
		mailboxId: ref(null),
		folderRole: ref('inbox'),
		renderer,
		listMessages: ref([]),
		flatRead: reads.flat,
		showingCached,
	});
}

describe('usePostboxListSources read state', () => {
	it.each(['conversations', 'categories', 'sections'] as const)(
		"reports the %s view's own failed read and retries it, not the flat feed",
		(view) => {
			const list = sources(ref(view));
			expect(list.listError.value).toBeNull();

			reads[view].error.value = failure;
			expect(list.listError.value).toBe(failure);
			list.retryList();
			expect(reads[view].refetch).toHaveBeenCalledTimes(1);
			expect(reads.flat.refetch).not.toHaveBeenCalled();
		}
	);

	it('ignores a failed flat feed under a grouped view that loaded', () => {
		const list = sources(ref('conversations'));
		reads.flat.error.value = failure;
		expect(list.listError.value).toBeNull();
	});

	it.each(['flat', 'bundled'] as const)('reports the flat feed for the %s view', (view) => {
		const showingCached = ref(false);
		const list = sources(ref(view), showingCached);
		reads.flat.error.value = failure;
		expect(list.listError.value).toBe(failure);
		list.retryList();
		expect(reads.flat.refetch).toHaveBeenCalledTimes(1);

		// Cached rows stand in for the failed read.
		showingCached.value = true;
		expect(list.listError.value).toBeNull();
	});
});
