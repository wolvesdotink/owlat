/**
 * ↑ in the empty Assistant box brings back your last question in this
 * conversation; more ↑ step to earlier ones and ↓ steps forward to an empty box.
 * A question you typed is never replaced, a recalled one goes out as a new turn
 * with Enter, and one box shared by every conversation never steps from a
 * question recalled in another.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';

import AssistantComposer from '../AssistantComposer.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import type { PromptHistoryEntry } from '~/utils/composerRecall';

let send: ReturnType<typeof vi.fn>;

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

beforeEach(() => {
	send = vi.fn(async () => ({ ok: true }));
});

const HISTORY: PromptHistoryEntry[] = [
	{ id: 'u1', prompt: 'Which customers asked about refunds?' },
	{ id: 'u2', prompt: 'Draft a reply to Contoso.\nKeep it short.' },
	{ id: 'u3', prompt: 'Thanks' },
];

function mountComposer(props: Record<string, unknown> = {}) {
	return mount(AssistantComposer, {
		attachTo: document.body,
		props: { send: send as never, promptHistory: HISTORY, historyKey: 'convo_a', ...props },
		global: { plugins: [createTestI18n()] },
	});
}

const field = (w: VueWrapper) => w.get('textarea').element as HTMLTextAreaElement;

async function press(w: VueWrapper, init: KeyboardEventInit) {
	const event = new KeyboardEvent('keydown', { cancelable: true, bubbles: true, ...init });
	field(w).dispatchEvent(event);
	await flushPromises();
	return event;
}

describe('AssistantComposer question recall', () => {
	it('brings back the last question, then earlier ones, then forward to empty', async () => {
		const w = mountComposer();
		const first = await press(w, { key: 'ArrowUp' });
		expect(first.defaultPrevented).toBe(true);
		expect(field(w).value).toBe('Thanks');
		expect(field(w).selectionStart).toBe('Thanks'.length);

		await press(w, { key: 'ArrowUp' });
		expect(field(w).value).toBe('Draft a reply to Contoso.\nKeep it short.');
		// The caret is on the second line: ↑ moves it, it does not step.
		const inside = await press(w, { key: 'ArrowUp' });
		expect(inside.defaultPrevented).toBe(false);
		expect(field(w).value).toBe('Draft a reply to Contoso.\nKeep it short.');
		field(w).setSelectionRange(0, 0);
		await press(w, { key: 'ArrowUp' });
		expect(field(w).value).toBe('Which customers asked about refunds?');
		// Nothing older: the key is left alone.
		expect((await press(w, { key: 'ArrowUp' })).defaultPrevented).toBe(false);

		await press(w, { key: 'ArrowDown' });
		expect(field(w).value).toBe('Draft a reply to Contoso.\nKeep it short.');
		await press(w, { key: 'ArrowDown' });
		expect(field(w).value).toBe('Thanks');
		await press(w, { key: 'ArrowDown' });
		expect(field(w).value).toBe('');
	});

	it('sends a recalled question as a new turn', async () => {
		const w = mountComposer();
		await press(w, { key: 'ArrowUp' });
		await press(w, { key: 'Enter' });
		expect(send).toHaveBeenCalledWith('Thanks');
		expect(field(w).value).toBe('');
		// After the send, ↑ starts from the newest question again.
		await press(w, { key: 'ArrowUp' });
		expect(field(w).value).toBe('Thanks');
	});

	it('never replaces a question being typed, nor a recalled one being edited', async () => {
		const w = mountComposer();
		await w.get('textarea').setValue('my own draft');
		field(w).setSelectionRange(0, 0);
		expect((await press(w, { key: 'ArrowUp' })).defaultPrevented).toBe(false);
		expect(field(w).value).toBe('my own draft');

		await w.get('textarea').setValue('');
		await press(w, { key: 'ArrowUp' });
		await w.get('textarea').setValue('Thanks a lot');
		field(w).setSelectionRange(0, 0);
		await press(w, { key: 'ArrowUp' });
		expect(field(w).value).toBe('Thanks a lot');
	});

	it('leaves modified arrows and IME input alone', async () => {
		const w = mountComposer();
		await press(w, { key: 'ArrowUp', shiftKey: true });
		await press(w, { key: 'ArrowUp', altKey: true });
		await press(w, { key: 'ArrowUp', metaKey: true });
		await press(w, { key: 'ArrowUp', isComposing: true });
		expect(field(w).value).toBe('');
	});

	it('does nothing without questions, or while unavailable', async () => {
		const empty = mountComposer({ promptHistory: [] });
		expect((await press(empty, { key: 'ArrowUp' })).defaultPrevented).toBe(false);
		expect(field(empty).value).toBe('');

		const disabled = mountComposer({ disabled: true });
		await press(disabled, { key: 'ArrowUp' });
		expect(field(disabled).value).toBe('');
	});

	it('does not step from a question recalled in another conversation', async () => {
		const w = mountComposer();
		await press(w, { key: 'ArrowUp' });
		expect(field(w).value).toBe('Thanks');

		await w.setProps({
			historyKey: 'convo_b',
			promptHistory: [{ id: 'b1', prompt: 'Summarise the onboarding drip' }],
		});
		field(w).setSelectionRange(0, 0);
		await press(w, { key: 'ArrowUp' });
		await press(w, { key: 'ArrowDown' });
		// The shared box keeps what it holds; conversation B's history is not mixed in.
		expect(field(w).value).toBe('Thanks');

		await w.get('textarea').setValue('');
		await press(w, { key: 'ArrowUp' });
		expect(field(w).value).toBe('Summarise the onboarding drip');
	});
});
