// @vitest-environment happy-dom
/**
 * The Reply Queue's clarification of an Answer queue item, above the editor:
 *  - it shows as the ask card while it asks, answered through the Reply
 *    Queue's mutation (a kept remembered answer goes back as `memory`);
 *  - "Answer later" puts it away;
 *  - the starter reply that lands while the page is open goes to the editor,
 *    once; a reply drafted before the page opened is left to the prepared draft.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { computed, ref } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import AnswerQueueMailAsk from '../AnswerQueueMailAsk.vue';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});
vi.mock('~/composables/useAnswerFileUpload', () => ({
	useAnswerFileUpload: () => ({ upload: vi.fn(), uploading: ref(false), progress: ref(0) }),
}));

const clarification = ref<Record<string, unknown>>({});
const current = computed(() => ({
	id: 'mail:thr_1',
	source: 'mail',
	row: {
		kind: 'needs_reply',
		threadId: 'thr_1',
		messageId: 'msg_1',
		clarification: clarification.value,
	},
}));
vi.mock('~/composables/useAnswerQueueSession', () => ({
	useAnswerQueueSession: () => ({ isCurrentRoute: ref(true), flow: { current } }),
}));

const run = vi.fn(async () => ({ ok: true }));
beforeAll(() => {
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		useToast: () => ({ showToast: vi.fn() }),
		useBackendOperation: () => ({ run, isLoading: ref(false) }),
	});
});
enableAutoUnmount(afterEach);
beforeEach(() => {
	run.mockClear();
	clarification.value = {
		isNeeded: true,
		askedAt: 1,
		questions: [
			{
				id: 'q1',
				slotType: 'decision',
				answerKind: 'choice',
				text: 'Is the PO on the invoice?',
				attribution: 'From example.org',
				options: ['Yes', 'No'],
				answer: { value: 'Yes', at: 1, source: 'memory' },
			},
			{
				id: 'q2',
				slotType: 'free_text',
				answerKind: 'text',
				text: 'Anything else?',
				attribution: 'From example.org',
			},
		],
	};
});

function mountAsk(props: Record<string, unknown> = {}) {
	return mount(AnswerQueueMailAsk, {
		props: { messageId: 'msg_1', ...props },
		global: {
			plugins: [createTestI18n()],
			stubs: { AnswerFilePicker: true },
		},
	});
}

describe('AnswerQueueMailAsk', () => {
	it('asks first, and sends the answers with the kept memory answer as memory', async () => {
		const w = mountAsk();
		expect(w.emitted('visible')?.at(-1)).toEqual([true]);
		await w.findAll('[data-testid="ask-input"]').at(-1)!.setValue('Thanks!');
		await w.get('[data-testid="ask-submit"]').trigger('click');
		await flushPromises();
		expect(run).toHaveBeenCalledWith({
			threadId: 'thr_1',
			answers: [
				{ questionId: 'q2', value: 'Thanks!', source: 'user' },
				{ questionId: 'q1', value: 'Yes', source: 'memory' },
			],
		});
	});

	it('"Answer later" puts it away', async () => {
		const w = mountAsk();
		await w.get('[data-testid="ask-skip"]').trigger('click');
		expect(w.find('[data-testid="answer-queue-ask"]').exists()).toBe(false);
		expect(w.emitted('visible')?.at(-1)).toEqual([false]);
	});

	it('hands the starter reply to the editor when it lands, once', async () => {
		const w = mountAsk();
		clarification.value = { ...clarification.value, answeredAt: 2 };
		await flushPromises();
		expect(w.get('[data-testid="answer-queue-ask-drafting"]').exists()).toBe(true);
		clarification.value = { ...clarification.value, draft: 'Hi Jonas, here it is.' };
		await flushPromises();
		expect(w.emitted('use-draft')).toEqual([['Hi Jonas, here it is.']]);
		expect(w.find('[data-testid="answer-queue-ask"]').exists()).toBe(false);
	});

	it('keeps what the person wrote meanwhile, and puts the draft in only when asked', async () => {
		const w = mountAsk({ written: true });
		clarification.value = { ...clarification.value, answeredAt: 2 };
		await flushPromises();
		clarification.value = { ...clarification.value, draft: 'Hi Jonas, here it is.' };
		await flushPromises();
		expect(w.emitted('use-draft')).toBeUndefined();
		const ready = w.get('[data-testid="answer-queue-ask-ready"]');
		expect(ready.text()).toContain('The AI draft is ready');

		await ready.findAll('button')[0]!.trigger('click');
		expect(w.emitted('use-draft')).toEqual([['Hi Jonas, here it is.']]);
		expect(w.find('[data-testid="answer-queue-ask"]').exists()).toBe(false);
	});

	it('leaves a reply drafted before the page opened to the prepared draft', async () => {
		clarification.value = { ...clarification.value, answeredAt: 2, draft: 'Earlier' };
		const w = mountAsk();
		await flushPromises();
		expect(w.emitted('use-draft')).toBeUndefined();
		expect(w.find('[data-testid="answer-queue-ask"]').exists()).toBe(false);
	});
});
