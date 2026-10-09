// @vitest-environment happy-dom
/**
 * The shared-mailbox reader's team stream (usePostboxTeamStream): the walk
 * back to the reader's oldest message is bounded per walk, and where it stops
 * short the reader says so and offers the rest (never a silent cut); the
 * viewer's discussion @mentions are cleared once the stream is seen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

const entries = ref<unknown[]>([]);
const hasEarlier = ref(true);
const isLoadingEarlier = ref(false);
const loadEarlier = vi.fn();
const markSeen = vi.fn();
const markRead = vi.fn(async () => ({ ok: true }));

vi.mock('@owlat/api', () => ({ api: { chat: { mailDiscussion: { markRead: 'markRead' } } } }));
vi.mock('~/composables/team/useTeamThread', () => ({
	useTeamThread: () => ({
		stream: { entries, hasEarlier, isLoadingEarlier, loadEarlier, markSeen },
	}),
}));

import { usePostboxTeamStream } from '../usePostboxTeamStream';

const note = (at: number, source: 'chatMessage' | 'threadNote' = 'chatMessage') => ({
	kind: 'note',
	key: `note:${at}`,
	at,
	tie: at,
	noteSource: source,
});

function host(messages: { _id: string; receivedAt: number }[]) {
	let state!: ReturnType<typeof usePostboxTeamStream>;
	mount(
		defineComponent({
			setup() {
				state = usePostboxTeamStream({
					isShared: () => true,
					threadId: () => 'mt_1',
					messages: () => messages,
					reply: () => {},
				});
				return () => h('div');
			},
		}),
		{ global: { plugins: [createTestI18n()] } }
	);
	return () => state;
}

enableAutoUnmount(afterEach);
beforeEach(() => {
	entries.value = [];
	isLoadingEarlier.value = false;
	hasEarlier.value = true;
	loadEarlier.mockReset();
	markSeen.mockReset();
	markRead.mockClear();
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		useFeatureFlag: () => ({ isEnabled: () => true }),
		useState: (_key: string, init: () => unknown) => ref(init()),
		useBackendOperation: () => ({ run: markRead, isLoading: ref(false) }),
	});
});

describe('usePostboxTeamStream', () => {
	it('walks back a bounded number of pages, then says the rest is not loaded and offers it', async () => {
		entries.value = [note(500)];
		// Each page loads, but brings nothing older: the walk stays behind the oldest message.
		loadEarlier.mockImplementation(() => {
			isLoadingEarlier.value = true;
		});
		const state = host([{ _id: 'm1', receivedAt: 100 }]);
		for (let i = 0; i < 15; i++) {
			await nextTick();
			isLoadingEarlier.value = false;
			await nextTick();
		}
		expect(loadEarlier.mock.calls.length).toBeLessThanOrEqual(10);
		expect(state().earlier.value).toBe('cut');
		state().loadEarlier();
		await nextTick();
		expect(state().earlier.value).not.toBe('cut');
	});

	it('offers older entries before the first message shown when it is caught up', async () => {
		entries.value = [note(50)];
		const state = host([{ _id: 'm1', receivedAt: 100 }]);
		await nextTick();
		expect(state().earlier.value).toBe('more');
		hasEarlier.value = false;
		await nextTick();
		expect(state().earlier.value).toBe('none');
	});

	it('clears the discussion mentions once, when discussion notes are seen', async () => {
		host([{ _id: 'm1', receivedAt: 100 }]);
		entries.value = [note(200)];
		await nextTick();
		entries.value = [note(200), note(300)];
		await nextTick();
		expect(markSeen).toHaveBeenCalled();
		expect(markRead).toHaveBeenCalledTimes(1);
		expect(markRead).toHaveBeenCalledWith({ threadId: 'mt_1' });
	});
});
