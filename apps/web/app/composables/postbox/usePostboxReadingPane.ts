/**
 * The reading-pane geometry PostboxLayout renders, split out of that file
 * (which owns the panes themselves) to keep it under the file-size cap.
 *
 * Two jobs, both thin wrappers over the pure module (utils/postboxReadingPane):
 *
 *   - resolve the persisted pane into the geometry the template branches on
 *     (stack direction, which axis the divider moves, whether the list survives
 *     an open message), and
 *   - carry the divider's LIVE size while it is being dragged, then hand back
 *     to the server value once the write lands — the same optimistic-override
 *     shape usePostboxInboxModes uses for the view mode, for the same reason: a
 *     seam that waited for a round trip would lag the pointer.
 */

import type { Ref } from 'vue';
import type { PostboxPaneAxis, PostboxReadingPane } from '~/utils/postboxReadingPane';
import { postboxPaneGeometry, postboxPaneStyle } from '~/utils/postboxReadingPane';

interface PostboxReadingPaneOptions {
	readingPane: Ref<PostboxReadingPane>;
	listWidth: Ref<number>;
	listHeight: Ref<number>;
	setListSize: (axis: PostboxPaneAxis, size: number) => Promise<boolean>;
	/** Whether a message is open — the two panes trade places around it. */
	activeMessageId: Ref<string | null | undefined>;
}

export function usePostboxReadingPane(options: PostboxReadingPaneOptions) {
	const geometry = computed(() => postboxPaneGeometry(options.readingPane.value));

	// Border side follows the stack: a vertical seam rules on the right, a
	// stacked one underneath, and the pane-less layout has no seam to rule.
	const listPaneBorder = computed(() => {
		if (geometry.value.axis === 'height') return 'lg:border-b';
		return geometry.value.axis === 'width' ? 'lg:border-r' : '';
	});

	// With no reading pane the list owns the width outright: opening a message
	// hands the whole surface to the reader, exactly like the narrow drill-in.
	const listPaneVisibility = computed(() => {
		if (!options.activeMessageId.value) return 'flex';
		return geometry.value.keepsListWhileReading ? 'hidden lg:flex' : 'hidden';
	});
	const readerPaneVisibility = computed(() => {
		if (options.activeMessageId.value) return 'block';
		return geometry.value.keepsListWhileReading ? 'hidden lg:block' : 'hidden';
	});

	// Live drag overrides, one per axis. `null` means "no interaction in
	// flight — show what the server has".
	const pendingWidth = ref<number | null>(null);
	const pendingHeight = ref<number | null>(null);

	const width = computed(() => pendingWidth.value ?? options.listWidth.value);
	const height = computed(() => pendingHeight.value ?? options.listHeight.value);

	// Hand back to the saved value once it agrees with the override, so the two
	// never diverge silently after a successful write.
	watch(options.listWidth, (saved) => {
		if (pendingWidth.value === saved) pendingWidth.value = null;
	});
	watch(options.listHeight, (saved) => {
		if (pendingHeight.value === saved) pendingHeight.value = null;
	});

	/** The size of the axis currently being resized (width unless stacked). */
	const listSize = computed(() => (geometry.value.axis === 'height' ? height.value : width.value));

	/** Follow the pointer / key without writing anything. */
	function previewListSize(size: number) {
		if (geometry.value.axis === 'height') pendingHeight.value = size;
		else pendingWidth.value = size;
	}

	/** Persist the seam once the interaction ends; snap back if the save failed. */
	function commitListSize(size: number) {
		const axis = geometry.value.axis;
		if (!axis) return;
		previewListSize(size);
		void options.setListSize(axis, size).then((saved) => {
			if (saved) return;
			// useBackendOperation already toasted; drop the override so the layout
			// shows what the server actually holds rather than a phantom seam.
			if (axis === 'height') {
				if (pendingHeight.value === size) pendingHeight.value = null;
			} else if (pendingWidth.value === size) pendingWidth.value = null;
		});
	}

	/** The custom properties postbox-panes.css reads off the Postbox root. */
	const paneStyle = computed(() => postboxPaneStyle(width.value, height.value));

	return {
		geometry,
		listPaneBorder,
		listPaneVisibility,
		readerPaneVisibility,
		listSize,
		previewListSize,
		commitListSize,
		paneStyle,
	};
}
