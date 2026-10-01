// @vitest-environment happy-dom
/**
 * The chat composer keeps its draft until the send is acknowledged (#945).
 *
 * `send` is an awaited callback: the text and the attachment selection stay on
 * screen until it resolves `ok`. A refused send keeps both for a retry, a
 * pending send blocks a second one, and whatever is typed or attached while a
 * send is in flight survives its success.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { ref } from 'vue';

import ChatInput from '../ChatInput.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

type SendArgs = [text: string, attachmentIds?: string[]];
type Pending = { args: SendArgs; resolve: (outcome: { ok: boolean }) => void };

let pending: Pending[];
let send: ReturnType<typeof vi.fn>;
let nextUploadId: number;

beforeAll(() => {
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		useChatMentionSearch: () => ({ candidates: ref([]) }),
		useChatAttachments: () => ({
			isUploading: ref(false),
			uploadFile: async () => `asset_${++nextUploadId}`,
		}),
	});
});

beforeEach(() => {
	pending = [];
	nextUploadId = 0;
	send = vi.fn(
		(...args: SendArgs) =>
			new Promise<{ ok: boolean }>((resolve) => pending.push({ args, resolve }))
	);
});

function mountInput() {
	return mount(ChatInput, {
		props: { send: send as never },
		global: {
			plugins: [createTestI18n()],
			stubs: { ChatMentionPicker: true, UiSpinner: true },
		},
	});
}

const textarea = (w: VueWrapper) => w.get('textarea').element as HTMLTextAreaElement;
const sendButton = (w: VueWrapper) => w.get('[data-testid="chat-send"]');
const chips = (w: VueWrapper) =>
	w.findAll('button[aria-label^="Remove"]').map((b) => b.attributes('aria-label'));

async function type(w: VueWrapper, value: string) {
	await w.get('textarea').setValue(value);
}

async function pressEnter(w: VueWrapper) {
	await w.get('textarea').trigger('keydown', { key: 'Enter' });
	await flushPromises();
}

async function attach(w: VueWrapper, name: string) {
	const input = w.get('input[type="file"]');
	Object.defineProperty(input.element, 'files', {
		configurable: true,
		value: [new File(['x'], name, { type: 'text/plain' })],
	});
	await input.trigger('change');
	await flushPromises();
}

async function settle(outcome: { ok: boolean }) {
	pending.shift()!.resolve(outcome);
	await flushPromises();
}

describe('ChatInput send acknowledgement (#945)', () => {
	it('clears the draft once the send is accepted, not before', async () => {
		const w = mountInput();
		await type(w, '  Important draft  ');
		await attach(w, 'notes.txt');
		await pressEnter(w);

		expect(send).toHaveBeenCalledWith('Important draft', ['asset_1']);
		// In flight: nothing is gone yet, and the button says it is busy.
		expect(textarea(w).value).toBe('  Important draft  ');
		expect(chips(w)).toEqual(['Remove attachment notes.txt']);
		expect(sendButton(w).attributes('aria-busy')).toBe('true');
		expect(sendButton(w).attributes('disabled')).toBeDefined();

		await settle({ ok: true });
		expect(textarea(w).value).toBe('');
		expect(chips(w)).toEqual([]);
		expect(sendButton(w).attributes('aria-busy')).toBeUndefined();
	});

	it('keeps the exact text and attachments of a refused send, and retries that snapshot', async () => {
		const w = mountInput();
		await type(w, 'Important unsent draft');
		await attach(w, 'plan.pdf');
		await pressEnter(w);
		await settle({ ok: false });

		expect(textarea(w).value).toBe('Important unsent draft');
		expect(chips(w)).toEqual(['Remove attachment plan.pdf']);
		expect(sendButton(w).attributes('disabled')).toBeUndefined();

		await pressEnter(w);
		expect(send).toHaveBeenCalledTimes(2);
		expect(send.mock.calls[1]).toEqual(['Important unsent draft', ['asset_1']]);
		await settle({ ok: true });
		expect(textarea(w).value).toBe('');
		expect(chips(w)).toEqual([]);
	});

	it('sends a pending draft once, however often Send is pressed', async () => {
		const w = mountInput();
		await type(w, 'once');
		await pressEnter(w);
		await pressEnter(w);
		await sendButton(w).trigger('click');
		await flushPromises();

		expect(send).toHaveBeenCalledTimes(1);
		await settle({ ok: true });
		expect(textarea(w).value).toBe('');
	});

	it('keeps text and attachments added while the send was in flight', async () => {
		const w = mountInput();
		await type(w, 'first message');
		await attach(w, 'a.txt');
		await pressEnter(w);

		// The member keeps typing and attaches another file before the answer.
		await type(w, 'first message\nsecond thought');
		await attach(w, 'b.txt');
		await settle({ ok: true });

		expect(textarea(w).value).toBe('\nsecond thought');
		expect(chips(w)).toEqual(['Remove attachment b.txt']);
	});

	it('leaves a draft edited inside the sent text alone', async () => {
		const w = mountInput();
		await type(w, 'teh typo');
		await pressEnter(w);
		await type(w, 'the typo');
		await settle({ ok: true });

		expect(textarea(w).value).toBe('the typo');
	});

	it('treats an attachment-only message the same way', async () => {
		const w = mountInput();
		await attach(w, 'photo.png');
		await sendButton(w).trigger('click');
		await flushPromises();

		expect(send).toHaveBeenCalledWith('', ['asset_1']);
		await settle({ ok: false });
		expect(chips(w)).toEqual(['Remove attachment photo.png']);

		await sendButton(w).trigger('click');
		await flushPromises();
		expect(send).toHaveBeenCalledTimes(2);
		await settle({ ok: true });
		expect(chips(w)).toEqual([]);
	});
});
