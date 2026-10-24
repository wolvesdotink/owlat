/**
 * The vitest setup (setup.ts) unmounts every component a test mounted once that
 * test is over, whether it passed or failed, so a suite needs no teardown of
 * its own and a broken test cannot leave a live component behind for the next.
 *
 * The probe component holds the three things a leaked mount keeps alive: an
 * `onUnmounted` cleanup, a window listener and a node teleported into the body.
 * `onTestFinished` runs after every `afterEach` hook, so it sees the state the
 * next test would start from.
 */
import { describe, expect, it, onTestFinished } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h, onUnmounted, Teleport } from 'vue';

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
}

/** What the document looks like once the current test's hooks have all run. */
function recordAfterTest(record: (state: AfterTest) => void): void {
	const unmountedBefore = unmountCount;
	onTestFinished(() => {
		const heardBefore = keysHeard;
		pressKey();
		record({
			unmounted: unmountCount - unmountedBefore,
			probeInBody: probeInBody(),
			keysHeardAfterUnmount: keysHeard - heardBefore,
		});
	});
}

describe('auto-unmount in the shared vitest setup', () => {
	it('unmounts a component the test left mounted', () => {
		recordAfterTest((state) => {
			expect(state).toEqual({ unmounted: 1, probeInBody: false, keysHeardAfterUnmount: 0 });
		});

		mount(Probe);
		expect(probeInBody()).toBe(true);
		const heardBefore = keysHeard;
		pressKey();
		expect(keysHeard - heardBefore).toBe(1);
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
		expect(afterFailure).toEqual({ unmounted: 1, probeInBody: false, keysHeardAfterUnmount: 0 });
	});

	it('composes with an explicit unmount, attached mounts included', () => {
		recordAfterTest((state) => {
			expect(state).toEqual({ unmounted: 1, probeInBody: false, keysHeardAfterUnmount: 0 });
		});

		mount(Probe, { attachTo: document.body }).unmount();
		expect(probeInBody()).toBe(false);
	});
});
