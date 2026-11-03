/**
 * The find bar presents its controller: "3 of 7", searching, no matches;
 * Enter and Shift+Enter step; what the count does not cover yet is said
 * beside it, with "Search earlier messages" and a retry.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, nextTick, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import type { PostboxThreadFind } from '~/composables/postbox/usePostboxThreadFind';
import PostboxThreadFindBar from '../PostboxThreadFindBar.vue';

beforeEach(() => {
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
});

function controller(over: Partial<Record<string, unknown>> = {}) {
	const state = {
		isOpen: ref(true),
		query: ref('refund'),
		focusRequest: ref(0),
		activeIndex: ref(2),
		total: ref(7),
		coverage: ref({ pending: 0, failed: 0, unsearchable: 0 }),
		hasEarlier: ref(false),
		loadingEarlier: ref(false),
		earlierFailed: ref(false),
		open: vi.fn(),
		close: vi.fn(),
		next: vi.fn(),
		previous: vi.fn(),
		retry: vi.fn(),
		searchEarlier: vi.fn(),
		findOf: () => null,
		matchCountOf: () => 0,
		...over,
	};
	return {
		...state,
		hasQuery: computed(() => state.query.value.trim() !== ''),
	} as unknown as PostboxThreadFind & typeof state;
}

function mountBar(find: ReturnType<typeof controller>) {
	return mount(PostboxThreadFindBar, {
		props: { find },
		attachTo: document.body,
		global: { plugins: [createTestI18n()] },
	});
}

const count = (w: ReturnType<typeof mountBar>) => w.get('[data-testid="thread-find-count"]').text();

describe('PostboxThreadFindBar', () => {
	it('renders nothing while find is closed', () => {
		const w = mountBar(controller({ isOpen: ref(false) }));
		expect(w.find('[data-testid="thread-find-bar"]').exists()).toBe(false);
	});

	it('says where the active match is, and when nothing matches', async () => {
		const find = controller();
		const w = mountBar(find);
		expect(w.get('[role="search"]').attributes('aria-label')).toBe('Find in conversation');
		expect(count(w)).toBe('3 of 7');
		find.total.value = 0;
		find.activeIndex.value = -1;
		await nextTick();
		expect(count(w)).toBe('No matches');
		find.coverage.value = { pending: 2, failed: 0, unsearchable: 0 };
		await nextTick();
		expect(count(w)).toBe('Searching…');
		expect(w.get<HTMLButtonElement>('[data-testid="thread-find-next"]').element.disabled).toBe(
			true
		);
	});

	it('steps with Enter and Shift+Enter, and with the buttons', async () => {
		const find = controller();
		const w = mountBar(find);
		const input = w.get('[data-testid="thread-find-input"]');
		await input.trigger('keydown', { key: 'Enter' });
		await input.trigger('keydown', { key: 'Enter', shiftKey: true });
		await input.trigger('keydown', { key: 'Enter', isComposing: true });
		expect(find.next).toHaveBeenCalledTimes(1);
		expect(find.previous).toHaveBeenCalledTimes(1);
		await w.get('[data-testid="thread-find-previous"]').trigger('click');
		await w.get('[data-testid="thread-find-next"]').trigger('click');
		await w.get('[data-testid="thread-find-close"]').trigger('click');
		expect(find.previous).toHaveBeenCalledTimes(2);
		expect(find.next).toHaveBeenCalledTimes(2);
		expect(find.close).toHaveBeenCalledTimes(1);
	});

	it('types into the controller and takes focus when asked', async () => {
		const find = controller();
		const w = mountBar(find);
		const input = w.get<HTMLInputElement>('[data-testid="thread-find-input"]');
		await input.setValue('invoice');
		expect(find.query.value).toBe('invoice');
		find.focusRequest.value++;
		await nextTick();
		await nextTick();
		expect(document.activeElement).toBe(input.element);
	});

	it('says what the count does not cover, and offers the earlier messages', async () => {
		const find = controller({
			coverage: ref({ pending: 3, failed: 2, unsearchable: 1 }),
			hasEarlier: ref(true),
		});
		const w = mountBar(find);
		const coverage = w.get('[data-testid="thread-find-coverage"]').text();
		expect(coverage).toContain('Still reading 3 messages…');
		expect(coverage).toContain('2 messages could not be searched.');
		expect(coverage).toContain('1 encrypted or signed message is not searched.');
		expect(coverage).toContain('Only the loaded part of the conversation is searched.');
		await w.get('[data-testid="thread-find-retry"]').trigger('click');
		await w.get('[data-testid="thread-find-earlier"]').trigger('click');
		expect(find.retry).toHaveBeenCalledTimes(1);
		expect(find.searchEarlier).toHaveBeenCalledTimes(1);
		find.hasEarlier.value = false;
		find.earlierFailed.value = true;
		await nextTick();
		expect(w.get('[data-testid="thread-find-coverage"]').text()).toContain(
			'Earlier messages could not be loaded.'
		);
	});

	it('stays quiet about coverage when there is nothing left to say', () => {
		const w = mountBar(controller());
		expect(w.find('[data-testid="thread-find-coverage"]').exists()).toBe(false);
	});
});
