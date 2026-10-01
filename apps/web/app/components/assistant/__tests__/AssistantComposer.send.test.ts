// @vitest-environment happy-dom
/**
 * The Assistant composer keeps the question until the send is accepted (#1049).
 *
 * Same contract as ChatInput: `send` is awaited, the text stays on screen until
 * it resolves `ok`, a pending send blocks a second one, and whatever is typed
 * while a send is in flight survives its success. A failed send also leaves an
 * inline "still here" line with Retry.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';

import AssistantComposer from '../AssistantComposer.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

type Pending = { text: string; resolve: (outcome: { ok: boolean }) => void };

let pending: Pending[];
let send: ReturnType<typeof vi.fn>;

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

beforeEach(() => {
	pending = [];
	send = vi.fn(
		(text: string) => new Promise<{ ok: boolean }>((resolve) => pending.push({ text, resolve }))
	);
});

function mountComposer() {
	return mount(AssistantComposer, {
		props: { send: send as never },
		global: { plugins: [createTestI18n()] },
	});
}

const textarea = (w: VueWrapper) => w.get('textarea').element as HTMLTextAreaElement;
const sendButton = (w: VueWrapper) => w.get('[data-testid="assistant-send"]');
const failedLine = (w: VueWrapper) => w.find('[data-testid="assistant-send-failed"]');

async function pressEnter(w: VueWrapper) {
	await w.get('textarea').trigger('keydown', { key: 'Enter' });
	await flushPromises();
}

async function settle(outcome: { ok: boolean }) {
	pending.shift()!.resolve(outcome);
	await flushPromises();
}

describe('AssistantComposer send acknowledgement (#1049)', () => {
	it('clears the question once the send is accepted, not before', async () => {
		const w = mountComposer();
		await w.get('textarea').setValue('  What changed?  ');
		await pressEnter(w);

		expect(send).toHaveBeenCalledWith('What changed?');
		expect(textarea(w).value).toBe('  What changed?  ');
		expect(sendButton(w).attributes('aria-busy')).toBe('true');
		expect(sendButton(w).attributes('disabled')).toBeDefined();
		// The textarea stays editable while the send is in flight.
		expect(textarea(w).disabled).toBe(false);

		await settle({ ok: true });
		expect(textarea(w).value).toBe('');
		expect(sendButton(w).attributes('aria-busy')).toBeUndefined();
		expect(failedLine(w).exists()).toBe(false);
	});

	it('keeps the exact question of a failed send, newlines included, and retries it once', async () => {
		const w = mountComposer();
		const question = 'Line one\n\nLine two\n  indented';
		await w.get('textarea').setValue(question);
		await pressEnter(w);
		await settle({ ok: false });

		expect(textarea(w).value).toBe(question);
		expect(failedLine(w).text()).toContain("Couldn't send. Your question is still here.");

		await failedLine(w).get('button').trigger('click');
		await flushPromises();
		expect(send).toHaveBeenCalledTimes(2);
		expect(send.mock.calls[1]).toEqual([question]);
		// Pending again: the failure line is gone until this one answers.
		expect(failedLine(w).exists()).toBe(false);

		await settle({ ok: true });
		expect(textarea(w).value).toBe('');
		expect(failedLine(w).exists()).toBe(false);
	});

	it('sends a pending question once, however often Send is pressed', async () => {
		const w = mountComposer();
		await w.get('textarea').setValue('once');
		await pressEnter(w);
		await pressEnter(w);
		await sendButton(w).trigger('click');
		await flushPromises();

		expect(send).toHaveBeenCalledTimes(1);
		await settle({ ok: true });
		expect(textarea(w).value).toBe('');
	});

	it('keeps text typed while the send was in flight', async () => {
		const w = mountComposer();
		await w.get('textarea').setValue('first question');
		await pressEnter(w);
		await w.get('textarea').setValue('first question\nand a follow-up');
		await settle({ ok: true });

		expect(textarea(w).value).toBe('\nand a follow-up');
	});

	it('sends an example prompt through the same path, keeping it on failure', async () => {
		const w = mountComposer();
		const vm = w.vm as unknown as { sendText: (text: string) => Promise<void> };
		void vm.sendText('Summarize the last campaign.');
		await flushPromises();

		expect(send).toHaveBeenCalledWith('Summarize the last campaign.');
		await settle({ ok: false });
		expect(textarea(w).value).toBe('Summarize the last campaign.');
		expect(failedLine(w).exists()).toBe(true);
	});

	it('never replaces a started draft with an example prompt', async () => {
		const w = mountComposer();
		await w.get('textarea').setValue('My own question  ');
		const vm = w.vm as unknown as { sendText: (text: string) => Promise<void> };
		await vm.sendText('Summarize the last campaign.');
		await flushPromises();

		expect(send).not.toHaveBeenCalled();
		expect(textarea(w).value).toBe('My own question\nSummarize the last campaign.');
	});
});

describe('AssistantComposer IME composition (#1052)', () => {
	it('does not send or clear on the Enter that confirms an IME candidate', async () => {
		const w = mountComposer();
		await w.get('textarea').setValue('你好');
		for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
			const event = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true, ...init });
			w.get('textarea').element.dispatchEvent(event);
			await flushPromises();
			expect(event.defaultPrevented).toBe(false);
		}
		expect(send).not.toHaveBeenCalled();
		expect(textarea(w).value).toBe('你好');

		// Shift+Enter is still a newline, not a send.
		await w.get('textarea').trigger('keydown', { key: 'Enter', shiftKey: true });
		expect(send).not.toHaveBeenCalled();

		// After the composition, Enter sends once.
		await pressEnter(w);
		expect(send).toHaveBeenCalledTimes(1);
		expect(send).toHaveBeenCalledWith('你好');
	});
});
