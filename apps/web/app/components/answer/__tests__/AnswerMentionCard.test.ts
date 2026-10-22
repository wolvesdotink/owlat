/**
 * A chat mention as an Answer-queue card. Its keys are the `mentionCard`
 * scope, bound through the app-wide dispatcher: Enter opens the conversation,
 * `d` marks the mention read, `s` skips it, none of them while typing, and the
 * card's key hints follow a remap.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import type { AnswerCardControls } from '~/utils/answerCard';
import { applyShortcutPreferences, resetShortcutPreferences } from '~/utils/shortcutScope';
import AnswerMentionCard from '../AnswerMentionCard.vue';

vi.mock('@owlat/api', () => {
	const anyPath: unknown = new Proxy(function () {}, {
		get: () => anyPath,
		apply: () => anyPath,
	});
	return { api: anyPath };
});

const markRead = vi.fn(async () => ({ ok: true }));
const navigateTo = vi.fn();

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
	vi.stubGlobal('useBackendOperation', () => ({ run: markRead, isLoading: ref(false) }));
	vi.stubGlobal('navigateTo', navigateTo);
});

enableAutoUnmount(afterEach);
afterEach(() => resetShortcutPreferences());

const controls: AnswerCardControls = {
	complete: vi.fn(),
	skip: vi.fn(),
	undoSelf: vi.fn(),
	back: vi.fn(),
	next: vi.fn(),
	openAnswer: vi.fn(),
};

beforeEach(() => {
	markRead.mockClear();
	navigateTo.mockClear();
	for (const fn of Object.values(controls)) vi.mocked(fn).mockClear();
});

const taskActionsStub = {
	props: ['hints'],
	template:
		'<div><span v-for="hint in hints" :key="hint.label" class="hint"><kbd v-for="k in hint.keys" :key="k">{{ k }}</kbd> {{ hint.label }}</span></div>',
};

function mountCard() {
	return mount(AnswerMentionCard, {
		props: {
			mention: {
				_id: 'men_1',
				roomId: 'room_1',
				roomName: 'support',
				messagePreview: 'Can you check this?',
				createdAt: 1,
			} as never,
			controls,
		},
		global: {
			plugins: [createTestI18n()],
			mocks: { formatCompactRelativeTime: () => 'now' },
			stubs: {
				TaskCardShell: { template: '<div><slot /></div>' },
				TaskContext: true,
				TaskAsk: true,
				TaskActions: taskActionsStub,
			},
		},
	});
}

// Through the app-wide dispatcher, a document listener.
const press = (key: string, target: EventTarget = document.body) =>
	target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

describe('AnswerMentionCard keys', () => {
	it('opens the conversation with Enter, marking the mention read', async () => {
		mountCard();
		press('Enter');
		await flushPromises();
		expect(markRead).toHaveBeenCalledWith({ mentionId: 'men_1' });
		expect(controls.complete).toHaveBeenCalledWith('opened');
		expect(navigateTo).toHaveBeenCalledWith('/dashboard/chat/room_1');
	});

	it('marks it read with d and skips it with s', async () => {
		mountCard();
		press('d');
		await flushPromises();
		expect(controls.complete).toHaveBeenCalledWith('cleared');
		press('s');
		expect(controls.skip).toHaveBeenCalledTimes(1);
	});

	it('leaves the keys to a text field', async () => {
		mountCard();
		const input = document.body.appendChild(document.createElement('input'));
		press('d', input);
		press('s', input);
		await flushPromises();
		input.remove();
		expect(markRead).not.toHaveBeenCalled();
		expect(controls.skip).not.toHaveBeenCalled();
	});

	it('hints and answers the keys the person has bound', async () => {
		applyShortcutPreferences('owlat', [{ id: 'mentionCard.markRead', keys: ['m'] }]);
		const wrapper = mountCard();
		expect(wrapper.findAll('.hint kbd').map((kbd) => kbd.text())).toEqual(['Enter', 'M']);
		press('d');
		await flushPromises();
		expect(markRead).not.toHaveBeenCalled();
		press('m');
		await flushPromises();
		expect(controls.complete).toHaveBeenCalledWith('cleared');
	});
});
