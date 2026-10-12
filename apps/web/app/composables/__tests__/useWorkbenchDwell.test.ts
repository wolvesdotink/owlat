// @vitest-environment happy-dom
/**
 * The Workbench marks a tab seen when the viewer leaves it after half a minute
 * with its summary on screen. Only on-screen time counts, and the watermark
 * moves only to the server time of the last snapshot that was on screen, so a
 * tab hidden by Zen mode (or still loading) is never acknowledged behind the
 * viewer's back, whatever the browser's clock says.
 */
import { describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { useWorkbenchDwell, WORKBENCH_DWELL_MS } from '../useWorkbenchDwell';

/** Server times of the snapshots the tab receives. */
const SNAPSHOT_1 = 1_000_000;
const SNAPSHOT_2 = 1_045_000;

function setup(initial: { scope: string | null; showing: boolean; clock?: number }) {
	// The browser's own clock, deliberately unrelated to the server's.
	let clock = initial.clock ?? 0;
	const scope = ref<string | null>(initial.scope);
	const showing = ref(initial.showing);
	const asOf = ref<number | null>(SNAPSHOT_1);
	const markSeen = vi.fn();
	const wrapper = mount(
		defineComponent({
			setup() {
				useWorkbenchDwell({ scope, showing, asOf, markSeen, now: () => clock });
				return () => h('div');
			},
		})
	);
	return {
		scope,
		showing,
		asOf,
		markSeen,
		wrapper,
		advance: (ms: number) => (clock += ms),
	};
}

describe('useWorkbenchDwell', () => {
	it('marks a tab seen, as of the snapshot on screen, when left after half a minute', async () => {
		const t = setup({ scope: 'ada', showing: true });
		t.advance(WORKBENCH_DWELL_MS);
		t.scope.value = 'team';
		await nextTick();
		expect(t.markSeen).toHaveBeenCalledWith('ada', SNAPSHOT_1);
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
		expect(t.markSeen).toHaveBeenCalledWith('ada', SNAPSHOT_1);
	});

	it('follows a new snapshot while it is on screen', async () => {
		const t = setup({ scope: 'ada', showing: true });
		t.advance(10_000);
		t.asOf.value = SNAPSHOT_2; // new mail, shown
		await nextTick();
		t.advance(WORKBENCH_DWELL_MS);
		t.wrapper.unmount();
		expect(t.markSeen).toHaveBeenCalledWith('ada', SNAPSHOT_2);
	});

	it('ignores snapshots that arrive while hidden, even with the browser clock far ahead', async () => {
		// The browser is an hour ahead of the server; its clock never reaches `at`.
		const t = setup({ scope: 'ada', showing: true, clock: SNAPSHOT_1 + 3_600_000 });
		t.advance(WORKBENCH_DWELL_MS);
		t.showing.value = false; // into Zen
		await nextTick();
		t.asOf.value = SNAPSHOT_2; // mail arrives out of view
		await nextTick();
		t.advance(60_000);
		t.wrapper.unmount(); // left while still in Zen
		expect(t.markSeen).toHaveBeenCalledWith('ada', SNAPSHOT_1);
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

	it('keeps the last snapshot that was on screen when the view loses its time', async () => {
		const t = setup({ scope: 'ada', showing: true });
		t.asOf.value = null;
		await nextTick();
		t.advance(WORKBENCH_DWELL_MS);
		t.wrapper.unmount();
		expect(t.markSeen).toHaveBeenCalledWith('ada', SNAPSHOT_1);
	});
});
