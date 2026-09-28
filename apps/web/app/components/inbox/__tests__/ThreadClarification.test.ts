// @vitest-environment happy-dom
/**
 * "The agent needs your input" on a team-inbox message. Every question is
 * required before the draft resumes, and a question answer-memory filled goes
 * back with its source, so confirming it untouched does not capture the same
 * fact again as the person's own.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { reactive } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import type { ClarificationQuestionInput } from '~/utils/clarificationAnswers';

import ThreadClarification from '../ThreadClarification.vue';

beforeAll(() => {
	vi.stubGlobal('reactive', reactive);
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

const questions: ClarificationQuestionInput[] = [
	{
		id: 'order',
		text: 'Which order is this about?',
		options: ['#1001', '#1002'],
		answer: { value: '#1002', source: 'memory' },
	},
	{ id: 'refund', text: 'Refund or replace?', options: ['Refund', 'Replace'] },
];

function mountCard(props: Record<string, unknown> = {}) {
	return mount(ThreadClarification, {
		props: { questions, ...props },
		global: {
			plugins: [createTestI18n()],
			stubs: {
				Icon: true,
				UiButton: {
					props: ['disabled', 'loading'],
					emits: ['click'],
					template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
				},
			},
		},
	});
}

const submit = (w: ReturnType<typeof mountCard>) =>
	w.get('[data-testid="thread-clarification-submit"]');

describe('InboxThreadClarification', () => {
	it('counts the remembered answer and waits for the rest', () => {
		const wrapper = mountCard();
		expect(wrapper.get('[data-testid="thread-clarification-progress"]').text()).toContain(
			'1 of 2 answered'
		);
		expect(wrapper.findAll('[data-testid="thread-clarification-question"]')).toHaveLength(2);
		expect(wrapper.text()).toContain('Question 1 of 2');
		expect(submit(wrapper).attributes('disabled')).toBeDefined();
		expect(wrapper.get('[data-testid="thread-clarification-remaining"]').text()).toContain(
			'Answer 1 more'
		);
	});

	it('sends the untouched remembered answer back as memory', async () => {
		const wrapper = mountCard();
		const chips = wrapper.findAll('[data-testid="thread-clarification-chip"]');
		await chips[2]!.trigger('click');
		expect(wrapper.find('[data-testid="thread-clarification-remaining"]').exists()).toBe(false);
		await submit(wrapper).trigger('click');
		expect(wrapper.emitted('submit')![0]![0]).toEqual([
			{ questionId: 'order', value: '#1002', source: 'memory' },
			{ questionId: 'refund', value: 'Refund', source: 'user' },
		]);
	});

	it('names the reply language when the classifier found one', () => {
		const wrapper = mountCard({ language: 'de' });
		expect(wrapper.text()).toContain('The reply will be written in German.');
	});
});
