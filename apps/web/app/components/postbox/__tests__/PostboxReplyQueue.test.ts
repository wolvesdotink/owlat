// @vitest-environment happy-dom
/**
 * Reply Queue task-list behavior:
 *   - a row headlines the AI askSummary, or falls back to the subject when
 *     the flag is deterministic-only (AI off / failed)
 *   - "Done" calls the clear mutation and hides the row optimistically
 *     (before the live query confirms), and restores it when the call fails
 *   - an empty queue renders the quiet "All caught up" moment
 *
 * The component leans on Nuxt auto-imports; composables are stubbed as
 * globals (the optimistic-hide one with its REAL implementation, since the
 * optimistic behavior is under test).
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref, computed } from 'vue';

import PostboxReplyQueue from '../PostboxReplyQueue.vue';
import PostboxEmptyState from '../PostboxEmptyState.vue';
import { usePostboxOptimisticHide } from '../../../composables/postbox/usePostboxOptimisticHide';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

function makeItem(i: number, overrides: Record<string, unknown> = {}) {
	return {
		threadId: `thread-${i}`,
		messageId: `msg-${i}`,
		urgency: 'normal',
		askSummary: undefined,
		dueHint: undefined,
		detectedAt: Date.now(),
		source: 'heuristic',
		fromAddress: `sender${i}@example.com`,
		fromName: `Sender ${i}`,
		subject: `Subject ${i}`,
		snippet: `Snippet ${i}`,
		receivedAt: Date.now() - i * 60_000,
		...overrides,
	};
}

const queueItems = ref<ReturnType<typeof makeItem>[]>([]);
const clearRun = vi.fn(async (_args: unknown): Promise<unknown> => null);

beforeAll(() => {
	vi.stubGlobal('usePostboxReplyQueue', () => ({
		items: computed(() => queueItems.value),
		count: computed(() => queueItems.value.length),
		isLoading: ref(false),
	}));
	// Real implementation — the optimistic hide/restore is what's under test.
	vi.stubGlobal('usePostboxOptimisticHide', usePostboxOptimisticHide);
	vi.stubGlobal('useFeatureFlag', () => ({ isEnabled: () => false }));
	vi.stubGlobal('usePostboxComposerStack', () => ({ open: vi.fn() }));
	vi.stubGlobal('useBackendOperation', (_op: unknown, opts: { label: string }) => ({
		run: opts.label === 'Mark done' ? clearRun : vi.fn(async () => null),
		isLoading: ref(false),
	}));
	vi.stubGlobal('usePostboxListKeyboard', () => ({
		focusedIndex: ref(-1),
		activeId: ref(undefined),
		onKeydown: vi.fn(),
	}));
	vi.stubGlobal('resolvePostboxShortcut', () => null);
	vi.stubGlobal('navigateTo', vi.fn());
	vi.stubGlobal('requireConvex', () => ({ query: vi.fn(async () => null) }));
	vi.stubGlobal('buildQuotedReply', () => '');
});

beforeEach(() => {
	queueItems.value = [];
	clearRun.mockClear();
	clearRun.mockImplementation(async () => null);
});

const iconStub = { props: ['name'], template: '<span />' };
const avatarStub = { template: '<span />' };
const snoozeDialogStub = { template: '<span />' };

function mountQueue() {
	return mount(PostboxReplyQueue, {
		props: { mailboxId: 'mbx-1' as never },
		global: {
			components: { PostboxEmptyState },
			stubs: {
				Icon: iconStub,
				UiAvatar: avatarStub,
				PostboxSnoozeDialog: snoozeDialogStub,
			},
		},
	});
}

describe('PostboxReplyQueue', () => {
	it('headlines the AI askSummary when present', () => {
		queueItems.value = [makeItem(1, { askSummary: 'Wants a decision on the venue' })];
		const wrapper = mountQueue();
		expect(wrapper.text()).toContain('Wants a decision on the venue');
	});

	it('falls back to the subject when there is no askSummary', () => {
		queueItems.value = [makeItem(2)];
		const wrapper = mountQueue();
		expect(wrapper.text()).toContain('Subject 2');
	});

	it('Done triggers the clear mutation and hides the row optimistically', async () => {
		queueItems.value = [makeItem(1), makeItem(2)];
		const wrapper = mountQueue();
		expect(wrapper.findAll('[role="option"]')).toHaveLength(2);

		// Hold the mutation unresolved — the row must disappear BEFORE it settles.
		let settle: (v: unknown) => void = () => {};
		clearRun.mockImplementation(
			() =>
				new Promise((resolvePromise) => {
					settle = resolvePromise;
				})
		);

		await wrapper.findAll('[data-testid="reply-queue-done"]')[0]!.trigger('click');
		expect(clearRun).toHaveBeenCalledWith({ threadId: 'thread-1' });
		expect(wrapper.findAll('[role="option"]')).toHaveLength(1);
		expect(wrapper.text()).not.toContain('Subject 1');

		settle(null);
		await flushPromises();
		expect(wrapper.findAll('[role="option"]')).toHaveLength(1);
	});

	it('restores the row when the clear mutation fails', async () => {
		queueItems.value = [makeItem(1)];
		// useBackendOperation signals failure by resolving undefined.
		clearRun.mockImplementation(async () => undefined);
		const wrapper = mountQueue();

		await wrapper.find('[data-testid="reply-queue-done"]').trigger('click');
		await flushPromises();
		expect(wrapper.findAll('[role="option"]')).toHaveLength(1);
	});

	it('renders the quiet "All caught up" moment when the queue is empty', () => {
		queueItems.value = [];
		const wrapper = mountQueue();
		const empty = wrapper.findComponent(PostboxEmptyState);
		expect(empty.exists()).toBe(true);
		expect(empty.text()).toContain('All caught up');
	});
});
