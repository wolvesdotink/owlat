/**
 * Postbox reading-pane util (utils/postboxReadingPane): pane normalisation, the
 * per-axis size clamp, the keyboard nudges, and the pane → geometry mapping the
 * layout and the divider both read.
 */
import { describe, it, expect } from 'vitest';
import {
	POSTBOX_LIST_SIZE_COARSE_STEP,
	POSTBOX_LIST_SIZE_LIMITS,
	POSTBOX_LIST_SIZE_STEP,
	POSTBOX_READING_PANE_DEFAULT,
	POSTBOX_READING_PANE_OPTIONS,
	clampPostboxListSize,
	nudgePostboxListSize,
	postboxListSizeFromPointer,
	postboxListSizeStep,
	postboxPaneGeometry,
	postboxPaneStyle,
	resolvePostboxListSize,
	resolvePostboxReadingPane,
} from '../postboxReadingPane';

describe('resolvePostboxReadingPane', () => {
	it('defaults to the right-hand pane — the geometry that already shipped', () => {
		expect(POSTBOX_READING_PANE_DEFAULT).toBe('right');
		expect(resolvePostboxReadingPane(undefined)).toBe('right');
		expect(resolvePostboxReadingPane(null)).toBe('right');
		expect(resolvePostboxReadingPane('sideways')).toBe('right');
	});

	it('passes through the three known panes', () => {
		expect(resolvePostboxReadingPane('right')).toBe('right');
		expect(resolvePostboxReadingPane('bottom')).toBe('bottom');
		expect(resolvePostboxReadingPane('off')).toBe('off');
	});

	it('offers exactly the three panes as options, each carrying a catalog key', () => {
		expect(POSTBOX_READING_PANE_OPTIONS.map((o) => o.value)).toEqual(['right', 'bottom', 'off']);
		for (const option of POSTBOX_READING_PANE_OPTIONS) {
			expect(option.label).toMatch(/^shared\.postboxReadingPane\./);
		}
	});
});

describe('clampPostboxListSize', () => {
	it('clamps into the axis bounds', () => {
		const { min, max } = POSTBOX_LIST_SIZE_LIMITS.width;
		expect(clampPostboxListSize(min - 500, 'width')).toBe(min);
		expect(clampPostboxListSize(max + 500, 'width')).toBe(max);
		expect(clampPostboxListSize(400, 'width')).toBe(400);
	});

	it('uses the height bounds on the height axis', () => {
		const height = POSTBOX_LIST_SIZE_LIMITS.height;
		expect(clampPostboxListSize(10, 'height')).toBe(height.min);
		expect(clampPostboxListSize(10_000, 'height')).toBe(height.max);
	});

	it('rounds to whole pixels', () => {
		expect(clampPostboxListSize(400.4, 'width')).toBe(400);
		expect(clampPostboxListSize(400.6, 'width')).toBe(401);
	});

	it('falls back to the axis default for a non-finite value', () => {
		expect(clampPostboxListSize(Number.NaN, 'width')).toBe(POSTBOX_LIST_SIZE_LIMITS.width.default);
		expect(clampPostboxListSize(Number.POSITIVE_INFINITY, 'height')).toBe(
			POSTBOX_LIST_SIZE_LIMITS.height.default
		);
	});
});

describe('resolvePostboxListSize', () => {
	it('resolves an unset width to 384px — the hardcoded lg:w-96 the layout had', () => {
		expect(POSTBOX_LIST_SIZE_LIMITS.width.default).toBe(384);
		expect(resolvePostboxListSize(undefined, 'width')).toBe(384);
		expect(resolvePostboxListSize(null, 'width')).toBe(384);
	});

	it('clamps a stored value that is out of range', () => {
		expect(resolvePostboxListSize(99_999, 'width')).toBe(POSTBOX_LIST_SIZE_LIMITS.width.max);
		expect(resolvePostboxListSize(1, 'height')).toBe(POSTBOX_LIST_SIZE_LIMITS.height.min);
	});
});

describe('nudgePostboxListSize', () => {
	it('moves by the signed delta', () => {
		expect(nudgePostboxListSize(400, POSTBOX_LIST_SIZE_STEP, 'width')).toBe(
			400 + POSTBOX_LIST_SIZE_STEP
		);
		expect(nudgePostboxListSize(400, -POSTBOX_LIST_SIZE_STEP, 'width')).toBe(
			400 - POSTBOX_LIST_SIZE_STEP
		);
	});

	it('saturates at the bounds instead of accumulating out of range', () => {
		const { min, max } = POSTBOX_LIST_SIZE_LIMITS.width;
		expect(nudgePostboxListSize(min, -POSTBOX_LIST_SIZE_COARSE_STEP, 'width')).toBe(min);
		expect(nudgePostboxListSize(max, POSTBOX_LIST_SIZE_COARSE_STEP, 'width')).toBe(max);
	});

	it('clamps a corrupt current value before moving', () => {
		expect(nudgePostboxListSize(99_999, POSTBOX_LIST_SIZE_STEP, 'width')).toBe(
			POSTBOX_LIST_SIZE_LIMITS.width.max
		);
	});

	it('takes a coarse step with the modifier held', () => {
		expect(postboxListSizeStep(false)).toBe(POSTBOX_LIST_SIZE_STEP);
		expect(postboxListSizeStep(true)).toBe(POSTBOX_LIST_SIZE_COARSE_STEP);
	});
});

describe('postboxPaneGeometry', () => {
	it('keeps the side-by-side layout resizable by width', () => {
		expect(postboxPaneGeometry('right')).toEqual({
			stack: 'row',
			axis: 'width',
			keepsListWhileReading: true,
		});
	});

	it('stacks the bottom pane and resizes it by height', () => {
		expect(postboxPaneGeometry('bottom')).toEqual({
			stack: 'column',
			axis: 'height',
			keepsListWhileReading: true,
		});
	});

	it('gives "off" no divider and lets opening a message take the whole width', () => {
		expect(postboxPaneGeometry('off')).toEqual({
			stack: 'row',
			axis: null,
			keepsListWhileReading: false,
		});
	});
});

describe('postboxPaneStyle', () => {
	it('publishes both custom properties, clamped', () => {
		expect(postboxPaneStyle(400, 300)).toEqual({
			'--pbx-list-width': '400px',
			'--pbx-list-height': '300px',
		});
		expect(postboxPaneStyle(99_999, 0)['--pbx-list-width']).toBe(
			`${POSTBOX_LIST_SIZE_LIMITS.width.max}px`
		);
	});
});

describe('postboxListSizeFromPointer', () => {
	it('measures the pointer from the pane origin', () => {
		expect(postboxListSizeFromPointer(700, 300, 'width')).toBe(400);
	});

	it('clamps a pointer dragged past either bound', () => {
		expect(postboxListSizeFromPointer(0, 300, 'width')).toBe(POSTBOX_LIST_SIZE_LIMITS.width.min);
		expect(postboxListSizeFromPointer(9_000, 0, 'width')).toBe(POSTBOX_LIST_SIZE_LIMITS.width.max);
	});
});
