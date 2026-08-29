/**
 * usePostboxThreads and the sort order: the default order is sent as NOTHING
 * (so a user who never touches the control keeps the exact query the list had
 * before it existed), a flip both sends the order and changes the feed's reset
 * key — cursors are minted for one index direction and must not outlive a flip.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computed, ref, type Ref } from 'vue';
import type { Id } from '@owlat/api/dataModel';
import type { PostboxSortOrder } from '~/utils/postboxSortOrder';
import { usePostboxThreads } from '../usePostboxThreads';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

/** The args factory and reset key the composable handed to the cursor feed. */
let captured: { args: () => unknown; resetKey: Ref<unknown> };

beforeEach(() => {
	vi.stubGlobal(
		'usePostboxCursorFeed',
		(_query: unknown, args: () => unknown, resetKey: Ref<unknown>) => {
			captured = { args, resetKey };
			return {
				rows: computed(() => []),
				isLoading: ref(false),
				isLoadingMore: ref(false),
				isRefetching: ref(false),
				hasMore: computed(() => false),
				canLoadMore: computed(() => false),
				loadMore: vi.fn(),
			};
		}
	);
});

function mountThreads(sortOrder?: Ref<PostboxSortOrder>) {
	usePostboxThreads({
		mailboxId: ref('mailbox-1' as Id<'mailboxes'>),
		folderRole: ref('inbox'),
		sortOrder,
	});
	return captured;
}

describe('usePostboxThreads sort order', () => {
	it('sends no sort argument on the default order', () => {
		const { args } = mountThreads();
		expect(args()).toEqual({ mailboxId: 'mailbox-1', folderRole: 'inbox', limit: 50 });
	});

	it('sends no sort argument when the caller passes newest explicitly', () => {
		const { args } = mountThreads(ref<PostboxSortOrder>('newest'));
		expect(args()).not.toHaveProperty('sortOrder');
	});

	it('sends the order once it is flipped to oldest', () => {
		const { args } = mountThreads(ref<PostboxSortOrder>('oldest'));
		expect(args()).toMatchObject({ sortOrder: 'oldest' });
	});

	it('changes the reset key on a flip, so no cursor survives it', async () => {
		const sortOrder = ref<PostboxSortOrder>('newest');
		const { resetKey } = mountThreads(sortOrder);
		const before = resetKey.value;
		sortOrder.value = 'oldest';
		expect(resetKey.value).not.toBe(before);
	});
});
