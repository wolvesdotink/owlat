/**
 * Dictation through the Web Speech API: offered only where an engine exists
 * (and in the desktop app only on-device), finished phrases out, the phrase
 * being heard shown but never handed on, Esc's cancel dropping it, and the
 * engine's failures named in the UI's terms.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { useSpeechDictation } from '../useSpeechDictation';

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

// Not `vi.unstubAllGlobals`: that would also take the suite's Nuxt auto-import stubs.
afterEach(() => {
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
});
