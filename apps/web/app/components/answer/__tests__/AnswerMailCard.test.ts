// @vitest-environment happy-dom
/**
 * AnswerMailCard is the follow-up reminder card: the only Postbox row the
 * Answer queue shows as a card. Every other row opens in Answer mode, so the
 * card's clarification and draft-review branches could never render and are
 * gone (#1188).
 *
 * Its one verb is Done; Reply writes a nudge in Answer mode and finishes
 * nothing, since only a send there completes the item (plan §10). The queue bug
 * that rule fixed: the card completed the item as the composer OPENED, so
 * closing it without sending dropped the email from the queue.
 */
import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';

import AnswerMailCard from '../AnswerMailCard.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import type { ReplyQueueItem } from '~/utils/postboxReplyQueue';
import type { AnswerCardControls } from '~/utils/answerCard';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

/** Each write the card can run, by its label, with the args it ran with. */
const runs = new Map<string, ReturnType<typeof vi.fn>>();
const navigateTo = vi.fn();

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
	vi.stubGlobal('useBackendOperation', (_fn: unknown, opts: { label: () => string }) => {
		const run = vi.fn(async () => ({ ok: true, result: { moved: [] } }));
		runs.set(opts.label(), run);
		return { run, isLoading: ref(false) };
	});
	vi.stubGlobal('navigateTo', navigateTo);
});

// Every card listens on window; a card left mounted would answer the next test's keys.
enableAutoUnmount(afterEach);

const controls: AnswerCardControls = {
	complete: vi.fn(),
	skip: vi.fn(),
	undoSelf: vi.fn(),
	back: vi.fn(),
	next: vi.fn(),
	openAnswer: vi.fn(),
};

beforeEach(() => {
	runs.clear();
	navigateTo.mockClear();
	for (const fn of Object.values(controls)) vi.mocked(fn).mockClear();
});

function followUp(over: Partial<ReplyQueueItem> = {}): ReplyQueueItem {
	return {
		kind: 'followup',
		threadId: 'thread-1',
		messageId: 'msg-1',
		urgency: 'normal',
		detectedAt: 1,
		source: 'heuristic',
		waitingOn: 'tom@harborline.io',
		fromAddress: 'tom@harborline.io',
		fromName: 'Tom Lindqvist',
		subject: 'SPF record',
		snippet: 'I will check the SPF record and get back to you.',
		receivedAt: 1,
		...over,
	};
}

// Clicking the stub's primary button runs the card's primary verb.
const taskActionsStub = {
	name: 'TaskActions',
	props: ['primaryLabel'],
	emits: ['primary', 'skip'],
	template:
		'<div><button class="primary" @click="$emit(\'primary\')">{{ primaryLabel }}</button><slot /></div>',
};

function mountCard(item: ReplyQueueItem = followUp()) {
	return mount(AnswerMailCard, {
		props: { row: item, mailboxId: 'mb-1' as never, controls },
		global: {
			plugins: [createTestI18n()],
			// A Nuxt auto-import the template calls directly.
			mocks: { formatCompactRelativeTime: () => 'now' },
			stubs: {
				Icon: true,
				TaskContext: { template: '<div class="context"><slot name="chips" /></div>' },
				TaskAsk: {
					props: ['ask', 'detail'],
					template: '<p class="ask">{{ ask }} | {{ detail }}</p>',
				},
				TaskActions: taskActionsStub,
			},
		},
	});
}

const press = (key: string, target: EventTarget = window) =>
	target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));

describe('AnswerMailCard renders a follow-up reminder', () => {
	it('says who we are waiting on, under a Follow-up chip, with Done as its verb', () => {
		const wrapper = mountCard();
		expect(wrapper.get('.context').text()).toBe('Follow-up');
		expect(wrapper.get('.ask').text()).toBe(
			"You're waiting on Tom Lindqvist | I will check the SPF record and get back to you."
		);
		expect(wrapper.get('.primary').text()).toBe('Done');
		expect(wrapper.get('[data-testid="answer-mail-nudge"]').text()).toBe('Reply');
	});

	it('Open shows the thread in the inbox it came in to', async () => {
		const wrapper = mountCard();
		const open = wrapper.findAll('button').find((button) => button.text() === 'Open');
		await open!.trigger('click');
		expect(navigateTo).toHaveBeenCalledWith('/dashboard/postbox/inbox/msg-1?mailbox=mb-1');
	});
});

describe('AnswerMailCard finishes an item only when something was done (plan §10)', () => {
	it('Done dismisses the reminder and completes the item', async () => {
		const wrapper = mountCard();
		await wrapper.get('.primary').trigger('click');
		await flushPromises();
		expect(runs.get('Dismiss reminder')).toHaveBeenCalledWith({ threadId: 'thread-1' });
		expect(controls.complete).toHaveBeenCalledWith('cleared');
	});

	it('Enter on the card is Done too', async () => {
		mountCard();
		press('Enter');
		await flushPromises();
		expect(runs.get('Dismiss reminder')).toHaveBeenCalledTimes(1);
		expect(controls.complete).toHaveBeenCalledWith('cleared');
		expect(controls.openAnswer).not.toHaveBeenCalled();
	});

	it('Reply opens Answer mode for a nudge and does not complete the item', async () => {
		const wrapper = mountCard();
		await wrapper.get('[data-testid="answer-mail-nudge"]').trigger('click');
		expect(controls.openAnswer).toHaveBeenCalledTimes(1);
		expect(controls.complete).not.toHaveBeenCalled();
	});
});

describe('AnswerMailCard keyboard', () => {
	it('browses with the arrows and j/k without acting on the item', () => {
		mountCard();
		press('ArrowLeft');
		press('k');
		press('ArrowRight');
		press('j');
		expect(controls.back).toHaveBeenCalledTimes(2);
		expect(controls.next).toHaveBeenCalledTimes(2);
		expect(controls.complete).not.toHaveBeenCalled();
	});

	it('offers no archive or skip key on a follow-up', async () => {
		mountCard();
		press('e');
		press('s');
		await flushPromises();
		expect(runs.get('Archive')).not.toHaveBeenCalled();
		expect(controls.skip).not.toHaveBeenCalled();
		expect(controls.complete).not.toHaveBeenCalled();
	});

	it('is inert while typing or with a modifier held', async () => {
		mountCard();
		const input = document.body.appendChild(document.createElement('input'));
		press('Enter', input);
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true }));
		await flushPromises();
		input.remove();
		expect(runs.get('Dismiss reminder')).not.toHaveBeenCalled();
		expect(controls.complete).not.toHaveBeenCalled();
	});
});
