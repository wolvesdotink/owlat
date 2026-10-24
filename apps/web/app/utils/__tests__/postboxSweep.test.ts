/**
 * The pure half of a sweep: which rows a press-and-drag covers, which row a
 * pointer height lands on, which presses may start one, and how a press on a
 * handle keeps the row's own drag out of the way.
 */
import { describe, it, expect, vi } from 'vitest';
import {
	createPostboxSweepHandle,
	isPostboxSweepPress,
	postboxSweepMark,
	postboxSweepRange,
	postboxSweepRowAtY,
} from '../postboxSweep';

const IDS = ['a', 'b', 'c', 'd', 'e'];

describe('postboxSweepRange', () => {
	it('covers origin to target inclusive, dragging down or up', () => {
		expect(postboxSweepRange(IDS, 'b', 'd')).toEqual(['b', 'c', 'd']);
		expect(postboxSweepRange(IDS, 'd', 'b')).toEqual(['b', 'c', 'd']);
		expect(postboxSweepRange(IDS, 'c', 'c')).toEqual(['c']);
	});

	it('keeps only the rows the action applies to', () => {
		expect(postboxSweepRange(IDS, 'a', 'e', (id) => id !== 'c')).toEqual(['a', 'b', 'd', 'e']);
	});

	it('covers nothing once the origin or the target has left the list', () => {
		expect(postboxSweepRange(IDS, 'gone', 'c')).toEqual([]);
		expect(postboxSweepRange(IDS, 'b', 'gone')).toEqual([]);
	});
});

describe('postboxSweepRowAtY', () => {
	const rows = [
		{ id: 'a', top: 0 },
		{ id: 'b', top: 50 },
		{ id: 'c', top: 100 },
	];

	it('finds the row whose band holds the height', () => {
		expect(postboxSweepRowAtY(rows, 10)).toBe('a');
		expect(postboxSweepRowAtY(rows, 50)).toBe('b');
		expect(postboxSweepRowAtY(rows, 99)).toBe('b');
	});

	it('clamps above the first row and below the last', () => {
		expect(postboxSweepRowAtY(rows, -200)).toBe('a');
		expect(postboxSweepRowAtY(rows, 5000)).toBe('c');
	});

	it('finds nothing in an empty list', () => {
		expect(postboxSweepRowAtY([], 10)).toBeNull();
	});
});

describe('postboxSweepMark', () => {
	it('takes a checkbox sweep’s direction from the box it starts on', () => {
		expect(postboxSweepMark('select', false)).toBe('select');
		expect(postboxSweepMark('select', true)).toBe('deselect');
		expect(postboxSweepMark('archive', true)).toBe('archive');
	});

	it('keeps Team Updates’ dismiss apart from archive', () => {
		expect(postboxSweepMark('dismiss', false)).toBe('dismiss');
		expect(postboxSweepMark('dismiss', true)).toBe('dismiss');
	});
});

describe('isPostboxSweepPress', () => {
	const plain = {
		pointerType: 'mouse',
		button: 0,
		isPrimary: true,
		shiftKey: false,
		metaKey: false,
		ctrlKey: false,
		altKey: false,
	};

	it('accepts a plain primary mouse press', () => {
		expect(isPostboxSweepPress(plain)).toBe(true);
	});

	it('leaves touch, pen, other buttons and modified clicks alone', () => {
		expect(isPostboxSweepPress({ ...plain, pointerType: 'touch' })).toBe(false);
		expect(isPostboxSweepPress({ ...plain, pointerType: 'pen' })).toBe(false);
		expect(isPostboxSweepPress({ ...plain, button: 2 })).toBe(false);
		expect(isPostboxSweepPress({ ...plain, shiftKey: true })).toBe(false);
		expect(isPostboxSweepPress({ ...plain, metaKey: true })).toBe(false);
		expect(isPostboxSweepPress({ ...plain, ctrlKey: true })).toBe(false);
		expect(isPostboxSweepPress({ ...plain, altKey: true })).toBe(false);
	});
});

describe('createPostboxSweepHandle', () => {
	/** A detached row: `closest` needs only the element's own ancestors. */
	function rowOf(html: string): HTMLElement {
		const li = document.createElement('li');
		li.innerHTML = html;
		return li;
	}
	function press(target: Element) {
		return { target } as unknown as PointerEvent;
	}
	function drag() {
		return { preventDefault: vi.fn() } as unknown as DragEvent & {
			preventDefault: ReturnType<typeof vi.fn>;
		};
	}

	it('reports a press on a handle and refuses the drag that follows it', () => {
		const row = rowOf(
			'<button data-sweep-handle="archive"><svg id="icon"></svg></button><span id="body"></span>'
		);
		const onStart = vi.fn();
		const handle = createPostboxSweepHandle(onStart);

		const event = press(row.querySelector('#icon')!);
		handle.onPointerdown(event);
		expect(onStart).toHaveBeenCalledWith('archive', event);
		const refused = drag();
		expect(handle.claimsDrag(refused)).toBe(true);
		expect(refused.preventDefault).toHaveBeenCalled();
	});

	it('lets a press elsewhere on the row start the row’s drag as before', () => {
		const row = rowOf('<button data-sweep-handle="select"></button><span id="body"></span>');
		const onStart = vi.fn();
		const handle = createPostboxSweepHandle(onStart);

		handle.onPointerdown(press(row.querySelector('[data-sweep-handle]')!));
		handle.onPointerdown(press(row.querySelector('#body')!));
		expect(onStart).toHaveBeenCalledTimes(1);
		const allowed = drag();
		expect(handle.claimsDrag(allowed)).toBe(false);
		expect(allowed.preventDefault).not.toHaveBeenCalled();
	});
});
