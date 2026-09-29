// @vitest-environment happy-dom
/**
 * ClarificationQuestions — the question list both clarification surfaces share.
 *
 * Covers the rules it owns:
 *   - `requireAll` gates submit both ways: every question (team inbox) or any
 *     one (Postbox, which then sends only the answered questions);
 *   - a remembered value starts selected and, submitted untouched, goes back
 *     with `source: 'memory'`; a changed value goes back as `user`;
 *   - a chip picked in the reader's language is submitted as the canonical
 *     option.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { reactive } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import type { ClarificationQuestionInput } from '~/utils/clarificationAnswers';

import ClarificationQuestions from '../ClarificationQuestions.vue';

beforeAll(() => {
	vi.stubGlobal('reactive', reactive);
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

const plan: ClarificationQuestionInput = {
	id: 'plan',
	text: 'Which plan?',
	options: ['Starter', 'Pro'],
};
const date: ClarificationQuestionInput = { id: 'date', text: 'Which date?' };

function mountList(props: {
	questions: ClarificationQuestionInput[];
	requireAll: boolean;
	numbered?: boolean;
}) {
	return mount(ClarificationQuestions, {
		props,
		slots: {
			actions: `<template #actions="{ canSubmit, submit, remaining }">
				<button data-testid="go" :disabled="!canSubmit" @click="submit">go</button>
				<span data-testid="remaining">{{ remaining }}</span>
			</template>`,
		},
		global: { plugins: [createTestI18n()], stubs: { Icon: true } },
	});
}

const chips = (w: ReturnType<typeof mountList>) => w.findAll('[data-testid="clarification-chip"]');
const inputs = (w: ReturnType<typeof mountList>) =>
	w.findAll('[data-testid="clarification-input"]');
const submitted = (w: ReturnType<typeof mountList>) => w.emitted('submit')?.[0]?.[0];

describe('ClarificationQuestions', () => {
	it('requireAll: stays closed until every question is answered', async () => {
		const wrapper = mountList({ questions: [plan, date], requireAll: true });
		const go = wrapper.get('[data-testid="go"]');
		expect(go.attributes('disabled')).toBeDefined();
		expect(wrapper.get('[data-testid="remaining"]').text()).toBe('2');

		await chips(wrapper)[1]!.trigger('click');
		expect(go.attributes('disabled')).toBeDefined();
		await go.trigger('click');
		expect(wrapper.emitted('submit')).toBeFalsy();

		await inputs(wrapper)[1]!.setValue('  1 March  ');
		expect(go.attributes('disabled')).toBeUndefined();
		await go.trigger('click');
		expect(submitted(wrapper)).toEqual([
			{ questionId: 'plan', value: 'Pro', source: 'user' },
			{ questionId: 'date', value: '1 March', source: 'user' },
		]);
	});

	it('without requireAll: one answer opens submit and only answered questions are sent', async () => {
		const wrapper = mountList({ questions: [plan, date], requireAll: false });
		const go = wrapper.get('[data-testid="go"]');
		expect(go.attributes('disabled')).toBeDefined();
		await inputs(wrapper)[1]!.setValue('Friday');
		expect(go.attributes('disabled')).toBeUndefined();
		await go.trigger('click');
		expect(submitted(wrapper)).toEqual([{ questionId: 'date', value: 'Friday', source: 'user' }]);
	});

	it('Enter in a free-text box obeys the same gate', async () => {
		const wrapper = mountList({ questions: [plan, date], requireAll: true });
		await inputs(wrapper)[1]!.setValue('Friday');
		await inputs(wrapper)[1]!.trigger('keydown', { key: 'Enter' });
		expect(wrapper.emitted('submit')).toBeFalsy();
	});

	it('a remembered answer starts selected and goes back untouched as memory', async () => {
		const remembered: ClarificationQuestionInput = {
			...plan,
			answer: { value: 'Pro', source: 'memory' },
		};
		const wrapper = mountList({ questions: [remembered], requireAll: true });
		const pro = chips(wrapper)[1]!;
		expect(pro.attributes('aria-pressed')).toBe('true');
		expect(pro.find('[data-testid="task-option-remembered"]').exists()).toBe(true);
		await wrapper.get('[data-testid="go"]').trigger('click');
		expect(submitted(wrapper)).toEqual([{ questionId: 'plan', value: 'Pro', source: 'memory' }]);
	});

	it('a changed remembered answer goes back as the person’s own', async () => {
		const remembered: ClarificationQuestionInput = {
			...plan,
			answer: { value: 'Pro', source: 'memory' },
		};
		const wrapper = mountList({ questions: [remembered], requireAll: true });
		await chips(wrapper)[0]!.trigger('click');
		await wrapper.get('[data-testid="go"]').trigger('click');
		expect(submitted(wrapper)).toEqual([{ questionId: 'plan', value: 'Starter', source: 'user' }]);
	});

	it('an answer the person typed is never pre-filled and never memory', async () => {
		const typed: ClarificationQuestionInput = {
			...plan,
			answer: { value: 'Pro', source: 'user' },
		};
		const wrapper = mountList({ questions: [typed], requireAll: true });
		expect(chips(wrapper).every((c) => c.attributes('aria-pressed') === 'false')).toBe(true);
		await chips(wrapper)[1]!.trigger('click');
		await wrapper.get('[data-testid="go"]').trigger('click');
		expect(submitted(wrapper)).toEqual([{ questionId: 'plan', value: 'Pro', source: 'user' }]);
	});

	it('shows chips in the reader’s language and submits the canonical option', async () => {
		const localized: ClarificationQuestionInput = {
			id: 'plan',
			text: 'Welcher Tarif?',
			options: ['Starter', 'Pro'],
			translations: [{ locale: 'en', text: 'Which plan?', options: ['Basic plan', 'Pro plan'] }],
			answer: { value: 'Pro', source: 'memory' },
		};
		const wrapper = mountList({ questions: [localized], requireAll: true });
		expect(wrapper.text()).toContain('Which plan?');
		expect(chips(wrapper).map((c) => c.text())).toEqual([
			expect.stringContaining('Basic plan'),
			expect.stringContaining('Pro plan'),
		]);
		// The remembered canonical value is shown as its localized chip.
		expect(chips(wrapper)[1]!.attributes('aria-pressed')).toBe('true');
		await wrapper.get('[data-testid="go"]').trigger('click');
		expect(submitted(wrapper)).toEqual([{ questionId: 'plan', value: 'Pro', source: 'memory' }]);

		const other = mountList({ questions: [localized], requireAll: true });
		await chips(other)[0]!.trigger('click');
		await other.get('[data-testid="go"]').trigger('click');
		expect(submitted(other)).toEqual([{ questionId: 'plan', value: 'Starter', source: 'user' }]);
	});

	it('numbered: counts the questions', () => {
		const wrapper = mountList({ questions: [plan, date], requireAll: true, numbered: true });
		expect(wrapper.text()).toContain('Question 1 of 2');
		expect(wrapper.text()).toContain('Question 2 of 2');
	});
});
