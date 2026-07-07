// @vitest-environment happy-dom
/**
 * The campaign wizard wraps its steps in <KeepAlive> so a step's component
 * instance survives navigation to a sibling step and back — the fix for the
 * old mutually-exclusive-v-if pattern that unmounted (and reset) each step.
 *
 * This asserts the mechanism the Setup step's A/B expander relies on: internal
 * state entered on step 1 persists after visiting step 2 and returning. The
 * same harness without <KeepAlive> is used as the control that DOES reset, so
 * the test proves the behaviour comes from KeepAlive, not from luck.
 */
import { describe, it, expect } from 'vitest';
import { defineComponent, h, ref, KeepAlive } from 'vue';
import { mount } from '@vue/test-utils';

// A stand-in "step" that carries local state (like the A/B expander's
// abTestExpanded / config refs). It resets to its initial value on remount.
const StepStub = defineComponent({
	setup() {
		const value = ref('');
		return { value };
	},
	template: `<input class="step-input" v-model="value" />`,
});

function makeHarness(keepAlive: boolean) {
	return defineComponent({
		components: { StepStub, KeepAlive },
		setup() {
			const step = ref<'a' | 'b'>('a');
			return { step };
		},
		render() {
			const active = this.step === 'a' ? h(StepStub, { key: 'a' }) : h(StepStub, { key: 'b' });
			return h('div', [
				keepAlive ? h(KeepAlive, null, { default: () => active }) : active,
				h('button', { class: 'to-b', onClick: () => (this.step = 'b') }, 'b'),
				h('button', { class: 'to-a', onClick: () => (this.step = 'a') }, 'a'),
			]);
		},
	});
}

async function roundTrip(keepAlive: boolean) {
	const wrapper = mount(makeHarness(keepAlive));
	await wrapper.find('input.step-input').setValue('configured');
	await wrapper.find('button.to-b').trigger('click');
	await wrapper.find('button.to-a').trigger('click');
	return (wrapper.find('input.step-input').element as HTMLInputElement).value;
}

describe('campaign wizard KeepAlive persistence', () => {
	it('preserves a step state across navigation to a sibling and back', async () => {
		expect(await roundTrip(true)).toBe('configured');
	});

	it('control: the same flow WITHOUT KeepAlive resets the step', async () => {
		expect(await roundTrip(false)).toBe('');
	});
});
