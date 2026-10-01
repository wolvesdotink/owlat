// @vitest-environment happy-dom
/**
 * "N things before I write this" (plan §05):
 *   - the header counts the questions and names the round;
 *   - one input per kind: chips with "Something else...", free text, a number,
 *     a date (chips plus a picker), a file (FileAsk);
 *   - a remembered answer is pre-picked with its "last time" tag and, left as
 *     it was, is not sent again;
 *   - keys 1 to 9 pick a chip on the first open question with chips;
 *   - "Answer and draft" sends what was answered; "Skip, draft with gaps" sends
 *     the same, as a skip; a file answer goes out as a file.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';

import AskCard from '../AskCard.vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';

vi.mock('~/composables/useAnswerFileUpload', () => ({
	useAnswerFileUpload: () => ({ upload: vi.fn(), uploading: ref(false), progress: ref(0) }),
}));

beforeAll(() => {
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		useToast: () => ({ showToast: vi.fn() }),
	});
});

const why = 'Generated from an email from example.org';
const QUESTIONS = [
	{
		id: 'file_request',
		slotType: 'attachment',
		answerKind: 'file' as const,
		text: 'They asked for the September invoice. I could not find it.',
		attribution: why,
		options: ["It isn't ready yet"],
		fileCandidates: [
			{
				source: 'semanticFile' as const,
				id: 'sf_1',
				filename: 'invoice-2026-08.pdf',
				mimeType: 'application/pdf',
				size: 1000,
				score: 0.4,
				note: 'August',
			},
		],
	},
	{
		id: 'po',
		slotType: 'decision',
		answerKind: 'choice' as const,
		text: 'Is PO BP-2231 already printed on the invoice?',
		attribution: why,
		options: ["Yes, it's on it", 'No, mention it in the email'],
		answer: { value: "Yes, it's on it", at: 0, source: 'memory' as const },
	},
	{
		id: 'when',
		slotType: 'date_time',
		answerKind: 'date' as const,
		text: 'When can you send it?',
		attribution: why,
		options: ['Tomorrow', 'Friday'],
	},
	{
		id: 'amount',
		slotType: 'price_number',
		answerKind: 'number' as const,
		text: 'What is the total?',
		attribution: why,
	},
	{
		id: 'note',
		slotType: 'free_text',
		answerKind: 'text' as const,
		text: 'Anything else?',
		attribution: why,
	},
];

const PickerStub = defineComponent({ name: 'AnswerFilePicker', setup: () => () => h('div') });

function mountCard(props: Record<string, unknown> = {}) {
	return mount(AskCard, {
		props: { questions: QUESTIONS, round: 1, ...props },
		attachTo: document.body,
		global: { plugins: [createTestI18n()], stubs: { AnswerFilePicker: PickerStub } },
	});
}

describe('AskCard', () => {
	it('counts the questions, names the round, and renders an input per kind', () => {
		const w = mountCard();
		expect(w.get('h2').text()).toBe('5 things before I write this');
		expect(w.get('[data-testid="ask-round"]').text()).toBe('round 1 of 2');
		expect(w.findAll('[data-testid="file-ask"]')).toHaveLength(1);
		expect(w.findAll('[data-testid="ask-date"]')).toHaveLength(1);
		const placeholders = w
			.findAll('[data-testid="ask-input"]')
			.map((i) => i.attributes('placeholder'));
		expect(placeholders).toEqual([
			'Something else…',
			'Or type a date…',
			'A number or an amount…',
			'Type your answer…',
		]);
		// The attribution line under every question.
		expect(w.findAll('[data-testid="task-ask-why"]')).toHaveLength(5);
		expectFullyLocalized(w);
		w.unmount();
	});

	it('pre-picks the remembered answer and does not send it back untouched', async () => {
		const w = mountCard();
		expect(w.find('[data-testid="task-option-remembered"]').exists()).toBe(true);
		await w.get('[data-testid="ask-submit"]').trigger('click');
		expect(w.emitted('answer')?.[0]).toEqual([[]]);
		w.unmount();
	});

	it('picks a chip of the first open question with keys 1 to 9', async () => {
		const w = mountCard();
		window.dispatchEvent(new KeyboardEvent('keydown', { key: '2' }));
		await flushPromises();
		await w.get('[data-testid="ask-submit"]').trigger('click');
		expect(w.emitted('answer')?.[0]?.[0]).toEqual([{ questionId: 'when', value: 'Friday' }]);
		w.unmount();
	});

	it('leaves 1 to 9 alone while the reply sheet hiding it is folded away (phone)', async () => {
		const sheet = document.createElement('div');
		sheet.setAttribute('data-sheet-hidden', '');
		document.body.appendChild(sheet);
		const w = mount(AskCard, {
			props: { questions: QUESTIONS, round: 1 },
			attachTo: sheet,
			global: { plugins: [createTestI18n()], stubs: { AnswerFilePicker: PickerStub } },
		});
		const event = new KeyboardEvent('keydown', { key: '2', cancelable: true });
		window.dispatchEvent(event);
		await flushPromises();
		expect(event.defaultPrevented).toBe(false);
		await w.get('[data-testid="ask-submit"]').trigger('click');
		expect(w.emitted('answer')?.[0]?.[0]).toEqual([]);
		w.unmount();
		sheet.remove();
	});

	it('takes a date from the picker, text and numbers as typed, and a file as a file', async () => {
		const w = mountCard();
		await w.get('[data-testid="ask-date"]').setValue('2026-10-02');
		await w.get('[data-testid="ask-date"]').trigger('change');
		const inputs = w.findAll('[data-testid="ask-input"]');
		await inputs[2]!.setValue('4,200 EUR');
		await inputs[3]!.setValue('Thanks for the reminder');
		await w.get('[data-testid="file-ask-candidate"]').trigger('click');
		await w.get('[data-testid="ask-submit"]').trigger('click');
		expect(w.emitted('answer')?.[0]?.[0]).toEqual([
			{
				questionId: 'file_request',
				file: { source: 'semanticFile', id: 'sf_1', filename: 'invoice-2026-08.pdf' },
				keepCopy: true,
			},
			{ questionId: 'when', value: '2026-10-02' },
			{ questionId: 'amount', value: '4,200 EUR' },
			{ questionId: 'note', value: 'Thanks for the reminder' },
		]);
		w.unmount();
	});

	it('sends "It isn\'t ready yet" as a value', async () => {
		const w = mountCard();
		await w.get('[data-testid="file-ask-option"]').trigger('click');
		await w.get('[data-testid="ask-submit"]').trigger('click');
		expect(w.emitted('answer')?.[0]?.[0]).toEqual([
			{ questionId: 'file_request', value: "It isn't ready yet" },
		]);
		w.unmount();
	});

	it('skips with what was answered so far', async () => {
		const w = mountCard();
		await w.findAll('[data-testid="ask-input"]')[3]!.setValue('Keep it short');
		await w.get('[data-testid="ask-skip"]').trigger('click');
		expect(w.emitted('skip')?.[0]?.[0]).toEqual([{ questionId: 'note', value: 'Keep it short' }]);
		expect(w.emitted('answer')).toBeUndefined();
		w.unmount();
	});

	it('holds still while submitting', async () => {
		const w = mountCard({ submitting: true });
		expect(w.get('[data-testid="ask-submit"]').attributes('disabled')).toBeDefined();
		await w.get('[data-testid="ask-skip"]').trigger('click');
		expect(w.emitted('skip')).toBeUndefined();
		w.unmount();
	});

	it('as a background clarification: no round, "Answer later", and every question required', async () => {
		const w = mountCard({
			questions: QUESTIONS.slice(2),
			round: undefined,
			requireAll: true,
			skipLabel: 'Answer later',
		});
		expect(w.find('[data-testid="ask-round"]').exists()).toBe(false);
		expect(w.get('[data-testid="ask-skip"]').text()).toBe('Answer later');
		const submit = w.get('[data-testid="ask-submit"]');
		await w.findAll('[data-testid="ask-input"]')[2]!.setValue('Nothing else');
		expect(submit.attributes('disabled')).toBeDefined();
		w.unmount();
	});
});
