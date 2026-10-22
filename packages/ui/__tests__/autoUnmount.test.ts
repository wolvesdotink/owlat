/**
 * The vitest setup (vitest.setup.ts) unmounts every component a test mounted
 * once that test is over, whether it passed or failed: @vue/test-utils wrappers
 * through `enableAutoUnmount`, and the plain `createApp` mounts of `mountUi()`
 * through `unmountAllUi`. A suite needs no teardown of its own and a broken
 * test cannot leave a live component behind for the next.
 *
 * The probe component holds the three things a leaked mount keeps alive: an
 * `onUnmounted` cleanup, a window listener and a node teleported into the body.
 * `onTestFinished` runs after every `afterEach` hook, so it sees the state the
 * next test would start from.
 */
import { describe, expect, it, onTestFinished } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h, onUnmounted, Teleport } from 'vue';
import { mountUi } from './i18n';

let unmountCount = 0;
let keysHeard = 0;

const Probe = defineComponent({
	setup() {
		const onKey = () => {
			keysHeard += 1;
		};
		window.addEventListener('keydown', onKey);
		onUnmounted(() => {
			window.removeEventListener('keydown', onKey);
			unmountCount += 1;
		});
		return () => h(Teleport, { to: 'body' }, h('div', { 'data-auto-unmount-probe': '' }));
	},
});

const probeInBody = () => document.body.querySelector('[data-auto-unmount-probe]') !== null;
const pressKey = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j' }));

interface AfterTest {
	unmounted: number;
	probeInBody: boolean;
	keysHeardAfterUnmount: number;
	hostInBody?: boolean;
}

/** What the document looks like once the current test's hooks have all run. */
function recordAfterTest(record: (state: AfterTest) => void, host?: HTMLElement): void {
	const unmountedBefore = unmountCount;
	onTestFinished(() => {
		const heardBefore = keysHeard;
		pressKey();
		record({
			unmounted: unmountCount - unmountedBefore,
			probeInBody: probeInBody(),
			keysHeardAfterUnmount: keysHeard - heardBefore,
			...(host ? { hostInBody: document.body.contains(host) } : {}),
		});
	});
}

const CLEAN = { unmounted: 1, probeInBody: false, keysHeardAfterUnmount: 0 };

describe('auto-unmount of @vue/test-utils wrappers', () => {
	it('unmounts a wrapper the test left mounted', () => {
		recordAfterTest((state) => {
			expect(state).toEqual(CLEAN);
		});
		mount(Probe);
		expect(probeInBody()).toBe(true);
	});

	// The next case reads what this failing one left behind; vitest runs the
	// cases of a file in order.
	let afterFailure: AfterTest | undefined;

	it.fails('still unmounts when an assertion in the test fails', () => {
		recordAfterTest((state) => {
			afterFailure = state;
		});
		mount(Probe);
		expect(probeInBody()).toBe(false);
	});

	it('left nothing behind after the failed test', () => {
		expect(afterFailure).toEqual(CLEAN);
	});

	it('composes with an explicit unmount, attached mounts included', () => {
		recordAfterTest((state) => {
			expect(state).toEqual(CLEAN);
		});
		const wrapper = mount(Probe, { attachTo: document.body });
		wrapper.unmount();
		expect(probeInBody()).toBe(false);
	});
});

describe('auto-unmount of mountUi() apps', () => {
	it('unmounts an app the test left mounted and removes its host element', () => {
		const { el } = mountUi(Probe);
		recordAfterTest((state) => {
			expect(state).toEqual({ ...CLEAN, hostInBody: false });
		}, el);
		expect(document.body.contains(el)).toBe(true);
		expect(probeInBody()).toBe(true);
	});

	let afterFailure: AfterTest | undefined;

	it.fails('still unmounts when an assertion in the test fails', () => {
		const { el } = mountUi(Probe);
		recordAfterTest((state) => {
			afterFailure = state;
		}, el);
		expect(probeInBody()).toBe(false);
	});

	it('left nothing behind after the failed test', () => {
		expect(afterFailure).toEqual({ ...CLEAN, hostInBody: false });
	});

	it('unmounts once when the test unmounted early, however often unmount is called', () => {
		const ui = mountUi(Probe);
		recordAfterTest((state) => {
			expect(state).toEqual({ ...CLEAN, hostInBody: false });
		}, ui.el);
		const before = unmountCount;
		ui.unmount();
		ui.unmount();
		expect(unmountCount - before).toBe(1);
		expect(document.body.contains(ui.el)).toBe(false);
	});
});
