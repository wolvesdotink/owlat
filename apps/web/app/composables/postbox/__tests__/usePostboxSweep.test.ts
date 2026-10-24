/**
 * usePostboxSweep — the pointer bookkeeping behind press-and-drag across rows.
 *
 * Rows are plain elements with stubbed `getBoundingClientRect` tops (50px
 * apart), so the sweep's hit-test runs for real; the pointer and key events are
 * dispatched on `window`, where a sweep listens once it has started. What this
 * pins is where a sweep goes wrong: a mutation before release, a click left
 * behind that toggles a checkbox or opens a message, an Esc that also closes
 * the reader, and listeners that outlive the list.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { effectScope, nextTick, ref, type EffectScope } from 'vue';
import { usePostboxSweep, type PostboxSweepCommit } from '../usePostboxSweep';
import type { PostboxSweepMark } from '~/utils/postboxSweep';

const ROW_PX = 50;

function buildList(ids: string[]) {
	const list = document.createElement('ul');
	for (const [i, id] of ids.entries()) {
		const li = document.createElement('li');
		li.dataset['sweepRow'] = id;
		li.getBoundingClientRect = () => ({ top: i * ROW_PX, bottom: (i + 1) * ROW_PX }) as DOMRect;
		list.appendChild(li);
	}
	document.body.appendChild(list);
	return list;
}

/** Row `i`'s vertical middle. */
const yOf = (i: number) => i * ROW_PX + ROW_PX / 2;

function pointer(
	type: string,
	init: { y: number; x?: number; pointerType?: string; button?: number; shiftKey?: boolean }
): PointerEvent {
	const event = new Event(type, { bubbles: true, cancelable: true });
	Object.defineProperties(event, {
		clientX: { value: init.x ?? 10 },
		clientY: { value: init.y },
		pointerType: { value: init.pointerType ?? 'mouse' },
		pointerId: { value: 1 },
		isPrimary: { value: true },
		button: { value: init.button ?? 0 },
		shiftKey: { value: init.shiftKey ?? false },
		metaKey: { value: false },
		ctrlKey: { value: false },
		altKey: { value: false },
	});
	return event as PointerEvent;
}

let scope: EffectScope;
let order: ReturnType<typeof ref<string[]>>;
let selected: Set<string>;
let scopeKey: ReturnType<typeof ref<string>>;
let commits: PostboxSweepCommit[];
let list: HTMLElement;

function mountSweep(canApply?: (mark: PostboxSweepMark, originId: string, id: string) => boolean) {
	scope = effectScope();
	return scope.run(() =>
		usePostboxSweep({
			orderedIds: () => order.value!,
			listEl: () => list,
			isSelected: (id) => selected.has(id),
			canApply,
			scopeKey: () => scopeKey.value,
			onCommit: (commit) => commits.push(commit),
		})
	)!;
}

/** Press at row `from`, drag through to row `to` (one move per row). */
function drag(
	sweep: ReturnType<typeof mountSweep>,
	kind: 'select' | 'archive',
	from: number,
	to: number
) {
	const started = sweep.start(kind, order.value![from]!, pointer('pointerdown', { y: yOf(from) }));
	const step = to >= from ? 1 : -1;
	window.dispatchEvent(pointer('pointermove', { y: yOf(from) + step * 8 }));
	for (let i = from; i !== to + step; i += step) {
		window.dispatchEvent(pointer('pointermove', { y: yOf(i) }));
	}
	return started;
}

const release = (row: number) => window.dispatchEvent(pointer('pointerup', { y: yOf(row) }));

/** A click as the browser sends it after the pointerup; true if something swallowed it. */
function click(): boolean {
	const event = new MouseEvent('click', { bubbles: true, cancelable: true });
	document.body.dispatchEvent(event);
	return event.defaultPrevented;
}

beforeEach(() => {
	vi.useFakeTimers();
	order = ref(['a', 'b', 'c', 'd', 'e']);
	selected = new Set();
	scopeKey = ref('inbox');
	commits = [];
	list = buildList(order.value!);
});

afterEach(() => {
	scope.stop();
	list.remove();
	vi.useRealTimers();
});

describe('usePostboxSweep', () => {
	it('selects exactly the rows dragged across, and only on release', () => {
		const sweep = mountSweep();
		expect(drag(sweep, 'select', 1, 3)).toBe(true);

		expect(commits).toEqual([]);
		expect(['a', 'b', 'c', 'd', 'e'].map((id) => sweep.markOf(id))).toEqual([
			null,
			'select',
			'select',
			'select',
			null,
		]);
		expect(sweep.status.value).toEqual({ mark: 'select', count: 3 });

		release(3);
		expect(commits).toEqual([{ mark: 'select', originId: 'b', ids: ['b', 'c', 'd'] }]);
		expect(sweep.status.value).toBeNull();
		expect(sweep.markOf('c')).toBeNull();
	});

	it('sweeps upwards just as well, and shrinks when the pointer comes back', () => {
		const sweep = mountSweep();
		drag(sweep, 'select', 4, 1);
		expect(sweep.status.value?.count).toBe(4);
		window.dispatchEvent(pointer('pointermove', { y: yOf(3) }));
		expect(sweep.status.value?.count).toBe(2);

		release(3);
		expect(commits[0]?.ids).toEqual(['d', 'e']);
	});

	it('deselects when it starts on a ticked box', () => {
		selected = new Set(['b', 'c']);
		const sweep = mountSweep();
		drag(sweep, 'select', 2, 4);
		expect(sweep.markOf('d')).toBe('deselect');
		release(4);
		expect(commits[0]).toEqual({ mark: 'deselect', originId: 'c', ids: ['c', 'd', 'e'] });
	});

	it('archives only the rows the action applies to', () => {
		const sweep = mountSweep((mark, _origin, id) => mark !== 'archive' || id !== 'c');
		drag(sweep, 'archive', 0, 4);
		expect(sweep.markOf('c')).toBeNull();
		release(4);
		expect(commits).toEqual([{ mark: 'archive', originId: 'a', ids: ['a', 'b', 'd', 'e'] }]);
	});

	it('swallows the one click a finished sweep leaves behind, and no later one', () => {
		const sweep = mountSweep();
		drag(sweep, 'select', 0, 2);
		release(2);
		expect(click()).toBe(true);
		expect(click()).toBe(false);
	});

	it('stops waiting for that click once the release task is over', () => {
		const sweep = mountSweep();
		drag(sweep, 'select', 0, 2);
		release(2);
		vi.runAllTimers();
		expect(click()).toBe(false);
	});

	it('leaves a plain click alone: no sweep, no commit, the click goes through', () => {
		const sweep = mountSweep();
		sweep.start('select', 'b', pointer('pointerdown', { y: yOf(1) }));
		// A jitter under the start distance is still a click.
		window.dispatchEvent(pointer('pointermove', { y: yOf(1) + 2 }));
		release(1);
		expect(commits).toEqual([]);
		expect(click()).toBe(false);
	});

	it('refuses touch, Shift and secondary-button presses', () => {
		const sweep = mountSweep();
		expect(sweep.start('select', 'b', pointer('pointerdown', { y: 0, pointerType: 'touch' }))).toBe(
			false
		);
		expect(sweep.start('select', 'b', pointer('pointerdown', { y: 0, shiftKey: true }))).toBe(
			false
		);
		expect(sweep.start('archive', 'b', pointer('pointerdown', { y: 0, button: 2 }))).toBe(false);
		window.dispatchEvent(pointer('pointermove', { y: yOf(4) }));
		release(4);
		expect(commits).toEqual([]);
		expect(sweep.status.value).toBeNull();
	});

	it('Esc cancels: no commit, the preview clears, and the key goes no further', () => {
		const sweep = mountSweep();
		const laterListener = vi.fn();
		window.addEventListener('keydown', laterListener);
		drag(sweep, 'archive', 0, 3);

		const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
		document.body.dispatchEvent(esc);
		expect(esc.defaultPrevented).toBe(true);
		expect(laterListener).not.toHaveBeenCalled();
		expect(sweep.status.value).toBeNull();

		// Moving on after Esc does not revive it, and release applies nothing...
		window.dispatchEvent(pointer('pointermove', { y: yOf(4) }));
		expect(sweep.status.value).toBeNull();
		release(4);
		expect(commits).toEqual([]);
		// ...but still eats the click, which would otherwise toggle or archive.
		expect(click()).toBe(true);
		window.removeEventListener('keydown', laterListener);
	});

	it('Esc with no sweep in flight is left to the page', () => {
		mountSweep();
		const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
		document.body.dispatchEvent(esc);
		expect(esc.defaultPrevented).toBe(false);
	});

	it('a cancelled pointer applies nothing and stops listening', () => {
		const sweep = mountSweep();
		drag(sweep, 'select', 0, 2);
		window.dispatchEvent(pointer('pointercancel', { y: yOf(2) }));
		expect(sweep.status.value).toBeNull();
		release(2);
		expect(commits).toEqual([]);
		expect(click()).toBe(false);
	});

	it('a scope change mid-sweep (another folder) cancels it', async () => {
		const sweep = mountSweep();
		drag(sweep, 'archive', 0, 2);
		scopeKey.value = 'archive';
		await nextTick();
		expect(sweep.status.value).toBeNull();
		release(2);
		expect(commits).toEqual([]);
	});

	it('applies nothing when the origin row leaves the list mid-sweep', () => {
		const sweep = mountSweep();
		drag(sweep, 'archive', 1, 3);
		order.value = ['a', 'c', 'd', 'e'];
		release(3);
		expect(commits).toEqual([]);
	});

	it('resolves the range against the whole row order, not just the mounted rows', () => {
		// A windowed list mounts a slice; the rows between two mounted ones that
		// are loaded but not rendered still belong to the range.
		order.value = ['a', 'b', 'x', 'y', 'c', 'd', 'e'];
		const sweep = mountSweep();
		drag(sweep, 'select', 1, 2);
		release(2);
		expect(commits[0]?.ids).toEqual(['b', 'x', 'y', 'c']);
	});

	it('removes every window listener when the list goes away mid-sweep', () => {
		const remove = vi.spyOn(window, 'removeEventListener');
		const sweep = mountSweep();
		drag(sweep, 'select', 0, 2);
		scope.stop();
		const removed = remove.mock.calls.map(([type]) => type);
		for (const type of ['pointermove', 'pointerup', 'pointercancel', 'keydown', 'blur', 'scroll']) {
			expect(removed).toContain(type);
		}
		release(2);
		expect(commits).toEqual([]);
		expect(sweep.status.value).toBeNull();
		remove.mockRestore();
	});
});
