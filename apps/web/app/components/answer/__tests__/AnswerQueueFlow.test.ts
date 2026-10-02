// @vitest-environment happy-dom
/**
 * The Answer queue page's body: an empty queue is good news ("Nothing needs an
 * answer"), but a queue that is empty because a source failed to load is not
 * (#721). It shows the error and a Try again that re-reads the failed sources.
 * A queue with rows and a failed source names what is missing (#1099).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { ref } from 'vue';

import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import type { AnswerQueueFailure } from '~/composables/useAnswerQueue';

const failures = ref<AnswerQueueFailure[]>([]);
const refetch = vi.fn();
const source = ref<unknown[]>([]);
const failure = new Error('[CONVEX Q(mail/needsReply:listQueue)] Server Error');
const sales = { mailboxId: 'mbx_sales', name: 'Sales', slot: 1 } as AnswerQueueFailure['inbox'];

const session = {
	queue: { isLoading: ref(false), failures, refetch },
	flow: {
		active: ref(false),
		current: ref(null),
		isComplete: ref(false),
		remainingSeconds: ref(0),
		nextItem: ref(null),
		position: ref(1),
		total: ref(1),
		newCount: ref(0),
		currentId: ref(null),
		canUndo: ref(false),
		canGoBack: ref(false),
		canGoNext: ref(false),
	},
	filter: ref('all'),
	source,
	setFilter: vi.fn(),
};

vi.mock('~/composables/useAnswerQueueSession', () => ({
	useAnswerQueueSession: () => session,
	createAnswerQueueSession: () => session,
}));
vi.mock('~/composables/useAnswerQueueChips', () => ({
	useAnswerQueueChips: () => ({
		chips: ref([]),
		showChips: ref(false),
		activeChipLabel: ref(null),
	}),
}));

import AnswerQueueFlow from '../AnswerQueueFlow.vue';
import InboxReadFailureNotice from '~/components/inbox/InboxReadFailureNotice.vue';

beforeEach(() => {
	failures.value = [];
	source.value = [];
	session.filter.value = 'all';
	refetch.mockClear();
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
});

function render() {
	return mount(AnswerQueueFlow, {
		global: {
			plugins: [createTestI18n()],
			components: { InboxReadFailureNotice },
			stubs: {
				AgentTaskFlow: true,
				AnswerIdentityBand: true,
				AnswerMailCard: true,
				AnswerMentionCard: true,
				AnswerTeamCard: true,
				InboxChip: true,
				UiIconBox: true,
				UiSkeleton: true,
			},
		},
	});
}

describe('AnswerQueueFlow read states', () => {
	it('says all clear when nothing waits', () => {
		const wrapper = render();
		expect(wrapper.text()).toContain('Nothing needs an answer');
		expect(wrapper.text()).not.toContain('Failed to load');
	});

	it('shows a failed read with Try again instead of all clear (#721)', async () => {
		failures.value = [{ id: 'mbx_sales', inbox: sales, error: failure }];
		const wrapper = render();

		expect(wrapper.text()).not.toContain('Nothing needs an answer');
		expect(wrapper.text()).toContain('Failed to load');
		expect(wrapper.find('[data-testid="inbox-read-failure-notice"]').exists()).toBe(false);
		const retry = wrapper.findAll('button').find((button) => button.text() === 'Try again');
		await retry!.trigger('click');
		expect(refetch).toHaveBeenCalledTimes(1);
	});

	it('keeps the loaded rows and names the inboxes that failed (#1099)', async () => {
		source.value = [{ id: 'mail:thr_a' }];
		failures.value = [
			{ id: 'mbx_sales', inbox: sales, error: failure },
			{ id: 'team', inbox: null, error: failure },
		];
		const wrapper = render();

		expect(wrapper.text()).not.toContain('Failed to load');
		const notice = wrapper.find('[data-testid="inbox-read-failure-notice"]');
		expect(notice.text()).toContain("Couldn't load Sales and Team inbox");
		await notice.find('button').trigger('click');
		expect(refetch).toHaveBeenCalledTimes(1);
	});

	it('leaves a failure in another inbox out of a filtered queue', () => {
		session.filter.value = 'mbx_support';
		failures.value = [{ id: 'mbx_sales', inbox: sales, error: failure }];
		const wrapper = render();

		expect(wrapper.text()).not.toContain('Failed to load');
		expect(wrapper.find('[data-testid="inbox-read-failure-notice"]').exists()).toBe(false);
	});
});
