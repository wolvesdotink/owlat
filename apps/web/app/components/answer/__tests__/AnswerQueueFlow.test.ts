// @vitest-environment happy-dom
/**
 * The Answer queue page's body: an empty queue is good news ("Nothing needs an
 * answer"), but a queue that is empty because a source failed to load is not
 * (#721). It shows the error and a Try again that re-reads the failed sources.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { computed, ref } from 'vue';

import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

const queueError = ref<Error | null>(null);
const refetch = vi.fn();

const session = {
	queue: { isLoading: ref(false), error: queueError, refetch },
	flow: {
		active: ref(false),
		current: ref(null),
		isComplete: ref(false),
		remainingSeconds: ref(0),
		nextItem: ref(null),
	},
	filter: ref('all'),
	source: computed(() => []),
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

beforeEach(() => {
	queueError.value = null;
	refetch.mockClear();
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
});

function render() {
	return mount(AnswerQueueFlow, {
		global: {
			plugins: [createTestI18n()],
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
		queueError.value = new Error('[CONVEX Q(mail/needsReply:listQueue)] Server Error');
		const wrapper = render();

		expect(wrapper.text()).not.toContain('Nothing needs an answer');
		expect(wrapper.text()).toContain('Failed to load');
		const retry = wrapper.findAll('button').find((button) => button.text() === 'Try again');
		await retry!.trigger('click');
		expect(refetch).toHaveBeenCalledTimes(1);
	});
});
