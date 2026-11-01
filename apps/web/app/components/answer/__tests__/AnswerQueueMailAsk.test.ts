/**
 * The Reply Queue's clarification of a thread, above the editor:
 *  - it shows as the ask card while it asks, answered through the Reply
 *    Queue's mutation (a kept remembered answer goes back as `memory`);
 *  - "Draft with what I have" sends what was answered, with gaps allowed;
 *  - file questions ask before any draft is written, like every other;
 *  - a reply opened outside the queue reads the thread's own questions;
 *  - the starter reply that lands while the page is open goes to the editor,
 *    once; a reply drafted before the page opened is left to the prepared draft.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
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
const inQueue = ref(true);
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
	useAnswerQueueSession: () => ({ isCurrentRoute: inQueue, flow: { current } }),
}));
/** The thread's own read, for a reply opened outside the queue. */
const preparedArgs = vi.fn();

const run = vi.fn(async () => ({ ok: true }));
beforeAll(() => {
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		useToast: () => ({ showToast: vi.fn() }),
		useBackendOperation: () => ({ run, isLoading: ref(false) }),
		useConvexQuery: (_query: unknown, args: () => unknown) => ({
			data: computed(() => {
				const value = args();
				preparedArgs(value);
				return value === 'skip' ? undefined : { clarification: clarification.value };
			}),
		}),
	});
});
beforeEach(() => {
	run.mockClear();
	preparedArgs.mockClear();
	inQueue.value = true;
	clarification.value = {
		isNeeded: true,
		askedAt: 1,
		questions: [
			{
				id: 'q1',
				slotType: 'decision',
				answerKind: 'choice',
				text: 'Is the PO on the invoice?',
				origin: { kind: 'email', senderDomain: 'example.org' },
				options: ['Yes', 'No'],
				answer: { value: 'Yes', at: 1, source: 'memory' },
			},
			{
				id: 'q2',
				slotType: 'free_text',
				answerKind: 'text',
				text: 'Anything else?',
				origin: { kind: 'email', senderDomain: 'example.org' },
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

	it('says no draft is written yet, and holds "Answer and draft" until all are answered', () => {
		const w = mountAsk();
		expect(w.get('[data-testid="ask-subline"]').text()).toMatch(/^No draft yet\./);
		expect(w.get('[data-testid="ask-submit"]').attributes('disabled')).toBeDefined();
	});

	it('"Draft with what I have" sends what was answered, with gaps allowed', async () => {
		const w = mountAsk();
		expect(w.get('[data-testid="ask-skip"]').text()).toBe('Draft with what I have');
		await w.get('[data-testid="ask-skip"]').trigger('click');
		await flushPromises();
		expect(run).toHaveBeenCalledWith({
			threadId: 'thr_1',
			answers: [{ questionId: 'q1', value: 'Yes', source: 'memory' }],
			withGaps: true,
		});
	});

	it("asks the thread's own questions on a reply opened outside the queue", async () => {
		inQueue.value = false;
		const w = mountAsk({ threadId: 'thr_1' });
		expect(preparedArgs).toHaveBeenCalledWith({ threadId: 'thr_1' });
		expect(w.find('[data-testid="ask-card"]').exists()).toBe(true);
		await w.findAll('[data-testid="ask-input"]').at(-1)!.setValue('Thanks!');
		await w.get('[data-testid="ask-submit"]').trigger('click');
		await flushPromises();
		expect(run).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thr_1' }));
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

	it('says there is no AI draft when the reply needs a fact Owlat never asks for', async () => {
		clarification.value = { ...clarification.value, answeredAt: 2, isDraftHeld: true };
		const w = mountAsk();
		expect(w.get('[data-testid="answer-queue-ask-held"]').text()).toContain(
			'No AI draft for this reply'
		);
		expect(w.find('[data-testid="answer-queue-ask-drafting"]').exists()).toBe(false);
	});

	it('says the AI reply is paused, without waiting for one, and leaves the editor to the person', async () => {
		clarification.value = { ...clarification.value, answeredAt: 2, isPaused: true };
		const w = mountAsk();
		expect(w.get('[data-testid="answer-queue-ask-paused"]').text()).toContain(
			'signature check changed after the AI read it'
		);
		expect(w.find('[data-testid="answer-queue-ask-drafting"]').exists()).toBe(false);
		expect(w.find('.animate-spin').exists()).toBe(false);
		expect(w.emitted('use-draft')).toBeUndefined();
		// Up, but asking nothing: the page keeps its plain reply label.
		expect(w.emitted('visible')?.at(-1)).toEqual([true]);
		expect(w.emitted('asking')?.at(-1)).toEqual([false]);

		// "I'll answer later" still puts it away.
		await w.get('[data-testid="answer-queue-ask-paused"] button').trigger('click');
		expect(w.find('[data-testid="answer-queue-ask"]').exists()).toBe(false);
		expect(w.emitted('visible')?.at(-1)).toEqual([false]);
	});

	it('says it is asking only while questions are up', async () => {
		const w = mountAsk();
		expect(w.emitted('asking')?.at(-1)).toEqual([true]);
		clarification.value = { ...clarification.value, answeredAt: 2 };
		await flushPromises();
		// Drafting: still up, no questions to answer.
		expect(w.emitted('visible')?.at(-1)).toEqual([true]);
		expect(w.emitted('asking')?.at(-1)).toEqual([false]);
	});

	it('drops a kept draft the server withdrew, and never hands it to the editor', async () => {
		clarification.value = { ...clarification.value, answeredAt: 2 };
		const w = mountAsk({ written: true });
		await flushPromises();
		clarification.value = { ...clarification.value, draft: 'I will pay account 999.' };
		await flushPromises();
		// Kept, since the person was writing.
		expect(w.find('[data-testid="answer-queue-ask-ready"]').exists()).toBe(true);

		// The thread's AI reading is paused: the server's draft is gone.
		const { draft: _withdrawn, ...paused } = clarification.value;
		clarification.value = { ...paused, isPaused: true };
		await flushPromises();
		expect(w.find('[data-testid="answer-queue-ask-ready"]').exists()).toBe(false);
		expect(w.emitted('use-draft')).toBeUndefined();
		expect(w.get('[data-testid="answer-queue-ask-paused"]').exists()).toBe(true);
	});

	it('leaves a reply drafted before the page opened to the prepared draft', async () => {
		clarification.value = { ...clarification.value, answeredAt: 2, draft: 'Earlier' };
		const w = mountAsk();
		await flushPromises();
		expect(w.emitted('use-draft')).toBeUndefined();
		expect(w.find('[data-testid="answer-queue-ask"]').exists()).toBe(false);
	});

	// Files the message asks for: no draft is written while they are missing either.
	it('asks for files before any draft, and sends the files the person gave', async () => {
		clarification.value = {
			isNeeded: true,
			askedAt: 1,
			questions: [
				{
					id: 'clarify_0',
					slotType: 'attachment',
					answerKind: 'file',
					text: 'Please provide the invoice PDFs for the four bookings',
					origin: { kind: 'email', senderDomain: 'example.org' },
					fileCandidates: [
						{
							source: 'mailAttachment',
							id: 'att_1',
							filename: 'invoice-1.pdf',
							mimeType: 'application/pdf',
							size: 1000,
							score: 0.7,
						},
					],
				},
			],
		};
		const w = mountAsk();
		expect(w.get('h2').text()).toBe('One thing before I write this');
		await w.get('[data-testid="file-ask-candidate"]').trigger('click');
		await w.get('[data-testid="ask-submit"]').trigger('click');
		await flushPromises();
		expect(run).toHaveBeenCalledWith({
			threadId: 'thr_1',
			answers: [
				{
					questionId: 'clarify_0',
					files: [{ source: 'mailAttachment', id: 'att_1', filename: 'invoice-1.pdf' }],
					keepCopy: true,
					source: 'user',
				},
			],
		});
	});
});
