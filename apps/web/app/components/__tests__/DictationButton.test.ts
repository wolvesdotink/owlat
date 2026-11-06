/**
 * The microphone beside a text field: absent without a speech engine; a
 * labelled toggle that says who hears the audio; "listening" announced; a
 * finished phrase written at the field's caret; Esc cancels without reaching
 * the page; a failure explained in a toast, in the desktop app in the OS's
 * terms.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { useToast } from '@owlat/ui/composables/useToast';
import DictationButton from '../DictationButton.vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';
import { useAnnounce } from '~/composables/useAnnounce';

// The desktop shell: an on-device engine whose sessions report to a Channel.
const { channels } = vi.hoisted(() => ({
	channels: [] as { deliver: (event: unknown) => void }[],
}));
vi.mock('@tauri-apps/api/core', () => ({
	invoke: async (cmd: string) => (cmd === 'dictation_available' ? true : 1),
	Channel: class {
		deliver: (event: unknown) => void;
		constructor(onmessage: (event: unknown) => void) {
			this.deliver = onmessage;
			channels.push(this);
		}
	},
}));

class FakeRecognition extends EventTarget {
	static last: FakeRecognition | null = null;
	start = vi.fn();
	stop = vi.fn(() => this.end());
	abort = vi.fn(() => this.end());
	constructor() {
		super();
		FakeRecognition.last = this;
	}
	finish(transcript: string) {
		const results = [Object.assign([{ transcript }], { isFinal: true })];
		this.dispatchEvent(Object.assign(new Event('result'), { resultIndex: 0, results }));
	}
	fail(error: string) {
		this.dispatchEvent(Object.assign(new Event('error'), { error }));
	}
	end() {
		this.dispatchEvent(new Event('end'));
	}
}

const globals = window as unknown as Record<string, unknown>;

beforeAll(async () => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
	// Loaded once, so a mount's `flushPromises` covers the composable's import of it.
	await import('@owlat/desktop/src/dictation');
});

afterEach(() => {
	delete globals.webkitSpeechRecognition;
	delete globals.__TAURI_INTERNALS__;
	channels.length = 0;
	FakeRecognition.last = null;
	useToast().clearToasts();
});

async function mountButton(props: Record<string, unknown> = {}) {
	const input = document.createElement('input');
	input.value = 'Thursday';
	document.body.appendChild(input);
	const wrapper = mount(DictationButton, {
		props: { target: input, ...props },
		attachTo: document.body,
		global: { plugins: [createTestI18n()] },
	});
	await flushPromises();
	return { wrapper, input };
}

const button = (w: Awaited<ReturnType<typeof mountButton>>['wrapper']) =>
	w.find('[data-testid="dictation-button"]');

describe('DictationButton', () => {
	it('is not there where the browser cannot turn speech into text', async () => {
		const { wrapper } = await mountButton();
		expect(button(wrapper).exists()).toBe(false);
	});

	it('is a labelled toggle that says the audio goes to the browser, not to Owlat', async () => {
		globals.webkitSpeechRecognition = FakeRecognition;
		const { wrapper } = await mountButton();
		const mic = button(wrapper);
		expect(mic.attributes('aria-label')).toBe('Dictate');
		expect(mic.attributes('aria-pressed')).toBe('false');
		const note = document.getElementById(mic.attributes('aria-describedby')!);
		expect(note?.textContent).toContain("Your browser's speech service");
		expect(note?.textContent).toContain('Owlat never receives it');
		expectFullyLocalized(wrapper);
	});

	it('listens on press, announces it, and writes a finished phrase at the caret', async () => {
		globals.webkitSpeechRecognition = FakeRecognition;
		const { wrapper, input } = await mountButton();
		await button(wrapper).trigger('click');
		expect(button(wrapper).attributes('aria-pressed')).toBe('true');
		expect(wrapper.find('[data-testid="dictation-bubble"]').exists()).toBe(true);
		expect(useAnnounce().politeMessage.value).toMatch(/^Listening\./);

		FakeRecognition.last!.finish('works for us');
		expect(input.value).toBe('Thursday works for us');

		await button(wrapper).trigger('click');
		expect(FakeRecognition.last!.stop).toHaveBeenCalled();
		expect(button(wrapper).attributes('aria-pressed')).toBe('false');
		expect(useAnnounce().politeMessage.value).toMatch(/^Stopped listening/);
	});

	it('cancels on Esc, and the page never sees that Esc', async () => {
		globals.webkitSpeechRecognition = FakeRecognition;
		const { wrapper } = await mountButton();
		const page = vi.fn();
		document.addEventListener('keydown', page);
		await button(wrapper).trigger('click');
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
		await flushPromises();
		expect(FakeRecognition.last!.abort).toHaveBeenCalled();
		expect(button(wrapper).attributes('aria-pressed')).toBe('false');
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
		expect(page).toHaveBeenCalledTimes(1);
		document.removeEventListener('keydown', page);
	});

	it('stops listening when its field goes away', async () => {
		globals.webkitSpeechRecognition = FakeRecognition;
		const { wrapper } = await mountButton();
		await button(wrapper).trigger('click');
		await wrapper.setProps({ disabled: true });
		expect(FakeRecognition.last!.abort).toHaveBeenCalled();
	});

	it('explains a blocked microphone in a toast', async () => {
		globals.webkitSpeechRecognition = FakeRecognition;
		const { wrapper } = await mountButton();
		await button(wrapper).trigger('click');
		FakeRecognition.last!.fail('not-allowed');
		FakeRecognition.last!.end();
		await flushPromises();
		const toast = useToast().toasts.value.at(-1);
		expect(toast?.type).toBe('error');
		expect(toast?.message).toContain('microphone');
	});

	it("in the desktop app, points a blocked microphone to the system's settings", async () => {
		globals.__TAURI_INTERNALS__ = {};
		const { wrapper } = await mountButton();
		await button(wrapper).trigger('click');
		channels.at(-1)!.deliver({ kind: 'error', reason: 'blocked' });
		channels.at(-1)!.deliver({ kind: 'end' });
		await flushPromises();
		const toast = useToast().toasts.value.at(-1);
		expect(toast?.type).toBe('error');
		expect(toast?.message).toContain("system's privacy settings");
	});
});
