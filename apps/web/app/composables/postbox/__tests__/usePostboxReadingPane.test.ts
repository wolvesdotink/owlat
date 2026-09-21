/**
 * usePostboxReadingPane — the layout-facing wrapper over the pure pane module:
 *   - maps the persisted pane to the geometry the template branches on,
 *   - shows a live drag override immediately and hands back once the server
 *     value agrees, and
 *   - snaps back to the saved seam when the persist failed.
 */
import { describe, it, expect, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import { usePostboxReadingPane } from '../usePostboxReadingPane';
import type { PostboxReadingPane } from '~/utils/postboxReadingPane';

function setup(
	pane: PostboxReadingPane,
	setListSize = vi.fn(async () => true),
	openMessage: string | null = null
) {
	const readingPane = ref<PostboxReadingPane>(pane);
	const listWidth = ref(384);
	const listHeight = ref(320);
	const activeMessageId = ref<string | null>(openMessage);
	const api = usePostboxReadingPane({
		readingPane,
		listWidth,
		listHeight,
		setListSize,
		activeMessageId,
	});
	return { ...api, readingPane, listWidth, listHeight, setListSize, activeMessageId };
}

describe('usePostboxReadingPane geometry', () => {
	it('resizes by width beside the list and by height when stacked', () => {
		expect(setup('right').geometry.value.axis).toBe('width');
		expect(setup('bottom').geometry.value.axis).toBe('height');
		expect(setup('off').geometry.value.axis).toBeNull();
	});

	it('reports the size of whichever axis is being resized', () => {
		expect(setup('right').listSize.value).toBe(384);
		expect(setup('bottom').listSize.value).toBe(320);
	});

	it('publishes both custom properties for the stylesheet', () => {
		expect(setup('right').paneStyle.value).toEqual({
			'--pbx-list-width': '384px',
			'--pbx-list-height': '320px',
		});
	});

	it('follows the pane preference as it changes', async () => {
		const { readingPane, geometry } = setup('right');
		readingPane.value = 'bottom';
		await nextTick();
		expect(geometry.value).toEqual({
			stack: 'column',
			axis: 'height',
			keepsListWhileReading: true,
		});
	});
});

describe('usePostboxReadingPane visibility', () => {
	it('keeps the stacked drill-in below lg with a message open', () => {
		// Both side-by-side panes hide the list only below `lg`, which is the
		// phone drill-in the responsive contract pins.
		for (const pane of ['right', 'bottom'] as const) {
			const open = setup(
				pane,
				vi.fn(async () => true),
				'msg-1'
			);
			expect(open.listPaneVisibility.value).toBe('hidden lg:flex');
			expect(open.readerPaneVisibility.value).toBe('block');
		}
	});

	it('shows the list and holds the reader back until a message is open', () => {
		const closed = setup('right');
		expect(closed.listPaneVisibility.value).toBe('flex');
		expect(closed.readerPaneVisibility.value).toBe('hidden lg:block');
	});

	it('hands the whole width over when the reading pane is off', () => {
		const closed = setup('off');
		expect(closed.listPaneVisibility.value).toBe('flex');
		// No empty "Select a message" pane at any width — there is no pane.
		expect(closed.readerPaneVisibility.value).toBe('hidden');

		const open = setup(
			'off',
			vi.fn(async () => true),
			'msg-1'
		);
		expect(open.listPaneVisibility.value).toBe('hidden');
		expect(open.readerPaneVisibility.value).toBe('block');
	});

	it('rules the seam on the side the stack puts it', () => {
		expect(setup('right').listPaneBorder.value).toBe('lg:border-r');
		expect(setup('bottom').listPaneBorder.value).toBe('lg:border-b');
		expect(setup('off').listPaneBorder.value).toBe('');
	});
});

describe('usePostboxReadingPane seam', () => {
	it('shows a preview immediately without writing', () => {
		const { previewListSize, listSize, setListSize } = setup('right');
		previewListSize(500);
		expect(listSize.value).toBe(500);
		expect(setListSize).not.toHaveBeenCalled();
	});

	it('commits the seam on the resized axis and keeps showing it', async () => {
		const { commitListSize, listSize, setListSize } = setup('bottom');
		commitListSize(260);
		expect(setListSize).toHaveBeenCalledWith('height', 260);
		await nextTick();
		expect(listSize.value).toBe(260);
	});

	it('hands back to the server value once it agrees', async () => {
		const { commitListSize, listSize, listWidth } = setup('right');
		commitListSize(500);
		listWidth.value = 500;
		await nextTick();
		expect(listSize.value).toBe(500);
		// The override is gone, so a later server change is honoured.
		listWidth.value = 420;
		await nextTick();
		expect(listSize.value).toBe(420);
	});

	it('snaps back to the saved seam when the save failed', async () => {
		const failing = vi.fn(async () => false);
		const { commitListSize, listSize } = setup('right', failing);
		commitListSize(500);
		expect(listSize.value).toBe(500);
		await nextTick();
		await nextTick();
		expect(listSize.value).toBe(384);
	});

	it('never writes on a pane that has no divider', () => {
		const { commitListSize, setListSize } = setup('off');
		commitListSize(500);
		expect(setListSize).not.toHaveBeenCalled();
	});
});
