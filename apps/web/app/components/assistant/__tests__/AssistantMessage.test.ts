// @vitest-environment happy-dom
/**
 * An assistant answer that stopped at its output ceiling finishes with status
 * `error` and keeps its text (ledger lane). It reads as the answer with a
 * quiet note in the reader's language, not as a failure in the server's
 * English; a real failure still reads as one.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { ASSISTANT_CUT_OFF_MESSAGE } from '@owlat/shared/aiRouting';
import AssistantMessage, { type AssistantMessageData } from '../AssistantMessage.vue';
import BudgetRefusal from '../../ai/BudgetRefusal.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

const mdStub = { props: ['source'], template: '<div class="md">{{ source }}</div>' };

function mountMessage(over: Partial<AssistantMessageData>) {
	const message: AssistantMessageData = {
		_id: 'am1',
		role: 'assistant',
		text: 'Here are the three open invoices: first',
		status: 'complete',
		toolCalls: [],
		errorMessage: null,
		createdAt: 1,
		...over,
	};
	return mount(AssistantMessage, {
		props: { message },
		global: {
			plugins: [createTestI18n()],
			stubs: { Icon: true, AssistantMarkdown: mdStub, AssistantToolCalls: true },
			components: { AiBudgetRefusal: BudgetRefusal },
		},
	});
}

describe('AssistantMessage', () => {
	it('keeps a cut-off answer and notes it from the catalog, not the server’s sentence', () => {
		const w = mountMessage({ status: 'error', errorMessage: ASSISTANT_CUT_OFF_MESSAGE });
		expect(w.find('.md').text()).toContain('three open invoices');
		const note = w.get('[data-testid="assistant-message-cut-off"]');
		expect(note.text()).toBe('This answer was cut off at its length limit.');
		expect(note.classes()).not.toContain('text-error');
		expect(w.text()).not.toContain(ASSISTANT_CUT_OFF_MESSAGE);
	});

	it('still reads a real failure as one', () => {
		const w = mountMessage({ status: 'error', errorMessage: 'Provider unavailable' });
		expect(w.find('[data-testid="assistant-message-cut-off"]').exists()).toBe(false);
		expect(w.get('.text-error').text()).toBe('Provider unavailable');
	});

	it('says a budget refusal in the reader’s language, from its stored code and reason', () => {
		const w = mountMessage({
			text: '',
			status: 'error',
			budgetRefusal: { code: 'AI_BUDGET_EXHAUSTED', reason: 'daily_ceiling' },
		});
		const notice = w.get('[data-testid="ai-budget-refusal"]');
		expect(notice.attributes('data-reason')).toBe('daily_ceiling');
		expect(notice.text()).toBe(
			'AI budget reached. The AI spend budget for today is used up. AI actions are back tomorrow.'
		);
		expect(w.text()).not.toContain('AI_BUDGET_EXHAUSTED');
	});

	it('reads an unknown refusal payload as the generic failure', () => {
		const w = mountMessage({
			text: '',
			status: 'error',
			budgetRefusal: { code: 'SOMETHING_ELSE', reason: 'daily_ceiling' },
		});
		expect(w.find('[data-testid="ai-budget-refusal"]').exists()).toBe(false);
		expect(w.get('.text-error').text()).toBe('The assistant could not complete this reply.');
	});
});
