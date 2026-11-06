/**
 * Dictation through the Web Speech API, or in the desktop app through the
 * shell's on-device engine: offered only where an engine exists (and in the
 * desktop app only on-device), finished phrases out, the phrase being heard
 * shown but never handed on, Esc's cancel dropping it, and the engine's
 * failures named in the UI's terms.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import type { NativeDictationEvent } from '@owlat/desktop/src/dictation';
import { useSpeechDictation } from '../useSpeechDictation';

// The desktop shell's IPC: `invoke` by command, and the `Channel` each
// `dictation_start` hands its events to.
const { invokeMock, channels } = vi.hoisted(() => ({
	invokeMock: vi.fn(),
	channels: [] as { deliver: (event: unknown) => void }[],
}));
vi.mock('@tauri-apps/api/core', () => ({
	invoke: (...args: unknown[]) => invokeMock(...args),
	Channel: class {
		deliver: (event: unknown) => void;
		constructor(onmessage: (event: unknown) => void) {
			this.deliver = onmessage;
			channels.push(this);
		}
	},
}));

/** A shell whose native engine can (or cannot) dictate on-device; sessions get id 7. */
function nativeEngine(local: boolean) {
	invokeMock.mockImplementation(async (cmd: string) => {
		if (cmd === 'dictation_available') return local;
		if (cmd === 'dictation_start') return 7;
		return undefined;
	});
}
/** What the shell says to the latest session (a newer shell may name reasons this one does not know). */
function shell(event: NativeDictationEvent | { kind: 'error'; reason: string }) {
	channels.at(-1)!.deliver(event);
}

class FakeRecognition extends EventTarget {
	static instances: FakeRecognition[] = [];
	lang = '';
	continuous = false;
	interimResults = false;
	start = vi.fn();
	stop = vi.fn(() => this.end());
	abort = vi.fn(() => this.end());
	constructor() {
		super();
		FakeRecognition.instances.push(this);
	}
	/** The engine reports results `[text, isFinal]` from `resultIndex` on. */
	hear(...results: [string, boolean][]) {
		const list = results.map(([transcript, isFinal]) =>
			Object.assign([{ transcript }], { isFinal })
		);
		this.dispatchEvent(Object.assign(new Event('result'), { resultIndex: 0, results: list }));
	}
	fail(error: string) {
		this.dispatchEvent(Object.assign(new Event('error'), { error }));
	}
	end() {
		this.dispatchEvent(new Event('end'));
	}
}

/** A Chromium engine that can run `lang` on-device when `local` says so. */
function onDeviceEngine(local: boolean) {
	return class extends FakeRecognition {
		static available = vi.fn(async () => (local ? 'available' : 'downloadable'));
		#processLocally = false;
		// An accessor, so it sits on the prototype like Chromium's attribute.
		get processLocally() {
			return this.#processLocally;
		}
		set processLocally(value: boolean) {
			this.#processLocally = value;
		}
	};
}

function setup() {
	const phrases: string[] = [];
	let api!: ReturnType<typeof useSpeechDictation>;
	const wrapper = mount(
		defineComponent({
			setup() {
				api = useSpeechDictation({ onPhrase: (phrase) => phrases.push(phrase) });
				return () => h('div');
			},
		})
	);
	return { api, phrases, wrapper };
}

const globals = window as unknown as Record<string, unknown>;
/** Put an engine on `window` under one of the names browsers use. */
function install(name: 'SpeechRecognition' | 'webkitSpeechRecognition', engine: unknown) {
	globals[name] = engine;
}

// The composable loads the bridge on mount; loaded once here, a mount's
// `flushPromises` covers it.
beforeAll(async () => {
	await import('@owlat/desktop/src/dictation');
});

// A shell without the dictation commands rejects them.
beforeEach(() => {
	invokeMock.mockRejectedValue(new Error('command dictation_available not found'));
});

// Not `vi.unstubAllGlobals`: that would also take the suite's Nuxt auto-import stubs.
afterEach(() => {
	invokeMock.mockReset();
	channels.length = 0;
	FakeRecognition.instances = [];
	for (const name of ['SpeechRecognition', 'webkitSpeechRecognition', '__TAURI_INTERNALS__']) {
		delete globals[name];
	}
});

describe('useSpeechDictation', () => {
	it('offers nothing where the browser has no speech engine', async () => {
		const { api } = setup();
		await flushPromises();
		expect(api.available.value).toBe(false);
		api.start();
		expect(api.listening.value).toBe(false);
	});

	it('hands on finished phrases and only shows the one being heard', async () => {
		install('webkitSpeechRecognition', FakeRecognition);
		const { api, phrases } = setup();
		await flushPromises();
		expect(api.available.value).toBe(true);
		expect(api.onDevice.value).toBe(false);

		api.start();
		const rec = FakeRecognition.instances[0]!;
		expect(rec.start).toHaveBeenCalled();
		expect(rec.continuous && rec.interimResults).toBe(true);
		expect(api.listening.value).toBe(true);

		rec.hear(['tell them Thursday', false]);
		expect(api.interim.value).toBe('tell them Thursday');
		expect(phrases).toEqual([]);

		rec.hear(['tell them Thursday works', true], [' and ask', false]);
		expect(phrases).toEqual(['tell them Thursday works']);
		expect(api.interim.value).toBe('and ask');

		api.stop();
		expect(rec.stop).toHaveBeenCalled();
		expect(api.listening.value).toBe(false);
		expect(api.interim.value).toBe('');
	});

	it('drops the phrase being heard on cancel, and anything the engine says after', async () => {
		install('webkitSpeechRecognition', FakeRecognition);
		const { api, phrases } = setup();
		await flushPromises();
		api.start();
		const rec = FakeRecognition.instances[0]!;
		rec.hear(['ask for the agenda', false]);

		api.cancel();
		rec.hear(['ask for the agenda', true]);
		expect(rec.abort).toHaveBeenCalled();
		expect(api.listening.value).toBe(false);
		expect(api.interim.value).toBe('');
		expect(phrases).toEqual([]);
		expect(api.error.value).toBeNull();
	});

	it("names the engine's failures, and ignores its report of our own cancel", async () => {
		install('webkitSpeechRecognition', FakeRecognition);
		const { api } = setup();
		await flushPromises();
		for (const [engine, ours] of [
			['not-allowed', 'blocked'],
			['no-speech', 'no-speech'],
			['network', 'network'],
			['language-not-supported', 'language'],
			['bad-grammar', 'failed'],
			['aborted', null],
		] as const) {
			api.error.value = null;
			api.start();
			const rec = FakeRecognition.instances.at(-1)!;
			rec.fail(engine);
			rec.end();
			expect(api.error.value).toBe(ours);
		}
	});

	it('stops listening when its component goes away', async () => {
		install('webkitSpeechRecognition', FakeRecognition);
		const { api, wrapper } = setup();
		await flushPromises();
		api.start();
		wrapper.unmount();
		expect(FakeRecognition.instances[0]!.abort).toHaveBeenCalled();
	});

	it('runs on-device where the engine can, and says so', async () => {
		const Engine = onDeviceEngine(true);
		install('SpeechRecognition', Engine);
		const { api } = setup();
		await flushPromises();
		expect(Engine.available).toHaveBeenCalledWith({
			langs: [navigator.language],
			processLocally: true,
		});
		expect(api.onDevice.value).toBe(true);
		api.start();
		expect((FakeRecognition.instances[0] as InstanceType<typeof Engine>).processLocally).toBe(true);
	});

	it('in the desktop app, offers dictation only on-device', async () => {
		globals.__TAURI_INTERNALS__ = {};
		install('webkitSpeechRecognition', FakeRecognition);
		const plain = setup();
		await flushPromises();
		expect(plain.api.available.value).toBe(false);

		install('SpeechRecognition', onDeviceEngine(false));
		const notInstalled = setup();
		await flushPromises();
		expect(notInstalled.api.available.value).toBe(false);

		install('SpeechRecognition', onDeviceEngine(true));
		const local = setup();
		await flushPromises();
		expect(local.api.available.value).toBe(true);
		expect(local.api.onDevice.value).toBe(true);
	});

	it('in the desktop app, dictates through the native on-device engine', async () => {
		globals.__TAURI_INTERNALS__ = {};
		nativeEngine(true);
		const { api, phrases } = setup();
		await flushPromises();
		expect(invokeMock).toHaveBeenCalledWith('dictation_available', { lang: navigator.language });
		expect(api.available.value).toBe(true);
		expect(api.onDevice.value).toBe(true);

		api.start();
		expect(api.listening.value).toBe(true);
		expect(invokeMock).toHaveBeenCalledWith('dictation_start', {
			lang: navigator.language,
			onEvent: expect.anything(),
		});
		await flushPromises();

		shell({ kind: 'partial', text: 'tell them Thursday' });
		expect(api.interim.value).toBe('tell them Thursday');
		expect(phrases).toEqual([]);
		shell({ kind: 'phrase', text: 'Tell them Thursday works.' });
		expect(phrases).toEqual(['Tell them Thursday works.']);
		expect(api.interim.value).toBe('');

		api.stop();
		expect(invokeMock).toHaveBeenCalledWith('dictation_stop', { session: 7 });
		shell({ kind: 'end' });
		expect(api.listening.value).toBe(false);
	});

	it('resets the mic when the shell ends the session on its own, as a hidden window does', async () => {
		globals.__TAURI_INTERNALS__ = {};
		nativeEngine(true);
		const { api, phrases } = setup();
		await flushPromises();
		api.start();
		await flushPromises();
		shell({ kind: 'partial', text: 'ask for the agenda' });
		expect(api.interim.value).toBe('ask for the agenda');

		shell({ kind: 'end' });
		expect(api.listening.value).toBe(false);
		expect(api.interim.value).toBe('');
		expect(api.error.value).toBeNull();
		expect(phrases).toEqual([]);
		expect(invokeMock).not.toHaveBeenCalledWith('dictation_stop', expect.anything());
		expect(invokeMock).not.toHaveBeenCalledWith('dictation_cancel', expect.anything());

		// Shown again, the window can dictate again.
		api.start();
		expect(api.listening.value).toBe(true);
		expect(invokeMock.mock.calls.filter(([cmd]) => cmd === 'dictation_start')).toHaveLength(2);
		await flushPromises();
		shell({ kind: 'end' });
	});

	it('cancels the native session and ignores what it says after', async () => {
		globals.__TAURI_INTERNALS__ = {};
		nativeEngine(true);
		const { api, phrases } = setup();
		await flushPromises();
		api.start();
		await flushPromises();
		shell({ kind: 'partial', text: 'ask for the agenda' });

		api.cancel();
		expect(invokeMock).toHaveBeenCalledWith('dictation_cancel', { session: 7 });
		expect(api.listening.value).toBe(false);
		expect(api.interim.value).toBe('');
		shell({ kind: 'phrase', text: 'ask for the agenda' });
		shell({ kind: 'end' });
		expect(phrases).toEqual([]);
		expect(api.error.value).toBeNull();
	});

	it('cancels a native session that had not started yet once it does', async () => {
		globals.__TAURI_INTERNALS__ = {};
		nativeEngine(true);
		const { api, wrapper } = setup();
		await flushPromises();
		api.start();
		wrapper.unmount();
		await flushPromises();
		expect(invokeMock).toHaveBeenCalledWith('dictation_cancel', { session: 7 });
	});

	it("names the native engine's failures", async () => {
		globals.__TAURI_INTERNALS__ = {};
		nativeEngine(true);
		const { api } = setup();
		await flushPromises();
		for (const [native, ours] of [
			['blocked', 'blocked'],
			['no-speech', 'no-speech'],
			['language', 'language'],
			['failed', 'failed'],
			['something-new', 'failed'],
		] as const) {
			api.error.value = null;
			api.start();
			shell({ kind: 'error', reason: native });
			shell({ kind: 'end' });
			expect(api.error.value).toBe(ours);
			expect(api.listening.value).toBe(false);
		}

		invokeMock.mockRejectedValue(new Error('no microphone'));
		api.error.value = null;
		api.start();
		await flushPromises();
		expect(api.error.value).toBe('failed');
		expect(api.listening.value).toBe(false);
	});

	it('keeps the mic hidden where the native engine cannot stay on the device', async () => {
		globals.__TAURI_INTERNALS__ = {};
		nativeEngine(false);
		const unavailable = setup();
		await flushPromises();
		expect(unavailable.api.available.value).toBe(false);
		unavailable.api.start();
		expect(invokeMock).not.toHaveBeenCalledWith('dictation_start', expect.anything());

		// An older shell without the commands, over a webview engine that is not on-device.
		invokeMock.mockRejectedValue(new Error('command dictation_available not found'));
		install('webkitSpeechRecognition', FakeRecognition);
		const older = setup();
		await flushPromises();
		expect(older.api.available.value).toBe(false);
	});

	it('asks no shell for dictation in the browser', async () => {
		install('webkitSpeechRecognition', FakeRecognition);
		setup();
		await flushPromises();
		expect(invokeMock).not.toHaveBeenCalled();
	});
});
