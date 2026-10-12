// @vitest-environment happy-dom
/**
 * The Workbench marks a tab seen when the viewer leaves it after half a minute
 * with its summary on screen. Only on-screen time counts, so a tab hidden by
 * Zen mode (or still loading) is never acknowledged behind the viewer's back.
 */
import { describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { useWorkbenchDwell, WORKBENCH_DWELL_MS } from '../useWorkbenchDwell';

function setup(initial: { scope: string | null; showing: boolean }) {
	let clock = 0;
	const scope = ref<string | null>(initial.scope);
	const showing = ref(initial.showing);
	const markSeen = vi.fn();
	const wrapper = mount(
		defineComponent({
			setup() {
				useWorkbenchDwell({ scope, showing, markSeen, now: () => clock });
				return () => h('div');
			},
		})
	);
	return {
		scope,
		showing,
		markSeen,
		wrapper,
		advance: (ms: number) => (clock += ms),
	};
}

describe('useWorkbenchDwell', () => {
	it('marks a tab seen when it is left after half a minute on screen', async () => {
		const t = setup({ scope: 'ada', showing: true });
		t.advance(WORKBENCH_DWELL_MS);
		t.scope.value = 'team';
		await nextTick();
		expect(t.markSeen).toHaveBeenCalledWith('ada');
	});

	it('leaves a short visit alone', async () => {
		const t = setup({ scope: 'ada', showing: true });
		t.advance(WORKBENCH_DWELL_MS - 1);
		t.scope.value = 'team';
		await nextTick();
		expect(t.markSeen).not.toHaveBeenCalled();
	});

	it('does not count time the summary was hidden (Zen), even when left in Zen', async () => {
		const t = setup({ scope: 'ada', showing: true });
		t.advance(1_000);
		t.showing.value = false; // Zen hides the bands
		await nextTick();
		t.advance(WORKBENCH_DWELL_MS);
		t.wrapper.unmount(); // navigated away, still in Zen
		expect(t.markSeen).not.toHaveBeenCalled();
	});

	it('adds up the stretches the summary was on screen', async () => {
		const t = setup({ scope: 'ada', showing: true });
		t.advance(20_000);
		t.showing.value = false;
		await nextTick();
		t.advance(60_000);
		t.showing.value = true;
		await nextTick();
		t.advance(10_000);
		t.wrapper.unmount();
		expect(t.markSeen).toHaveBeenCalledWith('ada');
	});

	it('starts each tab from zero', async () => {
		const t = setup({ scope: 'ada', showing: true });
		t.advance(20_000);
		t.scope.value = 'team';
		await nextTick();
		t.advance(20_000);
		t.wrapper.unmount();
		expect(t.markSeen).not.toHaveBeenCalled();
	});
});
