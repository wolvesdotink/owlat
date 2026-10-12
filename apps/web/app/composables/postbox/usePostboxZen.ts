import type { Ref } from 'vue';
import type { PostboxReadingPane } from '~/utils/postboxReadingPane';
import { useMediaQuery } from '~/composables/useMediaQuery';
import { useZenMode } from '~/composables/useZenMode';

/**
 * The Postbox in Zen mode: one conversation, the whole screen.
 *
 * The folder rail steps aside and the panes take the "reading pane off"
 * geometry, so with a message open the reader is all there is (with Back and
 * previous/next in its bar, see PostboxReaderBackBar), and without one the list
 * is. Nothing is saved: the reading-pane preference the Display menu shows and
 * writes stays the person's own, and leaving Zen restores it.
 *
 * Lifted out of PostboxLayout.vue to keep that file under the size cap.
 */
export function usePostboxZen(savedReadingPane: Ref<PostboxReadingPane>) {
	const { isZen } = useZenMode();
	const isDesktopViewport = useMediaQuery('(min-width: 1024px)');

	const readingPane = computed<PostboxReadingPane>(() =>
		isZen.value ? 'off' : savedReadingPane.value
	);
	/** The rail, and with it the Answer queue row and its count, is beside the list. */
	const railOnScreen = computed(() => isDesktopViewport.value && !isZen.value);

	return { isZen, readingPane, railOnScreen };
}
